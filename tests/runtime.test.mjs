import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendFileSync } from "node:fs";

import { parseArgs, normalizeEffort } from "../plugins/grok/scripts/lib/args.mjs";
import {
  parseJsonResult,
  buildHeadlessArgs,
  searchTurnOptions,
  readOnlyTurnOptions,
  isToolsAllowlistBug,
  isSandboxApplyFailure,
  sandboxOverride,
  DANGEROUS_TOOLS,
  RECURSION_GUARD,
  safeChildEnv
} from "../plugins/grok/scripts/lib/grok.mjs";

// jobs.mjs reads GROK_CC_STATE_DIR at call time, so set it before importing.
process.env.GROK_CC_STATE_DIR = mkdtempSync(path.join(tmpdir(), "grok-cc-jobs-"));
const jobs = await import("../plugins/grok/scripts/lib/jobs.mjs");

test("parseArgs splits value flags, bool flags, and positional text", () => {
  const { flags, rest } = parseArgs(["--model", "grok-build", "--background", "fix", "the", "bug"]);
  assert.equal(flags.model, "grok-build");
  assert.equal(flags.background, true);
  assert.equal(rest, "fix the bug");
});

test("parseArgs keeps base64 payload intact as a value flag", () => {
  const payload = Buffer.from(JSON.stringify({ a: 1 })).toString("base64");
  const { flags } = parseArgs(["__run", "--job", "job-1", "--payload", payload]);
  assert.equal(flags.job, "job-1");
  assert.equal(flags.payload, payload);
});

test("normalizeEffort maps friendly words to grok levels", () => {
  assert.equal(normalizeEffort("medium"), "medium");
  assert.equal(normalizeEffort("minimal"), "low");
  assert.equal(normalizeEffort("xhigh"), "high");
  assert.equal(normalizeEffort("bogus"), null);
  assert.equal(normalizeEffort(undefined), null);
});

test("parseJsonResult tolerates leading log noise", () => {
  const raw = 'some warning line\n{"text":"hi","sessionId":"s1","stopReason":"EndTurn"}';
  const parsed = parseJsonResult(raw);
  assert.equal(parsed.text, "hi");
  assert.equal(parsed.sessionId, "s1");
});

test("parseJsonResult returns null on garbage", () => {
  assert.equal(parseJsonResult(""), null);
  assert.equal(parseJsonResult("not json at all"), null);
});

test("buildHeadlessArgs uses denylist, never --tools by default", () => {
  const args = buildHeadlessArgs("hello", {
    disallowedTools: ["run_terminal_cmd", "search_replace"],
    alwaysApprove: true,
    noSubagents: true,
    sandbox: "read-only"
  });
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.includes("run_terminal_cmd,search_replace"));
  assert.ok(args.includes("--always-approve"));
  assert.ok(args.includes("--no-subagents"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("read-only"));
  assert.equal(args.includes("--tools"), false);
});

test("buildHeadlessArgs ignores tools allowlist unless force flag set", () => {
  const without = buildHeadlessArgs("q", { tools: ["web_search", "web_fetch"], alwaysApprove: true });
  assert.equal(without.includes("--tools"), false);

  const withForce = buildHeadlessArgs("q", {
    tools: ["web_search", "web_fetch"],
    forceToolsAllowlist: true,
    alwaysApprove: true
  });
  assert.ok(withForce.includes("--tools"));
  assert.ok(withForce.includes("web_search,web_fetch"));
});

test("searchTurnOptions / readOnlyTurnOptions never emit allowlist tools", () => {
  const search = searchTurnOptions({ model: "grok-build", tools: ["web_search"] });
  assert.equal(search.tools, undefined);
  assert.ok(search.disallowedTools.includes("run_terminal_cmd"));
  assert.ok(search.disallowedTools.includes("run_terminal_command"));
  assert.ok(search.disallowedTools.includes("use_tool"));
  assert.ok(search.disallowedTools.includes("search_replace"));
  assert.ok(search.disallowedTools.includes("write"));
  assert.equal(search.sandbox, "read-only");
  assert.equal(search.noSubagents, true);
  assert.equal(search.env[RECURSION_GUARD], "1");
  assert.equal(search.env.GROK_CLAUDE_MCPS_ENABLED, "0");
  assert.equal(search.env.GROK_CURSOR_MCPS_ENABLED, "0");

  const review = readOnlyTurnOptions();
  assert.ok(review.disallowedTools.length >= DANGEROUS_TOOLS.length);

  const args = buildHeadlessArgs("search me", search);
  assert.equal(args.includes("--tools"), false);
  assert.ok(args.includes("--disallowed-tools"));
});

