# Contributing

Contributions are welcome. Work from a source checkout; development tests and integration helpers are intentionally omitted from the runtime npm tarball.

## Prerequisites

- Node.js 22.19.0 or newer
- npm 10 or newer
- Pi 1.5.2 (the pinned development baseline); compatibility is also tested on 0.87.1

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

The end-to-end test uses `openai-codex/gpt-6.1-sol` at `low` thinking, symlinks Pi credentials into a temporary agent directory, makes multiple live model calls from one RPC prompt, and removes the temporary directory afterward. It can consume provider quota. Source an isolated Pi environment first: `PI_CODING_AGENT_DIR` (or `PI_E2E_SOURCE_AGENT_DIR`) is required, and `PATH` must select the matching Pi binary. See the README for installed-package smoke testing.

Keep changes focused, add real-behavior tests, update `CHANGELOG.md` when behavior changes, and never commit credentials or generated test artifacts.
