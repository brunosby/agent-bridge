import type { RoutingMode } from './types.ts';

interface Recipient {
  id: string;
  name: string;
  role: string;
}

export function leadingMentions(text: string): string {
  return text.match(/^\s*(?:@[\w-]+[\s,:]*)+/)?.[0] || '';
}

/** Resolves targets in team order, except explicit mentions, which follow input order. */
export function resolveRecipients(team: Recipient[], mode: RoutingMode, target = 'auto', prefix = ''): string[] {
  if (target === 'all') return team.map((agent) => agent.id);
  if (target && target !== 'auto') return team.some((agent) => agent.id === target) ? [target] : [];
  const byName = new Map(team.map(({ name, id }) => [name.toLowerCase(), id]));
  const ids = new Set<string>();
  for (const match of leadingMentions(prefix).matchAll(/@([\w-]+)/g)) {
    const id = byName.get(match[1].toLowerCase());
    if (id) ids.add(id);
  }
  if (ids.size) return [...ids];
  const fallback = (mode === 'orchestrator' && team.find((agent) => agent.role === 'orchestrator')) || team[0];
  return fallback ? [fallback.id] : [];
}
