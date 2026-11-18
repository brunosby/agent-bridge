import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { killTree } from './proc.mjs';
import { clip } from './claude-agent.mjs';

/**
 * Drives OpenCode through its official HTTP server (`opencode serve`, https://opencode.ai/docs/server/).
 * One server per agent, bound to 127.0.0.1 with a random password (OPENCODE_SERVER_PASSWORD).
 *
 * - Models: GET /provider -> { all, default, connected }. Models of providers that are not connected
 *   are listed but disabled.
 * - Messages: POST /session/:id/message { parts, model: { providerID, modelID }, agent, system } waits for
 *   the answer; GET /event (SSE) streams text, tool calls and permission requests while it runs.
 * - Permissions: POST /session/:id/permissions/:permissionID { response: once | always | reject }.
 *
 * Any failure of this contract (server not starting, unknown endpoints) marks the agent unavailable.
 */
export class OpenCodeAgent extends EventEmitter {
  constructor({ id = 'opencode', name = 'OpenCode', cwd, config, instructions, readOnly = false, tokens = 0, cachedTokens = 0 }) {
    super();
    this.id = id;
    this.name = name;
    this.label = name;
    this.cwd = cwd;
    this.config = config || {};
    this.instructions = instructions;
    this.readOnly = readOnly;
    this.tokens = tokens;
    this.cachedTokens = cachedTokens;
    this.sessionId = this.config.resumeSessionId || null;
    this.available = true;
    this.unavailableReason = null;
    this.models = [];
    this.resolvedModel = null;
    this.approvals = new Map();
    this.queue = [];
    this.running = false;
    this.ready = null;
    this.proc = null;
    this.sse = null;
    this.assistantMessages = new Set();
    this.toolsSeen = new Set();
  }

  /** Is the CLI on this machine? Used to grey out the provider in the "Add agent" form. */
  static probe(cfg = {}) {
    if (OpenCodeAgent._probe && Date.now() - OpenCodeAgent._probe.at < 60000) return OpenCodeAgent._probe.result;
    const command = cfg.command || 'opencode';
    const isWin = process.platform === 'win32';
    const r = spawnSync(isWin ? 'cmd.exe' : command, isWin ? ['/d', '/s', '/c', command, '--version'] : ['--version'], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
    const ok = r.status === 0 && /\d+\.\d+/.test(r.stdout || '');
    const result = ok ? { available: true, version: r.stdout.trim() } : { available: false, reason: 'OpenCode is not installed or does not run. See Settings > Accounts.' };
    OpenCodeAgent._probe = { at: Date.now(), result };
    return result;
  }

  get busy() {
    return this.running || this.queue.length > 0;
  }

  get model() {
    return this.config.model || null;
  }

  emitEvent(kind, data = {}) {
    this.emit('event', { agent: this.id, kind, ...data });
  }

  markUnavailable(reason) {
    this.available = false;
    this.unavailableReason = reason;
    this.emitEvent('unavailable', { reason });
  }

  get effort() {
    return null;
  }

  async setEffort() {
    throw new Error('Effort is not configurable for OpenCode agents in Agent Bridge.');
  }

  setInstructions(text) {
    this.instructions = text;
  }

  async reconfigure({ readOnly }) {
    this.readOnly = Boolean(readOnly);
  }

  // ---------- server ----------
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.boot().catch((err) => {
      this.ready = null;
      this.emitEvent('error', { text: `OpenCode start failed: ${err.message}` });
      this.markUnavailable(`OpenCode server did not start: ${err.message}`);
      throw err;
    });
    return this.ready;
  }

