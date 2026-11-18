# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Tests: end-to-end conversation tests with a scripted provider (no CLIs or tokens needed) and unit tests; CI on Windows and Linux.
- Tooling: ESLint (typescript-eslint), Prettier, EditorConfig, type checking, npm scripts (`check`, `lint`, `typecheck`, `test`, `format`).
- Light theme (follows the system setting) and a responsive layout for phones and tablets.
- `docs/architecture.md`.
- `@mentions` of team members are highlighted, and lines that hand work to an agent are marked in its colour.
- Researcher card warns when the model's context window is small for research.

### Changed

- Source split into layers (`core`, `providers`, `server`, `config`, `cli`, `workspace`) and converted to strict TypeScript, run directly by Node 22.18+.
- Page split into ES modules; CSS reorganised into cascade layers with design tokens and components.
- Single entry point `bin/agent-bridge.mjs` for the launchers and `npm start`.
- Personal settings are saved to `config.local.json`, which git ignores.
- Lean roles block every skill except the ones allowed in Settings > Roles (OpenCode: the skill tool is removed); read-only limits take precedence over skill instructions.
- Researcher opens at most a few pages per question.

### Fixed

- OpenCode agents showed the model's reasoning and OpenCode's own context summary as if they were answers; now only the answer is shown, with a notice when OpenCode summarises the context.
- OpenCode skill rules missed skills named without the plugin prefix.
- A line that addresses an agent by plain name ("Codex, please review...") is highlighted like an @mention.
- OpenCode: the final answer passed to the chat and to other agents also skips compaction summaries and synthetic text.
- Codex threads get a readable name and are archived when the conversation closes (unarchived on restore), so they leave the ChatGPT app history.
- Test servers end with the test run (`--exit-with-parent`, `--max-lifetime`), so a killed run no longer leaves servers behind.

## [0.1.0]

### Added

- Teams of agents from Claude Code, Codex and OpenCode, with roles, models, effort and bypass per agent.
- Routing modes (orchestrator + mentions by default), batched results, review rounds, missing-role prompt and final approval.
- Approvals panel, bypass rules, approval timeout, token counting and limits.
- Settings, account status per provider, conversation restore, launcher without a console window.
