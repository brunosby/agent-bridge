# Agent Bridge

A team of AI coding agents from different providers working on the same task, in a local web page where you watch everything live and step in at any time.

- **Claude** runs as Claude Code in headless mode (`claude -p --input-format stream-json --output-format stream-json`), one long-lived process per agent ([headless docs](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)).
- **Codex** runs as `codex app-server`, driven over its JSON-RPC protocol ([app-server docs](https://learn.chatgpt.com/docs/app-server)).
- **OpenCode** runs as `opencode serve` (one server per agent, random password, `127.0.0.1` only) and gives access to its providers ([server docs](https://opencode.ai/docs/server/)). Its free models (Big Pickle, DeepSeek V4.1 Flash Free and others) work without signing in.

No dependencies: Node.js 20+ and the CLIs of the providers you use. The page listens on `127.0.0.1` only, and every API call needs a random token created at start.

## Start

Double-click `agent-bridge.cmd` and type the project folder, or run:

```bat
agent-bridge.cmd --cwd C:\path\to\project
```

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | Project folder (default: current folder). |
| `--resume [id]` | Reopen the last conversation, or the one with this id. |
| `--port <n>` | Fixed port (default: a free one). |
| `--no-open` | Do not open the browser. |
| `--config <file>` | Use another config file. |
| `--logs <dir>` | Keep conversations in another folder (useful for tests). |
| `--main claude\|codex` | Old option: which agent is the orchestrator when no default team is saved. |

Stop with `Ctrl+C` in the console window; all agent processes are closed. If the page says the app "was updated after this window started", close the console and start it again.

First time? Open **Settings > Accounts** to see which CLIs are installed and signed in.

## The team

Each agent has a card at the top of the page with:

- **Role** (see below) and the models recommended for it;
- **Model**, listed from your account. ★ = recommended for the role, ⚠ = free/stealth model that may use your prompts for training (avoid sensitive code; the warning also shows for orchestrators), greyed out = not available (provider not connected, no access, usage limit, or the CLI is broken);
- **Effort**, with only the levels the model supports (Claude `--effort`, Codex `effort`);
- **Bypass** (below), tokens used, **Stop**, **Retry** (when unavailable) and **✕** to remove it.

**+ Add agent** adds more agents, including several from the same provider. Adding a third agent, or a second one on the same provider, shows a reminder that each agent spends its own tokens and shares its provider's quota. Optionally an agent gets its **own git worktree** (a branch next to the repository, `<repo>-agent-worktrees/...`), so coders never edit the same files; nothing is merged or deleted automatically.

The default team for new conversations is Claude as Orchestrator and Codex as Coder; change it with **Settings > General > Save the current team as the default**.

## Roles

Roles live in `roles/`, one JSON file each (`id`, `name`, `summary`, `canEdit`, `recommended`, `instructions`). Copy a file to create a new one.

| Role | Does | Edits files | Recommended |
| --- | --- | --- | --- |
| Orchestrator | Plans, delegates with @mentions, checks results, answers you | No | Opus 5.5, GPT-6.2-Sol, Fable 5.2 |
| Architect | Designs the solution before coding | No | Opus 5.5, Fable 5.2, GPT-6.2-Astra |
| Coder | Implements tasks and runs tests | Yes | GPT-6.2-Sol, Sonnet 5.5, DeepSeek |
| Reviewer | Reviews plans and diffs, approves or requests changes | No | Opus 5.5, Sonnet 5.5, GPT-6.2-Sol |
| Tester | Writes and runs tests | Tests only | Sonnet 5.5, GPT-6.1-Sol, Haiku 5.5 |
| Researcher | Looks up docs and sources | No | Haiku 5.5, GPT-6-Luna, Big Pickle |

The names follow common multi-agent setups (Anthropic's orchestrator-workers, Magentic-One, CrewAI, MetaGPT, Aider's architect/editor). "Edits files: No" is enforced: Claude runs without its edit tools, Codex in a read-only sandbox, OpenCode with its `plan` agent.

## Routing

The header's **Routing** menu (default in Settings):

| Mode | Who gets an agent's reply |
| --- | --- |
| **Orchestrator + mentions** (default) | The orchestrator delegates with `@Name`; every other agent answers the orchestrator; an orchestrator message without mentions is for you. A worker's `[[DONE]]` still goes to the orchestrator. |
| Free mentions | Whoever is mentioned; without a mention, back to whoever sent the last message. |
| Fixed pipeline | The next agent in the list; the last one answers you. |
| Round robin | The next agent in the list, in a loop. |

Your messages go to the box's target: **Auto** (the orchestrator, or the first agent), a specific agent, or all. A message that *starts* with `@Name` goes to that agent. Each agent sees the team list (names, roles, models) whenever it changes.

The relay stops when an orchestrator (or, in other modes, any agent) ends with a line containing only `[[DONE]]`, when the hand-off limit or the **token limit** is reached, or when you press **Pause** / **Stop all**. Sending a message or **Resume** continues.

## Approvals and bypass

Permission requests from every agent appear in a yellow panel pinned above the message box (**Allow once**, **Allow for session**, **Decline**). Unanswered requests are declined after `approvalTimeoutSec` (default 120 s) and the agent carries on.

- Claude runs with `--permission-prompt-tool stdio` (the channel behind the Agent SDK's `canUseTool`); "Allow for session" is kept in memory only.
- Codex approvals come from the app-server; OpenCode's from its permission endpoint.

**Bypass** (per agent) approves automatically, except destructive actions (forced push, `git reset --hard`, database drops, disk tools, publishing...) and deletions that are recursive, follow a `cd`, use variables like `$HOME`, or touch anything outside the project folder. Patterns are in `src/safety.mjs` and editable in Settings. It is a pattern check, not a sandbox: use it on projects under version control.

## Settings and accounts

**Settings > General** (saved to `config.json`): your name, default routing, auto-relay, hand-off limit, token limit, approval timeout, bypass for new agents, token warning, data-warning model patterns, safety patterns, opening the browser.

**Settings > Accounts** checks each CLI with its own commands and shows one of: *Not installed*, *Installed, not signed in*, *Signed in, no access* (plan inactive, invalid key, no credit), *Usage limit reached* (with the reset time when the provider reports it), or *Ready*, plus the next step: the install command, or **Sign in**, which opens a terminal running the CLI's own login (`claude auth login`, `codex login`, `opencode auth login`). Agent Bridge never sees or stores credentials.

No access and usage limits are also detected while agents work (Claude `rate_limit_event` and error codes, Codex `account/rateLimits/updated` and `unauthorized`, OpenCode session errors); that provider's models are disabled until it works again.

**Settings > Roles** lists the catalog.

## Providers through OpenCode

Only **connected** providers are listed. Out of the box that is OpenCode's own provider with its free models; nothing to sign in. With `opencode.freeOnly` (default `true` in `config.json`) only free models are enabled; paid ones are listed but greyed out. Every OpenCode session is created with "ask" rules for `bash`, `edit` and `webfetch` (`opencode.askFor`), so its requests reach the approval panel and the bypass rules like the other agents.

More providers can be connected with `opencode auth login` (a login or an API key, kept by OpenCode):

- **OpenCode Zen**, including the free `big-pickle` model (free for a limited time; prompts may be used to improve it, hence the ⚠).
- **DeepSeek** (`deepseek-flash`, `deepseek-v4-pro`) with an API key. DeepSeek also documents using it from Claude Code with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`.
- **OpenRouter** and other providers from the models.dev catalog.

**9router (optional, off by default).** [9router](https://github.com/decolua/9router) is a local router with an OpenAI-compatible endpoint at `http://localhost:20128/v1`. It can sit *behind* OpenCode as a custom OpenAI-compatible provider in `opencode.jsonc`. It also reuses subscription logins of other tools, which may go against those providers' terms of use, so Agent Bridge does not configure it; add it to OpenCode yourself if you accept that risk.

## Conversations and logs

Each conversation is saved in `logs/<timestamp>/`:

- `transcript.jsonl`: every event;
- `errors.log`: errors, unavailable agents, account problems and error-like CLI output, one line each, for finding causes;
- the instruction files given to Claude agents.

**Conversations** (header) lists them: **Restore** shows the old messages and brings back the whole team (agents, roles, models, effort, bypass, sessions, tokens); **Remove** moves a log to `logs/.removed`; **New conversation** starts fresh. `--resume` reopens the last one from the command line. Closing only the browser tab loses nothing.

## Files

```
agent-bridge.cmd        launcher
config.json             settings
roles/                  role catalog
src/server.mjs          HTTP + SSE server, team, routing, settings
src/claude-agent.mjs    Claude Code headless driver
src/codex-agent.mjs     Codex app-server driver
src/opencode-agent.mjs  OpenCode server driver
src/accounts.mjs        CLI install/sign-in status and login terminal
src/prompts.mjs         agent instructions and routing modes
src/roles.mjs           role catalog loader
src/safety.mjs          bypass rules
src/history.mjs         saved conversations
src/worktree.mjs        optional git worktree per agent
src/proc.mjs            process helpers
public/                 web page
dev-notes/CHECKPOINT.md development status
```

## Status

- Tested end to end: Claude, Codex and OpenCode agents (OpenCode 1.19.6 with Big Pickle and DeepSeek V4.1 Flash Free), teams of three, routing, approvals, bypass, effort, token counting, restore, worktree, settings and accounts status.
- The OpenCode driver uses the events checked against the server's OpenAPI spec (`GET /doc`): `message.part.delta` (live text), `message.part.updated` (tools), `permission.asked` / `permission.replied`, `session.error`. If OpenCode changes them, the agent is shown as unavailable.
- `codex app-server` is experimental; if its protocol changes, the Codex agent is shown as unavailable instead of breaking the app. `codex app-server generate-ts --out <dir>` prints the current protocol types.
