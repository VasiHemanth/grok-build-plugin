import { grokBinary, binaryAvailable, runCommand } from "./process.mjs";

// Tools that only read state. Used to force read-only runs (e.g. reviews).
export const READ_ONLY_TOOLS = ["read_file", "grep", "list_dir", "web_search", "web_fetch"];

// Tools removed when a run must not touch the filesystem or shell.
export const WRITE_AND_SHELL_TOOLS = ["run_terminal_cmd", "search_replace"];

const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

/**
 * Verify the grok CLI is installed and exposes headless mode.
 * @returns {{ available: boolean, detail: string, version?: string }}
 */
export function getGrokAvailability(cwd) {
  const version = binaryAvailable(grokBinary(), ["--version"], { cwd });
  if (!version.available) {
    return {
      available: false,
      detail:
        "Grok CLI not found. Install it from https://docs.x.ai (or set GROK_BIN to its path), then rerun /grok:setup."
    };
  }
  return { available: true, detail: version.detail, version: version.detail };
}

/**
 * Read login + default-model state from `grok models`. This is a local,
 * no-cost call (it does not start an agent turn).
 * @returns {{ available: boolean, loggedIn: boolean, detail: string, account: string|null, defaultModel: string|null, models: string[] }}
 */
export function getGrokAuthStatus(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      account: null,
      defaultModel: null,
      models: []
    };
  }

  const probe = binaryAvailable(grokBinary(), ["models"], { cwd });
  const text = probe.detail || "";
  // "You are logged in with grok.com." / "Not logged in" style messages.
  const loginMatch = text.match(/logged in with\s+([^\n]+?)\.?\s*$/im);
  const loggedIn = Boolean(loginMatch) && !/not logged in/i.test(text);
  const defaultMatch = text.match(/Default model:\s*([^\n]+)/i);
  const models = [...text.matchAll(/^\s*[-*]\s+([A-Za-z0-9._-]+)/gm)].map((m) => m[1]);

  if (!probe.available) {
    return {
      available: true,
      loggedIn: false,
      detail: probe.detail || "Could not query Grok models. Run `grok login`.",
      account: null,
      defaultModel: null,
      models: []
    };
  }

  return {
    available: true,
    loggedIn,
    detail: loggedIn
      ? `Logged in with ${loginMatch[1].trim()}`
      : "Grok is installed but not logged in. Run `!grok login`.",
    account: loginMatch ? loginMatch[1].trim() : null,
    defaultModel: defaultMatch ? defaultMatch[1].trim() : null,
    models
  };
}

/** List available model IDs (best-effort). */
export function getGrokModels(cwd) {
  return getGrokAuthStatus(cwd).models;
}

/**
 * Build the argv for a headless grok run.
 * @param {object} options
 */
function buildHeadlessArgs(prompt, options = {}) {
  const args = ["-p", prompt, "--output-format", options.streaming ? "streaming-json" : "json"];

  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }

  // Session continuity. Precedence: explicit resume > named session > continue.
  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  } else if (options.sessionId) {
    args.push("-s", options.sessionId);
  } else if (options.continueLast) {
    args.push("-c");
  }

  // Tool surface.
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }
  if (Array.isArray(options.disallowedTools) && options.disallowedTools.length > 0) {
    args.push("--disallowed-tools", options.disallowedTools.join(","));
  }

  // Permission rules (repeatable).
  for (const rule of options.allow ?? []) {
    args.push("--allow", rule);
  }
  for (const rule of options.deny ?? []) {
    args.push("--deny", rule);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  // Read-only runs auto-approve their (read-only) tools so they never block.
  // Write runs auto-approve only when explicitly asked.
  if (options.alwaysApprove) {
    args.push("--always-approve");
  }

  if (options.rules) {
    args.push("--rules", options.rules);
  }

  return args;
}

/**
 * Parse the final result object emitted by `--output-format json`.
 * Grok prints a single JSON object; be defensive about leading log lines.
 */
export function parseJsonResult(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }
  // Fast path: whole stdout is the object.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace scan */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Run a single headless Grok turn and return a normalized result.
 *
 * @param {string} cwd
 * @param {object} options - prompt, model, effort, tools, disallowedTools,
 *   allow, deny, permissionMode, sessionId, resumeSessionId, continueLast,
 *   alwaysApprove, rules, signal, onProgress, defaultPrompt, env
 */
export async function runGrokTurn(cwd, options = {}) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(availability.detail);
  }

  const prompt = (options.prompt ?? "").trim() || options.defaultPrompt || DEFAULT_CONTINUE_PROMPT;
  const streaming = Boolean(options.onProgress);
  const args = buildHeadlessArgs(prompt, { ...options, streaming });

  let finalEvent = null;
  const textChunks = [];

  const onStdoutLine = streaming
    ? (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        switch (event.type) {
          case "text":
            if (event.data) {
              textChunks.push(event.data);
            }
            break;
          case "thought":
            options.onProgress?.({ phase: "thinking", message: String(event.data ?? "").trim() });
            break;
          case "tool":
          case "tool_call":
            options.onProgress?.({
              phase: "tool",
              message: `Tool: ${event.name ?? event.tool ?? "unknown"}`
            });
            break;
          case "end":
            finalEvent = event;
            break;
          default:
            break;
        }
      }
    : undefined;

  const { code, stdout, stderr } = await runCommand(grokBinary(), args, {
    cwd,
    signal: options.signal,
    env: options.env,
    onStdoutLine
  });

  let text;
  let sessionId;
  let stopReason;
  let requestId;
  let thought;

  if (streaming) {
    text = textChunks.join("");
    sessionId = finalEvent?.sessionId ?? null;
    stopReason = finalEvent?.stopReason ?? (code === 0 ? "EndTurn" : "Error");
    requestId = finalEvent?.requestId ?? null;
  } else {
    const parsed = parseJsonResult(stdout);
    text = parsed?.text ?? "";
    sessionId = parsed?.sessionId ?? null;
    stopReason = parsed?.stopReason ?? (code === 0 ? "EndTurn" : "Error");
    requestId = parsed?.requestId ?? null;
    thought = parsed?.thought ?? null;
  }

  const status = code === 0 && stopReason !== "Error" ? 0 : 1;

  return {
    status,
    code,
    text: text ?? "",
    sessionId,
    stopReason,
    requestId,
    thought: thought ?? null,
    stderr: (stderr ?? "").trim(),
    args
  };
}

export { DEFAULT_CONTINUE_PROMPT };
