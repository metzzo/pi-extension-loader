import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { finished } from "node:stream/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceAgentPath = process.env.PI_E2E_SOURCE_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
if (!sourceAgentPath) throw new Error("Source an isolated Pi environment or set PI_E2E_SOURCE_AGENT_DIR");
const sourceAgentDir = resolve(sourceAgentPath);
const piExecutable = process.env.PI_EXECUTABLE ?? "pi";
const model = "openai-codex/gpt-6.1-sol";
const installedPackage = process.env.PI_E2E_INSTALLED_PACKAGE === "1";
const thinkingLevel = "low";
const timeoutMs = Number(process.env.PI_E2E_TIMEOUT_MS ?? 120_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("PI_E2E_TIMEOUT_MS must be a positive number");
}
const logDirectory = join(repositoryRoot, ".test-workspaces");
const rpcLogPath = join(logDirectory, "e2e-rpc.jsonl");
const stderrLogPath = join(logDirectory, "e2e-rpc.stderr.log");

mkdirSync(logDirectory, { recursive: true });

class RpcProcess {
  #child;
  #events = [];
  #exitPromise;
  #pending = new Map();
  #stderrLog;
  #stdoutBuffer = "";
  #stdoutLog;
  #waiters = new Set();

  constructor(agentDir, extensionPaths) {
    this.#stdoutLog = createWriteStream(rpcLogPath, { flags: "w" });
    this.#stderrLog = createWriteStream(stderrLogPath, { flags: "w" });
    this.#child = spawn(
      piExecutable,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        ...(installedPackage ? [] : ["--no-extensions"]),
        "--no-builtin-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--model",
        model,
        "--thinking",
        thinkingLevel,
        "--append-system-prompt",
        [
          "You are running an end-to-end integration test; perform the requested tool calls rather than describing them.",
          "Use the reload reason: Runtime reload end-to-end test.",
          "Set continueWith to exactly: After reload, call post_reload_check exactly once and report its output verbatim.",
        ].join(" "),
        ...extensionPaths.flatMap((path) => ["--extension", path]),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => {
      this.#stdoutLog.write(chunk);
      try {
        this.#consumeStdout(chunk);
      } catch (error) {
        const parseError = error instanceof Error ? error : new Error(String(error));
        for (const pending of this.#pending.values()) pending.reject(parseError);
        this.#pending.clear();
        for (const waiter of this.#waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(parseError);
        }
        this.#waiters.clear();
        this.#child.kill("SIGTERM");
      }
    });
    this.#child.stderr.on("data", (chunk) => this.#stderrLog.write(chunk));

    this.#exitPromise = new Promise((resolvePromise, reject) => {
      this.#child.on("error", reject);
      this.#child.on("exit", (code, signal) => {
        this.#stdoutLog.end();
        this.#stderrLog.end();
        const error = new Error(`Pi RPC exited (code=${code}, signal=${signal})`);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        for (const waiter of this.#waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.#waiters.clear();
        resolvePromise({ code, signal });
      });
    });
  }

  #consumeStdout(chunk) {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      let line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;

      const event = JSON.parse(line);
      this.#events.push(event);
      if (event.type === "response" && event.id && this.#pending.has(event.id)) {
        const pending = this.#pending.get(event.id);
        this.#pending.delete(event.id);
        pending.resolve(event);
      }
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }

  send(command) {
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(command.id, { resolve: resolvePromise, reject });
      this.#child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(command.id);
        reject(error);
      });
    });
  }

  waitFor(predicate, description) {
    const existing = this.#events.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${description}; RPC log: ${rpcLogPath}`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  waitForCount(predicate, count, description) {
    return this.waitFor(
      () => this.#events.filter(predicate).length >= count,
      description,
    );
  }

  get events() {
    return [...this.#events];
  }

  async close() {
    this.#child.stdin.end();
    let exitResult = await Promise.race([
      this.#exitPromise,
      new Promise((resolvePromise) =>
        setTimeout(() => resolvePromise(undefined), 5_000),
      ),
    ]);
    if (!exitResult) {
      this.#child.kill("SIGTERM");
      exitResult = await Promise.race([
        this.#exitPromise,
        new Promise((resolvePromise) =>
          setTimeout(() => resolvePromise(undefined), 5_000),
        ),
      ]);
    }
    if (!exitResult) {
      this.#child.kill("SIGKILL");
      exitResult = await this.#exitPromise;
    }
    await Promise.all([finished(this.#stdoutLog), finished(this.#stderrLog)]);

    assert.equal(this.#stdoutBuffer, "", "Pi RPC ended with an unterminated JSONL record");
    assert.deepEqual(exitResult, { code: 0, signal: null });
  }
}

async function send(rpc, command) {
  const response = await rpc.send(command);
  assert.equal(response.success, true, response.error);
  return response;
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-extension-reloader-e2e-"));
const agentDir = join(temporaryRoot, "agent");
const extensionPath = join(temporaryRoot, "index.ts");
const markerExtensionPath = join(temporaryRoot, "marker.js");
const reloadMarkerPath = join(temporaryRoot, "reload-complete.txt");
const continuationMarkerPath = join(temporaryRoot, "continuation-complete.txt");
const continueWith =
  "After reload, call post_reload_check exactly once and report its output verbatim.";
mkdirSync(agentDir, { recursive: true });
for (const name of ["auth.json", "models-store.json"]) {
  const source = join(sourceAgentDir, name);
  if (!existsSync(source)) continue;
  // Share OAuth locking/refresh with the source; copying can invalidate other sessions.
  if (name === "auth.json") symlinkSync(source, join(agentDir, name));
  else cpSync(source, join(agentDir, name));
}
if (installedPackage) {
  const settings = JSON.parse(readFileSync(join(sourceAgentDir, "settings.json"), "utf8"));
  assert.ok(settings.packages?.some((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return source && resolve(sourceAgentDir, source) === repositoryRoot;
  }), "pi install this worktree into the sourced agent directory before installed-package smoke");
  // Only this installed package; relative source paths would break in the temporary dir.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [repositoryRoot], projectTrusted: true }));
}
cpSync(join(repositoryRoot, "index.ts"), extensionPath);
writeFileSync(markerExtensionPath, "export default function () {}\n", "utf8");

const rpc = new RpcProcess(agentDir, installedPackage ? [markerExtensionPath] : [extensionPath, markerExtensionPath]);
let primaryError;
try {
  const initialState = await send(rpc, { id: "initial-state", type: "get_state" });
  assert.equal(initialState.data.model.provider, "openai-codex");
  assert.equal(initialState.data.model.id, "gpt-6.1-sol");
  assert.equal(initialState.data.thinkingLevel, thinkingLevel);

  const commands = await send(rpc, { id: "commands", type: "get_commands" });
  assert.ok(commands.data.commands.some((command) => command.name === "reload-runtime"));
  await send(rpc, { id: "manual-reload", type: "prompt", message: "/reload-runtime" });

  writeFileSync(
    markerExtensionPath,
    `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", (event) => {
    if (event.reason === "reload") {
      appendFileSync(${JSON.stringify(reloadMarkerPath)}, "reloaded\\n", "utf8");
    }
  });
  pi.registerTool({
    name: "post_reload_check",
    label: "Post-reload Check",
    description: "Confirm that the changed extension is active after runtime reload",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      appendFileSync(${JSON.stringify(continuationMarkerPath)}, "continued\\n", "utf8");
      return { content: [{ type: "text", text: "POST_RELOAD_CHECK_OK" }], details: {} };
    },
  });
}
`,
    "utf8",
  );

  // Attach every rejection handler before starting the run, so a timeout still
  // reaches finally and closes the real RPC child instead of orphaning it.
  const [toolEvent, postReloadToolEvent] = await Promise.all([
    rpc.waitFor(
      (event) => event.type === "tool_execution_end" && event.toolName === "reload_runtime",
      "the model to finish reload_runtime",
    ),
    rpc.waitFor(
      (event) => event.type === "tool_execution_end" && event.toolName === "post_reload_check",
      "the model to run post_reload_check after reload",
    ),
    rpc.waitForCount((event) => event.type === "agent_settled", 2, "both agent runs to settle"),
    send(rpc, {
      id: "model-reload",
      type: "prompt",
      message:
        "Reload the edited extension, then call the newly available post_reload_check tool and report its output verbatim.",
    }),
  ]);
  assert.equal(toolEvent.isError, false);
  const reloadCall = rpc.events.find((event) => event.type === "tool_execution_start" && event.toolName === "reload_runtime");
  assert.equal(toolEvent.result.details.reason, reloadCall.args.reason.trim(), "the tool trims surrounding whitespace from the model's reload reason");
  assert.equal(toolEvent.result.details.continueWith, continueWith);
  assert.equal(toolEvent.result.terminate, true);
  assert.equal(postReloadToolEvent.isError, false);
  assert.equal(postReloadToolEvent.result.content[0].text, "POST_RELOAD_CHECK_OK");

  const toolEvents = rpc.events.filter((event) => event.type === "tool_execution_end");
  assert.equal(
    toolEvents.filter((event) => event.toolName === "reload_runtime").length,
    1,
    "reload_runtime must run exactly once",
  );
  assert.equal(
    toolEvents.filter((event) => event.toolName === "post_reload_check").length,
    1,
    "post_reload_check must run exactly once",
  );
  assert.equal(
    rpc.events.filter((event) => event.type === "agent_settled").length,
    2,
    "the initial and automatically continued agent runs must each settle once",
  );
  assert.equal(readFileSync(reloadMarkerPath, "utf8"), "reloaded\n");
  assert.equal(readFileSync(continuationMarkerPath, "utf8"), "continued\n");

  const finalAnswer = await send(rpc, { id: "final-answer", type: "get_last_assistant_text" });
  assert.match(finalAnswer.data.text, /POST_RELOAD_CHECK_OK/);

  assert.deepEqual(
    rpc.events.filter((event) => event.type === "extension_error"),
    [],
  );

  console.log(
    `Validated ${installedPackage ? "installed package" : "explicit extension"}: /reload-runtime; ${model}:${thinkingLevel} -> reload_runtime -> reload -> automatic continuation -> post_reload_check`,
  );
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await rpc.close();
  } catch (closeError) {
    if (!primaryError) throw closeError;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
