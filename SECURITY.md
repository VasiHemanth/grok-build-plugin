# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, report privately via [GitHub Security Advisories](https://github.com/VasiHemanth/grok-build-plugin/security/advisories/new) (preferred) or email the maintainer listed in the repository profile. We aim to acknowledge reports within a few days.

## Scope and threat model

grok-build-plugin is a thin wrapper that shells out to your locally installed `grok` CLI. Things worth knowing:

- **No credentials are stored or transmitted by this project.** Authentication is handled entirely by your local `grok` CLI (`~/.grok`). This tool never reads your tokens.
- **Read-only by default for search and review.** `grok_search`, `/grok:search`, and `/grok:review` strip write/shell/MCP/media tools via `--disallowed-tools`, use `--sandbox read-only`, and disable subagents. They never use the broken `--tools` allowlist on grok-cli 0.2.x.
- **Fork-bomb guards.** Search turns set `GROK_SEARCH_MCP_RECURSION_GUARD` and disable Claude/Cursor MCP imports in the child env; the MCP server refuses nested `grok_search`, caps concurrency, and kills process groups on cancel.
- **`/grok:rescue` is write-capable** by design (it delegates real coding tasks). Treat it like any agent with edit/shell access and review its changes.
- **Background-job state** is written under `~/.grok/cc-plugin/jobs/` and contains your prompts and Grok session ids: no secrets, but be aware it's on disk.
- **The `grok` binary is resolved from `PATH`** (or `GROK_BIN`). Ensure that path is trusted.

Please report anything that lets this wrapper exceed those boundaries (e.g., a read-only command performing writes, or prompt/argument injection into the spawned process).
