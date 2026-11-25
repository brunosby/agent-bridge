import type { ProviderEventArgs } from '../core/types.ts';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { providerCommand } from './windows-command.ts';
import { spawnJsonl, type JsonlProcess } from './process.ts';
import type { Agent, AgentOptions, DriverConfig, ModelInfo, ReconfigureOptions } from '../core/types.ts';

interface ClaudeApproval {
  rpcId: string;
  input: unknown;
  suggestions?: { type: string; behavior?: string; [k: string]: unknown }[];
}

/**
 * Drives Claude Code in headless mode:
 *   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
 * One long-lived process receives user messages on stdin; each answer ends with a `result` event.
 *
 * Emits 'event' objects: { kind, ... } (see src/server/ for how they are used).
 */
export class ClaudeAgent extends EventEmitter implements Agent {
  id: string;
  name: string;
  label: string;
  cwd: string;
  config: DriverConfig;
  systemPromptFile?: string;
  readOnly: boolean;
  maxTurns: number | null;
  profile: 'full' | 'lean';
  skillsOff: string[];
  skillsOnly: string[] | null;
  tokens: number;
  cachedTokens: number;
  available: boolean;
  unavailableReason: string | null;
  stderrTail: string;
  sessionId: string | null;
  unconfirmed = new Map<string, string | undefined>();
  activeBatch: { uuid: string; taskIds: string[] } | null = null;
  proc: JsonlProcess | null;
  streamedMessages: Set<string | null>;
  currentMessageId: string | null;
  models: ModelInfo[];
  resolvedModel: string | null;
  restartWhenIdle: boolean;
  approvals: Map<string, ClaudeApproval>;
  commands: { name: string; description: string }[] = [];
  stopping = false;

  constructor({
    id = 'claude',
    name = 'Claude',
    cwd,
    config,
    systemPromptFile,
    readOnly = false,
    tokens = 0,
    cachedTokens = 0,
    maxTurns = null,
    profile = 'full',
    skillsOff = [],
    skillsOnly = null,
  }: AgentOptions) {
    super();
    this.id = id;
    this.name = name;
    this.label = name;
    this.readOnly = readOnly;
    this.maxTurns = maxTurns;
    this.profile = profile;
    this.skillsOff = skillsOff;
    this.skillsOnly = skillsOnly;
    this.tokens = tokens;
    this.cachedTokens = cachedTokens;
    this.available = true;
    this.unavailableReason = null;
    this.stderrTail = '';
    this.cwd = cwd;
    this.config = config || {};
    this.systemPromptFile = systemPromptFile;
    this.sessionId = this.config.resumeSessionId || null;
    this.proc = null;
    this.streamedMessages = new Set();
    this.currentMessageId = null;
    this.models = [];
    this.resolvedModel = null;
    this.restartWhenIdle = false;
    this.approvals = new Map();
  }

