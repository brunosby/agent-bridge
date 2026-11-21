// Shared page state: the latest server snapshot, the catalog and the rendered elements.
export const store = { state: null, catalog: { roles: [], drivers: [], routingModes: [], settings: {}, settingsSchema: {} }, lastSeq: 0 };
export const approvals = new Map(); // requestId -> element
export const cards = {}; // agent id -> card parts

export function agentOf(id) {
  return store.state?.team?.find((a) => a.id === id);
}
export function historyAgentOf(id) {
  return agentOf(id) || store.state?.knownAgents?.find((agent) => agent.id === id);
}
export function label(id) {
  return historyAgentOf(id)?.name || { claude: 'Claude', codex: 'Codex' }[id] || id;
}
export function roleOf(id) {
  return store.catalog.roles.find((r) => r.id === id);
}

export function findMentionAgent(name) {
  const key = name.toLowerCase();
  if (key === 'all' || key === 'everyone') return { name: 'everyone', driver: 'all', role: null };
  const member = historyAgentOf(key) || (!/^a\d+$/.test(key) && store.state?.team?.find((agent) => agent.name.toLowerCase() === key));
  return member ? { ...member, role: roleOf(member.role)?.name || null } : null;
}
