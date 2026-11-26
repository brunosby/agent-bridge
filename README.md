# Agent Bridge

A team of AI coding agents from different providers (Claude Code, Codex, OpenCode) working on one task, in a local web page where you watch the conversation live and step in at any time.

You talk to an orchestrator. It hands tasks to the other agents by role, collects their results and reports back to you.

For example, you ask for a login screen. The orchestrator asks the Coder to build it and the Reviewer to check it. If the Reviewer requests changes, the orchestrator can send the findings back to the Coder for up to two fix rounds by default. You can change that limit under **Settings > General > Review fix rounds**. The orchestrator reports the outcome, including any open findings. You can step in at any point of that conversation. The agents work directly in the project folder you choose.

Mixing providers means one model reviews another's work and each role can use the model it does best. Agent Bridge runs the CLIs you already have, so usage counts against your own provider accounts; it needs no account or key of its own.

Use **Settings → General → Progress layout** to follow the latest request beside or above the chat. Expand **Earlier requests** to see outstanding work from previous messages.

## Quick start

1. Install Node.js 22.18+ and the CLI of at least one provider: Claude Code, Codex or OpenCode.
2. On Windows, double-click `Agent Bridge.vbs` and choose the project folder. The page opens in your browser.
3. Check **Settings > Accounts**, then write your request and send it. To reach a specific agent, choose it under **Send to** or start your message with its `@Name`.

Closing the page does not stop Agent Bridge: the agents keep working in the background, and reopening the page shows what happened. Use **Quit** at the top of the page to close the app and all its agents.

## Features

- **Mixed team:** agents from different providers, each with its own role and model, working together.
- **Switch providers mid-conversation.** Open an idle agent’s details to change its provider. Its name, mentions, conversation history and worktree stay with the agent. The new provider starts a fresh session with a handoff summary.
- **Orchestration:** the orchestrator plans, delegates by role, runs tasks in parallel and checks the results, with a review loop between Coder and Reviewer.
- **Separate Git worktrees.** Select **Own git worktree** when adding an agent to a Git project. It gets its own branch and working directory, so two Coders can edit the same file in parallel without overwriting each other’s changes.
- **You stay in control.** Permission requests and role suggestions can prompt you for a decision. With **Ask me to approve the final result** enabled, the standard Orchestrator flow asks for final approval when it detects file changes. Optional browser notifications alert you to pending decisions.
- **Milestones.** In Orchestrator mode, Agent Bridge can propose an approval plan for larger tasks in a Git project. **Commit at milestones** defaults to **Ask me**, so each milestone commit requires your confirmation before it is created locally. The final milestone opens the final review.
- **Safe review:** the Reviewer sees the diff of the work with secret files left out.
- **Saved conversations:** restore any conversation with its team and sessions, and search its whole history.

## Roles

| Role | Does | Edits files | Recommended models |
| --- | --- | --- | --- |
| Orchestrator | Plans, delegates, checks results, answers you | No | Opus 5.5, GPT-6.2-Sol, Fable 5.2 |
| Architect | Designs larger changes before coding | No | Opus 5.5, Fable 5.2, GPT-6.2-Astra |
| Coder | Implements, then runs the project's lint, typecheck and tests | Yes | GPT-6.2-Sol, Sonnet 5.5, DeepSeek |
| Reviewer | Reviews the diff against the request: APPROVED or CHANGES REQUESTED | No | Opus 5.5, Sonnet 5.5, GPT-6.2-Sol |
| Tester | Writes and runs tests, reports failures | Tests only | Sonnet 5.5, GPT-6.1-Sol, Haiku 5.5 |
| Researcher | Looks up documentation, returns a summary with links | No | Haiku 5.5, GPT-6-Luna, Big Pickle |

Roles live in `roles/`, one JSON file each; copy one to create a new role.

## Security

- Open the page from the launcher. A single-use link authenticates that browser tab for the session. The link expires after 60 seconds. Restart preserves access in the same tab. Reopening the launcher rotates the session token and disconnects previously authenticated tabs. The conversation records tab openings, successful code exchanges and reuse alerts with timestamps. For five minutes after a link is used, a second attempt triggers a reuse alert. After that, the link is still rejected as invalid.
- The approval check recognizes literal Bridge ports with `localhost`, `127.0.0.1` or `[::1]`. Other host spellings and computed ports may escape that check. The conversation API and event stream still require the current token.
- Before approving a `git push` or `gh pr create` requested through Bridge, review the local secret scan. The card identifies the commit, file, line and rule. Resolve each finding or confirm a scoped exception. The card lists each applied exception with its reason. When checking a private destination, Bridge uses system and user Git settings in a directory outside the repository. If authentication fails, it scans the full reachable history. Use **Settings > General** to enable the optional pre-push hook for terminal pushes.
- Provider permissions determine which commands reach the approval card. A Codex sandbox with network access can push directly. The optional hook checks terminal and provider pushes in that repository unless Git skips hooks with `--no-verify`.
- The scanner checks known credential formats and sensitive filenames. Text files are scanned even when they have image extensions. Binary files and LFS objects are listed separately. To add project-specific token prefixes, create `.agent-bridge/secret-patterns.json` with a `prefixes` array, for example `{"prefixes":["internal_key_"]}`. Use `rules` for path-specific prefixes, such as `{"rules":[{"prefix":"internal_key_","pathSuffix":".ini"}]}`. Set `genericAssignments` to `true` to also check high-entropy password, secret and token assignments. These settings add checks. Exceptions require confirmation in the approval card.
- Sign in through each provider’s CLI.
- Codex uses its read-only sandbox for read-only roles. For Claude and OpenCode, shell requests for these roles skip bypass and require approval unless Bridge recognizes a safe read or an existing session grant. External actions detected in approval requests always require confirmation.

## Development

```bash
npm install
```

```bash
npm run check
```

The app has no runtime dependencies; `npm install` adds only the development tools. See [docs/architecture.md](docs/architecture.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
