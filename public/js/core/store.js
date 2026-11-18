// Shared page state: the latest server snapshot, the catalog and the rendered elements.
export const store = { state: null, catalog: { roles: [], drivers: [], routingModes: [], settings: {}, settingsSchema: {} }, lastSeq: 0 };
export const bubbles = new Map(); // `${agent}|${key}` -> { el, body, text }
export const tools = new Map(); // `${agent}|${key}` -> element
export const approvals = new Map(); // requestId -> element
export const cards = {}; // agent id -> card parts

export function agentOf(id) {
  return store.state?.team?.find((a) => a.id === id);
}
export function label(id) {
  return agentOf(id)?.name || { claude: 'Claude', codex: 'Codex' }[id] || id;
}
export function driverOf(id) {
  return agentOf(id)?.driver || id;
}
export function roleOf(id) {
  return store.catalog.roles.find((r) => r.id === id);
}