  async boot() {
    const port = await freePort();
    this.password = crypto.randomBytes(16).toString('hex');
    this.base = `http://127.0.0.1:${port}`;
    const command = this.config.command || 'opencode';
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1', ...(this.config.extraArgs || [])];
    this.emitEvent('info', { text: `Starting: ${command} ${args.join(' ')}` });
    const isWin = process.platform === 'win32';
    this.stopping = false;
    this.proc = spawn(isWin ? 'cmd.exe' : command, isWin ? ['/d', '/s', '/c', command, ...args] : args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this.password },
    });
    this.proc.stdout.on('data', (d) => this.emitEvent('stderr', { text: String(d) }));
    this.proc.stderr.on('data', (d) => this.emitEvent('stderr', { text: String(d) }));
    this.proc.on('exit', (code) => {
      const expected = this.stopping;
      this.proc = null;
      this.ready = null;
      this.running = false;
      this.sse?.abort();
      this.closeApprovals();
      this.emitEvent('status', { busy: false });
      if (!expected) {
        this.emitEvent('error', { text: `OpenCode server exited (code ${code}).` });
        this.markUnavailable(`OpenCode server stopped (exit code ${code}).`);
      }
    });

    // Wait for the documented health endpoint.
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const h = await this.http('GET', '/global/health');
        if (h) break;
      } catch {
        // not up yet
      }
      if (!this.proc) throw new Error('the server process exited');
      if (Date.now() > deadline) throw new Error('no answer from /global/health after 30 s');
      await sleep(400);
    }

    await this.loadModels();
    if (this.sessionId) {
      try {
        await this.http('GET', `/session/${encodeURIComponent(this.sessionId)}`);
      } catch {
        this.emitEvent('info', { text: 'Could not find the earlier OpenCode session; starting a new one.' });
        this.sessionId = null;
      }
    }
    if (!this.sessionId) {
      // Ask before shell commands, edits and web fetches so requests reach the approval panel (and bypass rules).
      const ask = (this.config.askFor || ['bash', 'edit', 'webfetch']).map((permission) => ({ permission, pattern: '*', action: 'ask' }));
      const s = await this.http('POST', '/session', { title: `Agent Bridge · ${this.name}`, permission: ask });
      if (!s?.id) throw new Error('POST /session returned no id (API changed?)');
      this.sessionId = s.id;
    }
    this.emitEvent('session', { sessionId: this.sessionId });
    this.listen();
    this.emitEvent('status', { busy: this.busy });
  }

  async http(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${clip(await res.text().catch(() => ''), 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  }

  async loadModels() {
    const p = await this.http('GET', '/provider');
    if (!p || !Array.isArray(p.all)) throw new Error('GET /provider did not return { all, connected } (API changed?)');
    // OpenCode knows hundreds of providers; only the connected ones are listed. With freeOnly (default),
    // models that cost anything are listed but disabled.
    const connected = new Set(p.connected || []);
    const freeOnly = this.config.freeOnly !== false;
    const out = [];
    for (const prov of p.all.filter((x) => connected.has(x.id))) {
      const models = Array.isArray(prov.models) ? prov.models : Object.values(prov.models || {});
      for (const m of models) {
        const modelId = m.id || m.modelID;
        if (!modelId) continue;
        const free = Number(m.cost?.input || 0) === 0 && Number(m.cost?.output || 0) === 0;
        const blocked = freeOnly && !free;
        out.push({
          value: `${prov.id}/${modelId}`,
          label: `${prov.name || prov.id}: ${m.name || modelId}${free ? ' (free)' : ''}`,
          description: free ? 'Free model.' : `Paid: ${m.cost?.input ?? '?'} / ${m.cost?.output ?? '?'} per 1M tokens (input/output).`,
          disabled: blocked,
          disabledReason: blocked ? 'Paid model: only free models are enabled (opencode.freeOnly in config.json).' : null,
        });
      }
    }
    out.sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.label.localeCompare(b.label));
    // The account default may be a paid model; mark the first enabled model as the default instead.
    const def = p.default?.opencode ? `opencode/${p.default.opencode}` : null;
    const defEntry = out.find((m) => m.value === def && !m.disabled) || out.find((m) => !m.disabled);
    if (defEntry) defEntry.isDefault = true;
    this.models = out;
    if (!this.config.model && defEntry) this.config.model = defEntry.value;
    this.resolvedModel = this.config.model || null;
    this.emitEvent('models', {});
  }

  async setModel(model) {
    this.config.model = model && model !== 'default' ? model : null;
    this.emitEvent('info', { text: `Model set to ${this.config.model || 'default'} (applies from the next message).` });
  }

  // ---------- live events ----------
  async listen() {
    this.sse?.abort();
    const ctrl = new AbortController();
    this.sse = ctrl;
    try {
      const res = await fetch(`${this.base}/event`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try {
            this.onEvent(JSON.parse(data));
          } catch {
            // ignore malformed events
          }
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) this.emitEvent('info', { text: `OpenCode event stream closed: ${err.message}` });
    }
  }

  onEvent(ev) {
    const type = ev.type || '';
    const p = ev.properties || {};
    const sid = p.sessionID || p.part?.sessionID || p.info?.sessionID;
    if (sid && sid !== this.sessionId) return;
    if (type === 'message.part.delta') {
      // Streaming text of the assistant: { messageID, partID, field: "text", delta }
      if (p.field === 'text' && p.partID) this.emitEvent('delta', { key: p.partID, text: p.delta || '' });
      return;
    }
    if (type === 'message.part.updated' && p.part) {
      const part = p.part;
      if (part.type === 'text' && this.assistantMessages.has(part.messageID)) {
        this.emitEvent('text', { key: part.id, text: part.text || '' });
      } else if (part.type === 'tool') {
        const st = part.state || {};
        // The first update ("pending") has no input yet; announce the tool once its input is known.
        if (!this.toolsSeen.has(part.id) && st.status !== 'pending') {
          this.toolsSeen.add(part.id);
          this.emitEvent('tool', { key: part.id, title: part.tool || 'tool', detail: clip(st.input?.command || st.input?.filePath || st.title || JSON.stringify(st.input || {}), 300) });
        }
        if (st.status === 'completed' || st.status === 'error') {
          this.emitEvent('toolResult', { key: part.id, ok: st.status === 'completed', detail: st.status === 'error' ? clip(st.error || '', 300) : undefined });
        }
      }
    } else if (type === 'message.updated' && p.info?.role === 'assistant') {
      this.assistantMessages.add(p.info.id);
    } else if (type === 'permission.asked') {
      // { id, sessionID, permission: "bash" | "edit" | ..., patterns[], metadata: { command, filepath, ... }, always[] }
      const key = `oc${this.id}-${p.id}`;
      if (this.approvals.has(key)) return;
      this.approvals.set(key, { permissionId: p.id });
      const what = p.permission || 'an action';
      const patterns = (p.patterns || []).join(' ');
      const command = p.metadata?.command;
      const file = p.metadata?.filepath || p.metadata?.filePath;
      this.emitEvent('approval', {
        requestId: key,
        title: `OpenCode wants to use ${what}`,
        matchText: what === 'bash' ? command || patterns : `${what} ${file || patterns}`,
        detail: [command && `$ ${command}`, file, !command && !file ? patterns : null, p.always?.length ? `"Allow for session" covers: ${p.always.join(', ')}` : null]
          .filter(Boolean)
          .join('\n'),
        decisions: ['accept', 'acceptForSession', 'decline'],
      });
      this.emitEvent('status', { busy: this.busy });
    } else if (type === 'permission.replied') {
      const key = `oc${this.id}-${p.requestID || p.permissionID || p.id}`;
      if (this.approvals.delete(key)) this.emitEvent('approvalClosed', { requestId: key });
    } else if (type === 'session.error') {
      const msg = p.error?.data?.message || p.error?.message || p.error?.name || 'unknown error';
      this.emitEvent('error', { text: `OpenCode error: ${msg}` });
      if (/auth|api key|unauthori[sz]ed|credit|billing|payment/i.test(msg)) this.emitEvent('account', { state: 'no_access', detail: clip(msg, 200) });
      else if (/rate limit|quota|too many requests/i.test(msg)) this.emitEvent('account', { state: 'rate_limited', detail: clip(msg, 200) });
    }
  }

  respondApproval(requestId, decision) {
    const a = this.approvals.get(requestId);
    if (!a) return false;
    this.approvals.delete(requestId);
    const response = decision === 'accept' ? 'once' : decision === 'acceptForSession' ? 'always' : 'reject';
    this.http('POST', `/session/${encodeURIComponent(this.sessionId)}/permissions/${encodeURIComponent(a.permissionId)}`, { response }).catch((err) =>
      this.emitEvent('error', { text: `Could not answer the OpenCode permission request: ${err.message}` }),
    );
    this.emitEvent('status', { busy: this.busy });
    return true;
  }

  closeApprovals() {
    for (const key of this.approvals.keys()) this.emitEvent('approvalClosed', { requestId: key, decision: 'cancelled' });
    this.approvals.clear();
  }

  // ---------- messages ----------
  async send(text) {
    this.queue.push(text);
    this.emitEvent('status', { busy: true });
    try {
      await this.start();
    } catch {
      this.queue = [];
      this.emitEvent('status', { busy: false });
      return;
    }
    this.pump();
  }

  /** One message at a time: POST /session/:id/message waits for the full answer. */
  async pump() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const text = this.queue.splice(0).join('\n\n');
    const body = { parts: [{ type: 'text', text }], agent: this.readOnly ? 'plan' : 'build', system: this.instructions };
    const model = this.config.model;
    if (model) {
      const i = model.indexOf('/');
      body.model = { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
    }
    try {
      const res = await this.http('POST', `/session/${encodeURIComponent(this.sessionId)}/message`, body);
      const info = res?.info || {};
      const parts = res?.parts || [];
      const answer = parts.filter((x) => x.type === 'text').map((x) => x.text || '').join('\n').trim();
      for (const x of parts.filter((x) => x.type === 'text')) this.emitEvent('text', { key: x.id || `${info.id}-text`, text: x.text || '', final: true });
      const t = info.tokens || {};
      const used = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.write || 0);
      this.cachedTokens += t.cache?.read || 0;
      if (used) {
        this.tokens += used;
        this.emitEvent('usage', { tokens: this.tokens });
      }
      if (info.providerID && info.modelID) this.resolvedModel = `${info.providerID}/${info.modelID}`;
      if (info.error) {
        const msg = info.error.data?.message || info.error.message || info.error.name || 'error';
        this.emitEvent('turnEnd', { text: answer, ok: false, detail: clip(msg, 300) });
      } else {
        this.emitEvent('account', { state: 'ok' });
        this.emitEvent('turnEnd', { text: answer, ok: true });
      }
    } catch (err) {
      this.emitEvent('error', { text: `OpenCode message failed: ${err.message}` });
      if (/HTTP 404|HTTP 405/.test(err.message)) this.markUnavailable(`OpenCode API changed: ${err.message}`);
      this.emitEvent('turnEnd', { text: '', ok: false, detail: clip(err.message, 300) });
    }
    this.running = false;
    this.emitEvent('status', { busy: this.busy });
    if (this.queue.length) this.pump();
  }

  async interrupt() {
    if (!this.running || !this.sessionId) return;
    try {
      await this.http('POST', `/session/${encodeURIComponent(this.sessionId)}/abort`);
    } catch (err) {
      this.emitEvent('error', { text: `OpenCode abort failed: ${err.message}` });
    }
  }

  async restart() {
    this.available = true;
    this.unavailableReason = null;
    await this.shutdown();
    OpenCodeAgent._probe = null;
    await this.start().catch(() => {});
  }

  async shutdown() {
    this.stopping = true;
    this.sse?.abort();
    if (this.proc) await killTree(this.proc);
    this.proc = null;
    this.ready = null;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
