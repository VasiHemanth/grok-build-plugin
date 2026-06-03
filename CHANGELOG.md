# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `grok_search` **MCP server** (`plugins/grok/scripts/grok-mcp.mjs`) exposing Grok's live X/web search to any MCP-capable agent (Claude Code, Codex, Cursor). Auto-wired for the plugin via `.mcp.json`.
- npm `bin` + `files` so the server runs via `npx`. Initially via `github:`, then published to the registry as `grok-build-x-search-mcp` for v0.1.0.
- Open-source scaffolding: `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, CI workflow.

### Changed
- `.mcp.json` (and README examples) launch the server with `npx -y grok-build-x-search-mcp` (registry for speed) or `github:` fallback. `npx` is harness-neutral (works where `${CLAUDE_PLUGIN_ROOT}` doesn't, e.g. Codex). Verified in Codex, agy, Gemini.

## [0.1.0] - 2026-06-03

### Added
- Initial Claude Code / Grok plugin: `/grok:search`, `/grok:review`, `/grok:rescue`, `/grok:status`, `/grok:result`, `/grok:cancel`, `/grok:setup`.
- `grok:grok-rescue` subagent and `grok-runtime` skill.
- Companion runtime wrapping `grok -p --output-format json`, with read-only tool gating, session resume, and background-job tracking.
- Unit tests and Apache-2.0 license.
- Published the MCP server to npm as `grok-build-x-search-mcp` for instant `npx -y grok-build-x-search-mcp` in any agent (Codex, agy, Gemini, Cursor, etc.). The `github:` form remains available as a fallback. Updated all examples and docs to prefer the registry package for fastest startup.
