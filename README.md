# Pi Extension Reloader

A [Pi](https://github.com/earendil-works/pi) extension that reloads extensions, skills, prompt templates, themes, and context files without restarting the current session.

It provides two entry points:

| Entry point | Intended caller | Behavior |
| --- | --- | --- |
| `/reload-runtime` | User | Runs Pi's native runtime reload once the active run is idle. |
| `reload_runtime` | Agent | Reloads after the active agent run settles, then automatically resumes the remaining work. |

## Requirements

- Pi with the public reload API; tested on 0.87.1, with no upper version bound
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
pi install git:github.com/metzzo/pi-extension-loader@v0.2.0
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

The agent can call `reload_runtime` after editing a Pi extension, skill, prompt template, theme, or context file. It supplies:

- `reason`: why the runtime must reload
- `continueWith`: the exact work to perform automatically after reload

Examples:

- After changing an extension tool: `Call hello_world and report its output.`
- After editing a skill: `Use the updated review skill on src/index.ts.`
- After changing a theme or context file: `Verify that the new runtime resource is active.`

The tool persists the request before returning with `terminate: true`. When Pi emits `agent_settled`, the extension dispatches `/reload-runtime`. The reloaded extension marks the saved continuation as dispatched so later reloads do not replay it, then starts a fresh agent turn that identifies the completed reload and the remaining work.

The settlement boundary matters: reloading inside the tool's `execute()` method would invalidate the extension context before Pi finishes wrapping the tool result. Deferring the command lets the tool and any sibling work finish before Pi replaces the runtime. After `ctx.reload()` completes, the old command frame invokes a callback installed by the fresh extension instance, so `session_start` and `resources_discover` finish before the continuation begins. The automatic continuation then prevents multi-step requests such as “edit, reload, and use the changed tool” from stopping after reload.

Pi 0.84.2 does not expose a separate hook after every extension's `agent_settled` handler has finished. A later extension with a long-running `agent_settled` handler can therefore overlap the reload dispatched by this extension. Pi 0.84.2 also does not provide acknowledged continuation delivery. If the process exits or prompt preflight fails just after dispatch begins, the saved continuation remains marked as dispatched and is not replayed automatically.

Pi collects extension load errors instead of failing the reload, so the continuation can start even though an edited extension was skipped; check Pi's extension error output when expected tools or commands are missing. If this extension itself fails to load after an edit, no continuation is dispatched, and a failed reload in the TUI is reported by Pi without reaching this extension; in both cases the persisted continuation resumes on the next `/reload-runtime`. The automatic continuation is designed for persistent sessions (TUI, RPC); single-shot print or JSON runs may exit before it completes.

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
- a packaged-consumer smoke test against Pi 0.87.1
- an offline Pi loading smoke test
- a production-dependency security audit

Run the authenticated end-to-end test separately:

```bash
npm run test:e2e
```

It runs the real plugin through Pi RPC using `openai-codex/gpt-5.6-luna` at `low` thinking. It verifies the model calls `reload_runtime`, the command dispatches, a changed extension receives `session_start` with reason `reload`, and the automatically resumed agent calls a tool that exists only after reload.

The test copies `auth.json` and `models-store.json` from `~/.pi/agent` into a temporary agent directory, submits one RPC prompt that makes multiple live model calls, and removes the directory afterward. Override the source with `PI_E2E_SOURCE_AGENT_DIR` or the executable with `PI_EXECUTABLE`. Raw RPC and stderr evidence is written under `.test-workspaces/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [RELEASING.md](RELEASING.md) for the maintainer checklist.

## License

[MIT](LICENSE) © 2026 Robert Fischer
