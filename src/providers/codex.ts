import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawnJsonl, type JsonlProcess } from './process.ts';
import type { Agent, AgentOptions, DriverConfig, ModelInfo, ReconfigureOptions } from '../core/types.ts';
import { clip } from './claude.ts';

/**
 * Drives Codex through `codex app-server` (JSON-RPC 2.0 without the "jsonrpc" field, JSONL over stdio).
 * Flow: initialize -> initialized -> thread/start (or thread/resume) -> turn/start per message.
 * Approval requests arrive as server->client requests and are forwarded to the UI.
 */
export class CodexAgent extends EventEmitter implements Agent {
  id: string;
  name: string;
  label: string;
  readOnly: boolean;
  sandboxOverride: boolean;
  tokens: number;
  cachedTokens: number;
  available: boolean;
  unavailableReason: string | null;
  cwd: string;
  config: DriverConfig;
  instructions?: string;
  nextId: number;
  waiting: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>;
  threadId: string | null;
  activeTurnId: string | null;
  turnMessages: { text: string; phase?: string | null }[];
  queue: string[];
  ready: Promise<void> | null;
  approvals: Map<string, { rpcId: number | string; method: string }>;
  fileChanges: Map<string, { path: string; kind: unknown }[]>;
  models: ModelInfo[] = [];
  resolvedModel: string | null = null;
  proc: JsonlProcess | null = null;
  stopping = false;

  get sessionId(): string | null {
    return this.threadId;
  }

  constructor({ id = 'codex', name = 'Codex', cwd, config, instructions, readOnly = false, tokens = 0, cachedTokens = 0 }: AgentOptions) {
    super();
    this.id = id;
    this.name = name;
    this.label = name;
    this.readOnly = readOnly;
    this.sandboxOverride = false;
    this.tokens = tokens;
    this.cachedTokens = cachedTokens;
    this.available = true;
    this.unavailableReason = null;
    this.cwd = cwd;
    this.config = config || {};
    this.instructions = instructions;
    this.nextId = 1;
    this.waiting = new Map();
    this.threadId = null;
    this.activeTurnId = null;
    this.turnMessages = [];
    this.queue = [];
    this.ready = null;
    this.approvals = new Map();
    this.fileChanges = new Map();
  }

  get busy() {
    return Boolean(this.activeTurnId) || this.queue.length > 0;
  }

