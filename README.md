# Pi Extension Reloader

Reload Pi resources without restarting the session. The package adds:

- `/reload-runtime` for a manual reload
- `reload_runtime` for an agent-requested reload after it edits Pi resources

Both paths reload extensions, skills, prompt templates, themes, and context files.

## Install

From this directory:

```bash
pi install .
```

Run `/reload` once if Pi was already open when the package was installed. New sessions load it automatically.

## Use

Run the command directly:

```text
/reload-runtime
```

The agent can call `reload_runtime` after changing a Pi resource. Once the agent run settles, the extension dispatches `/reload-runtime` with command expansion enabled. Waiting for settlement prevents the reload from invalidating the tool while it is still returning its result.

## Development

```bash
npm test
npm run smoke
```

The live end-to-end test runs the real plugin through Pi RPC with `openai-codex/gpt-5.6-luna` at `low` thinking. It requires configured OpenAI Codex credentials:

```bash
npm run test:e2e
```

Its raw RPC and stderr artifacts are saved under `.test-workspaces/`.
