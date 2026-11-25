# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

### Added

- Single-use links authenticate the browser tab. Restarting preserves access in that tab. Reopening from the launcher revokes previous access. The conversation records tab openings, code use and reuse alerts.
- Push and PR approval cards identify known secrets in outgoing commits and PR text, including text files with image extensions. Cards show each applied exception and its reason. Projects can add detection rules and enable a pre-push hook in Settings.
- Publication checks use the destination refs and the remote default branch to identify outgoing commits. Private remotes can use system and user Git credentials. The pre-push hook also checks the default branch when publishing a new ref.
- For a tag push, Bridge compares up to 4,096 remote refs and scans the outgoing commits. A remote with 300 tags remains within that limit. At 4,097 refs, Bridge scans the full outgoing history and reports this on the approval card.

- Tasks in orchestrator mode show an editable size estimate. Large tasks require an approved specification before coding. Coordinators can collect decisions in a question card, and the user can select a successor when a coordinator leaves or becomes unavailable.
- Manual pauses retain incoming replies. Stopping all agents discards cancelled work. Provider control requests report timeouts, and a quiet turn remains open for the user to inspect.
- Read-only roles now route shell requests through the approval policy even in bypass mode. External writes require approval, and the Reviewer excludes additional credential filenames.
- Worker reports can include a summary card in the chat. By default only the summary is relayed to the orchestrator, with any Reviewer verdict and review-round guidance. Other recipients receive the full report. Toggle this in **Settings > General**.
- Change the provider of an idle agent from its details. The agent keeps its name, mentions, history and worktree. The new provider gets a handoff summary, and incoming work waits for it to start.
- Use **Customize** on a role recommendation or missing-role card to choose the agent’s name, provider, model and options before adding it.
- **Settings > General > Automatically approve read-only commands** covers supported workspace reads. PowerShell support includes recursive listings and literal values for `Get-ChildItem -Depth`, `-Filter` and `-Include`.
- **Allow for session** remembers approved, supported test commands for the same agent, directory and conversation. For Claude Code, this includes PowerShell test pipelines that start with a directory change inside the workspace and use filters such as `Select-String` and `Select -First`. Patterns with special characters must be single-quoted.
- Rename an agent from its details while it works. Mentions keep their agent ID, and saved history shows the current name.
- Tests: end-to-end conversation tests with a scripted provider (no CLIs or tokens needed) and unit tests; CI on Windows and Linux.
- Tooling: ESLint (typescript-eslint), Prettier, EditorConfig, type checking, npm scripts (`check`, `lint`, `typecheck`, `test`, `format`).
- Light theme (follows the system setting) and a responsive layout for phones and tablets.
- `docs/architecture.md`.
- Inline `@mentions` use the referenced agent’s colour. Each agent keeps the same colour across the workspace, chat and history, even when agents share a provider or model.
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

- Overlapping specifications and questions open in order. If the Architect returns a missing or invalid specification, the Bridge asks for one correction. If the correction also fails, **Retry specification** reopens the same task, including after restoring the conversation.
- Other agents can start while a Coder waits for specification approval. The coordinator receives skipped-recipient notices with its next delivery. It gets an immediate notice when nobody received the delegation.
- Git approval checks allow ordinary branch switches and require confirmation for pushes, file restoration and forced branch changes, including `git switch -f` and `git switch --discard-changes`.
- Task growth checks run asynchronously and only for small tasks.
- Codex and OpenCode preserve the saved session after a control request times out. A confirmed missing session starts a replacement.
- Roles with a missing or invalid `canEdit` setting default to read-only and report a warning.
- **Stop all**, **Quit** and **Bypass** report failed requests in the chat and keep the controls consistent with the server.
- Agent messages render markdown tables, lists, headings, quotes and rules. Inline code is read before bold, italics and table pipes, so mixed formatting no longer breaks, and inline code (such as `darkMode: true`) no longer splits across lines.
- **Resume** delivers replies held at the token or hand-off limit in order, as the current limits allow. **Stop all** and a new user message clear the queue.
- New worktrees use the full conversation ID and the agent ID to keep agents isolated. Restoring a conversation reuses its saved worktree path and branch.
- Simultaneous Codex approval requests and requests after a restart have distinct IDs.
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
