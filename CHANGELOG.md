# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

### Added

- Tests: end-to-end conversation tests with a scripted provider (no CLIs or tokens needed) and unit tests; CI on Windows and Linux.
- Tooling: ESLint (typescript-eslint), Prettier, EditorConfig, type checking, npm scripts (`check`, `lint`, `typecheck`, `test`, `format`).
- Light theme (follows the system setting) and a responsive layout for phones and tablets.
- `docs/architecture.md`.
- Inline `@mentions` of team members are highlighted in their provider colour.
- Researcher card warns when the model's context window is small for research.
- The orchestrator can recommend roles for substantial work. A card lists up to three roles with the reason and the recommended model, and nothing is added without your choice (**Settings > General > Recommend roles**).
- **Search saved history** finds messages from the whole saved conversation, including those outside the loaded history, with one result per message.
- Browser notifications for pending approvals, role decisions, milestone decisions and final review while the page is hidden or unfocused. A single tab sends each notification once.
- The Reviewer can read the filtered patch of one listed file through the Bridge's own `bridge_diff` MCP tool when the diff is over the size limit. Secret paths stay omitted. Verified with Claude Code, Codex and OpenCode.
- Agents that fail to start, are signed out, have no access or reach the usage limit stay visible with a reason and **Retry**. Delegation skips them until they are ready again.
- The orchestrator can propose a milestone plan for Git projects. An approved plan tracks progress, supports a per-project verification command and creates local commits limited to eligible changes. Commit approval defaults to **Ask me**.

### Changed

- Source split into layers (`core`, `providers`, `server`, `config`, `cli`, `workspace`) and converted to strict TypeScript, run directly by Node 22.18+.
- Page split into ES modules; CSS reorganised into cascade layers with design tokens and components.
- Final approval uses detected Git changes since the last user message. In folders without Git, a reported successful edit can trigger approval. Restored work without a comparison point can still require approval. Completing the last milestone also opens the final review.
- Agent cards show the model next to the role (for example `Orchestrator · Opus 5.5`); the tooltip shows the full model id and the effort.
- `Enter` sends the message and `Shift+Enter` adds a new line. While the `@` list is open, `Enter` picks the agent.
- Team, routing and usage appear in a resizable sidebar on wide screens and in the **Workspace** panel on narrow screens. Agent messages align left and user messages align right.
- The composer starts at one line and grows with the draft. **Send to** and **Send** sit alongside the message box on wide screens. The destination preview follows the same routing rule as sending and calls attention to routing changes and problems.
- Single entry point `bin/agent-bridge.mjs` for the launchers and `npm start`.
- Personal settings are saved to `config.local.json`, which git ignores.
- Lean roles block every skill except the ones allowed in Settings > Roles (OpenCode: the skill tool is removed); read-only limits take precedence over skill instructions.
- Researcher opens at most a few pages per question.
- The chat opens at the end of the conversation. While an agent writes, scrolling up keeps your position, and **Back to end** shows how many messages arrived. A reconnect keeps the reading position.
- **Dismiss** on a role card no longer leaves hand-offs paused, unless you paused or stopped them yourself. **Resume** and a new message close a pending role card.
- Stopping one agent closes only its part of a batch so the orchestrator can receive the other results. Task and batch events have explicit types, and Codex and OpenCode share the logic for cancelling queued tasks.

### Fixed

- The effort menu of a Codex agent stayed disabled when its models loaded before the agent was ready; it now unlocks as soon as the agent is ready.
- OpenCode agents showed the model's reasoning and OpenCode's own context summary as if they were answers; now only the answer is shown, with a notice when OpenCode summarises the context.
- OpenCode skill rules missed skills named without the plugin prefix.
- OpenCode: the final answer passed to the chat and to other agents also skips compaction summaries and synthetic text.
- Codex threads get a readable name and are archived when the conversation closes (unarchived on restore), so they leave the ChatGPT app history.
- A batch no longer waits forever when a target agent is unavailable, its delivery is dropped or its task is cancelled; a late reply to another message no longer closes the batch.
- Invalid or truncated lines in a saved conversation are skipped instead of breaking the restore.
- The access token is no longer written to `errors.log`.
- Invalid role-card actions are rejected before the conversation state changes.
- CI runs with read-only repository permissions.
- Test servers end with the test run (`--exit-with-parent`, `--max-lifetime`), so a killed run no longer leaves servers behind.

## [0.1.0]

### Added

- Teams of agents from Claude Code, Codex and OpenCode, with roles, models, effort and bypass per agent.
- Routing modes (orchestrator + mentions by default), batched results, review rounds, missing-role prompt and final approval.
- Approvals panel, bypass rules, approval timeout, token counting and limits.
- Settings, account status per provider, conversation restore, launcher without a console window.
