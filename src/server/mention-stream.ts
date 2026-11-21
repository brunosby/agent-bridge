import { parseMilestoneMarkers } from '../../public/js/core/milestone-markers.js';
import { parseRoleMarkers } from '../../public/js/core/role-markers.js';
import { toMentionIds } from '../core/recipients.ts';
import type { Conversation } from '../core/types.ts';
import { publish } from './events.ts';

// null marks a message that already received the provider's authoritative final text.
const streams = new WeakMap<Conversation, Map<string, Map<string, string[] | null>>>();

export function recordMessageFragment(owner: Conversation, agent: string, key: string, text: string, kind: 'delta' | 'text' | 'final') {
  let agents = streams.get(owner);
  if (!agents) streams.set(owner, (agents = new Map()));
  let messages = agents.get(agent);
  if (!messages) agents.set(agent, (messages = new Map()));
  const fragments = messages.get(key);
  if (fragments === null && kind !== 'final') return false;
  if (kind === 'final') messages.set(key, null);
  else if (kind === 'text' || !fragments) messages.set(key, [text]);
  else fragments.push(text);
  return true;
}

export function flushMentionStreams(owner: Conversation, agent?: string) {
  const agents = streams.get(owner);
  if (!agents) return;
  for (const [id, messages] of agents) {
    if (agent !== undefined && id !== agent) continue;
    agents.delete(id);
    for (const [key, fragments] of messages) {
      if (!fragments) continue;
      const original = fragments.join('');
      const clean = parseRoleMarkers(parseMilestoneMarkers(original).text).text;
      const text = toMentionIds(clean, owner.team);
      if (text === clean) continue;
      const { seq } = publish({ kind: 'text', agent: id, key, text, final: true });
      if (seq) owner.lastAnswerSeq[id] = seq;
    }
  }
}
