# grok-mcp — Grok Build for any coding agent

Bring **Grok Build's live X (Twitter) + web search** (and its coding agent) into the tools you already use. Two ways to consume it:

- **An MCP tool (`grok_search`)** — works in **any MCP-capable agent**: Claude Code, OpenAI Codex, Cursor, and others. This is the cross-agent, real-time-search core.
- **A Claude Code / Grok plugin** — convenience slash commands (`/grok:search`, `/grok:review`, `/grok:rescue`, …) plus a delegation subagent, with the MCP tool auto-wired in.

Grok Build has native, real-time access to X and the web — strong for breaking news, social sentiment, current package/version facts, and anything where "what's true right now" matters, which a model's training cutoff can't provide. This project is a thin, auditable wrapper around your local `grok` CLI.

## What you get

- **`grok_search` MCP tool** — live X/web search with sources, callable autonomously by any MCP-capable agent (the cross-agent core)
- `/grok:search` — the same search as an explicit slash command
- `/grok:review` — a read-only Grok code review of your uncommitted changes or a branch
- `/grok:rescue` — delegate a coding/investigation task to Grok (write-capable)
- `/grok:status`, `/grok:result`, `/grok:cancel` — manage background jobs
- `/grok:setup` — verify Grok is installed and signed in
- a `grok:grok-rescue` subagent that Claude can hand substantial tasks to proactively

## Requirements

- **Grok Build CLI** installed and on your `PATH` as `grok` (or point `GROK_BIN` at it). Verify with `grok --version`.
- A signed-in Grok account (`grok login`). Usage counts toward your Grok limits.
- **Node.js 18.18 or later.**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add VasiHemanth/grok-mcp
```

Install the plugin:

```bash
/plugin install grok@grok-mcp
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/grok:setup
```

`/grok:setup` reports whether Grok is installed and authenticated. If it is installed but not signed in, run `!grok login` and rerun setup.

## Usage

### `/grok:search` — live X + web search

Grok's specialty. Answers questions using current information from X and the web, then lists its sources (including `x.com` post links when used).

```bash
/grok:search what are people on X saying about the new React release this week
/grok:search latest stable version of Node.js, with a source
/grok:search --background deep dive on recent X discussion of AI agent frameworks
```

Read-only: it only searches and reads; it never edits files.

### `/grok:review` — read-only code review

Runs a read-only Grok review of your current work. Grok will not modify any files.

```bash
/grok:review
/grok:review --base main
/grok:review --background look for race conditions in the new queue code
```

- Default target is your uncommitted changes. `--base <ref>` reviews the current branch against that ref.
- Any text after the flags becomes extra reviewer focus.
- Supports `--background` for large diffs.

### `/grok:rescue` — delegate a task to Grok

Hands a task to Grok through the `grok:grok-rescue` subagent. Write-capable by default.

```bash
/grok:rescue investigate why the integration tests started failing
/grok:rescue fix the failing test with the smallest safe patch
/grok:rescue --read-only diagnose the memory leak without changing code
/grok:rescue --resume-last apply the top fix from the last run
/grok:rescue --background --effort high refactor the database connection layer
```

- `--read-only` restricts Grok to reading/searching (no edits or shell).
- `--resume-last` continues the latest Grok task session in this repo; `--fresh` forces a new one. If you omit both, the plugin offers to continue when a resumable session exists.
- `--model <id>` and `--effort <low|medium|high>` are optional runtime controls.

You can also just ask in natural language, e.g. *"Ask Grok to redesign the retry logic to be more resilient,"* and Claude will route it to the subagent.

### `/grok:status`, `/grok:result`, `/grok:cancel`

```bash
/grok:status                # list running and recent jobs for this repo
/grok:result                # final output of the most recent completed job
/grok:result --job <id>     # a specific job
/grok:cancel                # cancel the most recent running job
```

`/grok:result` includes the Grok **session id** so you can reopen that run directly with `grok -r <session-id>` and continue it inside Grok.

## How it works

The plugin wraps the local `grok` CLI's **headless mode**:

```bash
grok -p "<prompt>" --output-format json
# → { "text": ..., "stopReason": ..., "sessionId": ..., "requestId": ... }
```

There is no separate server or daemon. Grok manages its own session store (under `~/.grok/sessions`), so:

- it uses the same Grok install and login you use directly,
- sessions started here can be resumed in the Grok TUI with `grok -r <id>` (and vice versa),
- read-only commands restrict Grok's toolset (`read_file`, `grep`, `list_dir`, `web_search`, `web_fetch`) so reviews and searches can't modify your repo.

Background jobs run the headless turn in a detached process, streaming output to a per-repository log under `~/.grok/cc-plugin/jobs/`. `/grok:status` and `/grok:result` read from there.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `GROK_BIN` | Path to the `grok` binary if it isn't named `grok` on `PATH`. |
| `GROK_CC_STATE_DIR` | Override the background-job state directory (used by tests). |

## Use the search tool from any agent (MCP)

The `grok_search` tool lives in one file — `plugins/grok/scripts/grok-mcp.mjs` — a dependency-free MCP server (JSON-RPC over stdio). When you install the plugin in Claude Code or Grok, it's wired up automatically via `.mcp.json`. Any **other** MCP-capable agent can use the exact same file by pointing its own MCP config at it:

```jsonc
// e.g. OpenAI Codex / Cursor MCP config
{
  "mcpServers": {
    "grok": {
      "command": "node",
      "args": ["/absolute/path/to/grok-mcp/plugins/grok/scripts/grok-mcp.mjs"]
    }
  }
}
```

Then the agent can call `grok_search(query)` on its own whenever it needs current information. It returns a synthesized answer plus a Sources list (including `x.com` links). The tool is read-only (Grok is restricted to `web_search`/`web_fetch`).

> MCP is a vendor-neutral protocol, but each host has its own config format and its own subset of features — so the same server works across hosts with a little per-host setup, not zero-config everywhere. (Codex and Cursor support MCP today; check your agent's docs.)

## Cross-harness: install in Grok too

This plugin follows the shared plugin spec, so it installs into **Grok Build** as a native plugin as well as into Claude Code. Grok reads Claude-format marketplaces, scans `~/.claude/skills/`, honors `~/.claude/settings.json`, and maps a plugin's `commands/` into its own skill/slash-command system. Verified with `grok plugin validate` and a full install cycle.

```bash
# Validate against Grok's plugin spec
grok plugin validate ./plugins/grok

