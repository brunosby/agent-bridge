import type { ProviderEventArgs } from '../core/types.ts';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, AgentOptions, DriverConfig, ModelInfo } from '../core/types.ts';

interface FakeRule {
  agent?: string;
  match?: string;
  reply: string;
  /** Report a successful Edit tool call, or a failed one for regression tests. */
  edit?: boolean | 'failed';
  /** Write [file, content] in the working folder before the reply, without a tool event (like a shell edit). */
  writeFile?: [string, string];
}

/**
 * Scripted agent for tests: answers from rules instead of calling a model, so routing, review loops and
 * restore can be tested without any CLI or tokens. Enabled only with "enableFakeProvider": true in the config.
 *
 * config.fake.rules: [{ agent?: "<name regex>", match: "<message regex>", reply: "<text>" }]
 * The first rule whose agent and match patterns fit the incoming message is used; "{n}" in a reply is
 * replaced by how many messages the agent has received.
 */
export class FakeAgent extends EventEmitter implements Agent {
  id: string;
  name: string;
  label: string;
  cwd: string;
  config: DriverConfig;
  tokens: number;
  cachedTokens: number;
  available = true;
  unavailableReason: string | null = null;
  approvals = new Map<string, unknown>();
  sessionId: string;
  models: ModelInfo[] = [
    { value: 'fake-large', label: 'Fake Large', isDefault: true, efforts: ['low', 'high'] },
    { value: 'fake-small', label: 'Fake Small', efforts: [] },
  ];
  resolvedModel: string | null = 'fake-large';
  received = 0;
  busyCount = 0;
  inbox: string[] = [];
  timers = new Map<ReturnType<typeof setTimeout>, string | undefined>();

  constructor({ id = 'fake', name = 'Fake', cwd = '.', config = {}, tokens = 0, cachedTokens = 0 }: AgentOptions) {
    super();
    this.id = id;
    this.name = name;
    this.label = name;
    this.cwd = cwd;
    this.config = config || {};
    this.tokens = tokens;
    this.cachedTokens = cachedTokens;
    this.sessionId = this.config.resumeSessionId || `fake-${id}`;
  }

  get busy(): boolean {
    return this.busyCount > 0;
  }

  get model(): string | null {
    return this.config.model || null;
  }

  get effort(): string | null {
    return this.config.effort || null;
  }

  emitEvent<const K extends string>(kind: K, ...[data]: ProviderEventArgs<NoInfer<K>>): void {
    this.emit('event', { agent: this.id, kind, ...data });
  }

  async start(): Promise<void> {
    if (this.config.failRoleStartup && this.name === this.config.failRoleStartup && this.available) {
      this.available = false;
      this.unavailableReason = 'Fixture startup failure.';
      this.config.failRoleStartup = null;
      this.emitEvent('unavailable', { reason: this.unavailableReason });
      return;
    }
    this.emitEvent('session', { sessionId: this.sessionId });
    this.emitEvent('models', {});
  }

  send(text: string, taskId?: string): void {
    this.received += 1;
    this.inbox.push(text);
    this.busyCount += 1;
    this.emitEvent('status', { busy: true });
    const n = this.received;
    const taskIds = taskId ? [taskId] : [];
    this.emitEvent('taskStarted', { taskIds });
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        const rule = this.ruleFor(text);
        const reply = rule ? String(rule.reply).replace(/\{n\}/g, String(n)) : `ok ${n}`;
        if (rule?.edit) {
          this.emitEvent('tool', { key: `${this.id}-edit-${n}`, title: 'Edit', detail: 'file.txt' });
          this.emitEvent('toolResult', { key: `${this.id}-edit-${n}`, ok: rule.edit === true });
        }
        if (rule?.writeFile) fs.writeFileSync(path.join(this.cwd, rule.writeFile[0]), rule.writeFile[1]);
        this.tokens += 100;
        this.emitEvent('usage', { tokens: this.tokens });
        this.emitEvent('text', { key: `${this.id}-${n}`, text: reply, final: true });
        this.busyCount -= 1;
        this.emitEvent('turnEnd', { taskIds, text: reply, ok: true });
        this.emitEvent('status', { busy: this.busy });
      },
      Number(this.config.delayMs ?? 20),
    );
    this.timers.set(timer, taskId);
  }

  ruleFor(text: string): FakeRule | null {
    for (const r of (this.config.rules || []) as FakeRule[]) {
      if (r.agent && !new RegExp(r.agent, 'i').test(this.name)) continue;
      if (r.match && !new RegExp(r.match, 'i').test(text)) continue;
      return r;
    }
    return null;
  }

  async setModel(model: string): Promise<void> {
    this.config.model = model && model !== 'default' ? model : null;
  }

  async setEffort(effort: string | null): Promise<void> {
    this.config.effort = effort && effort !== 'default' ? effort : null;
  }

  async reconfigure(): Promise<void> {}

  respondApproval(): boolean {
    return false;
  }

  async interrupt(): Promise<void> {
    for (const timer of this.timers.keys()) clearTimeout(timer);
    const taskIds = [...this.timers.values()].filter((id): id is string => Boolean(id));
    this.timers.clear();
    this.busyCount = 0;
    if (taskIds.length) this.emitEvent('tasksCancelled', { taskIds });
    this.emitEvent('status', { busy: false });
  }

  async restart(): Promise<void> {
    this.available = true;
    this.unavailableReason = null;
    await this.start();
  }

  async shutdown(): Promise<void> {
    await this.interrupt();
  }
}
