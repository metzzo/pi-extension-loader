# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Fence the model-authored `reason` and `continueWith` fields inside the automatic continuation prompt.
- Report a duplicate `reload_runtime` call in the same run as explicitly ignored instead of letting it look accepted.

### Fixed

- Reject a `reload_runtime` call that exactly repeats the last dispatched continuation, structurally preventing same-edits reload loops.

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
