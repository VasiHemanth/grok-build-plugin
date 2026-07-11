#!/usr/bin/env node
/**
 * Grok Companion — the runtime behind the Grok plugin for Claude Code.
 *
 * Wraps the local `grok` CLI's headless mode (`grok -p ... --output-format json`)
 * to provide code review, task delegation, and live X/web search to Claude Code,
 * plus lightweight background-job management on top of Grok's own session store.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { parseArgs, normalizeEffort } from "./lib/args.mjs";
import {
  getGrokAuthStatus,
  runGrokTurn,
  searchTurnOptions,
  readOnlyTurnOptions,
  safeChildEnv
} from "./lib/grok.mjs";
import { collectReviewDiff } from "./lib/git.mjs";
import { buildReviewPrompt, buildSearchPrompt } from "./lib/prompts.mjs";
import {
  newJobId,
  writeJob,
  updateJob,
  readJob,
  listJobs,
  latestJob,
  latestRunningJob,
  reconcileJob,
  readJobOutput,
  cancelJob,
  logPathFor
} from "./lib/jobs.mjs";
import { renderJobLine, resumeHint, statusBadge, relativeTime } from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function out(text) {
  process.stdout.write(`${text}\n`);
}

function emit(flags, human, json) {
  if (flags.json) {
    out(JSON.stringify(json, null, 2));
  } else {
    out(human);
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
function cmdSetup(cwd, flags) {
  const auth = getGrokAuthStatus(cwd);
  const json = {
    available: auth.available,
    loggedIn: auth.loggedIn,
    detail: auth.detail,
    account: auth.account,
    defaultModel: auth.defaultModel,
    models: auth.models
  };

  if (flags.json) {
    out(JSON.stringify(json, null, 2));
    return auth.available && auth.loggedIn ? 0 : 1;
  }

  const lines = ["## Grok plugin setup", ""];
  if (!auth.available) {
    lines.push(`❌ ${auth.detail}`);
  } else if (!auth.loggedIn) {
    lines.push("✅ Grok CLI is installed.", `⚠️  ${auth.detail}`, "", "Run `!grok login` to authenticate, then rerun `/grok:setup`.");
  } else {
    lines.push(
      "✅ Grok CLI is installed and authenticated.",
      `- Account: ${auth.account ?? "unknown"}`,
      `- Default model: ${auth.defaultModel ?? "unknown"}`,
      auth.models.length ? `- Models: ${auth.models.join(", ")}` : ""
    );
  }
  out(lines.filter((l) => l !== "").join("\n"));
  return auth.available && auth.loggedIn ? 0 : 1;
}

// ---------------------------------------------------------------------------
// shared: run a turn either inline (foreground) or detached (background)
// ---------------------------------------------------------------------------
async function runForeground(cwd, { kind, prompt, runOptions, flags }) {
  const result = await runGrokTurn(cwd, { ...runOptions, prompt });
  // Persist a finished job record so /grok:status and /grok:result can find it.
  const job = {
    id: newJobId(),
    kind,
    prompt,
    status: result.status === 0 ? "finished" : "failed",
    sessionId: result.sessionId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: runOptions.model ?? null
  };
  // Mirror the output into the job log so /grok:result can replay it later.
  persistResultLog(cwd, job.id, result);
  writeJob(cwd, job);

  if (flags.json) {
    out(JSON.stringify({ ...job, text: result.text, stopReason: result.stopReason, stderr: result.stderr }, null, 2));
    return result.status;
  }

  if (result.status !== 0 && !result.text) {
    out(`Grok run failed (${result.stopReason}).${result.stderr ? `\n\n${result.stderr}` : ""}`);
    return result.status;
  }
  out(`${result.text}${resumeHint(result.sessionId)}`);
  return result.status;
}

function runBackground(cwd, { kind, prompt, runOptions }) {
  const jobId = newJobId();
  const logPath = logPathFor(cwd, jobId);
  writeFileSync(logPath, "");

  const job = {
    id: jobId,
    kind,
    prompt,
    status: "running",
    sessionId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    model: runOptions.model ?? null,
    pid: null
  };
  writeJob(cwd, job);

  const workerArgs = [SCRIPT_PATH, "__run", "--job", jobId, "--cwd", cwd, "--payload", encodePayload({ kind, prompt, runOptions })];
  const child = spawn(process.execPath, workerArgs, {
    cwd,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  // Merge the pid in without clobbering a fast worker that may already have
  // written its finished status + sessionId.
  return updateJob(cwd, jobId, { pid: child.pid });
}

// Write a turn result into a job log as streaming-json so readJobOutput can
// replay it identically for foreground and background jobs.
function persistResultLog(cwd, jobId, result) {
  appendFileSync(
    logPathFor(cwd, jobId),
    `${JSON.stringify({ type: "text", data: result.text ?? "" })}\n${JSON.stringify({
      type: "end",
      stopReason: result.stopReason,
      sessionId: result.sessionId,
      requestId: result.requestId
    })}\n`
  );
}

function encodePayload(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
function decodePayload(str) {
  return JSON.parse(Buffer.from(str, "base64").toString("utf8"));
}

// Internal background worker: runs grok streaming-json into the job log,
// then records the final session id + status.
async function cmdRun(cwd, flags) {
  const jobId = flags.job;
  const payload = decodePayload(flags.payload);
  const patch = { status: "failed", sessionId: null };

  try {
    const result = await runGrokTurn(cwd, { ...payload.runOptions, prompt: payload.prompt });
    persistResultLog(cwd, jobId, result);
    patch.status = result.status === 0 ? "finished" : "failed";
    patch.sessionId = result.sessionId;
  } catch (error) {
    appendFileSync(logPathFor(cwd, jobId), `${JSON.stringify({ type: "text", data: `Worker error: ${error.message}` })}\n`);
  } finally {
    patch.finishedAt = new Date().toISOString();
    // Merge so we keep the pid the parent recorded.
    updateJob(cwd, jobId, patch);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------
async function cmdReview(cwd, flags, rest) {
  const diff = collectReviewDiff(cwd, flags.base ?? null);
  if (!diff.ok) {
    emit(flags, diff.detail, { ok: false, detail: diff.detail });
    return 1;
  }
  let prompt = buildReviewPrompt(diff);
  if (rest) {
    prompt += `\n\n## Reviewer focus\n${rest}`;
  }

  // Never use --tools allowlist: grok-cli 0.2.x fails session creation for
  // many allowlists (web tools / shell). Denylist + sandbox is the safe path.
  const runOptions = readOnlyTurnOptions({
    model: flags.model ?? null
  });

  if (flags.background) {
    const job = runBackground(cwd, { kind: "review", prompt, runOptions });
    emit(flags, backgroundStartedMessage(job), job);
    return 0;
  }
  return runForeground(cwd, { kind: "review", prompt, runOptions, flags });
}

// ---------------------------------------------------------------------------
// task (rescue / delegate)
// ---------------------------------------------------------------------------
async function cmdTask(cwd, flags, rest) {
  if (!rest) {
    emit(flags, "Provide a task for Grok to work on.", { ok: false, detail: "missing task text" });
    return 1;
  }

  const readOnly = Boolean(flags["read-only"]);
  // Write-capable by default (full tool surface). --read-only uses the same
  // denylist+sandbox profile as review/search.
  const runOptions = readOnly
    ? readOnlyTurnOptions({
        model: flags.model ?? null,
        effort: normalizeEffort(flags.effort)
      })
    : {
        model: flags.model ?? null,
        effort: normalizeEffort(flags.effort),
        alwaysApprove: true,
        // Still isolate vendor MCP imports so a rescue turn cannot re-enter
        // grok_search via a host-injected MCP bridge (issue #1 class).
        env: safeChildEnv()
      };

  // Session continuity: resume the latest task session when asked.
  if (flags["resume-last"] || flags.resume) {
    const prior = latestJob(cwd, (j) => j.kind === "task" && j.sessionId);
    if (prior?.sessionId) {
      runOptions.resumeSessionId = prior.sessionId;
    }
  }

  if (flags.background) {
    const job = runBackground(cwd, { kind: "task", prompt: rest, runOptions });
    emit(flags, backgroundStartedMessage(job), job);
    return 0;
  }
  return runForeground(cwd, { kind: "task", prompt: rest, runOptions, flags });
}

// ---------------------------------------------------------------------------
// search (Grok's X / web specialty)
// ---------------------------------------------------------------------------
async function cmdSearch(cwd, flags, rest) {
  if (!rest) {
    emit(flags, "Provide a search query (X posts, people, topics, or web).", { ok: false, detail: "missing query" });
    return 1;
  }
  const prompt = buildSearchPrompt(rest);
  const runOptions = searchTurnOptions({
    model: flags.model ?? null
  });

  if (flags.background) {
    const job = runBackground(cwd, { kind: "search", prompt, runOptions });
    emit(flags, backgroundStartedMessage(job), job);
    return 0;
  }
  return runForeground(cwd, { kind: "search", prompt, runOptions, flags });
}

// ---------------------------------------------------------------------------
// status / result / cancel
// ---------------------------------------------------------------------------
function cmdStatus(cwd, flags) {
  const jobId = flags.job ?? null;
  if (jobId) {
    const job = reconcileJob(cwd, readJob(cwd, jobId));
    if (!job) {
      emit(flags, `No job found with id ${jobId}.`, { ok: false });
      return 1;
    }
    emit(flags, renderJobLine(job), job);
    return 0;
  }

  const jobs = listJobs(cwd).slice(0, 15);
  if (!jobs.length) {
    emit(flags, "No Grok jobs recorded for this repository yet.", { jobs: [] });
    return 0;
  }
  emit(flags, ["## Grok jobs", "", ...jobs.map(renderJobLine)].join("\n"), { jobs });
  return 0;
}

function cmdResult(cwd, flags) {
  const job = flags.job
    ? reconcileJob(cwd, readJob(cwd, flags.job))
    : latestJob(cwd, (j) => j.status === "finished" || j.status === "failed");
  if (!job) {
    emit(flags, "No completed Grok job found.", { ok: false });
    return 1;
  }
  if (job.status === "running") {
    emit(flags, `Job ${job.id} is still running. Try \`/grok:status\`.`, job);
    return 0;
  }
  const output = readJobOutput(cwd, job.id);
  const sessionId = output.sessionId ?? job.sessionId;
  const body = output.text?.trim() || "(no output captured)";
  emit(
    flags,
    `**${job.id}** — ${statusBadge(job.status)} · ${relativeTime(job.finishedAt ?? job.startedAt)}\n\n${body}${resumeHint(sessionId)}`,
    { ...job, text: output.text, sessionId }
  );
  return 0;
}

function cmdCancel(cwd, flags) {
  const target = flags.job ?? latestRunningJob(cwd)?.id;
  if (!target) {
    emit(flags, "No running Grok job to cancel.", { ok: false });
    return 1;
  }
  const result = cancelJob(cwd, target);
  emit(flags, result.detail, result);
  return result.ok ? 0 : 1;
}

// Reports whether a resumable task session exists (used by /grok:rescue).
function cmdTaskResumeCandidate(cwd, flags) {
  const prior = latestJob(cwd, (j) => j.kind === "task" && j.sessionId);
  const available = Boolean(prior);
  emit(
    flags,
    available ? `Resumable task session ${prior.sessionId} (${relativeTime(prior.startedAt)}).` : "No resumable task session.",
    { available, sessionId: prior?.sessionId ?? null, startedAt: prior?.startedAt ?? null }
  );
  return 0;
}

function backgroundStartedMessage(job) {
  return [
    `Started Grok ${job.kind} in the background as **${job.id}**.`,
    "",
    "- Check progress: `/grok:status`",
    "- Get the result: `/grok:result`",
    "- Cancel: `/grok:cancel`"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
async function main() {
  const [, , subcommand, ...argv] = process.argv;
  const { flags, rest } = parseArgs(argv);
  const cwd = flags.cwd || process.cwd();

  try {
    switch (subcommand) {
      case "setup":
        return cmdSetup(cwd, flags);
      case "review":
        return await cmdReview(cwd, flags, rest);
      case "task":
        return await cmdTask(cwd, flags, rest);
      case "search":
        return await cmdSearch(cwd, flags, rest);
      case "status":
        return cmdStatus(cwd, flags);
      case "result":
        return cmdResult(cwd, flags);
      case "cancel":
        return cmdCancel(cwd, flags);
      case "task-resume-candidate":
        return cmdTaskResumeCandidate(cwd, flags);
      case "__run":
        return await cmdRun(cwd, flags);
      default:
        out(
          [
            "Grok Companion — usage:",
            "  setup [--json]",
            "  review [--base <ref>] [--background] [--model <m>] [focus text]",
            "  task <text> [--background] [--resume-last|--fresh] [--read-only] [--model <m>] [--effort <low|medium|high>]",
            "  search <query> [--background] [--model <m>]",
            "  status [--job <id>]",
            "  result [--job <id>]",
            "  cancel [--job <id>]"
          ].join("\n")
        );
        return subcommand ? 1 : 0;
    }
  } catch (error) {
    if (flags.json) {
      out(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      out(`Grok companion error: ${error.message}`);
    }
    return 1;
  }
}

main().then((code) => process.exit(code ?? 0));
