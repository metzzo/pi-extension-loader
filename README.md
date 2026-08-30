# Pi Extension Reloader

A [Pi](https://github.com/earendil-works/pi) extension that reloads extensions, skills, prompt templates, themes, and context files without restarting the current session.

It provides two entry points:

| Entry point | Intended caller | Behavior |
| --- | --- | --- |
| `/reload-runtime` | User | Runs Pi's native runtime reload immediately. |
| `reload_runtime` | Agent | Requests one reload after the active agent run settles. |

## Requirements

- Pi 0.84.2 (the pinned release-test baseline)
- Node.js 22.19.0 or newer

The package keeps Pi and TypeBox as `"*"` peer dependencies, as Pi's package documentation requires for bundled extension APIs. Development and packaged-consumer tests pin Pi and TypeBox to the versions used for this release so the release gate does not float with those peers.

## Installation

Install the npm release for the current user:

```bash
pi install npm:pi-extension-reloader
```

Update or remove it with Pi's package manager:

```bash
pi update npm:pi-extension-reloader
pi remove npm:pi-extension-reloader
```

Install the matching Git tag instead:

```bash
pi install git:github.com/metzzo/pi-extension-loader@v0.1.1
```

For local development, install this checkout by absolute path:

```bash
pi install /absolute/path/to/pi-extension-reloader
```

If Pi was already open during installation, run `/reload` once. New sessions discover the package automatically.

Pi extensions execute with the user's full permissions. Review the source and [security policy](SECURITY.md) before installing.

## Usage

Run a reload directly:

```text
/reload-runtime
```

The agent can call `reload_runtime` after editing a Pi extension, skill, prompt template, theme, or context file. The tool records the request and returns with `terminate: true`. When Pi emits `agent_settled`, the extension dispatches `/reload-runtime` with command expansion enabled.

The settlement boundary matters: reloading inside the tool's `execute()` method would invalidate the extension context before Pi finishes wrapping the tool result. Deferring the command lets the tool and any sibling work finish before Pi replaces the runtime.

## Development

Development tests and helpers are intentionally omitted from the npm tarball. Clone the source repository before running these commands.

Install the locked toolchain and run the deterministic release gate:

```bash
npm ci
npm run release:check
```

The gate performs:

- strict TypeScript checking
- real Pi runtime tests for command and tool registration
- a packaged-consumer smoke test against Pi 0.84.2
- an offline Pi loading smoke test
- a production-dependency security audit

Run the authenticated end-to-end test separately:

```bash
npm run test:e2e
```

It runs the real plugin through Pi RPC using `openai-codex/gpt-5.6-luna` at `low` thinking. It verifies the model calls `reload_runtime`, the command dispatches, and a changed extension receives `session_start` with reason `reload`.

The test copies `auth.json` and `models-store.json` from `~/.pi/agent` into a temporary agent directory, makes one live model request, and removes the directory afterward. Override the source with `PI_E2E_SOURCE_AGENT_DIR` or the executable with `PI_EXECUTABLE`. Raw RPC and stderr evidence is written under `.test-workspaces/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [RELEASING.md](RELEASING.md) for the maintainer checklist.

## License

[MIT](LICENSE) © 2026 Robert Fischer
