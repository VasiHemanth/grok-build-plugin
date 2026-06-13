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
 */
import process from "node:process";
import { runGrokTurn } from "./lib/grok.mjs";
import { buildSearchPrompt } from "./lib/prompts.mjs";

const SERVER_INFO = { name: "grok", version: "0.1.2" };
const DEFAULT_PROTOCOL = "2024-11-05";

// Recursion guard env var. When present, the MCP server was launched as a
// child of a grok_search turn. We refuse to serve the grok_search tool to
// break the fork-bomb loop (child Grok seeing the bridge in its own config).
const RECURSION_GUARD = "GROK_SEARCH_MCP_RECURSION_GUARD";

const TOOLS = [
  {
    name: "grok_search",
    description:
      "Search X (Twitter) and the web in REAL TIME using Grok, and return a synthesized answer with source URLs. " +
      "Use this whenever you need current or recent information that may be beyond your training cutoff: latest " +
      "package/library versions, breaking API changes, recent releases, ongoing incidents, or what people are " +
      "saying on X right now. Read-only — it never edits files or runs shell commands.",
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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
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
          content: [{ type: "text", text: "Error: grok_search recursion guard active. Recursive calls from inside a grok_search session are blocked to prevent fork-bombs." }],
          isError: true
        });
      }

      const query = String(params?.arguments?.query ?? "").trim();
      if (!query) {
        return ok(id, { content: [{ type: "text", text: "Error: 'query' is required." }], isError: true });
      }
      try {
        const r = await runGrokTurn(process.cwd(), {
          prompt: buildSearchPrompt(query),
          tools: ["web_search", "web_fetch"],
          alwaysApprove: true,
          env: { [RECURSION_GUARD]: "1" }
        });
        const text = r.text?.trim() || "(no result returned)";
        return ok(id, { content: [{ type: "text", text }] });
      } catch (error) {
        return ok(id, {
          content: [{ type: "text", text: `Grok search failed: ${error?.message ?? error}` }],
          isError: true
        });
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
      process.stderr.write(`grok-build-plugin error: ${error?.message ?? error}\n`);
    });
  }
});
process.stdin.on("end", () => process.exit(0));
