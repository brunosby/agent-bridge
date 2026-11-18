# Agent Bridge

Let Claude Code and Codex talk to each other on the same task while you watch the conversation live and can step in at any time.

- **Claude** runs as Claude Code in headless mode, kept alive as one process:
  `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
  ([headless docs](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)).
- **Codex** runs as `codex app-server`, driven over its JSON-RPC protocol on stdio
  ([app-server docs](https://learn.chatgpt.com/docs/app-server)). `codex mcp-server` no longer exists, so MCP is not used.
- A small local web page (served on `127.0.0.1` only) shows both agents' text as it streams, their tool calls, and Codex approval requests, with a box to message the main agent, the peer, or both.

No dependencies: only Node.js 20+ and the two CLIs, each already logged in.

## Start

Double-click `agent-bridge.cmd` and type the project folder, or run:

```bat
agent-bridge.cmd --cwd C:\path\to\project
```

Options:

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | Folder both agents work in (default: current folder). |
| `--main claude\|codex` | Which agent leads (default from `config.json`, `claude`). |
| `--port <n>` | Fixed port (default: a free one). |
| `--no-open` | Do not open the browser. |
| `--config <file>` | Use another config file. |
| `--resume [id]` | Reopen the last conversation, or the one with this id (see below). |

Stop with `Ctrl+C` in the console window; both agent processes are closed.

## How the conversation flows

1. You write to the **main** agent (or the peer, or both) from the box at the bottom. `Ctrl+Enter` sends.
2. When an agent finishes a turn, its final message is forwarded to the other one as `[Message from Claude]` / `[Message from Codex]`.
3. The relay stops when an agent ends a message with a line containing only `[[DONE]]`, when the hop limit is reached, or when you press **Pause** / **Stop all**.
4. Any message you send resets the hop counter and resumes the relay. **Resume** does the same without sending anything.

Each agent gets short instructions (see `src/prompts.mjs`) explaining its role, the relay, and the `[[DONE]]` marker. Claude receives them through `--append-system-prompt-file`; Codex through `developerInstructions` on `thread/start`.

You can message an agent while it is working: Claude queues the message for its next turn, and Codex adds it to the running turn.

## Permissions

Both agents' permission requests appear in a yellow panel pinned above the message box, with **Allow once**, **Allow for session** (when offered) and **Decline**. The agent's chip shows "waiting for your approval" and the tab title shows the number of pending requests.

- **Claude** runs with `--permission-prompt-tool stdio`, so each prompt arrives as a `can_use_tool` control request (the channel behind the Agent SDK's `canUseTool`). Its base mode is `permissionMode` (default `acceptEdits`); `allowedTools` adds rules such as `"Bash(npm test *)"`. **Allow for session** keeps the suggested rule in memory for this session only; nothing is written to the project's settings. `AskUserQuestion` is declined with a note telling Claude to ask in its message instead. Set `claude.permissionPrompts` to `false` to go back to plain headless behaviour (prompts are denied).
- **Codex** uses `approvalPolicy` (default `on-request`) and `sandbox` (default `workspace-write`); its requests come from the app-server.

**Unanswered requests.** Agents wait for an answer with no time limit, so the bridge declines a request after `approvalTimeoutSec` seconds (default 120, `0` = wait forever). The agent receives the refusal and carries on.

### Bypass mode

Tick **Bypass** on an agent's chip (or set `bypass.claude` / `bypass.codex` in `config.json`) to accept its requests automatically. The page still asks you for:

- destructive actions: forced git push, `git reset --hard`, `git clean -f`, branch deletion, database drops, disk tools, shutdown, publishing, and similar (`destructivePatterns`);
- deletions (`rm`, `del`, `Remove-Item`, `rmdir`, ... in `deletionPatterns`) that are recursive, that follow a `cd`, that use variables such as `$HOME`, or whose paths fall outside the project folder. Deleting single files inside the project folder is accepted.

Requests that were accepted this way are listed in the conversation as "auto-approved (bypass)". Both pattern lists are case-insensitive regular expressions and can be replaced in `config.json`; the defaults are in `src/safety.mjs`. This is a pattern check, not a sandbox: an unusual command can slip past it, so keep bypass for projects under version control.

## Models

Each agent chip in the header has a model menu filled with the models your account can use:

- **Claude:** the list comes from Claude Code's `initialize` control message on the stream-json channel (the same data the Agent SDK exposes as `supportedModels()` / `initializationResult()`). Changing it restarts the Claude process with `--model <value> --resume <session>`, so the conversation continues. If Claude is working, the switch waits until the turn ends.
- **Codex:** the list comes from the app-server `model/list` method (hidden models are left out). The chosen model is sent with every `turn/start`, so it applies from the next turn.

**Default** means each CLI's own default (shown in brackets). `config.json` sets the model at start; changes made in the page last until the bridge is closed.

## Stop buttons

- **Stop** on Codex sends `turn/interrupt`.
- **Stop** on Claude ends the process; the next message restarts it with `--resume <session id>`, so the conversation continues.
- **Stop all** stops both and pauses the relay.

## Configuration (`config.json`)

| Key | Meaning |
| --- | --- |
| `mainAgent` | `claude` or `codex`. |
| `userName` | How the agents refer to you. |
| `autoRelay`, `maxHops` | Initial relay settings (both can be changed in the page). |
| `claude.model`, `codex.model` | Model at start; `null` uses each CLI's default. Can be changed in the page. |
| `claude.permissionMode`, `claude.allowedTools` | Claude permissions. |
| `codex.approvalPolicy`, `codex.sandbox` | Codex permissions. |
| `approvalTimeoutSec` | Seconds before an unanswered approval is declined (0 = never). |
| `bypass.claude`, `bypass.codex` | Start with bypass mode on. |
| `destructivePatterns`, `deletionPatterns` | Replace the default safety patterns. |
| `claude.permissionPrompts` | Send Claude's permission prompts to the page (default `true`). |
| `*.instructions` | Extra text appended to that agent's instructions. |
| `*.extraArgs` | Extra CLI arguments. |
| `claude.resumeSessionId`, `codex.resumeThreadId` | Continue an earlier session. |

## Conversations: restore and start new

Every conversation is saved in `logs/<timestamp>/transcript.jsonl` (all events, including CLI stderr). Session ids are shown when you hover over each agent in the header.

- **Closing the browser tab** loses nothing: reopen the address and the page replays the conversation.
- **Conversations** (header button) lists earlier conversations with their first message, folder and date. **Restore** shows the old messages again and continues both agents' sessions (Claude with `--resume <session id>`, Codex with `thread/resume`), in the same project folder and with the same models. The relay stays paused until you send a message. **New conversation** starts fresh, optionally in another folder. **Remove** takes a conversation off the list by moving its folder to `logs/.removed` (nothing is deleted). Logs that continue the same agent sessions are shown once, as the most recent.
- **`agent-bridge.cmd --resume`** opens the most recent conversation directly; `--resume <timestamp>` opens a specific one (the folder name under `logs`).

Restoring needs the agents' own session files (kept by Claude Code and Codex on this machine). If an agent had not received any message in that conversation, it starts a fresh session.

If the page shows "Agent Bridge was updated after this window started", the code on disk changed while the app was running: close the console window and start it again.

## Files

```
agent-bridge.cmd        launcher
config.json             settings
src/server.mjs          HTTP + SSE server and relay logic
src/claude-agent.mjs    Claude Code headless driver
src/codex-agent.mjs     Codex app-server driver
src/prompts.mjs         instructions given to each agent
src/safety.mjs          bypass-mode rules (destructive actions, deletions)
src/history.mjs         reads saved conversations for the Conversations list and restore
src/proc.mjs            process helpers
public/                 web page
```

## Limits

- `codex app-server` is marked experimental by OpenAI; protocol changes may need updates in `src/codex-agent.mjs`. `codex app-server generate-ts --out <dir>` prints the current protocol types.
- The page has no login: it listens only on `127.0.0.1` and every API call needs a random token created at start.
