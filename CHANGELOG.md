# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-28

### Added

- Add `/reload-runtime` for manually reloading Pi extensions, skills, prompt templates, themes, and context files.
- Add the LLM-callable `reload_runtime` tool.
- Defer tool-requested reloads until `agent_settled` so the active tool can return safely.
- Add deterministic runtime tests and an authenticated Luna-low end-to-end test.

### Fixed

- Dispatch the reload request as an extension command instead of sending a literal command-shaped model prompt.

[Unreleased]: https://github.com/metzzo/pi-extension-loader/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/metzzo/pi-extension-loader/releases/tag/v0.1.1
