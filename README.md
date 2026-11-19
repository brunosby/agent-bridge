# Agent Bridge

A team of AI coding agents from different providers (Claude Code, Codex, OpenCode) working on one task, in a local web page where you watch the conversation live and step in at any time.

You talk to an orchestrator; it hands tasks to the other agents by role (coder, reviewer, tester...), collects their results and comes back to you for the final approval.

## Quick start

1. **Requirements:** Windows, Node.js 22.18+, and the CLI of at least one provider: Claude Code, Codex or OpenCode (**Settings > Accounts** shows the install command for each). No `npm install` needed to use it.
2. **Open:** double-click `Agent Bridge.vbs` and choose the project folder. The page opens in your browser; there is no console window.
3. **Check your accounts:** **Settings > Accounts** shows, per provider, whether the CLI is installed and signed in, with the next step (install command or a **Sign in** button that opens the CLI's own login).
4. **Write your request** in the box at the bottom and press `Enter` (`Shift+Enter` adds a new line).

Use **Restart** and **Quit** at the top of the page to restart or close the app.

## Using it

**The team.** The **Workspace** sidebar shows each agent with its role, model and status. Select a card for details and controls. Drag the sidebar edge to resize it on wide screens, or open it with **Workspace** on narrow screens. The default team is Claude as Orchestrator and Codex as Coder. **+ Add agent** adds more agents, including several from the same provider. The form suggests a name (`Provider-Role`) and marks recommended models for the selected role and recommended roles for the selected model.

**Messages.** The message box starts at one line and grows as you type. Use **Send to** to choose an agent or the whole team. **Auto** routes to the orchestrator by default and follows leading `@Name` mentions. The preview highlights changes to the expected recipient and routing problems before you send. Agent messages align left and your messages align right. Press `Shift+Enter` for a new line or `Ctrl+Enter` (`Cmd+Enter` on macOS) to send while mention suggestions are open.

**Routing.** By default the orchestrator delegates with `@Name`, every other agent answers the orchestrator, and the results of parallel tasks reach it together in one message. The **Routing** section in **Workspace** also offers free mentions, fixed pipeline and round robin.

**Approvals.** Permission requests from any agent appear in a yellow panel above the message box (**Allow once**, **Allow for session**, **Decline**). Unanswered requests are declined after 2 minutes and the agent carries on. **Bypass** on a card approves automatically, except destructive actions and deletions outside the project folder.

**Notifications.** In **Settings > General**, **Enable browser notifications** lets your browser alert you to pending approvals, role decisions, milestone decisions and final review while the page is hidden or unfocused. Keep an app tab open to receive them. A single tab sends each notification once.

**Finishing.** With final confirmation enabled, an **Approve** / **Ask for changes** card appears when Git detects file changes since your last message. In folders without Git, a reported successful edit can trigger the card. Restored work without an earlier snapshot can still need your approval. Hand-offs also stop at the hand-off limit, at the token limit, or when you press **Pause** or **Stop all**. Send a message or press **Resume** to continue.

**Conversations.** Everything is saved. **Conversations** lists earlier conversations: **Restore** brings back the messages and the whole team with its sessions; **New conversation** starts fresh, optionally in another folder.

**Conversation history.** The chat opens at the end. Scrolling up while an agent writes keeps your position, and **Back to end** shows how many messages arrived. The filter panel searches loaded messages or activity. **Search saved history** also finds older messages and shows an excerpt for results outside the loaded chat. Successful tool calls are grouped and failures stay visible. Drafts are kept per conversation in the current browser tab.

**Reviewer context.** The Bridge excludes common secret paths before requesting the reviewer patch. Add repository-relative globs or filename patterns to the `reviewDiffExcludePatterns` array in `config.local.json` for project-specific exclusions. The final review shows observed Git paths and status separately from the agent summary, without including file content. When the diff is over the size limit, the Reviewer can read one listed file at a time through the Bridge's `bridge_diff` tool, with the same exclusions. The tool was verified with Claude Code, Codex and OpenCode. A client without access to the tool still receives the file list.

## Milestones

In orchestrator mode, substantial Git work can be split into milestones with a completion criterion for each one. Review and edit the proposed plan before approving it. The **Milestones** panel shows progress and commit IDs. Creating commits requires a Git workspace on a branch with an existing commit.

When approving the plan, you can choose a verification command. Agent Bridge suggests one for recognised projects and remembers your choice per project in `config.local.json`. If set, the command runs in each workspace with files eligible for the milestone. The commit also requires that pending tasks and approvals are resolved and that the Reviewer has approved the milestone when one is on the team.

In **Settings > General > Commit at milestones**, **Ask me** is the default. **Automatic** commits after the required checks pass. If the plan has no verification command and the team has no Reviewer, each commit still requires your approval.

Milestone commits include eligible changes made since the milestone began. Agent Bridge preserves pre-existing changes and staged work, excludes secret paths using the reviewer exclusion rules, and prevents Git hooks from expanding the approved set of paths. It uses your Git identity and commits on each affected Git workspace's branch. Commits stay local.

The last milestone opens the final review. Restoring a conversation shows its recorded milestone progress. Approve a new plan to resume unfinished milestone work.

## Roles

| Role | Does | Edits files | Recommended models |
| --- | --- | --- | --- |
| Orchestrator | Plans, delegates, checks results, answers you | No | Opus 5.5, GPT-6.2-Sol, Fable 5.2 |
| Architect | Designs larger changes before coding | No | Opus 5.5, Fable 5.2, GPT-6.2-Astra |
| Coder | Implements, then runs the project's lint, typecheck and tests | Yes | GPT-6.2-Sol, Sonnet 5.5, DeepSeek |
| Reviewer | Reviews the diff against the request: APPROVED or CHANGES REQUESTED | No | Opus 5.5, Sonnet 5.5, GPT-6.2-Sol |
| Tester | Writes and runs tests, reports failures | Tests only | Sonnet 5.5, GPT-6.1-Sol, Haiku 5.5 |
| Researcher | Looks up documentation, returns a summary with links | No | Haiku 5.5, GPT-6-Luna, Big Pickle |

- **Read-only is enforced**, not just asked: Claude runs without its edit tools, Codex in a read-only sandbox, OpenCode with its `plan` agent.
- The orchestrator **sizes the team to the request**: one agent for small things, Coder then Reviewer for normal changes, the others only for large work.
- **Review loop:** CHANGES REQUESTED goes back to the coder for up to 2 rounds; after that the orchestrator reports the open findings to you.
- **Missing role:** if the task needs a role nobody has, the page asks whether to add it (with a recommended model) or continue with the closest agent.
- **Recommended roles:** for substantial work, the orchestrator can suggest up to three roles with a reason each. You choose which to add; nothing is added on its own (**Settings > General > Recommend roles**).
- **Unavailable agents** (failed to start, signed out, no access, usage limit) stay visible with the reason and **Retry**, but the orchestrator does not delegate to them until they are ready.
- **Profiles:** Orchestrator and Coder use your full setup (hooks, skills, plugins, CLAUDE.md). The other roles run lean: no hooks and no skills, except the ones you allow for the role in **Settings > Roles** (Claude and OpenCode agents). This keeps a support role from loading a workflow skill that conflicts with its job.
- **Researcher** opens at most 3 pages per question, so long pages do not fill the model's context. Its card warns when the chosen model has a context window of 200k tokens or less.
- Roles live in `roles/`, one JSON file each; copy one to create a new role.

## Providers

| Provider | Runs as | Sign-in |
| --- | --- | --- |
| Claude | Claude Code in headless mode | Claude account or API key (`claude auth login`) |
| Codex | `codex app-server` | ChatGPT account or API key (`codex login`) |
| OpenCode | `opencode serve`, one per agent | None for its free models; `opencode auth login` for other providers |

Models are listed from your own account. Unavailable ones are greyed out: a provider that is not connected, no access, a usage limit, or a broken CLI.

**OpenCode free models** (Big Pickle, DeepSeek V4.1 Flash Free and others) work without any account. Only free models are enabled by default (`opencode.freeOnly` in `config.json`). They show ⚠ because the provider may use prompts to improve them, so avoid sensitive code with them. Other providers can be connected through OpenCode with a login or an API key, for example DeepSeek or OpenRouter.

**Codex history.** Codex threads opened by Agent Bridge are named `Agent Bridge · <folder> · <agent>` and archived when the conversation closes, so they leave the thread list of Codex and the ChatGPT app; restoring the conversation brings them back. Set `codex.archiveOnClose` to `false` in `config.json` to keep them listed.

Effort levels follow the selected model (Claude and Codex). The per-role step limit applies to Claude agents only.

## Security and privacy

- The page listens on `127.0.0.1` only, and every request needs a random token created at start.
- Agent Bridge never sees or stores credentials: signing in always happens in each provider's CLI.
- Bypass is a pattern check, not a sandbox. Use it on projects under version control.
- Free and stealth models may use your prompts for training (⚠ in the model list).
- An optional **own git worktree** per agent (in **+ Add agent**) keeps two coders from editing the same files. Agent Bridge never merges or deletes worktrees.

## Configuration

**Settings > General** saves local settings to `config.local.json`. You can set your name, the default routing, auto-relay, the hand-off and new-token limits, review rounds, final confirmation, role recommendations, missing-role behaviour, milestone commit approval, the approval timeout, bypass for new agents, and safety patterns. **Save the current team as the default** sets the team for new conversations.

Launcher options (`wscript "Agent Bridge.vbs" ...` or `agent-bridge.cmd ...`, which keeps a console window):

| Option | Meaning |
| --- | --- |
| `--cwd <folder>` | Project folder (skips the folder picker). |
| `--resume [id]` | Reopen the last conversation, or a specific one. |
| `--port <n>` | Fixed port instead of a free one. |
| `--no-open` | Do not open the browser. |
| `--config <file>` | Use another config file. |
| `--logs <folder>` | Keep conversations in another folder. |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The app does not open | A message box explains why; details are in `logs\server.log`. |
| The page says the app "was updated after it started" | Press **Restart**. |
| An agent card is red, "unavailable" | Its CLI did not start or its protocol changed. Check **Settings > Accounts**, then press **Retry**. |
| "No access" or "Usage limit" on a card | Plan, key or quota problem with that provider; the reset time is shown when known. |
| Something went wrong during a conversation | `logs\<conversation>\errors.log` lists errors, unavailable agents and account problems. |

## How it works

A local Node.js server starts one process per agent and talks to it through the provider's official interface:

- Claude Code headless with streaming JSON in and out, with permission prompts routed to the page (`--permission-prompt-tool stdio`);
- the Codex app-server JSON-RPC protocol;
- the OpenCode HTTP server and its event stream.

The page receives everything live over Server-Sent Events. If a provider's interface changes, that agent is shown as unavailable instead of breaking the app.

The code is strict TypeScript run directly by Node (no build step), in layers: `src/core` (pure logic and types), `src/providers` (one adapter per provider), `src/server` (team, routing, HTTP), `src/config` and `src/cli`. The page in `public/` uses ES modules and layered CSS. See [docs/architecture.md](docs/architecture.md).

```
Agent Bridge.vbs     launcher (no console)          src/core/        roles, prompts, safety, history, types
agent-bridge.cmd     launcher (console)             src/providers/   Claude Code, Codex, OpenCode, fake (tests)
bin/agent-bridge.mjs entry point                    src/server/      team, conversation, routing, HTTP, API
config.json          default settings               src/config/      options and settings
roles/               role catalog                   src/cli/         start, restart, quit
public/              web page (js/, css/)           test/            end-to-end and unit tests
logs/                conversations (not in git)     docs/            architecture
```

## Development

```bash
npm install
```

```bash
npm run check
```

`npm install` only adds the development tools (lint, format, type check); the app itself has no dependencies. `npm run check` runs lint, type check and tests. The tests use a scripted `fake` provider, so they need no CLI, account or tokens. Changes are listed in [CHANGELOG.md](CHANGELOG.md).
