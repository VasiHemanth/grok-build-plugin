import { grokBinary, binaryAvailable, runCommand } from "./process.mjs";

// ---------------------------------------------------------------------------
// Tool surfaces
//
// IMPORTANT (grok-cli 0.2.x, verified on 0.2.87–0.2.93):
//   `grok -p ... --tools <allowlist>` often fails session creation with:
//     agent building failed: tool error: Requirements unsatisfied
//     [GrokBuild:run_terminal_cmd / auto_background_on_timeout ...]
//   Reproduced whenever the allowlist includes web tools or shell itself.
//   `--disallowed-tools` (denylist) works reliably. This plugin therefore
//   NEVER passes `--tools` unless GROK_CC_FORCE_TOOLS_ALLOWLIST=1 is set
//   (escape hatch for a future fixed CLI).
// ---------------------------------------------------------------------------

/** Tools that only read state. Documented intent for reviews/searches. */
export const READ_ONLY_TOOLS = ["read_file", "grep", "list_dir", "web_search", "web_fetch"];

/** Tools needed for a pure live X/web search turn. */
export const SEARCH_TOOLS = ["web_search", "web_fetch"];

/**
 * Mutable / interactive / fan-out tools we strip for read-only and search runs.
 * Includes both historical (`run_terminal_cmd`) and current (`run_terminal_command`)
 * shell IDs, write tools, MCP bridge tools (fork-bomb vector), media gens, and
 * subagent spawn aliases.
 */
export const DANGEROUS_TOOLS = [
  // shell (both IDs appear across docs / hooks)
  "run_terminal_cmd",
  "run_terminal_command",
  // filesystem writes
  "search_replace",
  "write",
  // interactive
  "ask_user_question",
  // subagents (flag + tool IDs)
  "Agent",
  "spawn_subagent",
  "task",
  // MCP bridge (prevents recursive grok_search via use_tool)
  "use_tool",
  "search_tool",
  // media / side effects
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "monitor",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list"
];

/** Write + shell only (lighter denylist when subagents/MCP still OK). */
export const WRITE_AND_SHELL_TOOLS = ["run_terminal_cmd", "run_terminal_command", "search_replace", "write"];

const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

/** Env marker: MCP server was launched from inside a grok_search turn. */
export const RECURSION_GUARD = "GROK_SEARCH_MCP_RECURSION_GUARD";

/**
 * Child env for headless turns that must not re-import host MCP bridges
 * (Claude/Cursor vendor MCP scan) — primary defence against issue #1 fork-bombs
 * together with the recursion guard in grok-mcp.mjs.
 */
export function safeChildEnv(extra = {}) {
  return {
    ...extra,
    // Isolation guards always win over caller overrides.
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CURSOR_MCPS_ENABLED: "0",
    [RECURSION_GUARD]: "1"
  };
}

/**
 * Optional operator override for the sandbox profile on safe (read-only /
 * search) turns. Recognized values: `read-only`, `workspace`, `strict`, `off`
 * (aliases: `readonly`, `none`, `false`). Unset means the default `read-only`
 * with automatic fallback when the profile cannot be applied on this host.
 * When set, the value is honored exactly and no fallback is attempted.
 * @returns {{ set: boolean, sandbox: string|null }}
 */
export function sandboxOverride() {
  const raw = String(process.env.GROK_CC_SANDBOX ?? "").trim().toLowerCase();
  if (!raw) {
    return { set: false, sandbox: "read-only" };
  }
  if (raw === "off" || raw === "none" || raw === "false") {
    return { set: true, sandbox: null };
  }
  if (raw === "readonly") {
    return { set: true, sandbox: "read-only" };
  }
  if (raw === "read-only" || raw === "workspace" || raw === "strict") {
    return { set: true, sandbox: raw };
  }
  return { set: false, sandbox: "read-only" };
}

/**
 * Detect a sandbox-application failure from the grok CLI. On macOS a symlinked
 * runtime socket such as `/var/run/docker.sock` makes the CLI refuse to start
 * under `read-only`/`strict` rather than run with protections missing.
 */
