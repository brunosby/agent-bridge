/** Transcript entries are independent of their rendered nodes. */
export class Transcript {
  constructor() {
    this.clear();
  }

  clear() {
    this.entries = [];
    this.byKey = new Map();
    this.bySequence = new Map();
    this.openTurns = new Map();
  }

  add(event, text, category, agents = [], key = null) {
    const entry = {
      category,
      agents,
      seq: event.seq,
      at: event.at,
      text,
      key,
      ok: event.ok,
      previous: this.entries.at(-1),
      searchable: text.toLowerCase(),
    };
    this.entries.push(entry);
    if (Number.isInteger(event.seq)) this.bySequence.set(event.seq, entry);
    if (key) this.byKey.set(key, entry);
    return entry;
  }

  search(query, mode, agent, category = '') {
    return this.entries.filter((entry) => this.matches(entry, query, mode, agent, category));
  }

  matches(entry, query, mode, agent, category = '') {
    return (
      (!agent || entry.agents.includes(agent)) &&
      (!category || entry.category === category || (category === 'error' && entry.ok === false)) &&
      (mode !== 'messages' || ['message', 'error', 'approval'].includes(entry.category) || entry.ok === false) &&
      (!query || entry.searchable.includes(query))
    );
  }

  update(entry, text, displayedText = text) {
    entry.text = text;
    entry.searchable = displayedText.toLowerCase();
  }

  track(agent, entry) {
    if (!this.openTurns.has(agent)) this.openTurns.set(agent, new Set());
    this.openTurns.get(agent).add(entry);
  }

  endTurn(agent) {
    const entries = this.openTurns.get(agent) || [];
    this.openTurns.delete(agent);
    return entries;
  }
}
