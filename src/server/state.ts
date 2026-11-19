// Shared mutable state of the running app.
import type { ServerResponse } from 'node:http';
import { loadRoles } from '../core/roles.ts';
import { ROLES_DIR, setting } from '../config/settings.ts';
import type { AccountStatus, RuntimeStatus } from '../providers/accounts.ts';
import type { BridgeEvent, Conversation, ModelInfo, RoleCatalog } from '../core/types.ts';

export interface AppState {
  /** The open conversation. Set at startup and replaced on restore / new conversation. */
  conv: Conversation;
  /** Events replayed to a page that connects (the open conversation's history). */
  history: BridgeEvent[];
  seq: number;
  roles: RoleCatalog;
}

export const S: AppState = { conv: null as unknown as Conversation, history: [], seq: 0, roles: loadRoles(ROLES_DIR) };

export const DONE_MARKER = /^\s*\[\[DONE\]\]\s*$/m;

/** What agents reported about their account while running, per provider. */
export const providerRuntime: Record<string, RuntimeStatus> = {};

/** Hand-off state of the relay between agents. */
export const relay = { auto: Boolean(setting('autoRelay')), maxHops: Number(setting('maxHops')) };

export const approvalTimers = new Map<string, NodeJS.Timeout>();

/** Pages connected to the live event stream. */
export const clients = new Set<ServerResponse>();

/** Account status per provider from the CLIs, cached for 30 s. */
export const cliCache: Record<string, { at: number; status: AccountStatus }> = {};

/** Model lists per provider, for the "Add agent" form. */
export const driverModelCache: Record<string, { at: number; models: ModelInfo[] }> = {};
