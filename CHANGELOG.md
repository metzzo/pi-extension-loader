# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Pin development Pi to 1.5.2 and TypeBox to 1.3.27 while retaining support for Pi 0.87.1 and wildcard host peers. Packaged-consumer tests follow the installed development versions.
- Cover automatic continuation while a concurrent custom-message run is held in `before_agent_start`, in addition to streaming notifications.
- Run authenticated RPC tests with GPT-6.1 Sol at low thinking, explicit isolated configuration, shared symlinked credentials, manual command coverage, and optional installed-package discovery.
- Fence the model-authored `reason` and `continueWith` fields inside the automatic continuation prompt.
- Omit `CONTRIBUTING.md` and `RELEASING.md` from the published npm tarball; they remain in the source repository.
- Report a duplicate `reload_runtime` call in the same run as explicitly ignored instead of letting it look accepted.

### Fixed

- Attach RPC test waiters before prompting so timeouts reach cleanup instead of leaving a child process behind.
- Queue automatic continuation as a follow-up when another extension starts a notification turn during reload, instead of marking it dispatched and losing it to Pi's busy-session refusal. Real offline SDK tests cover delayed reload, user STOP, fresh tools, and missing tools without adding retries or dependencies.
- Verify development and packed-load tests on Pi 0.87.1 and 1.5.2 while retaining wildcard host peers without an upper version bound.
- Reject a `reload_runtime` call that exactly repeats the last dispatched continuation, structurally preventing same-edits reload loops.
- Without a UI (print or JSON mode), hold the reload command until the automatic continuation settles, including any further reload it schedules. Previously the initial prompt resolved first, the host disposed the session, and the continuation kept calling the model on a session that no longer persisted anything.

## [0.2.0] - 2026-08-30

### Changed

- Require `reload_runtime` callers to provide the exact work that should continue after reload.
- Clarify the tool description with examples of Pi runtime resources that require reloading.

### Fixed

- Automatically resume the pending task in a fresh agent turn after the runtime reloads.
- Persist continuations before settlement and mark them as dispatched so later manual reloads do not replay them.
- Wait for the complete reload lifecycle, including resource discovery, before starting the continuation.
- Label the resumed turn with the reload phase and guard against reloading the same edits again.

## [0.1.1] - 2026-08-28

### Added

- Add `/reload-runtime` for manually reloading Pi extensions, skills, prompt templates, themes, and context files.
- Add the LLM-callable `reload_runtime` tool.
- Defer tool-requested reloads until `agent_settled` so the active tool can return safely.
- Add deterministic runtime tests and an authenticated Luna-low end-to-end test.

### Fixed

- Dispatch the reload request as an extension command instead of sending a literal command-shaped model prompt.

[Unreleased]: https://github.com/metzzo/pi-extension-loader/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/metzzo/pi-extension-loader/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/metzzo/pi-extension-loader/releases/tag/v0.1.1