  /** Answer a permission prompt shown in the page. decision: accept | acceptForSession | decline */
  respondApproval(requestId: string, decision: string, reason?: string, command?: string): boolean {
    const a = this.approvals.get(requestId);
    if (!a) return false;
    this.approvals.delete(requestId);
    let response: Record<string, unknown>;
    if (decision === 'accept' || decision === 'acceptForSession') {
      response = { behavior: 'allow', updatedInput: command && a.input && typeof a.input === 'object' ? { ...a.input, command } : a.input };
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

  approveShellCommand(requestId: string, command: string): boolean {
    return this.respondApproval(requestId, 'accept', undefined, command);
  }

  closeApprovals() {
    for (const key of this.approvals.keys()) this.emitEvent('approvalClosed', { requestId: key, decision: 'cancelled' });
    this.approvals.clear();
  }

  handleControlRequest(m: any): void {
    const r = m.request || {};
    if (r.subtype === 'can_use_tool') {
      if (r.tool_name === 'AskUserQuestion') {
        this.proc?.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: m.request_id,
            response: {
              behavior: 'deny',
              message: 'Questions are not supported in Agent Bridge. Ask the user in your message and end it with [[DONE]].',
            },
          },
        });
        return;
      }
      const key = `claude-${m.request_id}`;
      const shell = r.tool_name === 'Bash' ? 'bash' : r.tool_name === 'PowerShell' ? 'powershell' : undefined;
      const suggestions = shell ? [] : r.permission_suggestions;
      this.approvals.set(key, { rpcId: m.request_id, input: r.input, suggestions });
      const hasRule = (suggestions || []).some((s: { type: string }) => s.type === 'addRules');
      this.emitEvent('approval', {
        requestId: key,
        title: `Claude wants to use ${r.display_name || r.tool_name}`,
        commandApproval: Boolean(shell),
        shellCommand: shell && typeof r.input?.command === 'string' ? { shell, text: r.input.command } : null,
        cwd: typeof r.input?.cwd === 'string' ? r.input.cwd : undefined,
        matchText: `${r.tool_name} ${r.input?.command || r.input?.file_path || JSON.stringify(r.input || {})}`,
        detail: [
          toolDetail(r.tool_name, r.input),
          r.description && r.description !== r.input?.command ? r.description : null,
          r.blocked_path && `path: ${r.blocked_path}`,
          r.decision_reason,
        ]
          .filter((x) => typeof x === 'string' && x)
          .join('\n'),
        decisions: hasRule ? ['accept', 'acceptForSession', 'decline'] : ['accept', 'decline'],
      });
      this.emitEvent('status', { busy: this.busy });
      return;
    }
    this.proc?.write({
      type: 'control_response',
      response: { subtype: 'error', request_id: m.request_id, error: `agent-bridge does not handle ${r.subtype}` },
    });
    this.emitEvent('info', { text: `Rejected unsupported control request: ${r.subtype}` });
  }

  /** Model chosen in the UI or config; null means the CLI default. */
  get model() {
    return this.config.model || null;
  }

  get busy() {
    return Boolean(this.activeBatch) || this.unconfirmed.size > 0;
  }

  emitEvent<const K extends string>(kind: K, ...[data]: ProviderEventArgs<NoInfer<K>>): void {
    this.emit('event', { agent: this.id, kind, ...data });
  }

  buildArgs(reviewUrl?: string): string[] {
    const c = this.config;
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
    ];
    if (c.model) args.push('--model', c.model);
    if (c.effort) args.push('--effort', c.effort);
    // Step limit of the role (per message): keeps support roles short.
    if (this.maxTurns) args.push('--max-turns', String(this.maxTurns));
    if (c.permissionMode) args.push('--permission-mode', c.permissionMode);
    // Roles that must not edit files lose the file-editing tools; skills switched off for the role are denied.
    // Allow-list with nothing allowed: the Skill tool is removed altogether.
    const skillDeny = this.skillsOnly && !this.skillsOnly.length ? ['Skill'] : this.skillsOff.map((s) => `Skill(${s})`);
    const deny = [...(this.readOnly ? ['Edit', 'Write', 'NotebookEdit'] : []), ...skillDeny];
    if (deny.length) args.push('--disallowedTools', deny.join(','));
    // Lean profile: no hooks (plugins' hooks run on every turn and change how support agents behave).
    args.push(
      '--settings',
      JSON.stringify({
        ...(this.profile === 'lean' ? { disableAllHooks: true } : {}),
        permissions: { ask: ['Bash(git push:*)', 'Bash(gh pr:*)', 'PowerShell(git push:*)', 'PowerShell(gh pr:*)'] },
      }),
    );
    const allowed = Array.isArray(c.allowedTools) ? [...c.allowedTools] : [];
    if (reviewUrl) {
      allowed.push('mcp__bridge_review__bridge_diff');
      args.push(
        '--mcp-config',
        JSON.stringify({
          mcpServers: {
            bridge_review: { type: 'http', url: reviewUrl, headers: { Authorization: 'Bearer ${AGENT_BRIDGE_REVIEW_TOKEN}' } },
          },
        }),
      );
    }
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    // Route permission prompts back to us as `can_use_tool` control requests (the channel the Agent SDK's canUseTool uses).
    if (c.permissionPrompts !== false) args.push('--permission-prompt-tool', 'stdio');
    if (this.systemPromptFile) args.push('--append-system-prompt-file', this.systemPromptFile);
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (Array.isArray(c.extraArgs)) args.push(...c.extraArgs);
    return args;
  }

  start() {
    const command = this.config.command || 'claude';
    const review = this.config.reviewMcp?.();
    const args = this.buildArgs(review?.url);
    this.emitEvent('info', { text: `Starting: ${command} ${args.join(' ')}` });
    const failed = (error: unknown) => {
      this.proc = null;
      const tasks = [...this.unconfirmed.values()].filter((id): id is string => Boolean(id));
      this.unconfirmed.clear();
      if (tasks.length) this.emitEvent('tasksCancelled', { taskIds: tasks });
      this.markUnavailable(
        `Could not start ${command}: ${error instanceof Error ? error.message : String(error)}. Check claude.command in the configuration.`,
      );
    };
    try {
      const launch = providerCommand(command, args, this.cwd);
      this.proc = spawnJsonl(launch.file, launch.args, {
        windowsVerbatimArguments: launch.verbatim,
        onSpawnError: failed,
        cwd: this.cwd,
        shell: false,
        env: review ? { ...process.env, AGENT_BRIDGE_REVIEW_TOKEN: review.token } : process.env,
        onMessage: (m) => this.handle(m),
        onText: (t) => this.emitEvent('info', { text: t }),
        onStderr: (t) => {
          this.stderrTail = (this.stderrTail + String(t)).slice(-800);
          this.emitEvent('stderr', { text: String(t) });
        },
        onExit: (code) => {
          const wasExpected = this.stopping;
          this.stopping = false;
          this.proc = null;
          const taskIds = [...(this.activeBatch?.taskIds || []), ...this.unconfirmed.values()];
          this.activeBatch = null;
          this.unconfirmed.clear();
          const cancelled = taskIds.filter((id): id is string => Boolean(id));
          if (cancelled.length) this.emitEvent('tasksCancelled', { taskIds: cancelled });
          this.closeApprovals();
          this.emitEvent('status', { busy: false });
          if (!wasExpected)
            this.emitEvent('error', {
              text: `Claude process exited (code ${code}).${this.stderrTail.trim() ? ` ${this.stderrTail.trim().slice(-300)}` : ''}`,
            });
          // An unexpected exit is an explicit failure even if the CLI wrote output before it became ready.
          if (!wasExpected) this.markUnavailable(`Claude Code stopped unexpectedly (exit code ${code}).`);
        },
      });
    } catch (error) {
      failed(error);
      return;
    }
    // Same control message the Agent SDK sends first; its answer lists the models this account can use.
    this.proc?.write({ type: 'control_request', request_id: `init-${Date.now()}`, request: { subtype: 'initialize' } });
    this.emitEvent('status', { busy: false });
  }

  /**
   * Change the model. Claude Code takes --model at start, so the process is restarted with
   * --resume on the same session. If a turn is running, the restart waits for it to end.
   */
  async setModel(model: string): Promise<void> {
    this.config.model = model && model !== 'default' ? model : null;
    if (this.busy) {
      this.restartWhenIdle = true;
      this.emitEvent('info', { text: `Model will change to ${model || 'default'} after the current turn.` });
      return;
    }
    await this.restart();
    this.emitEvent('info', { text: `Model set to ${model || 'default'}.` });
  }

  markUnavailable(reason: string): void {
    this.available = false;
    this.unavailableReason = reason;
    this.emitEvent('unavailable', { reason });
  }

  /** Role changed: apply read-only mode and new instructions by restarting on the same session. */
  async reconfigure({ readOnly, maxTurns, profile, skillsOff, skillsOnly }: ReconfigureOptions): Promise<void> {
    this.readOnly = Boolean(readOnly);
    this.maxTurns = maxTurns || null;
    if (profile) this.profile = profile;
    if (skillsOff) this.skillsOff = skillsOff;
    if (skillsOnly !== undefined) this.skillsOnly = skillsOnly;
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
  async setEffort(effort: string | null): Promise<void> {
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
    this.stderrTail = '';
    if (this.proc) {
      this.stopping = true;
      await this.proc.kill();
    }
    this.start();
  }

  send(text: string, taskId?: string): void {
    if (!this.proc) this.start();
    if (!this.proc || this.stopping) {
      if (taskId) this.emitEvent('tasksCancelled', { taskIds: [taskId] });
      this.emitEvent('error', { text: 'Claude is unavailable or stopping. The input was not sent.' });
      return;
    }
    const uuid = randomUUID();
    this.unconfirmed.set(uuid, taskId);
    this.proc.write({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.emitEvent('status', { busy: this.busy });
  }

  /** Stop the current work: kill the process and restart it on the same session. */
  async interrupt() {
    if (!this.proc || !this.busy) return;
    this.stopping = true;
    await this.proc.kill();
    this.emitEvent('info', { text: 'Claude interrupted; session will resume on next message.' });
    this.emitEvent('status', { busy: false });
  }

  async shutdown() {
    this.stopping = true;
    await this.proc?.kill();
  }

  handle(m: any): void {
    switch (m.type) {
      case 'control_request':
        this.handleControlRequest(m);
        break;

      case 'control_response': {
        const r = m.response?.response || {};
        if (Array.isArray(r.models)) {
          this.commands = (r.commands || []).map((c: { name: string; description?: string }) => ({
            name: c.name,
            description: c.description || '',
          }));
          this.models = r.models.map((x: any) => ({
            value: x.value,
            label: x.displayName || x.value,
            resolved: x.resolvedModel || null,
            description: x.description || '',
            efforts: x.supportsEffort ? x.supportedEffortLevels || [] : [],
          }));
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
          this.emitEvent('account', {
            state: 'rate_limited',
            resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
            detail: `Usage limit reached (${info.rateLimitType || 'limit'}).`,
          });
        }
        break;
      }

      case 'assistant': {
        if (m.parent_tool_use_id) break;
        const msg = m.message || {};
        if (m.error === 'authentication_failed' || m.error === 'billing_error') {
          this.emitEvent('account', {
            state: 'no_access',
            detail: m.error === 'billing_error' ? 'Billing problem: plan inactive or no credit.' : 'Authentication failed: sign in again.',
          });
        } else if (m.error === 'rate_limit') {
          this.emitEvent('account', { state: 'rate_limited', detail: 'Usage limit reached.' });
        }
        (msg.content || []).forEach((block: any, i: number) => {
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
        if (this.unconfirmed.has(m.uuid)) {
          const taskId = this.unconfirmed.get(m.uuid);
          this.unconfirmed.delete(m.uuid);
          // Claude acknowledges queued messages when it consumes them, after the previous result if needed.
          const batch: NonNullable<ClaudeAgent['activeBatch']> = (this.activeBatch ??= { uuid: m.uuid, taskIds: [] });
          if (taskId) {
            batch.taskIds.push(taskId);
            this.emitEvent('inputAccepted', { taskIds: [taskId] });
            this.emitEvent('taskStarted', { taskIds: [taskId], turnId: batch.uuid });
          }
          break;
        }
        for (const block of m.message?.content || []) {
          if (block?.type === 'tool_result' && block.is_error) {
            this.emitEvent('toolResult', { key: block.tool_use_id, ok: false, detail: clip(contentText(block.content), 400) });
          } else if (block?.type === 'tool_result') {
            this.emitEvent('toolResult', { key: block.tool_use_id, ok: true });
          }
        }
        break;
      }

      case 'result': {
        const batch = this.activeBatch;
        this.activeBatch = null;
        if (!batch && this.unconfirmed.size) {
          const taskIds = [...this.unconfirmed.values()].filter((id): id is string => Boolean(id));
          this.unconfirmed.clear();
          if (taskIds.length) this.emitEvent('tasksCancelled', { taskIds });
          this.emitEvent('error', { text: 'Claude returned without acknowledging its inputs. Unconfirmed inputs were not resent.' });
        }
        if (m.usage) {
          const u = m.usage;
          // tokens = new tokens (input, output, cache writes); cachedTokens = cache reads, which cost much less
          this.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
          this.cachedTokens += u.cache_read_input_tokens || 0;
          this.emitEvent('usage', { tokens: this.tokens });
        }
        if (
          m.is_error &&
          /invalid api key|please run \/login|not logged in|oauth token|credit balance|billing|subscription/i.test(String(m.result || ''))
        ) {
          this.emitEvent('account', { state: 'no_access', detail: String(m.result).slice(0, 200) });
        } else if (!m.is_error) {
          this.emitEvent('account', { state: 'ok' });
        }
        this.emitEvent('turnEnd', {
          taskIds: batch?.taskIds || [],
          turnId: batch?.uuid,
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
      }

      default:
        break;
    }
  }
}

function toolDetail(_name: string, input: any = {}): string {
  if (input.command) return clip(input.command, 300);
  if (input.file_path) return input.file_path;
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
  if (input.url) return input.url;
  if (input.description) return clip(input.description, 200);
  return clip(JSON.stringify(input), 200);
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
  return '';
}

function summarize(m: unknown): string {
  return clip(JSON.stringify(m), 300);
}

export function clip(value: unknown, n: number): string {
  const s = String(value ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
