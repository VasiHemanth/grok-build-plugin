# Contributing

Thanks for your interest in improving grok-mcp! This is a community project.

## Ground rules

- Be respectful (see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)).
- This project is **unofficial** and not affiliated with xAI, Anthropic, OpenAI, or Google. Don't add code or copy that implies otherwise.
- Keep the runtime dependency-free where reasonable. The whole point is a thin, auditable wrapper around the local `grok` CLI.

## Development setup

```bash
git clone https://github.com/VasiHemanth/grok-mcp.git
cd grok-mcp
npm test        # runs the unit + MCP smoke tests (no Grok account required)
```

To exercise the live path you need the Grok Build CLI installed (`grok --version`) and signed in (`grok login`).

## Project layout

- `plugins/grok/scripts/lib/` — shared runtime (`grok.mjs` wraps `grok -p`)
- `plugins/grok/scripts/grok-companion.mjs` — CLI behind the slash commands
- `plugins/grok/scripts/grok-mcp.mjs` — MCP server exposing `grok_search`
- `plugins/grok/commands/`, `agents/`, `skills/` — Claude Code / Grok plugin components
- `tests/` — `node --test` suites

## Making changes

1. Open an issue describing the change first for anything non-trivial.
2. Create a branch, make your change, and add/adjust tests.
3. Run `npm test` and make sure it passes.
4. Keep commits focused; write a clear PR description.

## Tests

Unit tests must not require a Grok account or network access. Anything that calls the live `grok` CLI belongs behind a manual/integration path, not the default `npm test`.