export function isSandboxApplyFailure(text) {
  if (!text) {
    return false;
  }
  return (
    /sandbox could not be applied/i.test(text) ||
    /could not apply the ['"]?[\w-]+['"]? sandbox profile/i.test(text) ||
    /socket deny resolution failed/i.test(text) ||
    /could not resolve runtime-socket deny path/i.test(text)
  );
}

/**
 * Options for a live X/web search turn: denylist + sandbox + no subagents.
 * Prefer this over an allowlist (`--tools`) on current CLI versions.
 */
export function searchTurnOptions(overrides = {}) {
  return buildSafeTurnOptions(overrides);
}

/**
 * Options for a read-only review / diagnose turn.
 */
export function readOnlyTurnOptions(overrides = {}) {
  return buildSafeTurnOptions(overrides);
}

/**
 * Shared safe-turn profile: denylist of dangerous tools, read-only sandbox,
 * no subagents, and env that blocks vendor MCP re-import + recursion.
 */
function buildSafeTurnOptions(overrides = {}) {
  const cleaned = stripToolAllowlist(overrides);
  const { env: extraEnv, disallowedTools, sandbox: _ignoredSandbox, ...rest } = cleaned;
  const { sandbox } = sandboxOverride();
  return {
    alwaysApprove: true,
    noSubagents: true,
    ...(sandbox ? { sandbox } : {}),
    ...rest,
    // Callers may extend the denylist; they cannot shrink the default set
    // without passing an explicit full list via disallowedTools.
    disallowedTools: Array.isArray(disallowedTools)
      ? [...new Set([...DANGEROUS_TOOLS, ...disallowedTools])]
      : [...DANGEROUS_TOOLS],
    // Isolation env always wins for guard keys; extraEnv can add more.
    env: safeChildEnv(extraEnv)
  };
}

/**
 * Drop `tools` allowlist from overrides unless the operator explicitly forces it.
 * Call sites used to pass tools: READ_ONLY_TOOLS — that path is broken on CLI 0.2.x.
 */
function stripToolAllowlist(overrides = {}) {
  const force = process.env.GROK_CC_FORCE_TOOLS_ALLOWLIST === "1" || overrides.forceToolsAllowlist;
  if (force) {
    return { ...overrides };
  }
  if (overrides.tools) {
    const { tools: _drop, forceToolsAllowlist: _f, ...rest } = overrides;
    return rest;
  }
  return { ...overrides };
}

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
 * Exported for unit tests — production callers should use runGrokTurn.
 * @param {string} prompt
 * @param {object} options
 */
export function buildHeadlessArgs(prompt, options = {}) {
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
  // Default: denylist only. Allowlist is gated — see module header.
  const forceAllowlist =
    process.env.GROK_CC_FORCE_TOOLS_ALLOWLIST === "1" || options.forceToolsAllowlist;
  if (forceAllowlist && Array.isArray(options.tools) && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }
  if (Array.isArray(options.disallowedTools) && options.disallowedTools.length > 0) {
    // de-dupe while preserving order
    const unique = [...new Set(options.disallowedTools.filter(Boolean))];
    if (unique.length) {
      args.push("--disallowed-tools", unique.join(","));
    }
  }

  if (options.noSubagents) {
    args.push("--no-subagents");
  }
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  if (options.disableWebSearch) {
    args.push("--disable-web-search");
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
 * Detect the known `--tools` session-creation bug in stderr/stdout so callers
 * can surface a useful message instead of a raw internal error.
 */
export function isToolsAllowlistBug(text) {
  if (!text) {
    return false;
  }
  return (
    /Requirements unsatisfied/i.test(text) &&
    /run_terminal_cmd|auto_background_on_timeout/i.test(text)
  );
}

/**
 * Run a single headless Grok turn and return a normalized result.
 *
 * @param {string} cwd
 * @param {object} options - prompt, model, effort, tools, disallowedTools,
 *   allow, deny, permissionMode, sessionId, resumeSessionId, continueLast,
 *   alwaysApprove, rules, signal, onProgress, defaultPrompt, env,
 *   noSubagents, sandbox, disableWebSearch, forceToolsAllowlist
 */
export async function runGrokTurn(cwd, options = {}) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(availability.detail);
  }

  const result = await runGrokTurnOnce(cwd, options);

  // A requested sandbox profile can fail to apply on some hosts (e.g. a
  // symlinked runtime socket such as /var/run/docker.sock on macOS). The CLI
  // refuses to start, so no turn ran; retrying on `workspace` keeps the turn
  // alive while still confining writes. An explicit GROK_CC_SANDBOX is
  // honored exactly, so operators who require read-only can opt out of this.
  const override = sandboxOverride();
  const requested = options.sandbox;
  if (
    !override.set &&
    requested &&
    requested !== "workspace" &&
    result.status !== 0 &&
    isSandboxApplyFailure(`${result.stderr}\n${result.stdout ?? ""}`)
  ) {
    const retried = await runGrokTurnOnce(cwd, { ...options, sandbox: "workspace" });
    const note =
      `[grok plugin] sandbox "${requested}" could not be applied on this host; ` +
      'retried with "workspace". Set GROK_CC_SANDBOX=read-only to fail instead, ' +
      "or GROK_CC_SANDBOX=off to disable the sandbox.";
    retried.stderr = [note, retried.stderr].filter(Boolean).join("\n");
    return retried;
  }

  return result;
}

async function runGrokTurnOnce(cwd, options = {}) {
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

  const { code, stdout, stderr, pid } = await runCommand(grokBinary(), args, {
    cwd,
    signal: options.signal,
    env: options.env,
    onStdoutLine,
    // Own process group so cancel/abort can reap the whole tree (MCP children).
    processGroup: true,
    onSpawn: options.onSpawn
  });

  let text = "";
  let sessionId = null;
  let stopReason = code === 0 ? "EndTurn" : "Error";
  let requestId = null;
  let thought = null;
  let structuredError = null;

  if (streaming) {
    text = textChunks.join("");
    sessionId = finalEvent?.sessionId ?? null;
    stopReason = finalEvent?.stopReason ?? stopReason;
    requestId = finalEvent?.requestId ?? null;
  } else {
    const parsed = parseJsonResult(stdout);
    if (parsed?.type === "error" && parsed?.message) {
      structuredError = String(parsed.message);
      stopReason = "Error";
    } else if (parsed) {
      text = parsed.text ?? "";
      sessionId = parsed.sessionId ?? null;
      stopReason = parsed.stopReason ?? stopReason;
      requestId = parsed.requestId ?? null;
      thought = parsed.thought ?? null;
    }
  }

  const sessionFail =
    /Couldn't create session|agent building failed|Requirements unsatisfied/i.test(stdout || "") ||
    /Couldn't create session|agent building failed|Requirements unsatisfied/i.test(stderr || "");

  const combinedErr = [stderr, structuredError, sessionFail ? stdout : ""].filter(Boolean).join("\n").trim();

  let friendlyStderr = combinedErr;
  if (isToolsAllowlistBug(combinedErr) || isToolsAllowlistBug(stdout)) {
    friendlyStderr =
      "Grok CLI rejected this tool allowlist (`--tools`). " +
      "This is a known grok-cli 0.2.x bug (run_terminal_cmd param constraints). " +
      "This plugin uses `--disallowed-tools` instead; if you still see this, " +
      "unset GROK_CC_FORCE_TOOLS_ALLOWLIST. Original error:\n" +
      (combinedErr || stdout || "");
    stopReason = "Error";
  }

  const failed =
    code !== 0 || stopReason === "Error" || sessionFail || isToolsAllowlistBug(stdout) || Boolean(structuredError);

  return {
    status: failed ? 1 : 0,
    code,
    text: text ?? "",
    sessionId,
    stopReason: failed && stopReason === "EndTurn" ? "Error" : stopReason,
    requestId,
    thought: thought ?? null,
    stderr: friendlyStderr,
    stdout: stdout ?? "",
    args,
    pid: pid ?? null
  };
}

export { DEFAULT_CONTINUE_PROMPT };
