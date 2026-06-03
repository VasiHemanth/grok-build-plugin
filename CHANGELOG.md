# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `grok_search` **MCP server** (`plugins/grok/scripts/grok-mcp.mjs`) exposing Grok's live X/web search to any MCP-capable agent (Claude Code, Codex, Cursor). Auto-wired for the plugin via `.mcp.json`.
- npm packaging (`bin` + `files`) so the server runs via `npx -y grok-x-search-mcp`. Published name is `grok-x-search-mcp` (the repo/plugin stay `grok-mcp`; `grok-mcp` was taken on npm).
- Open-source scaffolding: `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, CI workflow.

### Changed
- `.mcp.json` now launches the server with `npx -y grok-x-search-mcp` instead of `node ${CLAUDE_PLUGIN_ROOT}/...`. `${CLAUDE_PLUGIN_ROOT}` is Claude/Grok-only and breaks under Codex; `npx` is harness-neutral. **Requires the npm package to be published.**

## [0.1.0] - 2026-06-03

### Added
- Initial Claude Code / Grok plugin: `/grok:search`, `/grok:review`, `/grok:rescue`, `/grok:status`, `/grok:result`, `/grok:cancel`, `/grok:setup`.
- `grok:grok-rescue` subagent and `grok-runtime` skill.
- Companion runtime wrapping `grok -p --output-format json`, with read-only tool gating, session resume, and background-job tracking.
- Unit tests and Apache-2.0 license.
