import { EventEmitter } from 'node:events';
import { spawnJsonl } from './proc.mjs';

/**
 * Drives Claude Code in headless mode:
 *   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
 * One long-lived process receives user messages on stdin; each answer ends with a `result` event.
 *
 * Emits 'event' objects: { kind, ... } (see server.mjs for the list of kinds).
 */
export class ClaudeAgent extends EventEmitter {
  constructor({ id = 'claude', name = 'Claude', cwd, config, systemPromptFile, readOnly = false, tokens = 0 }) {
    super();
    this.id = id;
    this.name = name;
    this.label = name;
    this.readOnly = readOnly;
    this.tokens = tokens;
    this.available = true;
    this.unavailableReason = null;
    this.stderrTail = '';
    this.gotOutput = false;
    this.cwd = cwd;
    this.config = config || {};
    this.systemPromptFile = systemPromptFile;
    this.sessionId = this.config.resumeSessionId || null;
    this.pending = 0;
    this.proc = null;
    this.streamedMessages = new Set();
    this.currentMessageId = null;
    this.models = [];
    this.resolvedModel = null;
    this.restartWhenIdle = false;
    this.approvals = new Map();
  }

  /** Answer a permission prompt shown in the page. decision: accept | acceptForSession | decline */
  respondApproval(requestId, decision, reason) {
    const a = this.approvals.get(requestId);
    if (!a) return false;
    this.approvals.delete(requestId);
    let response;
    if (decision === 'accept' || decision === 'acceptForSession') {
      response = { behavior: 'allow', updatedInput: a.input };
      if (decision === 'acceptForSession') {
        // Keep "always allow" in memory for this session only; never write the project's settings files.
        const rules = (a.suggestions || []).filter((s) => s.type === 'addRules' && s.behavior === 'allow');
        if (rules.length) response.updatedPermissions = rules.map((s) => ({ ...s, destination: 'session' }));
      }
    } else {
      response = { behavior: 'deny', message: reason || 'The user declined this action in Agent Bridge.' };
    }
    this.proc?.write({ type: 'control_response', response: { subtype: 'success', request_id: a.rpcId, response } });
    this.emitEvent('status', { busy: this.busy });
    return true;
  }

  closeApprovals() {
    for (const key of this.approvals.keys()) this.emitEvent('approvalClosed', { requestId: key, decision: 'cancelled' });
    this.approvals.clear();
  }

