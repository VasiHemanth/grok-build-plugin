# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-07-11

### Fixed
- **`--tools` allowlist session-creation bug** (still present on grok-cli 0.2.87–0.2.93).
  Search/review previously passed `--tools web_search,web_fetch` (or a read-only allowlist).
  On current CLI builds this often fails with `agent building failed: Requirements unsatisfied`
  for `GrokBuild:run_terminal_cmd` / `auto_background_on_timeout` — so `grok_search` and
  `/grok:search` silently died before any search ran.
  - Plugin paths now use `--disallowed-tools` (comprehensive denylist), `--sandbox read-only`,
    and `--no-subagents` instead of `--tools`.
  - Allowlist via `--tools` is only emitted if `GROK_CC_FORCE_TOOLS_ALLOWLIST=1` (escape hatch).
- **Fork-bomb hardening (issue #1 follow-up):**
  - Child turns set `GROK_CLAUDE_MCPS_ENABLED=0`, `GROK_CURSOR_MCPS_ENABLED=0`, and the
    recursion guard so host MCP bridges are not re-imported into the search session.
  - Denylist also strips `use_tool` / `search_tool` (MCP bridge tools).
  - MCP server kills in-flight process groups on `notifications/cancelled`, stdin end, SIGTERM/SIGINT.
  - Concurrency cap (`GROK_SEARCH_MCP_MAX_INFLIGHT`, default 2) on `tools/call`.
- Local `.mcp.json` again points at `${CLAUDE_PLUGIN_ROOT}/scripts/grok-mcp.mjs` so Claude Code
  runs the bundled server (with these fixes) instead of only the npm package lagging behind.

### Changed
- Shared `searchTurnOptions` / `readOnlyTurnOptions` / `safeChildEnv` helpers in `lib/grok.mjs`.
- `runCommand` spawns children in their own process group so cancel reaps MCP grandchildren.
- Skill + rescue agent guidance: prefer `grok_search` for pure live search; rescue for write work.
- Version bump to 0.1.4.


### Added
- `grok_search` **MCP server** (`plugins/grok/scripts/grok-mcp.mjs`) exposing Grok's live X/web search to any MCP-capable agent (Claude Code, Codex, Cursor). Auto-wired for the plugin via `.mcp.json`.
- npm `bin` + `files` so the server runs via `npx`. Initially via `github:`, then published to the registry as `grok-build-x-search-mcp` for v0.1.0.
- Open-source scaffolding: `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, CI workflow.

### Fixed
- **Critical recursion / fork-bomb in the published MCP server** (GitHub issue #1). When a `grok_search` call spawns an inner `grok -p`, the child Grok could see the `grok` MCP bridge in its merged config and recursively call the tool, leading to hundreds of processes and OOM/crashes. 
  - Added `GROK_SEARCH_MCP_RECURSION_GUARD` env marker passed only on search turns.
  - `grok-mcp.mjs` now returns empty tools list (or explicit error) when the guard is present.
  - `runGrokTurn` / `runCommand` now forward custom `env`.
  - Improved GitHub publish workflow (provenance, repo guard, clearer release instructions).
- Users of `npx -y grok-build-x-search-mcp` will receive the fixed version automatically on next run after `v0.1.1` is tagged/published. Previously installed users should update/reinstall.

## [0.1.1] - 2026-06-13

### Fixed
- Recursion guard and publish workflow improvements for the `grok_search` MCP server (see Unreleased for full details).

### Changed
- Renamed the GitHub repository from `grok-mcp` to `grok-build-plugin` for clarity (the old URL web-redirects). The Claude/Grok plugin is named `grok`; the npm package is `grok-build-x-search-mcp`.
- `.mcp.json` (and README examples) launch the server with `npx -y grok-build-x-search-mcp` (registry for speed) or `github:` fallback. `npx` is harness-neutral (works where `${CLAUDE_PLUGIN_ROOT}` doesn't, e.g. Codex). Verified in Codex, agy, Gemini.

## [0.1.0] - 2026-06-03

### Added
- Initial Claude Code / Grok plugin: `/grok:search`, `/grok:review`, `/grok:rescue`, `/grok:status`, `/grok:result`, `/grok:cancel`, `/grok:setup`.
- `grok:grok-rescue` subagent and `grok-runtime` skill.
- Companion runtime wrapping `grok -p --output-format json`, with read-only tool gating, session resume, and background-job tracking.
- Unit tests and Apache-2.0 license.
- Published the MCP server to npm as `grok-build-x-search-mcp` for instant `npx -y grok-build-x-search-mcp` in any agent (Codex, agy, Gemini, Cursor, etc.). The `github:` form remains available as a fallback. Updated all examples and docs to prefer the registry package for fastest startup.
