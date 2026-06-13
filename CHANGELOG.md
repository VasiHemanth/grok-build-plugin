# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
