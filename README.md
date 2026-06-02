# Grok plugin for Claude Code

Use **Grok Build** from inside Claude Code — for **live X (Twitter) and web search**, read-only code reviews, and delegating coding tasks to Grok.

This plugin is for Claude Code users who want to bring Grok's real-time knowledge of X and the web, plus a second coding agent, into the workflow they already have. It is part of a broader effort to let Claude Code orchestrate multiple specialized coding agents (Codex, Gemini, Grok) so it can pull in the right context and capabilities for each task.

> **Why Grok?** Grok Build has native, real-time access to X and the web. That makes it especially strong for breaking news, social sentiment, current package/version facts, and anything where "what's true right now" matters — exactly the context a model's training cutoff can't provide.

## What you get

- `/grok:search` — **the headline feature**: search X and the web in real time and get an answer with sources
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
/plugin marketplace add <your-org>/grok-plugin-cc
```

Install the plugin:

```bash
/plugin install grok@grok-build
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

## Cross-harness: install in Grok too

This plugin follows the shared plugin spec, so it installs into **Grok Build** as a native plugin as well as into Claude Code. Grok reads Claude-format marketplaces, scans `~/.claude/skills/`, honors `~/.claude/settings.json`, and maps a plugin's `commands/` into its own skill/slash-command system. Verified with `grok plugin validate` and a full install cycle.

```bash
# Validate against Grok's plugin spec
grok plugin validate ./plugins/grok

# Install locally into Grok (trusts hooks/MCP)
grok plugin install ./plugins/grok --trust

# Or from a published repo / marketplace
grok plugin install <your-org>/grok-plugin-cc#plugins/grok --trust
grok plugin marketplace add <your-org>/grok-plugin-cc

grok plugin list          # confirm it's installed
grok inspect              # see its skills/agents/commands (tagged `plugin: grok`)
grok plugin uninstall grok --confirm
```

When installed, Grok surfaces the `grok-runtime` skill, the `grok-rescue` agent, and the `search`/`review`/`rescue`/`setup`/`status`/`result`/`cancel` commands.

> **Note:** the plugin's primary purpose is to bring Grok *into Claude Code*. Inside Grok itself, the search/review capabilities are largely native already, and the companion shells out to `grok -p` (a nested Grok run). Installing it in Grok is mainly useful for format parity and multi-harness/team marketplaces — delegating between Grok, Codex, and Gemini from whichever harness you're in.

## Development

```bash
npm test    # runs the runtime unit tests
```

The runtime lives in `plugins/grok/scripts/`:

- `grok-companion.mjs` — CLI dispatcher for all subcommands
- `lib/grok.mjs` — headless `grok` invocation + result parsing
- `lib/jobs.mjs` — background-job tracking and log replay
- `lib/git.mjs`, `lib/prompts.mjs`, `lib/args.mjs`, `lib/render.mjs`, `lib/process.mjs` — supporting helpers

## FAQ

**Do I need a separate Grok account?**
No. The plugin uses your local `grok` CLI authentication. If you're already signed in (`grok login`), it works immediately.

**Does it use a separate Grok runtime?**
No. It delegates to your local `grok` CLI on the same machine, with the same auth, config, and repository checkout.

**Is the review really read-only?**
Yes. Review and search runs are restricted to read-only tools, so Grok cannot edit files or run shell commands during them. `/grok:rescue` is write-capable by default (use `--read-only` to restrict it).

## License

Apache-2.0. See [LICENSE](./LICENSE).

> This is a community plugin and is not affiliated with or endorsed by xAI or Anthropic.
