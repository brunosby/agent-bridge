import { leadingMentionTokens, mapMentions, mentionTokens } from '../../public/js/core/mentions.js';
import type { RoutingMode } from './types.ts';

interface MentionAgent {
  id: string;
  name: string;
}

interface Recipient extends MentionAgent {
  role: string;
}

export function mentionLookup(team: MentionAgent[]) {
  const byId = new Map(team.map((agent) => [agent.id.toLowerCase(), agent]));
  const byName = new Map(team.map((agent) => [agent.name.toLowerCase(), agent]));
  return (name: string) => {
    const key = name.toLowerCase();
    return byId.get(key) || (/^a\d+$/.test(key) ? undefined : byName.get(key));
  };
}

export function validateMentionChecks(team: MentionAgent[], input: unknown): void {
  if (input === undefined) return;
  if (!Array.isArray(input)) throw new Error('invalid mention checks');
  const find = mentionLookup(team);
  for (const entry of input) {
    if (!entry || typeof entry.name !== 'string' || !/^[\w-]+$/.test(entry.name) || typeof entry.id !== 'string')
      throw new Error('invalid mention check');
    if (find(entry.name)?.id !== entry.id)
      throw new Error('Check the mention @' + entry.name + '. Pick the intended agent or edit the mention.');
  }
}

export function toMentionIds(text: string, team: MentionAgent[]): string {
  const find = mentionLookup(team);
  return mapMentions(text, (name: string) => {
    const agent = find(name);
    return agent ? '@' + agent.id : undefined;
  });
}

export function mentionedAgents(text: string, team: MentionAgent[]): string[] {
  const find = mentionLookup(team);
  return [
    ...new Set(
      mentionTokens(text).flatMap(({ name }) => {
        const agent = find(name);
        return agent ? [agent.id] : [];
      }),
    ),
  ];
}

/** Resolves targets in team order, except explicit mentions, which follow input order. */
export function resolveRecipients(team: Recipient[], mode: RoutingMode, target = 'auto', prefix = ''): string[] {
  if (target === 'all') return team.map((agent) => agent.id);
  if (target && target !== 'auto') return team.some((agent) => agent.id === target) ? [target] : [];
  const find = mentionLookup(team);
  const ids = new Set<string>();
  for (const { name } of leadingMentionTokens(prefix)) {
    const agent = find(name);
    if (!agent) throw new Error('Unknown recipient @' + name + '. Choose an agent or correct the mention.');
    ids.add(agent.id);
  }
  if (ids.size) return [...ids];
  const fallback = (mode === 'orchestrator' && team.find((agent) => agent.role === 'orchestrator')) || team[0];
  return fallback ? [fallback.id] : [];
}
