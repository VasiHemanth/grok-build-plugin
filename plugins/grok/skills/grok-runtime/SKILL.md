---
name: grok-runtime
description: Internal helper contract for calling the grok-companion runtime from Claude Code or Codex. Reference when invoking the Grok companion script or the grok_search MCP tool.
---

# Grok companion runtime

The Grok plugin wraps the local `grok` CLI's **headless mode** (`grok -p "<prompt>" --output-format json`). Grok manages its own session store under `~/.grok/sessions`, so the plugin does not run a separate server or broker.

Always invoke through the companion script so job tracking, prompt shaping, and tool filtering stay consistent:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" <subcommand> [flags] [text]
```

Or, for live search from any MCP-capable agent, call the `grok_search` tool (auto-wired when the plugin is installed; otherwise `npx -y grok-build-x-search-mcp`).

## When to use Grok (routing guidance for host agents)

| Need | Prefer |
| --- | --- |
| Live X sentiment, breaking news, "what are people saying" | `grok_search` / `/grok:search` |
| Current package/version/docs facts beyond training cutoff | `grok_search` / `/grok:search` |
| Second opinion code review on a diff | `/grok:review` |
| Substantial implement/debug pass with write access | `/grok:rescue` or `grok:grok-rescue` subagent |
| Trivial local edit the host can do in one step | **Do not** delegate — handle inline |

## Subcommands

| Subcommand | Purpose | Tool surface |
| --- | --- | --- |
| `setup [--json]` | Check install + login (no API call) | none |
| `review [--base <ref>] [--background] [--model <m>] [focus]` | Read-only code review of a git diff | denylist of write/shell/MCP/media; `--sandbox read-only` |
| `task <text> [--background] [--resume-last\|--fresh] [--read-only] [--model <m>] [--effort <low\|medium\|high>]` | Delegate work; write-capable by default | full (or read-only with `--read-only`) |
| `search <query> [--background] [--model <m>]` | Live X/web search | same safe profile as review (web tools kept) |
| `status [--job <id>]` | List or show jobs | n/a |
| `result [--job <id>]` | Final output + Grok session id | n/a |
| `cancel [--job <id>]` | Cancel a running job | n/a |

## Tool filtering note (CLI bug)

On grok-cli **0.2.x**, `grok -p ... --tools <allowlist>` often fails session creation when web tools or shell are involved (`Requirements unsatisfied` / `run_terminal_cmd` / `auto_background_on_timeout`). This plugin **never** uses `--tools` for search/review; it uses `--disallowed-tools` + `--sandbox read-only` + `--no-subagents`, and disables vendor MCP imports in the child env to prevent recursive `grok_search` fork-bombs.

## Key facts

- Add `--json` to any command for machine-readable output.
- The JSON contract from `grok -p` is `{ text, stopReason, sessionId, requestId, thought }`.
- Sessions: `-s <id>` creates a **new** session id, `-r <id>` resumes, `-c` continues most recent in cwd. The companion handles this via `--resume-last`.
- Background jobs write streaming-json to a per-repo log under `~/.grok/cc-plugin/jobs/`; `status`/`result` read from there.
- Models available locally: run `grok models`. Default is `grok-build`.
- `GROK_BIN` overrides the binary path; `GROK_CC_STATE_DIR` overrides the job state directory (used in tests).
- Always return the companion's stdout verbatim to the user. Do not paraphrase.
