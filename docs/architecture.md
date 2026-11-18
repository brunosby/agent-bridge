# Architecture

Agent Bridge is a local Node.js app. It starts one process per agent, talks to each through the provider's official interface, routes messages between agents, and streams everything to a page in the browser.

```
browser (public/)  ⇄  HTTP + Server-Sent Events  ⇄  server/  →  providers/  →  claude · codex app-server · opencode serve
                                                       ↑
                                                core/ (pure logic) · config/
```

## Layers

The code follows a "ports and adapters" layout: the core does not know how providers or HTTP work, and every provider implements the same interface.

| Folder | Role | Depends on |
| --- | --- | --- |
| `src/core/` | Pure logic and shared types: roles, prompts, routing modes, safety rules (bypass), saved conversations, `types.ts`. No network, no processes. | nothing else in `src/` |
| `src/providers/` | One adapter per provider, all implementing the `Agent` interface from `core/types.ts`: `claude.ts` (Claude Code headless, stream-json), `codex.ts` (Codex app-server, JSON-RPC), `opencode.ts` (OpenCode HTTP server + SSE), `fake.ts` (scripted, for tests). Also account status (`accounts.ts`), process helpers and the registry. | `core` |
| `src/server/` | The running app: shared state, team management, conversation lifecycle, routing (orchestrator hand-offs, review rounds, missing roles), event bus, HTTP server and API. | `core`, `providers`, `config` |
| `src/config/` | Command-line options, log file, `config.json` + `config.local.json` and the Settings schema. | `core` |
| `src/workspace/` | Optional git worktree per agent. | — |
| `src/cli/` | Entry point: open or restore a conversation, start the server, restart and quit. | everything |
| `bin/agent-bridge.mjs` | Stable entry used by the launchers and `npm start`. | `cli` |
| `public/` | The page: `js/core` (API, DOM helpers, page state) and `js/features` (agents, conversation log, approvals, dialogs, controls); `css/` with cascade layers. | server API only |

## Runtime

- **TypeScript without a build step.** Node 22.18+ runs `.ts` files directly (type stripping), so the code only uses erasable TypeScript syntax (`erasableSyntaxOnly`). `tsc` is used for type checking only.
- **Events.** Each agent emits `AgentEvent`s (`delta`, `text`, `tool`, `turnEnd`, `approval`, `usage`, `account`, `unavailable`...). `server/conversation.ts` handles them, `server/routing.ts` decides who gets each reply, and `server/events.ts` publishes `BridgeEvent`s to the page and to `logs/<conversation>/transcript.jsonl`.
- **State.** `server/state.ts` holds the open conversation, the history replayed to new pages and per-provider caches. Restoring a conversation replaces it.
- **Approvals.** Permission requests from every provider arrive as `approval` events; the bypass rules in `core/safety.ts` either answer them automatically or pin them in the page.

## Page

- ES modules loaded natively by the browser (`<script type="module">`), no bundler.
- CSS uses cascade layers in this order: `tokens` (custom properties, light and dark theme), `base`, `layout` (app shell and breakpoints at 640 px and 1024 px), `components` (buttons, forms, agent card, messages, approvals, dialogs), `utilities`.
- Mobile first: on phones the relay controls fold behind **Controls**, agent cards open on tap, and dialogs go full screen.

## Tests

- `test/conversation.test.mjs` starts the real server with the `fake` provider and checks routing, batched results, the review loop limit, missing roles, settings storage and restore.
- `test/unit.test.mjs` covers safety rules, roles, prompts and conversation history.
- `npm run check` runs lint, type check and tests; CI runs them on Windows and Linux.

## Adding a provider

1. Create `src/providers/<name>.ts` with a class implementing `Agent` (see `fake.ts` for the smallest example).
2. Register it in `src/providers/registry.ts` (label, class, optional `probe`).
3. Add its account checks to `src/providers/accounts.ts` if it has a CLI to sign in to.