  handleControlRequest(m) {
    const r = m.request || {};
    if (r.subtype === 'can_use_tool') {
      if (r.tool_name === 'AskUserQuestion') {
        this.proc.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: m.request_id,
            response: { behavior: 'deny', message: 'Questions are not supported in Agent Bridge. Ask the user in your message and end it with [[DONE]].' },
          },
        });
        return;
      }
      const key = `claude-${m.request_id}`;
      this.approvals.set(key, { rpcId: m.request_id, input: r.input, suggestions: r.permission_suggestions });
      const hasRule = (r.permission_suggestions || []).some((s) => s.type === 'addRules');
      this.emitEvent('approval', {
        requestId: key,
        title: `Claude wants to use ${r.display_name || r.tool_name}`,
        matchText: `${r.tool_name} ${r.input?.command || r.input?.file_path || JSON.stringify(r.input || {})}`,
        detail: [toolDetail(r.tool_name, r.input), r.description && r.description !== r.input?.command ? r.description : null, r.blocked_path && `path: ${r.blocked_path}`, r.decision_reason]
          .filter((x) => typeof x === 'string' && x)
          .join('\n'),
        decisions: hasRule ? ['accept', 'acceptForSession', 'decline'] : ['accept', 'decline'],
      });
      this.emitEvent('status', { busy: this.busy });
      return;
    }
    this.proc.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `agent-bridge does not handle ${r.subtype}` } });
    this.emitEvent('info', { text: `Rejected unsupported control request: ${r.subtype}` });
  }

  /** Model chosen in the UI or config; null means the CLI default. */
  get model() {
    return this.config.model || null;
  }

  get busy() {
    return this.pending > 0;
  }

  emitEvent(kind, data = {}) {
    this.emit('event', { agent: this.id, kind, ...data });
  }

  buildArgs() {
    const c = this.config;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (c.model) args.push('--model', c.model);
    if (c.effort) args.push('--effort', c.effort);
    if (c.permissionMode) args.push('--permission-mode', c.permissionMode);
    // Roles that must not edit files lose the file-editing tools.
    if (this.readOnly) args.push('--disallowedTools', 'Edit,Write,NotebookEdit');
    if (Array.isArray(c.allowedTools) && c.allowedTools.length) {
      args.push('--allowedTools', c.allowedTools.join(','));
    }
    // Route permission prompts back to us as `can_use_tool` control requests (the channel the Agent SDK's canUseTool uses).
    if (c.permissionPrompts !== false) args.push('--permission-prompt-tool', 'stdio');
    if (this.systemPromptFile) args.push('--append-system-prompt-file', this.systemPromptFile);
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (Array.isArray(c.extraArgs)) args.push(...c.extraArgs);
    return args;
  }

  start() {
    const command = this.config.command || 'claude';
    const args = this.buildArgs();
    this.emitEvent('info', { text: `Starting: ${command} ${args.join(' ')}` });
    this.proc = spawnJsonl(command, args, {
      cwd: this.cwd,
      shell: false,
      onMessage: (m) => this.handle(m),
      onText: (t) => this.emitEvent('info', { text: t }),
      onStderr: (t) => {
        this.stderrTail = (this.stderrTail + String(t)).slice(-800);
        this.emitEvent('stderr', { text: String(t) });
      },
      onExit: (code) => {
        const wasExpected = this.stopping;
        const neverStarted = !this.gotOutput;
        this.stopping = false;
        this.proc = null;
        this.pending = 0;
        this.closeApprovals();
        this.emitEvent('status', { busy: false });
        if (!wasExpected) this.emitEvent('error', { text: `Claude process exited (code ${code}).${this.stderrTail.trim() ? ` ${this.stderrTail.trim().slice(-300)}` : ''}` });
        // A process that dies before producing any output usually means the CLI changed or is broken.
        if (!wasExpected && neverStarted) this.markUnavailable(`Claude Code did not start (exit code ${code}).`);
      },
    });
    // Same control message the Agent SDK sends first; its answer lists the models this account can use.
    this.proc.write({ type: 'control_request', request_id: `init-${Date.now()}`, request: { subtype: 'initialize' } });
    this.emitEvent('status', { busy: false });
  }

  /**
   * Change the model. Claude Code takes --model at start, so the process is restarted with
   * --resume on the same session. If a turn is running, the restart waits for it to end.
   */
  async setModel(model) {
    this.config.model = model && model !== 'default' ? model : null;
    if (this.busy) {
      this.restartWhenIdle = true;
      this.emitEvent('info', { text: `Model will change to ${model || 'default'} after the current turn.` });
      return;
    }
    await this.restart();
    this.emitEvent('info', { text: `Model set to ${model || 'default'}.` });
  }

  markUnavailable(reason) {
    this.available = false;
    this.unavailableReason = reason;
    this.emitEvent('unavailable', { reason });
  }

  /** Role changed: apply read-only mode and new instructions by restarting on the same session. */
  async reconfigure({ readOnly }) {
    this.readOnly = Boolean(readOnly);
    if (this.busy) {
      this.restartWhenIdle = true;
      return;
    }
    if (this.proc) await this.restart();
  }

  get effort() {
    return this.config.effort || null;
  }

  /** Effort is a start flag (--effort), so it is applied like a model change. */
  async setEffort(effort) {
    this.config.effort = effort && effort !== 'default' ? effort : null;
    if (this.busy) {
      this.restartWhenIdle = true;
      return;
    }
    if (this.proc) await this.restart();
  }

  async restart() {
    this.restartWhenIdle = false;
    this.available = true;
    this.unavailableReason = null;
    this.gotOutput = false;
    this.stderrTail = '';
    if (this.proc) {
      this.stopping = true;
      await this.proc.kill();
    }
    this.start();
  }

  send(text) {
    if (!this.proc) this.start();
    this.pending += 1;
    this.emitEvent('status', { busy: true });
    this.proc.write({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  /** Stop the current work: kill the process and restart it on the same session. */
  async interrupt() {
    if (!this.proc || !this.busy) return;
    this.stopping = true;
    await this.proc.kill();
    this.pending = 0;
    this.emitEvent('info', { text: 'Claude interrupted; session will resume on next message.' });
    this.emitEvent('status', { busy: false });
  }

  async shutdown() {
    this.stopping = true;
    await this.proc?.kill();
  }

  handle(m) {
    this.gotOutput = true;
    switch (m.type) {
      case 'control_request':
        this.handleControlRequest(m);
        break;

      case 'control_response': {
        const r = m.response?.response || {};
        if (Array.isArray(r.models)) {
          this.models = r.models.map((x) => ({ value: x.value, label: x.displayName || x.value, resolved: x.resolvedModel || null, description: x.description || '', efforts: x.supportsEffort ? x.supportedEffortLevels || [] : [] }));
          const current = this.models.find((x) => x.value === (this.model || 'default'));
          if (current?.resolved) this.resolvedModel = current.resolved;
          this.emitEvent('models', {});
        }
        break;
      }

      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id || this.sessionId;
          this.resolvedModel = m.model || this.resolvedModel;
          this.emitEvent('session', { sessionId: this.sessionId, model: m.model });
        } else if (m.subtype === 'api_retry') {
          this.emitEvent('info', { text: `API retry (${m.error || 'error'})` });
        } else if (m.subtype === 'permission_denied' || /denied/i.test(m.subtype || '')) {
          this.emitEvent('info', { text: `Permission denied: ${summarize(m)}` });
        }
        break;

      case 'stream_event': {
        if (m.parent_tool_use_id) break; // subagent internals: keep the view readable
        const ev = m.event || {};
        if (ev.type === 'message_start') {
          this.currentMessageId = ev.message?.id;
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.streamedMessages.add(this.currentMessageId);
          this.emitEvent('delta', { key: `${this.currentMessageId}:${ev.index}`, text: ev.delta.text });
        }
        break;
      }

      case 'rate_limit_event': {
        const info = m.rate_limit_info || {};
        if (info.status && !/^allowed/.test(info.status)) {
          this.emitEvent('account', { state: 'rate_limited', resetsAt: info.resetsAt ? info.resetsAt * 1000 : null, detail: `Usage limit reached (${info.rateLimitType || 'limit'}).` });
        }
        break;
      }

      case 'assistant': {
        if (m.parent_tool_use_id) break;
        const msg = m.message || {};
        if (m.error === 'authentication_failed' || m.error === 'billing_error') {
          this.emitEvent('account', { state: 'no_access', detail: m.error === 'billing_error' ? 'Billing problem: plan inactive or no credit.' : 'Authentication failed: sign in again.' });
        } else if (m.error === 'rate_limit') {
          this.emitEvent('account', { state: 'rate_limited', detail: 'Usage limit reached.' });
        }
        (msg.content || []).forEach((block, i) => {
          if (block.type === 'text' && !this.streamedMessages.has(msg.id)) {
            this.emitEvent('text', { key: `${msg.id}:${i}`, text: block.text });
          } else if (block.type === 'tool_use') {
            this.emitEvent('tool', { key: block.id, title: block.name, detail: toolDetail(block.name, block.input) });
          }
        });
        break;
      }

      case 'user': {
        if (m.parent_tool_use_id) break;
        for (const block of m.message?.content || []) {
          if (block?.type === 'tool_result' && block.is_error) {
            this.emitEvent('toolResult', { key: block.tool_use_id, ok: false, detail: clip(contentText(block.content), 400) });
          } else if (block?.type === 'tool_result') {
            this.emitEvent('toolResult', { key: block.tool_use_id, ok: true });
          }
        }
        break;
      }

      case 'result':
        this.pending = Math.max(0, this.pending - 1);
        if (m.usage) {
          const u = m.usage;
          this.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          this.emitEvent('usage', { tokens: this.tokens });
        }
        if (m.is_error && /invalid api key|please run \/login|not logged in|oauth token|credit balance|billing|subscription/i.test(String(m.result || ''))) {
          this.emitEvent('account', { state: 'no_access', detail: String(m.result).slice(0, 200) });
        } else if (!m.is_error) {
          this.emitEvent('account', { state: 'ok' });
        }
        this.emitEvent('turnEnd', {
          text: typeof m.result === 'string' ? m.result : '',
          ok: !m.is_error,
          detail: m.is_error ? m.subtype : undefined,
          costUsd: m.total_cost_usd,
        });
        this.emitEvent('status', { busy: this.busy });
        if (!this.busy && this.restartWhenIdle) {
          this.restart().then(() => this.emitEvent('info', { text: `New settings applied (model ${this.model || 'default'}).` }));
        }
        break;

      default:
        break;
    }
  }
}

function toolDetail(name, input = {}) {
  if (input.command) return clip(input.command, 300);
  if (input.file_path) return input.file_path;
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
  if (input.url) return input.url;
  if (input.description) return clip(input.description, 200);
  return clip(JSON.stringify(input), 200);
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
  return '';
}

function summarize(m) {
  return clip(JSON.stringify(m), 300);
}

export function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
