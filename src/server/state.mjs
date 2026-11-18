// Shared mutable state of the running app.
import { loadRoles } from '../core/roles.mjs';
import { ROLES_DIR, setting } from '../config/settings.mjs';
export const S = { conv: null, history: [], seq: 0, roles: loadRoles(ROLES_DIR) };

export const DONE_MARKER = /^\s*\[\[DONE\]\]\s*$/m;
/** What agents reported about their account while running: { driver: { state, detail, resetsAt } }. */
export const providerRuntime = {};

export const relay = { auto: setting('autoRelay'), maxHops: Number(setting('maxHops')), hops: 0, halted: false };
export const approvalTimers = new Map();

export const clients = new Set();
export const cliCache = {};
