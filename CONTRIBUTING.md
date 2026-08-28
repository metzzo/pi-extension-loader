# Contributing

Contributions are welcome. Work from a source checkout; development tests and integration helpers are intentionally omitted from the runtime npm tarball.

## Prerequisites

- Node.js 22.19.0 or newer
- npm 10 or newer
- Pi 0.84.2 (the pinned release-test baseline)

Install the locked development dependencies:

```bash
npm ci
```

## Before submitting a change

Run the deterministic release gate:

```bash
npm run release:check
```

Changes to command dispatch, tool execution, or reload timing should also run the authenticated end-to-end test:

```bash
npm run test:e2e
```

The end-to-end test uses `openai-codex/gpt-5.6-luna` at `low` thinking, copies Pi credentials into a temporary agent directory, makes a live model request, and removes the temporary directory afterward. It can consume provider quota. Set `PI_E2E_SOURCE_AGENT_DIR` if the source Pi configuration is not under `~/.pi/agent`.

Keep changes focused, add real-behavior tests, update `CHANGELOG.md` when behavior changes, and never commit credentials or generated test artifacts.