  emitEvent(kind: string, data: Record<string, unknown> = {}): void {
    this.emit('event', { agent: this.id, kind, ...data });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, method });
      this.proc?.write({ method, id, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.proc?.write({ method, params });
  }

  start() {
    if (this.ready) return this.ready;
    const command = this.config.command || 'codex';
    const args = ['app-server', ...(this.config.extraArgs || [])];
    this.emitEvent('info', { text: `Starting: ${command} ${args.join(' ')}` });
    // codex is usually an npm .cmd shim on Windows, so it runs through cmd.exe. Args come from config, not from the UI.
    const isWin = process.platform === 'win32';
    this.proc = spawnJsonl(isWin ? 'cmd.exe' : command, isWin ? ['/d', '/s', '/c', command, ...args] : args, {
      cwd: this.cwd,
      onMessage: (m) => this.handle(m),
      onText: (t) => this.emitEvent('info', { text: t }),
      onStderr: (t) => this.emitEvent('stderr', { text: String(t) }),
      onExit: (code) => {
        const expected = this.stopping;
        this.stopping = false;
        this.proc = null;
        this.ready = null;
        this.activeTurnId = null;
        for (const key of this.approvals.keys()) this.emitEvent('approvalClosed', { requestId: key, decision: 'cancelled' });
        this.approvals.clear();
        for (const w of this.waiting.values()) w.reject(new Error('codex app-server exited'));
        this.waiting.clear();
        this.emitEvent('status', { busy: false });
        if (!expected) this.emitEvent('error', { text: `Codex app-server exited (code ${code}).` });
      },
    });
    this.ready = this.handshake().catch((err) => {
      this.emitEvent('error', { text: `Codex start failed: ${errorText(err)}` });
      this.ready = null;
      // The handshake is the protocol contract; if it fails, treat Codex as unavailable instead of retrying forever.
      this.markUnavailable(`Codex app-server did not start: ${errorText(err)}`);
      throw err;
    });
    return this.ready;
  }

  async handshake() {
    await this.request('initialize', {
      clientInfo: { name: 'agent_bridge', title: 'Agent Bridge', version: '0.1.0' },
    });
    this.notify('initialized');
    const c = this.config;
    let res;
    if (this.threadId || c.resumeThreadId) {
      // Threads are archived when a conversation closes (see shutdown); bring it back before resuming.
      await this.request('thread/unarchive', { threadId: this.threadId || c.resumeThreadId }).catch(() => {});
      try {
        res = await this.request('thread/resume', { threadId: this.threadId || c.resumeThreadId });
      } catch (err) {
        this.emitEvent('info', { text: `Could not resume the earlier Codex thread (${errorText(err)}); starting a new one.` });
        this.threadId = null;
        c.resumeThreadId = null;
      }
    }
    if (!res) {
      const params: Record<string, unknown> = {
        cwd: this.cwd,
        approvalPolicy: c.approvalPolicy || 'on-request',
        sandbox: this.readOnly ? 'read-only' : c.sandbox || 'workspace-write',
        serviceName: 'agent_bridge',
        developerInstructions: this.instructions,
      };
      if (c.model) params.model = c.model;
      res = await this.request('thread/start', params);
    }
    this.threadId = res.thread.id;
    this.resolvedModel = res.model || null;
    // A readable title in Codex's thread list (and the ChatGPT app) instead of the first relayed message.
    if (!res.thread.name)
      this.request('thread/name/set', { threadId: this.threadId, name: `Agent Bridge · ${path.basename(this.cwd)} · ${this.name}` }).catch(
        () => {},
      );
    this.emitEvent('session', { sessionId: this.threadId, model: res.model });
    this.loadModels().catch((err) => this.emitEvent('info', { text: `model/list failed: ${errorText(err)}` }));
    this.emitEvent('status', { busy: this.busy });
  }

  /** Models available to this account, from the app-server `model/list` method. */
  async loadModels() {
    const all = [];
    let cursor = null;
    do {
      const res = await this.request('model/list', cursor ? { cursor } : {});
      all.push(...(res.data || []));
      cursor = res.nextCursor;
    } while (cursor);
    this.models = all
      .filter((m) => !m.hidden)
      .map((m) => ({
        value: m.model,
        label: m.displayName || m.model,
        isDefault: Boolean(m.isDefault),
        description: m.description || '',
        efforts: (m.supportedReasoningEfforts || [])
          .map((e: string | { reasoningEffort: string }) => (typeof e === 'string' ? e : e.reasoningEffort))
          .filter(Boolean),
        defaultEffort: m.defaultReasoningEffort || null,
      }));
    this.emitEvent('models', {});
  }

  get model() {
    return this.config.model || null;
  }

  /** Change the model. It is sent with every following turn/start, so it applies from the next turn. */
  async setModel(model: string): Promise<void> {
    const value = model && model !== 'default' ? model : null;
    this.config.model = value;
    this.emitEvent('info', {
      text: `Model set to ${value || 'default'}${this.activeTurnId ? ' (applies from the next turn)' : ''}.`,
    });
  }

  async send(text: string): Promise<void> {
    this.queue.push(text);
    this.emitEvent('status', { busy: true });
    try {
      await this.start();
    } catch {
      this.queue = [];
      this.emitEvent('status', { busy: false });
      return;
    }
    this.flush();
  }

  /** Start a turn with all queued text. If a turn is active, Codex adds the input to it. */
  async flush(): Promise<void> {
    if (!this.queue.length || !this.threadId) return;
    const text = this.queue.splice(0).join('\n\n');
    try {
      const params: Record<string, unknown> = { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }] };
      // Always send the model explicitly (the account default when none is chosen), so switching back to default is unambiguous.
      const model = this.config.model || this.models?.find((m) => m.isDefault)?.value;
      if (model) params.model = model;
      if (this.config.effort) params.effort = this.config.effort;
      if (this.sandboxOverride) {
        params.sandboxPolicy = this.readOnly
          ? { type: 'readOnly', networkAccess: false }
          : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
      }
      const res = await this.request('turn/start', params);
      if (model) this.resolvedModel = model;
      if (res?.turn?.id && !this.activeTurnId) this.activeTurnId = res.turn.id;
    } catch (err) {
      this.emitEvent('error', { text: `turn/start failed: ${errorText(err)}` });
      if (/method not found|unknown (method|variant|field)|invalid params|missing field/i.test(errorText(err))) {
        this.markUnavailable(`Codex protocol changed: ${errorText(err)}`);
      }
    }
    this.emitEvent('status', { busy: this.busy });
  }

  get effort() {
    return this.config.effort || null;
  }

  /** Reasoning effort is sent with every turn/start, so it applies from the next turn. */
  async setEffort(effort: string | null): Promise<void> {
    this.config.effort = effort && effort !== 'default' ? effort : null;
  }

  markUnavailable(reason: string): void {
    this.available = false;
    this.unavailableReason = reason;
    this.emitEvent('unavailable', { reason });
  }

  /** Role changed: switch between read-only and workspace-write from the next turn. */
  async reconfigure({ readOnly }: ReconfigureOptions): Promise<void> {
    if (Boolean(readOnly) !== this.readOnly) this.sandboxOverride = true;
    this.readOnly = Boolean(readOnly);
  }

  async restart() {
    this.available = true;
    this.unavailableReason = null;
    if (this.proc) {
      this.stopping = true;
      await this.proc.kill();
    }
    await this.start().catch(() => {});
  }

  async interrupt() {
    if (!this.activeTurnId || !this.threadId) return;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
    } catch (err) {
      this.emitEvent('error', { text: `turn/interrupt failed: ${errorText(err)}` });
    }
  }

  /** Answer an approval request that the UI showed to the user. */
  respondApproval(requestId: string, decision: string): boolean {
    const a = this.approvals.get(requestId);
    if (!a) return false;
    this.approvals.delete(requestId);
    this.proc?.write({ id: a.rpcId, result: { decision } });
    this.emitEvent('status', { busy: this.busy });
    return true;
  }

  /**
   * Conversation closed: archive the thread so it leaves Codex's thread list (and the ChatGPT app's
   * history). Agent Bridge keeps its own history, and restoring unarchives the thread before resuming it.
   * Set codex.archiveOnClose to false in config.json to keep the threads listed.
   */
  async shutdown() {
    if (this.threadId && this.proc && this.config.archiveOnClose !== false) {
      const archive = this.request('thread/archive', { threadId: this.threadId }).catch((err) =>
        this.emitEvent('info', { text: `Could not archive the Codex thread: ${errorText(err)}` }),
      );
      await Promise.race([archive, new Promise((r) => setTimeout(r, 3000))]);
    }
    this.stopping = true;
    await this.proc?.kill();
  }

  handle(m: any): void {
    // Response to one of our requests.
    if (m.id !== undefined && m.method === undefined) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error.message || JSON.stringify(m.error)));
      else w.resolve(m.result);
      return;
    }
    // Request from the server.
    if (m.id !== undefined && m.method) {
      this.handleServerRequest(m);
      return;
    }
    this.handleNotification(m.method, m.params || {});
  }

  handleServerRequest(m: any): void {
    const p = m.params || {};
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
      const key = `codex-${m.id}`;
      this.approvals.set(key, { rpcId: m.id, method: m.method });
      const isCommand = m.method.startsWith('item/commandExecution');
      this.emitEvent('approval', {
        requestId: key,
        title: isCommand ? 'Codex wants to run a command' : 'Codex wants to change files',
        matchText: isCommand ? String(p.command || '') : '',
        cwd: p.cwd || undefined,
        // Files this patch deletes (fileChange items are announced before their approval request).
        deletePaths: isCommand
          ? []
          : (this.fileChanges.get(p.itemId) || []).filter((c) => /delete/i.test(JSON.stringify(c.kind))).map((c) => c.path),
        detail: [p.command && `$ ${p.command}`, p.cwd && `in ${p.cwd}`, p.reason, p.grantRoot && `write access to ${p.grantRoot}`]
          .filter(Boolean)
          .join('\n'),
        decisions: ['accept', 'acceptForSession', 'decline'],
      });
      this.emitEvent('status', { busy: this.busy });
      return;
    }
    if (m.method === 'mcpServer/elicitation/request') {
      this.proc?.write({ id: m.id, result: { action: 'decline', content: null, _meta: null } });
      this.emitEvent('info', { text: 'Declined an MCP elicitation request (not supported by the bridge).' });
      return;
    }
    this.proc?.write({ id: m.id, error: { code: -32601, message: `agent-bridge does not handle ${m.method}` } });
    this.emitEvent('info', { text: `Rejected unsupported server request: ${m.method}` });
  }

  handleNotification(method: string, p: any): void {
    switch (method) {
      case 'turn/started':
        this.activeTurnId = p.turn?.id || this.activeTurnId;
        this.turnMessages = [];
        this.emitEvent('status', { busy: true });
        break;

      case 'item/agentMessage/delta':
        this.emitEvent('delta', { key: p.itemId, text: p.delta });
        break;

      case 'item/started': {
        const it = p.item || {};
        if (it.type === 'commandExecution') {
          this.emitEvent('tool', { key: it.id, title: 'shell', detail: clip(it.command, 300) });
        } else if (it.type === 'fileChange') {
          this.fileChanges.set(it.id, it.changes || []);
          this.emitEvent('tool', {
            key: it.id,
            title: 'edit',
            detail: (it.changes || []).map((c: any) => `${c.kind?.type || c.kind || ''} ${c.path}`).join('\n'),
          });
        } else if (it.type === 'mcpToolCall') {
          this.emitEvent('tool', { key: it.id, title: `${it.server}.${it.tool}`, detail: clip(JSON.stringify(it.arguments), 200) });
        } else if (it.type === 'webSearch') {
          this.emitEvent('tool', { key: it.id, title: 'web search', detail: clip(it.query || '', 200) });
        }
        break;
      }

      case 'item/completed': {
        const it = p.item || {};
        if (it.type === 'agentMessage') {
          this.turnMessages.push({ text: it.text || '', phase: it.phase });
          this.emitEvent('text', { key: it.id, text: it.text || '', final: true });
        } else if (it.type === 'commandExecution') {
          const ok = it.exitCode === 0 || it.exitCode === null;
          this.emitEvent('toolResult', {
            key: it.id,
            ok,
            detail: ok ? undefined : `exit ${it.exitCode}\n${clip(it.aggregatedOutput || '', 400)}`,
          });
        } else if (it.type === 'fileChange' || it.type === 'mcpToolCall' || it.type === 'webSearch') {
          this.emitEvent('toolResult', { key: it.id, ok: !/fail|declin/i.test(String(it.status)) });
        }
        break;
      }

      case 'turn/completed': {
        const turn = p.turn || {};
        this.activeTurnId = null;
        if (turn.status === 'completed') this.emitEvent('account', { state: 'ok' });
        const finals = this.turnMessages.filter((x) => x.phase === 'final_answer');
        const chosen = finals.length ? finals : this.turnMessages.slice(-1);
        const text = chosen.map((x) => x.text).join('\n\n');
        this.turnMessages = [];
        this.emitEvent('turnEnd', {
          text,
          ok: turn.status === 'completed',
          detail:
            turn.status !== 'completed'
              ? `${turn.status}${turn.error ? `: ${turn.error.message || JSON.stringify(turn.error)}` : ''}`
              : undefined,
        });
        this.emitEvent('status', { busy: this.busy });
        if (this.queue.length) this.flush();
        break;
      }

      case 'account/rateLimits/updated': {
        const rl = p.rateLimits || {};
        const windows = [rl.primary, rl.secondary].filter(Boolean);
        const full = windows.find((w) => w.usedPercent >= 100);
        if (rl.rateLimitReachedType || full) {
          const resets = (full || windows[0])?.resetsAt;
          this.emitEvent('account', {
            state: 'rate_limited',
            resetsAt: resets ? resets * 1000 : null,
            detail: 'Codex usage limit reached.',
          });
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        // Thread totals (cumulative, also across resume): new tokens = total - cached input.
        const t = p.tokenUsage?.total;
        if (t && typeof t.totalTokens === 'number') {
          const cached = t.cachedInputTokens || 0;
          this.tokens = Math.max(this.tokens, t.totalTokens - cached);
          this.cachedTokens = Math.max(this.cachedTokens, cached);
          this.emitEvent('usage', { tokens: this.tokens });
        }
        break;
      }

      case 'error':
        {
          const info = p.error?.codexErrorInfo;
          if (info === 'unauthorized')
            this.emitEvent('account', { state: 'no_access', detail: p.error?.message || 'Codex is not authorized: sign in again.' });
          else if (!p.willRetry && (info === 'rateLimitExceeded' || info === 'usageLimitExceeded'))
            this.emitEvent('account', { state: 'rate_limited', detail: p.error?.message || 'Codex usage limit reached.' });
        }
        this.emitEvent('error', { text: `Codex error${p.willRetry ? ' (retrying)' : ''}: ${p.error?.message || JSON.stringify(p.error)}` });
        break;

      case 'serverRequest/resolved': {
        const key = `codex-${p.requestId}`;
        this.approvals.delete(key);
        this.emitEvent('approvalClosed', { requestId: key });
        this.emitEvent('status', { busy: this.busy });
        break;
      }

      default:
        break;
    }
  }
}

/** Message of an unknown thrown value. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