test("safeChildEnv merges extra without dropping guards", () => {
  const env = safeChildEnv({ FOO: "bar", GROK_CLAUDE_MCPS_ENABLED: "1" });
  assert.equal(env.FOO, "bar");
  // Guards always win even if extra tries to re-enable vendor MCPs.
  assert.equal(env.GROK_CLAUDE_MCPS_ENABLED, "0");
  assert.equal(env.GROK_CURSOR_MCPS_ENABLED, "0");
  assert.equal(env[RECURSION_GUARD], "1");
});

test("isToolsAllowlistBug detects the known CLI failure text", () => {
  const sample =
    'agent building failed: tool error: Requirements unsatisfied: [RequirementError { tool: "GrokBuild:run_terminal_cmd", message: "auto_background_on_timeout requires enabled_background to be true"';
  assert.equal(isToolsAllowlistBug(sample), true);
  assert.equal(isToolsAllowlistBug("ordinary stderr"), false);
});

test("sandboxOverride reads GROK_CC_SANDBOX and defaults to read-only", () => {
  const prev = process.env.GROK_CC_SANDBOX;
  try {
    delete process.env.GROK_CC_SANDBOX;
    assert.deepEqual(sandboxOverride(), { set: false, sandbox: "read-only" });

    process.env.GROK_CC_SANDBOX = "off";
    assert.deepEqual(sandboxOverride(), { set: true, sandbox: null });

    process.env.GROK_CC_SANDBOX = "workspace";
    assert.deepEqual(sandboxOverride(), { set: true, sandbox: "workspace" });

    process.env.GROK_CC_SANDBOX = "readonly";
    assert.deepEqual(sandboxOverride(), { set: true, sandbox: "read-only" });

    process.env.GROK_CC_SANDBOX = "bogus";
    assert.deepEqual(sandboxOverride(), { set: false, sandbox: "read-only" });
  } finally {
    if (prev === undefined) delete process.env.GROK_CC_SANDBOX;
    else process.env.GROK_CC_SANDBOX = prev;
  }
});

test("GROK_CC_SANDBOX override controls searchTurnOptions", () => {
  const prev = process.env.GROK_CC_SANDBOX;
  try {
    process.env.GROK_CC_SANDBOX = "off";
    assert.equal(searchTurnOptions().sandbox, undefined);
    process.env.GROK_CC_SANDBOX = "workspace";
    assert.equal(searchTurnOptions().sandbox, "workspace");
    delete process.env.GROK_CC_SANDBOX;
    assert.equal(searchTurnOptions().sandbox, "read-only");
  } finally {
    if (prev === undefined) delete process.env.GROK_CC_SANDBOX;
    else process.env.GROK_CC_SANDBOX = prev;
  }
});

test("isSandboxApplyFailure detects the macOS symlink socket refusal", () => {
  const sample =
    "warning: sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink\n" +
    "error: could not apply the 'read-only' sandbox profile; see the warning above for the cause. Refusing to start with its protections missing.";
  assert.equal(isSandboxApplyFailure(sample), true);
  assert.equal(isSandboxApplyFailure("ordinary stderr"), false);
  assert.equal(isSandboxApplyFailure(""), false);
});

test("job write/read roundtrip and listing are per-cwd", () => {
  const cwd = "/tmp/project-a";
  const id = jobs.newJobId();
  jobs.writeJob(cwd, { id, kind: "task", prompt: "p", status: "finished", startedAt: new Date().toISOString() });
  const read = jobs.readJob(cwd, id);
  assert.equal(read.kind, "task");
  assert.ok(jobs.listJobs(cwd).some((j) => j.id === id));
  // A different cwd must not see it.
  assert.equal(jobs.listJobs("/tmp/project-b").length, 0);
});

test("updateJob merges without clobbering existing fields", () => {
  const cwd = "/tmp/project-merge";
  const id = jobs.newJobId();
  jobs.writeJob(cwd, { id, status: "running", sessionId: null, pid: 999 });
  jobs.updateJob(cwd, id, { status: "finished", sessionId: "sess" });
  const merged = jobs.readJob(cwd, id);
  assert.equal(merged.status, "finished");
  assert.equal(merged.sessionId, "sess");
  assert.equal(merged.pid, 999); // preserved
});

test("readJobOutput reconstructs text from streaming-json log", () => {
  const cwd = "/tmp/project-log";
  const id = jobs.newJobId();
  appendFileSync(
    jobs.logPathFor(cwd, id),
    `${JSON.stringify({ type: "text", data: "Hello " })}\n${JSON.stringify({ type: "text", data: "world" })}\n${JSON.stringify({ type: "end", sessionId: "s9", stopReason: "EndTurn" })}\n`
  );
  const out = jobs.readJobOutput(cwd, id);
  assert.equal(out.text, "Hello world");
  assert.equal(out.sessionId, "s9");
});
