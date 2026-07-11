#!/usr/bin/env node
/**
 * Grok MCP server — exposes Grok Build's live X/web search as a Model Context
 * Protocol tool, so ANY MCP-capable coding agent (Claude Code, Codex, Cursor,
 * and others) can call it autonomously.
 *
 * Transport: JSON-RPC 2.0 over stdio, newline-delimited (one JSON object per
 * line). Logs go to stderr only — stdout is reserved for protocol messages.
 *
 * It reuses the same runtime as the slash commands (lib/grok.mjs), so there is
 * one implementation of "call grok" shared by the plugin and the MCP tool.
 *
 * Hardening (issue #1 fork-bomb + CLI --tools bug):
 *  - Recursion guard env: refuse tools when already inside a search turn
 *  - Child grok runs with vendor MCP imports disabled + dangerous-tool denylist
 *    (never `--tools` allowlist — broken on grok-cli 0.2.x for web tools)
 *  - In-flight child process groups are killed on cancel / stdin end / signals
 *  - Concurrent tools/call capped to avoid accidental fan-out storms
 */
import process from "node:process";
import { runGrokTurn, searchTurnOptions, RECURSION_GUARD } from "./lib/grok.mjs";
import { buildSearchPrompt } from "./lib/prompts.mjs";
import { terminateProcess } from "./lib/process.mjs";

const SERVER_INFO = { name: "grok", version: "0.1.4" };
const DEFAULT_PROTOCOL = "2024-11-05";

/** Max simultaneous grok_search turns per MCP server process. */
const MAX_INFLIGHT = Number(process.env.GROK_SEARCH_MCP_MAX_INFLIGHT || 2);

const TOOLS = [
  {
    name: "grok_search",
    description:
      "Search X (Twitter) and the web in REAL TIME using Grok, and return a synthesized answer with source URLs. " +
      "Use this whenever you need current or recent information that may be beyond your training cutoff: latest " +
      "package/library versions, breaking API changes, recent releases, ongoing incidents, or what people are " +
      "saying on X right now. Read-only — it never edits files or runs shell commands. " +
      "Prefer this over guessing about current events, social sentiment, or package versions.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for. Be specific; mention X/x.com if you want social or primary sources."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
];

/** @type {Map<string|number, { controller: AbortController, pids: Set<number> }>} */
const inflight = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function log(...parts) {
  process.stderr.write(`[grok-mcp] ${parts.join(" ")}\n`);
}

function cancelInflight(id) {
  const entry = inflight.get(id);
  if (!entry) {
    return false;
  }
  try {
    entry.controller.abort();
  } catch {
    /* ignore */
  }
  for (const pid of entry.pids) {
    terminateProcess(pid, { processGroup: true });
  }
  inflight.delete(id);
  return true;
}

function cancelAll() {
  for (const id of [...inflight.keys()]) {
    cancelInflight(id);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    case "notifications/initialized":
    case "initialized":
      return; // notification — no response
    case "notifications/cancelled": {
      // MCP cancellation: kill the matching in-flight tools/call if we still have it.
      const requestId = params?.requestId;
      if (requestId !== undefined && requestId !== null) {
        cancelInflight(requestId);
      }
      return;
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      if (process.env[RECURSION_GUARD]) {
        // Child session from within a grok_search turn: advertise no tools
        // so the inner Grok cannot discover and call grok_search again.
        return ok(id, { tools: [] });
      }
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (name !== "grok_search") {
        return fail(id, -32602, `Unknown tool: ${name}`);
      }

      // Guard against recursion: if this MCP server itself was started by an
      // inner grok (because the child saw the bridge in its MCP config), refuse
      // the tool call. This is the primary fix for the fork-bomb (issue #1).
      if (process.env[RECURSION_GUARD]) {
        return ok(id, {
          content: [
            {
              type: "text",
              text:
                "Error: grok_search recursion guard active. Recursive calls from inside a grok_search session are blocked to prevent fork-bombs."
            }
          ],
          isError: true
        });
      }

      if (inflight.size >= MAX_INFLIGHT) {
        return ok(id, {
          content: [
            {
              type: "text",
              text: `Error: grok_search concurrency limit (${MAX_INFLIGHT}) reached. Wait for an in-flight search to finish, or raise GROK_SEARCH_MCP_MAX_INFLIGHT.`
            }
          ],
          isError: true
        });
      }

      const query = String(params?.arguments?.query ?? "").trim();
      if (!query) {
        return ok(id, { content: [{ type: "text", text: "Error: 'query' is required." }], isError: true });
      }

      const controller = new AbortController();
      const pids = new Set();
      inflight.set(id, { controller, pids });

      try {
        const r = await runGrokTurn(
          process.cwd(),
          searchTurnOptions({
            prompt: buildSearchPrompt(query),
            signal: controller.signal,
            onSpawn: (pid) => {
              if (pid) {
                pids.add(pid);
              }
            }
          })
        );
        if (r.status !== 0 && !r.text?.trim()) {
          const detail = r.stderr?.trim() || r.stopReason || "unknown error";
          return ok(id, {
            content: [{ type: "text", text: `Grok search failed: ${detail}` }],
            isError: true
          });
        }
        const text = r.text?.trim() || "(no result returned)";
        return ok(id, { content: [{ type: "text", text }] });
      } catch (error) {
        if (controller.signal.aborted) {
          return ok(id, {
            content: [{ type: "text", text: "Grok search cancelled." }],
            isError: true
          });
        }
        return ok(id, {
          content: [{ type: "text", text: `Grok search failed: ${error?.message ?? error}` }],
          isError: true
        });
      } finally {
        inflight.delete(id);
      }
    }
    default:
      if (id !== undefined && id !== null) {
        fail(id, -32601, `Method not found: ${method}`);
      }
      return;
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON lines
    }
    Promise.resolve(handle(message)).catch((error) => {
      log(`error: ${error?.message ?? error}`);
    });
  }
});

function shutdown(reason) {
  log(`shutdown (${reason}); cancelling ${inflight.size} in-flight turn(s)`);
  cancelAll();
  // Give kills a tick, then exit.
  setTimeout(() => process.exit(0), 50).unref?.();
}

process.stdin.on("end", () => shutdown("stdin-end"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
