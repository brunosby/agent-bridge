import { EventEmitter } from 'node:events';
import type { Agent, AgentOptions, DriverConfig, ModelInfo } from '../core/types.ts';

interface FakeRule {
  agent?: string;
  match?: string;
  reply: string;
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

  emitEvent(kind: string, data: Record<string, unknown> = {}): void {
    this.emit('event', { agent: this.id, kind, ...data });
  }

  async start(): Promise<void> {
    this.emitEvent('session', { sessionId: this.sessionId });
    this.emitEvent('models', {});
  }

  send(text: string): void {
    this.received += 1;
    this.inbox.push(text);
    this.busyCount += 1;
    this.emitEvent('status', { busy: true });
    const n = this.received;
    setTimeout(
      () => {
        const reply = this.replyFor(text, n);
        this.tokens += 100;
        this.emitEvent('usage', { tokens: this.tokens });
        this.emitEvent('text', { key: `${this.id}-${n}`, text: reply, final: true });
        this.busyCount -= 1;
        this.emitEvent('turnEnd', { text: reply, ok: true });
        this.emitEvent('status', { busy: this.busy });
      },
      Number(this.config.delayMs ?? 20),
    );
  }

  replyFor(text: string, n: number): string {
    for (const r of (this.config.rules || []) as FakeRule[]) {
      if (r.agent && !new RegExp(r.agent, 'i').test(this.name)) continue;
      if (r.match && !new RegExp(r.match, 'i').test(text)) continue;
      return String(r.reply).replace(/\{n\}/g, String(n));
    }
    return `ok ${n}`;
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

  async interrupt(): Promise<void> {}

  async restart(): Promise<void> {
    this.available = true;
  }

  async shutdown(): Promise<void> {}
}
