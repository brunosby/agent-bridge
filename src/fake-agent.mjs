// @ts-check
import { EventEmitter } from 'node:events';

/**
 * Scripted agent for tests: answers from rules instead of calling a model, so routing, review loops and
 * restore can be tested without any CLI or tokens. Enabled only with "enableFakeProvider": true in the config.
 *
 * config.fake.rules: [{ agent?: "<name regex>", match: "<message regex>", reply: "<text>" }]
 * The first rule whose agent and match patterns fit the incoming message is used; "{n}" in a reply is
 * replaced by how many messages the agent has received.
 */
export class FakeAgent extends EventEmitter {
  /** @param {{ id?: string, name?: string, cwd?: string, config?: any, tokens?: number, cachedTokens?: number }} opts */
  constructor({ id = 'fake', name = 'Fake', cwd = '.', config = {}, tokens = 0, cachedTokens = 0 }) {
    super();
    this.id = id;
    this.name = name;
    this.label = name;
    this.cwd = cwd;
    this.config = config || {};
    this.tokens = tokens;
    this.cachedTokens = cachedTokens;
    this.available = true;
    this.unavailableReason = null;
    this.approvals = new Map();
    this.sessionId = this.config.resumeSessionId || `fake-${id}`;
    /** @type {{ value: string, label: string, isDefault?: boolean, efforts?: string[] }[]} */
    this.models = [
      { value: 'fake-large', label: 'Fake Large', isDefault: true, efforts: ['low', 'high'] },
      { value: 'fake-small', label: 'Fake Small', efforts: [] },
    ];
    this.resolvedModel = 'fake-large';
    this.received = 0;
    this.busyCount = 0;
    /** @type {string[]} */
    this.inbox = [];
  }

  get busy() {
    return this.busyCount > 0;
  }

  get model() {
    return this.config.model || null;
  }

  get effort() {
    return this.config.effort || null;
  }

  /** @param {string} kind @param {Record<string, unknown>} [data] */
  emitEvent(kind, data = {}) {
    this.emit('event', { agent: this.id, kind, ...data });
  }

  async start() {
    this.emitEvent('session', { sessionId: this.sessionId });
    this.emitEvent('models', {});
  }

  /** @param {string} text */
  send(text) {
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

  /** @param {string} text @param {number} n */
  replyFor(text, n) {
    for (const r of this.config.rules || []) {
      if (r.agent && !new RegExp(r.agent, 'i').test(this.name)) continue;
      if (r.match && !new RegExp(r.match, 'i').test(text)) continue;
      return String(r.reply).replace(/\{n\}/g, String(n));
    }
    return `ok ${n}`;
  }

  /** @param {string} model */
  async setModel(model) {
    this.config.model = model && model !== 'default' ? model : null;
  }

  /** @param {string} effort */
  async setEffort(effort) {
    this.config.effort = effort && effort !== 'default' ? effort : null;
  }

  async reconfigure() {}

  respondApproval() {
    return false;
  }

  async interrupt() {}

  async restart() {
    this.available = true;
  }

  async shutdown() {}
}
