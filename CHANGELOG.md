# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Tests: end-to-end conversation tests with a scripted provider (no CLIs or tokens needed) and unit tests; CI on Windows and Linux.
- Tooling: ESLint (typescript-eslint), Prettier, EditorConfig, type checking, npm scripts (`check`, `lint`, `typecheck`, `test`, `format`).
- Light theme (follows the system setting) and a responsive layout for phones and tablets.
- `docs/architecture.md`.

### Changed

- Source split into layers (`core`, `providers`, `server`, `config`, `cli`, `workspace`) and converted to strict TypeScript, run directly by Node 22.18+.
- Page split into ES modules; CSS reorganised into cascade layers with design tokens and components.
- Single entry point `bin/agent-bridge.mjs` for the launchers and `npm start`.
- Personal settings are saved to `config.local.json`, which git ignores.

## [0.1.0]

### Added

- Teams of agents from Claude Code, Codex and OpenCode, with roles, models, effort and bypass per agent.
- Routing modes (orchestrator + mentions by default), batched results, review rounds, missing-role prompt and final approval.
- Approvals panel, bypass rules, approval timeout, token counting and limits.
- Settings, account status per provider, conversation restore, launcher without a console window.
