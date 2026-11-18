# Agent Bridge

A team of AI coding agents from different providers (Claude Code, Codex, OpenCode) working on one task, in a local web page where you watch the conversation live and step in at any time.

You talk to an orchestrator; it hands tasks to the other agents by role (coder, reviewer, tester...), collects their results and comes back to you for the final approval.

## Quick start

1. **Requirements:** Windows, [Node.js](https://nodejs.org) 20+, and the CLI of at least one provider: [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://developers.openai.com/codex/cli) or [OpenCode](https://opencode.ai/docs/). No `npm install` needed.
2. **Open:** double-click `Agent Bridge.vbs` and choose the project folder. The page opens in your browser; there is no console window.
3. **Check your accounts:** **Settings > Accounts** shows, per provider, whether the CLI is installed and signed in, with the next step (install command or a **Sign in** button that opens the CLI's own login).
4. **Write your request** in the box at the bottom and press `Ctrl+Enter`.

Use **Restart** and **Quit** at the top of the page to restart or close the app.

## Using it

**The team.** Each agent has a card at the top with its role, model, effort level, bypass switch, tokens used, **Stop** and **✕**. The default team is Claude as Orchestrator and Codex as Coder. **+ Add agent** adds more (several from the same provider are fine); the form suggests a name (`Provider-Role`), lists the models of that provider and marks recommendations both ways: ★ models for the chosen role, ★ roles for the chosen model.

**Messages.** Your message goes to the orchestrator by default. Pick another agent in the box's menu, start the message with `@Name`, or send it to all.

**Routing.** By default the orchestrator delegates with `@Name`, every other agent answers the orchestrator, and the results of parallel tasks reach it together in one message. Other modes are in the header's **Routing** menu: free mentions, fixed pipeline and round robin.

**Approvals.** Permission requests from any agent appear in a yellow panel above the message box (**Allow once**, **Allow for session**, **Decline**). Unanswered requests are declined after 2 minutes and the agent carries on. **Bypass** on a card approves automatically, except destructive actions and deletions outside the project folder.

**Finishing.** When the work is done, a card shows the orchestrator's summary with **Approve** and **Ask for changes**. Hand-offs also stop at the hand-off limit, at the token limit, or when you press **Pause** / **Stop all**; send a message or press **Resume** to continue.

**Conversations.** Everything is saved. **Conversations** lists earlier conversations: **Restore** brings back the messages and the whole team with its sessions; **New conversation** starts fresh, optionally in another folder.

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
- **Profiles:** Orchestrator and Coder use your full setup (hooks, skills, plugins, CLAUDE.md). The other roles run lean, without hooks. **Settings > Roles** changes a role's profile and switches skills off per role (Claude and OpenCode agents).
- Roles live in `roles/`, one JSON file each; copy one to create a new role.

## Providers

| Provider | Runs as | Sign-in |
| --- | --- | --- |
| Claude | Claude Code in headless mode | Claude account or API key (`claude auth login`) |
| Codex | `codex app-server` | ChatGPT account or API key (`codex login`) |
| OpenCode | `opencode serve`, one per agent | None for its free models; `opencode auth login` for other providers |

Models are listed from your own account. Unavailable ones are greyed out: a provider that is not connected, no access, a usage limit, or a broken CLI.

**OpenCode free models** (Big Pickle, DeepSeek V4.1 Flash Free and others) work without any account. Only free models are enabled by default (`opencode.freeOnly` in `config.json`). They show ⚠ because the provider may use prompts to improve them, so avoid sensitive code with them. Other providers can be connected through OpenCode with a login or an API key, for example DeepSeek or OpenRouter.

[9router](https://github.com/decolua/9router), a local router that reuses subscription logins of other tools, can be added to OpenCode as an OpenAI-compatible provider. Agent Bridge does not set it up, because reusing subscriptions that way may go against those providers' terms of use.

Effort levels follow the selected model (Claude and Codex). The per-role step limit applies to Claude agents only.

## Security and privacy

- The page listens on `127.0.0.1` only, and every request needs a random token created at start.
- Agent Bridge never sees or stores credentials: signing in always happens in each provider's CLI.
- Bypass is a pattern check, not a sandbox. Use it on projects under version control.
- Free and stealth models may use your prompts for training (⚠ in the model list).
- An optional **own git worktree** per agent (in **+ Add agent**) keeps two coders from editing the same files. Agent Bridge never merges or deletes worktrees.

## Configuration

**Settings > General** (saved to `config.json`): your name, default routing, auto-relay, hand-off limit, token limit (counts new tokens; cached tokens are shown apart because they cost much less), review rounds, final confirmation, missing-role behaviour, approval timeout, bypass for new agents, and the safety patterns. **Save the current team as the default** sets the team for new conversations.

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

A Node.js server (`src/server.mjs`) starts one process per agent and talks to it through the provider's official interface:

- Claude Code headless with streaming JSON in and out, with permission prompts routed to the page (`--permission-prompt-tool stdio`);
- the Codex app-server JSON-RPC protocol;
- the OpenCode HTTP server and its event stream.

The page (`public/`) receives everything live over Server-Sent Events. If a provider's interface changes, that agent is shown as unavailable instead of breaking the app.

```
Agent Bridge.vbs      launcher (no console)      src/claude-agent.mjs    Claude Code driver
agent-bridge.cmd      launcher (console)         src/codex-agent.mjs     Codex driver
config.json           settings                   src/opencode-agent.mjs  OpenCode driver
roles/                role catalog               src/accounts.mjs        account status and sign-in
public/               web page                   src/safety.mjs          bypass rules
logs/                 conversations and logs     src/history.mjs         saved conversations
src/server.mjs        server, team, routing      src/worktree.mjs        git worktree per agent
```
