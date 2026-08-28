import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
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

function findPiPackageRoot() {
  const configuredExecutable = process.env.PI_EXECUTABLE ?? "pi";
  const executable = configuredExecutable.includes("/")
    ? configuredExecutable
    : execFileSync("which", [configuredExecutable], { encoding: "utf8" }).trim();

  let directory = dirname(realpathSync(executable));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`Could not locate the pi-coding-agent package from ${executable}`);
}

const piPackageRoot = findPiPackageRoot();
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(piPackageRoot, "dist", "index.js")));

async function waitFor(check, description) {
  const deadline = Date.now() + 2_000;
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
  cpSync(extensionPath, temporaryExtension);
  writeFileSync(markerExtension, "export default function () {}\n", "utf8");

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

    writeFileSync(
      markerExtension,
      `export default function (pi) {
  pi.registerTool({
    name: "reload_test_marker",
    label: "Reload Test Marker",
    description: "Proves that the changed extension was loaded",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "loaded" }], details: {} };
    },
  });
}
`,
      "utf8",
    );

    const toolResult = await reloadTool.execute("reload-test", { reason: "integration test" });
    assert.equal(toolResult.details.command, "/reload-runtime");
    assert.equal(toolResult.details.reason, "integration test");
    assert.match(toolResult.content[0].text, /reload/i);
    assert.equal(toolResult.terminate, true);
    assert.equal(
      session.agent.state.tools.some((tool) => tool.name === "reload_test_marker"),
      false,
      "the tool must finish before reload invalidates its extension context",
    );

    await session.extensionRunner.emit({ type: "agent_settled" });
    await waitFor(
      () => session.agent.state.tools.some((tool) => tool.name === "reload_test_marker"),
      "the changed marker extension to become active",
    );
    assert.deepEqual(extensionErrors, []);
  } finally {
    session?.dispose();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
