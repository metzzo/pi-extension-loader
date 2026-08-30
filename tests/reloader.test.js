import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repositoryRoot, "index.ts");

const piPackageRoot = realpathSync(
  join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
);
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(piPackageRoot, "dist", "index.js")));

async function waitFor(check, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("the package advertises its extension and bundled Pi imports as peers", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));

  assert.equal(manifest.name, "pi-extension-reloader");
  assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies?.typebox, "*");
  assert.equal(manifest.dependencies, undefined);
});

test("reload_runtime reloads changed resources through the real Pi runtime", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-extension-reloader-"));
  const temporaryExtension = join(temporaryRoot, "index.ts");
  const markerExtension = join(temporaryRoot, "marker.js");
  const continuationMarker = join(temporaryRoot, "continuation.txt");
  const reloadLifecycleMarker = join(temporaryRoot, "reload-lifecycle.txt");
  const continueWith = "Verify the reloaded runtime with reload_test_marker.";
  const continuationPrompt = [
    "Automatic continuation after Pi runtime reload.",
    "Reload reason: integration test",
    "Continue the original user request from where it stopped. Later user messages take precedence for the remaining work; the reload itself is already complete.",
    "Do not call reload_runtime again for the same edits.",
    `Remaining work: ${continueWith}`,
  ].join("\n");
  cpSync(extensionPath, temporaryExtension);
  writeFileSync(
    markerExtension,
    `export default function (pi) {
  pi.registerCommand("reload-runtime", { handler: async () => {} });
}
`,
    "utf8",
  );

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: repositoryRoot,
    agentDir: join(temporaryRoot, "agent"),
    settingsManager,
    additionalExtensionPaths: [temporaryExtension, markerExtension],
  });

  let session;
  try {
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: repositoryRoot,
      agentDir: join(temporaryRoot, "agent"),
      resourceLoader,
      sessionManager: SessionManager.inMemory(repositoryRoot),
      settingsManager,
      noTools: "builtin",
    });
    session = result.session;
    assert.deepEqual(result.extensionsResult.errors, []);

    const extensionErrors = [];
    await session.bindExtensions({
      mode: "print",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async () => ({ cancelled: false }),
        fork: async () => ({ cancelled: false }),
        navigateTree: async () => ({ cancelled: false }),
        switchSession: async () => ({ cancelled: false }),
        reload: () => session.reload(),
      },
      onError: (error) => extensionErrors.push(error),
    });

    const reloadTool = session.agent.state.tools.find((tool) => tool.name === "reload_runtime");
    assert.ok(reloadTool, "reload_runtime should be active");

    assert.match(
      reloadTool.description,
      /Examples: use after editing an extension before calling its changed tool/,
    );
    assert.deepEqual(reloadTool.parameters.required, ["reason", "continueWith"]);
    await assert.rejects(
      reloadTool.execute("invalid-reload", { reason: " ", continueWith: "\n" }),
      /non-whitespace text/,
    );

    writeFileSync(
      markerExtension,
      `import { appendFileSync } from "node:fs";
export default function (pi) {
  let sessionStartComplete = false;
  let resourcesDiscoverComplete = false;
  pi.registerTool({
    name: "reload_test_marker",
    label: "Reload Test Marker",
    description: "Proves that the changed extension was loaded",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "loaded" }], details: {} };
    },
  });
  pi.on("session_start", async (event) => {
    if (event.reason !== "reload") return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    sessionStartComplete = true;
    appendFileSync(${JSON.stringify(reloadLifecycleMarker)}, "reload\\n", "utf8");
  });
  pi.on("resources_discover", async (event) => {
    if (event.reason !== "reload") return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    resourcesDiscoverComplete = true;
  });
  pi.on("input", (event) => {
    if (event.text !== ${JSON.stringify(continuationPrompt)}) return { action: "continue" };
    const text = sessionStartComplete && resourcesDiscoverComplete ? event.text : "continued too early";
    appendFileSync(${JSON.stringify(continuationMarker)}, text + "\\n", "utf8");
    return { action: "handled" };
  });
}
`,
      "utf8",
    );

    const toolResult = await reloadTool.execute("reload-test", {
      reason: "integration test",
      continueWith,
    });
    assert.equal(toolResult.details.command, "/reload-runtime");
    assert.equal(toolResult.details.reason, "integration test");
    assert.equal(toolResult.details.continueWith, continueWith);
    assert.match(toolResult.content[0].text, /reload/i);
    assert.match(toolResult.content[0].text, /continue/i);
    assert.equal(toolResult.terminate, true);

    const pendingEntries = session.sessionManager.getBranch().filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-extension-reloader.pending-continuation",
    );
    assert.equal(pendingEntries.length, 1, "the continuation must persist before settlement");
    assert.deepEqual(pendingEntries[0].data, { reason: "integration test", continueWith });

    const duplicateResult = await reloadTool.execute("duplicate-reload", {
      reason: "later duplicate",
      continueWith: "Do something else.",
    });
    assert.equal(duplicateResult.details.reason, "integration test");
    assert.equal(duplicateResult.details.continueWith, continueWith);
    assert.equal(
      session.sessionManager.getBranch().filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-extension-reloader.pending-continuation",
      ).length,
      1,
      "duplicate tool calls must share the first persisted continuation",
    );

    assert.equal(
      session.agent.state.tools.some((tool) => tool.name === "reload_test_marker"),
      false,
      "the tool must finish before reload invalidates its extension context",
    );

    await session.extensionRunner.emit({ type: "agent_settled" });
    await waitFor(
      () => session.agent.state.tools.some((tool) => tool.name === "reload_test_marker"),
      "the changed marker extension to become active despite a public command-name collision",
    );
    await waitFor(
      () =>
        existsSync(reloadLifecycleMarker) &&
        readFileSync(reloadLifecycleMarker, "utf8") === "reload\n",
      "the first reload lifecycle",
    );
    await waitFor(
      () =>
        existsSync(continuationMarker) &&
        readFileSync(continuationMarker, "utf8") === `${continuationPrompt}\n`,
      "the post-reload continuation to run",
    );

    await Promise.all([
      session.prompt("/reload-runtime", { expandPromptTemplates: true }),
      session.prompt("/reload-runtime", { expandPromptTemplates: true }),
    ]);
    await waitFor(
      () => readFileSync(reloadLifecycleMarker, "utf8") === "reload\nreload\n",
      "concurrent manual commands to coalesce into one reload",
    );

    await session.reload();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(
      readFileSync(reloadLifecycleMarker, "utf8"),
      "reload\nreload\nreload\n",
      "the direct reload should still complete",
    );
    assert.equal(
      readFileSync(continuationMarker, "utf8"),
      `${continuationPrompt}\n`,
      "a later reload must not replay an already dispatched continuation",
    );
    assert.equal(
      session.sessionManager.getBranch().filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-extension-reloader.dispatched-continuation",
      ).length,
      1,
    );
    assert.deepEqual(extensionErrors, []);
  } finally {
    session?.dispose();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
