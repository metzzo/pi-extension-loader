#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(join(tmpdir(), "pi-extension-reloader-package-"));
const packDirectory = join(workspace, "pack");
const consumerDirectory = join(workspace, "consumer");
// Match the SDK actually installed for this gate, including --no-save compatibility runs.
const piVersion = JSON.parse(await readFile(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
const typeboxVersion = JSON.parse(await readFile(join(root, "node_modules/typebox/package.json"), "utf8")).version;

async function run(command, arguments_, cwd) {
  try {
    return await execFileAsync(command, arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        npm_config_audit: "false",
        npm_config_dry_run: "false",
        npm_config_fund: "false",
      },
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(`${command} ${arguments_.join(" ")} failed\n${stdout}${stderr}`.trim());
  }
}

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "pi-extension-reloader-package-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );

  const packed = await run("npm", ["pack", "--json", "--pack-destination", packDirectory], root);
  const packResult = JSON.parse(packed.stdout)?.[0];
  if (!packResult?.filename) throw new Error("npm pack did not report a tarball filename");

  const expectedFiles = [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "index.ts",
    "package.json",
  ];
  const packedFiles = (packResult.files ?? []).map((file) => file.path).sort();
  if (JSON.stringify(packedFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`packed files did not match the public package contract: ${packedFiles.join(", ")}`);
  }

  const tarball = join(packDirectory, packResult.filename);
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      tarball,
      `@earendil-works/pi-coding-agent@${piVersion}`,
      `typebox@${typeboxVersion}`,
    ],
    consumerDirectory,
  );

  const packageRoot = join(consumerDirectory, "node_modules", "pi-extension-reloader");
  const piRoot = join(consumerDirectory, "node_modules", "@earendil-works", "pi-coding-agent");
  const { DefaultResourceLoader, SettingsManager } = await import(
    pathToFileURL(join(piRoot, "dist", "index.js")).href
  );

  // Drive discovery and loading through Pi's public resource loader; a missing
  // pi.extensions declaration or a load failure surfaces here.
  const agentDirectory = join(workspace, "agent");
  await mkdir(agentDirectory, { recursive: true });
  const settingsManager = SettingsManager.create(consumerDirectory, agentDirectory);
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({
    cwd: consumerDirectory,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: [packageRoot],
  });
  await resourceLoader.reload();
  const { extensions, errors } = resourceLoader.getExtensions();
  if (errors.length > 0) {
    throw new Error(
      `packed extension failed to load: ${errors.map((error) => error.error ?? error).join("; ")}`,
    );
  }
  if (extensions.length !== 1) {
    throw new Error(`Pi loaded ${extensions.length} extensions instead of one`);
  }

  const [extension] = extensions;
  if (!extension.commands.has("reload-runtime") || !extension.tools.has("reload_runtime")) {
    throw new Error("packed extension did not register reload-runtime and reload_runtime");
  }

  process.stdout.write(`Package smoke passed: ${packResult.name}@${packResult.version} on Pi ${piVersion} / TypeBox ${typeboxVersion}\n`);
} finally {
  if (process.env.PI_PACKAGE_SMOKE_KEEP !== "1") {
    await rm(workspace, { recursive: true, force: true });
  } else {
    process.stdout.write(`Package smoke workspace: ${workspace}\n`);
  }
}
