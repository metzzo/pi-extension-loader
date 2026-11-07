import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
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
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(piPackageRoot, "dist", "index.js")));
// Use this SDK's existing provider test kit, whether npm nested or hoisted it.
const aiEntry = createRequire(join(piPackageRoot, "package.json")).resolve.paths("@earendil-works/pi-ai")
  .map((directory) => join(directory, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
assert.ok(aiEntry, "the installed Pi SDK must provide its pi-ai dependency");
const { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(aiEntry));
const { getCurrentTools } = await import(pathToFileURL(join(dirname(aiEntry), "utils/transcript.js")));

async function waitFor(check, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

for (const control of ["idle", "notification", "stop", "missing-tool"]) {
  test(`automatically continues through the real SDK after reload: ${control}`, { timeout: 20000 }, async () => {
    const workspace = join(repositoryRoot, ".test-workspaces");
    mkdirSync(workspace, { recursive: true });
    const root = mkdtempSync(join(workspace, "automatic-continuation-"));
    const marker = join(root, "marker.ts");
    const effect = join(root, "next-action.txt");
    const busy = control === "notification" || control === "stop";
    const errors = [];
    let releaseNotification;
    let releaseDiscovery;
    const notification = new Promise((resolvePromise) => { releaseNotification = resolvePromise; });
    const discovery = new Promise((resolvePromise) => { releaseDiscovery = resolvePromise; });
    let discoveryEntered = false;
    let discoveryFinished = false;
    let notificationEntered = false;
    let continuationSeen = false;
    let reloads = 0;
    let session;
    let running;
    let passed = false;
    const provider = fauxProvider({ provider: "faux", models: [{ id: "parent", reasoning: true }] });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true });
    try {
      writeFileSync(marker, "export default function() {}\n");
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(provider.provider);
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [extensionPath, marker],
        extensionFactories: [(pi) => {
          pi.on("session_start", (event) => {
            if (event.reason !== "reload") return;
            reloads += 1;
            if (busy) pi.sendMessage({ customType: "review-notification", content: "Unrelated review finished.", display: true }, { triggerTurn: true, deliverAs: "followUp" });
          });
          pi.on("resources_discover", async (event) => {
            if (event.reason !== "reload") return;
            discoveryEntered = true;
            await discovery;
            discoveryFinished = true;
          });
        }],
      });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), resourceLoader: loader,
        modelRuntime: runtime, model: runtime.getModel("faux", "parent"), settingsManager: settings,
        sessionManager: SessionManager.create(root, join(root, "sessions")), noTools: "builtin" }));
      await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error), commandContextActions: {
        waitForIdle: () => session.waitForIdle(), reload: () => session.reload(),
        newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
      } });
      const identity = session.sessionId;
      assert.equal(session.getActiveToolNames().includes("after_reload_action"), false);
      writeFileSync(marker, control === "missing-tool" ? "throw new Error('Changed extension cannot load');\n" : `import {appendFileSync} from 'node:fs';
export default function(pi) { pi.registerTool({name:'after_reload_action', label:'After reload action', description:'New action from changed resource', parameters:{type:'object',properties:{}},
async execute(){appendFileSync(${JSON.stringify(effect)}, 'acted\\n'); return {content:[{type:'text',text:'acted'}],details:{},terminate:true};}}); }\n`);
      const next = async (context) => {
        const text = context.messages.filter((message) => message.role === "user").map((message) =>
          typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n")).join("\n");
        if (!text.includes("Automatic continuation after Pi runtime reload.")) {
          notificationEntered = true;
          await notification;
          return fauxAssistantMessage("Notification noted.");
        }
        continuationSeen = true;
        assert.equal(discoveryFinished, true, "automatic continuation waits for complete resource discovery");
        assert.equal(session.sessionId, identity, "reload retains the same parent");
        assert.match(text, /Later user messages take precedence/);
        if (control === "stop") {
          assert.match(text, /STOP: do not perform the remaining action/, "intervening user stop reaches the continuation unchanged");
          return fauxAssistantMessage("Stopped as requested.");
        }
        const advertised = getCurrentTools(context.messages).some((tool) => tool.name === "after_reload_action");
        if (control === "missing-tool") {
          assert.equal(advertised, false, "failed resource loading is not represented as a callable fresh tool");
          return fauxAssistantMessage("Expected action unavailable; do not reload or act blindly.");
        }
        assert.equal(advertised, true, "the actual resumed request sees the new tool, not stale bindings");
        return fauxAssistantMessage(fauxToolCall("after_reload_action", {}), { stopReason: "toolUse" });
      };
      const request = { reason: "Changed marker extension", continueWith: "Invoke after_reload_action once if still authorized and available." };
      provider.setResponses([fauxAssistantMessage(fauxToolCall("reload_runtime", request), { stopReason: "toolUse" }), next, next, next]);
      running = session.prompt("Reload the changed runtime and perform the remaining action.");
      await waitFor(() => discoveryEntered && (!busy || notificationEntered), "the real delayed reload and optional concurrent notification");
      assert.equal(continuationSeen, false, "no premature continuation while discovery is held");
      if (control === "stop") await session.steer("STOP: do not perform the remaining action.");
      releaseDiscovery();
      if (busy) {
        await waitFor(() => errors.length > 0 || session.getFollowUpMessages().length > 0, "continuation admission while the notification turn is active");
        assert.deepEqual(errors, [], "busy continuation must be queued rather than silently dropped after dispatch");
        assert.equal(session.getFollowUpMessages().length, 1);
      }
      releaseNotification();
      await running;
      await waitFor(() => continuationSeen && session.isIdle, "the actual automatic post-reload request without another human prompt");
      assert.deepEqual(errors, []);
      assert.equal(reloads, 1);
      assert.equal(session.messages.filter((message) => message.role === "user").length, control === "stop" ? 3 : 2);
      assert.equal(existsSync(effect), control !== "stop" && control !== "missing-tool");
      if (existsSync(effect)) assert.equal(readFileSync(effect, "utf8"), "acted\n", "the next action runs exactly once");
      assert.equal(loader.getExtensions().errors.length, control === "missing-tool" ? 1 : 0);
      const count = (kind) => session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === `pi-extension-reloader.${kind}-continuation`).length;
      assert.equal(count("pending"), 1); assert.equal(count("dispatched"), 1);
      await assert.rejects(session.agent.state.tools.find((tool) => tool.name === "reload_runtime").execute("duplicate", request), /same edits/);
      assert.equal(reloads, 1, "an exact repeat cannot reload or replay the action");
      passed = true;
    } finally {
      releaseDiscovery(); releaseNotification();
      await session?.abort(); await running?.catch(() => undefined); await session?.waitForIdle(); session?.dispose();
      await settings.flush();
      if (passed) rmSync(root, { recursive: true, force: true });
    }
  });
}