# Install locally into Grok (trusts hooks/MCP)
grok plugin install ./plugins/grok --trust

# Or from a published repo / marketplace
grok plugin install VasiHemanth/grok-mcp#plugins/grok --trust
grok plugin marketplace add VasiHemanth/grok-mcp

grok plugin list          # confirm it's installed
grok inspect              # see its skills/agents/commands (tagged `plugin: grok`)
grok plugin uninstall grok --confirm
```

When installed, Grok surfaces the `grok-runtime` skill, the `grok-rescue` agent, and the `search`/`review`/`rescue`/`setup`/`status`/`result`/`cancel` commands.

> **Note:** the plugin's primary purpose is to bring Grok *into Claude Code*. Inside Grok itself, the search/review capabilities are largely native already, and the companion shells out to `grok -p` (a nested Grok run). Installing it in Grok is mainly useful for format parity and multi-harness/team marketplaces — delegating between Grok, Codex, and Gemini from whichever harness you're in.

## Development

```bash
npm test    # runtime unit tests + MCP server smoke tests (no Grok account needed)
```

The runtime lives in `plugins/grok/scripts/`:

- `grok-mcp.mjs` — MCP server exposing the `grok_search` tool (cross-agent)
- `grok-companion.mjs` — CLI dispatcher behind the slash commands
- `lib/grok.mjs` — headless `grok` invocation + result parsing (shared by both)
- `lib/jobs.mjs` — background-job tracking and log replay
- `lib/git.mjs`, `lib/prompts.mjs`, `lib/args.mjs`, `lib/render.mjs`, `lib/process.mjs` — supporting helpers

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and conventions.

## FAQ

**Do I need a separate Grok account?**
No. The plugin uses your local `grok` CLI authentication. If you're already signed in (`grok login`), it works immediately.

**Does it use a separate Grok runtime?**
No. It delegates to your local `grok` CLI on the same machine, with the same auth, config, and repository checkout.

**Is the review really read-only?**
Yes. Review and search runs are restricted to read-only tools, so Grok cannot edit files or run shell commands during them. `/grok:rescue` is write-capable by default (use `--read-only` to restrict it).

## Credits

Independent implementation. Its plugin layout and command surface were inspired by the architecture of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0); no source code was copied. See [NOTICE](./NOTICE).

## License

Apache-2.0. See [LICENSE](./LICENSE).

> **Unofficial / community project.** Not affiliated with, endorsed by, or sponsored by xAI, Anthropic, OpenAI, Google, or any other vendor. "Grok", "Claude Code", "Codex", "Cursor", and "Antigravity" are trademarks of their respective owners; names are used only to describe interoperability. You are responsible for complying with xAI and X terms when using your Grok CLI through this tool.
