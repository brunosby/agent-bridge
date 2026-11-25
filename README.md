# Agent Bridge

A team of AI coding agents from different providers (Claude Code, Codex, OpenCode) working on one task, in a local web page where you watch the conversation live and step in at any time.

You talk to an orchestrator. It hands tasks to the other agents by role, collects their results and reports back to you.

For example, you ask for a login screen. The orchestrator asks the Coder to build it and the Reviewer to check it. If the Reviewer requests changes, the orchestrator can send the findings back to the Coder for up to two fix rounds by default. You can change that limit under **Settings > General > Review fix rounds**. The orchestrator reports the outcome, including any open findings. You can step in at any point of that conversation. The agents work directly in the project folder you choose.

Mixing providers means one model reviews another's work and each role can use the model it does best. Agent Bridge runs the CLIs you already have, so usage counts against your own provider accounts; it needs no account or key of its own.

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

- The page listens on `127.0.0.1` only and requires a token created at start.
- Agent Bridge never handles credentials: you sign in through each provider's CLI.
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