test("without a UI the initial prompt resolves only after every continuation, including a nested reload, is persisted", { timeout: 20000 }, async () => {
  const workspace = join(repositoryRoot, ".test-workspaces");
  mkdirSync(workspace, { recursive: true });
  const root = mkdtempSync(join(workspace, "headless-continuation-"));
  const errors = [];
  let session;
  let passed = false;
  const provider = fauxProvider({ provider: "faux", models: [{ id: "parent", reasoning: true }] });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true });
  try {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider.provider);
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [extensionPath],
      extensionFactories: [(pi) => {
        // A turn_end handler makes Pi report turns whose assistant message was not persisted.
        pi.on("turn_end", () => {});
        // High-priority mail arriving during reload starts its own turn.
        pi.on("session_start", (event) => {
          if (event.reason === "reload") pi.sendMessage({ customType: "mail", content: "High priority mail.", display: true }, { triggerTurn: true, deliverAs: "steer" });
        });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), resourceLoader: loader,
      modelRuntime: runtime, model: runtime.getModel("faux", "parent"), settingsManager: settings,
      sessionManager: SessionManager.create(root, join(root, "sessions")), noTools: "builtin" }));
    // No uiContext: the same headless binding print mode uses before it disposes the session.
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error), commandContextActions: {
      waitForIdle: () => session.waitForIdle(), reload: () => session.reload(),
      newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
    } });
    const textOf = (message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
    // Answer the latest prompt: mail is acknowledged, each continuation advances one step.
    const respond = (context) => {
      const latest = textOf(context.messages.filter((message) => message.role === "user" || message.role === "custom").at(-1));
      if (latest.includes("Report second reload done.")) return fauxAssistantMessage("Final continuation reply.");
      if (latest.includes("Invoke the second reload.")) {
        return fauxAssistantMessage(fauxToolCall("reload_runtime", { reason: "Second change", continueWith: "Report second reload done." }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Mail noted.");
    };
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("reload_runtime", { reason: "First change", continueWith: "Invoke the second reload." }), { stopReason: "toolUse" }),
      ...Array(8).fill(respond),
    ]);
    await session.prompt("Reload twice and finish.");
    const persisted = new Set(session.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message));
    const replies = session.messages.filter((message) => message.role === "assistant");
    assert.deepEqual(errors, [], "no turn may run on a session that stopped persisting");
    assert.deepEqual(replies.filter((message) => !persisted.has(message)), [], "every assistant reply is persisted before the prompt resolves");
    const finalText = replies.at(-1)?.content.map((part) => part.text ?? "").join("");
    assert.equal(finalText, "Final continuation reply.", "the prompt resolves only after the nested continuation finished");
    const count = (kind) => session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === `pi-extension-reloader.${kind}-continuation`).length;
    assert.equal(count("dispatched"), 2);
    passed = true;
  } finally {
    await session?.abort(); await session?.waitForIdle(); session?.dispose();
    await settings.flush();
    if (passed) rmSync(root, { recursive: true, force: true });
  }
});

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
  // TypeScript goes through Pi's reloadable loader. A .js file below this
  // type:module checkout is native-imported and retains Node's ESM cache.
  const markerExtension = join(temporaryRoot, "marker.ts");
  const continuationMarker = join(temporaryRoot, "continuation.txt");
  const reloadLifecycleMarker = join(temporaryRoot, "reload-lifecycle.txt");
  const continueWith = "Verify the reloaded runtime with reload_test_marker.";
  const continuationPrompt = [
    "Automatic continuation after Pi runtime reload.",
    "Reload reason (model-supplied):",
    '"""',
    "integration test",
    '"""',
    "Continue the original user request from where it stopped. Later user messages take precedence for the remaining work; the reload itself is already complete.",
    "Do not call reload_runtime again for the same edits.",
    "Remaining work (model-supplied):",
    '"""',
    continueWith,
    '"""',
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
    assert.deepEqual(result.extensionsResult.extensions.map((extension) => extension.path).sort(), [temporaryExtension, markerExtension].sort(), "the collision fixture must load both exact extension files");

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
    assert.match(
      duplicateResult.content[0].text,
      /duplicate call was ignored/,
      "a coalesced duplicate must be told it was ignored",
    );
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
      () => session.agent.state.tools.some((tool) => tool.name === "reload_test_marker") || extensionErrors.length > 0,
      "the changed marker extension to become active despite a public command-name collision",
    );
    assert.deepEqual(extensionErrors, [], JSON.stringify({ loadErrors: resourceLoader.getExtensions().errors, tools: session.getActiveToolNames() }));
    assert.ok(session.agent.state.tools.some((tool) => tool.name === "reload_test_marker"));
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
    const dispatchedEntries = session.sessionManager.getBranch().filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-extension-reloader.dispatched-continuation",
    );
    assert.equal(dispatchedEntries.length, 1);
    assert.deepEqual(
      dispatchedEntries[0].data,
      { reason: "integration test", continueWith },
      "the dispatched entry carries the request for the repeat-loop guard",
    );

    const reloadedTool = session.agent.state.tools.find((tool) => tool.name === "reload_runtime");
    assert.ok(reloadedTool, "reload_runtime should be registered by the reloaded extension");
    await assert.rejects(
      reloadedTool.execute("repeat-reload", { reason: "integration test", continueWith }),
      /same edits/,
      "an exact repeat of the dispatched continuation must be rejected",
    );
    assert.equal(
      session.sessionManager.getBranch().filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-extension-reloader.pending-continuation",
      ).length,
      1,
      "a rejected repeat must not persist another pending continuation",
    );
    assert.deepEqual(extensionErrors, []);
  } finally {
    session?.dispose();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
