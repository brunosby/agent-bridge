import { taskIdsFromLog } from './task-events.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentIdentity, AgentSpec, BridgeEvent } from './types.ts';

/** One saved conversation, as shown in the Conversations list. */
export interface ConversationSummary {
  id: string;
  startedAt: number | null;
  lastAt: number | null;
  title: string;
  userMessages: number;
  agentTurns: number;
  workDir: string | null;
  routingMode: string | null;
  team: AgentSpec[];
  sessionIds: string[];
}

/** Every run writes logs/<id>/transcript.jsonl; this module reads them back. */
export const LOGS_DIR_NAME = 'logs';
const ID_PATTERN = /^[0-9A-Za-z_-]+$/;

export function parseTranscriptLine(line: string): BridgeEvent | null {
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object' && typeof event.kind === 'string' ? event : null;
  } catch {
    return null;
  }
}

function readEvents(file: string): BridgeEvent[] {
  const out: BridgeEvent[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = parseTranscriptLine(line);
    if (event) out.push(event);
    else skipped += 1;
  }
  if (skipped) console.warn('Skipped ' + skipped + ' invalid line(s) in transcript history.');
  return out;
}

function summarize(id: string, events: BridgeEvent[]): ConversationSummary {
  let state: BridgeEvent | null = null;
  let first: BridgeEvent | null = null;
  let users = 0;
  let turns = 0;
  for (const ev of events) {
    if (ev.kind === 'state') state = ev;
    else if (ev.kind === 'user') {
      users += 1;
      first ??= ev;
    } else if (ev.kind === 'turnEnd') turns += 1;
  }
  const timed = events.filter((e) => e.at);
  const team = teamFromState(state);
  return {
    id,
    startedAt: timed[0]?.at || null,
    lastAt: timed.at(-1)?.at || null,
    title: first ? first.text.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    userMessages: users,
    agentTurns: turns,
    workDir: state?.workDir || null,
    routingMode: state?.routingMode || null,
    team,
    sessionIds: team.map((a) => a.sessionId).filter((x): x is string => Boolean(x)),
  };
}

/** The team saved in a state snapshot. Older logs had two fixed agents (claude main/peer, codex). */
function teamFromState(state: BridgeEvent | null): AgentSpec[] {
  if (!state) return [];
  if (Array.isArray(state.team)) {
    return state.team.map((a: AgentSpec) => ({
      id: a.id,
      name: a.name,
      driver: a.driver,
      role: a.role,
      model: a.model && a.model !== 'default' ? a.model : null,
      effort: a.effort && a.effort !== 'default' ? a.effort : null,
      bypass: Boolean(a.bypass),
      sessionId: a.sessionId || null,
      // The snapshot exposes totals; the adapter resumes with just its own session usage.
      tokens: Math.max(0, (a.tokens || 0) - (a.baseTokens || 0)),
      cachedTokens: Math.max(0, (a.cachedTokens || 0) - (a.baseCachedTokens || 0)),
      baseTokens: a.baseTokens,
      baseCachedTokens: a.baseCachedTokens,
      providerChangeId: a.providerChangeId,
      cwd: a.cwd || null,
      worktree: a.worktree || null,
    }));
  }
  const ids = state.mainId === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  return ids.map((driver, i) => ({
    id: `a${i + 1}`,
    name: driver === 'claude' ? 'Claude' : 'Codex',
    driver,
    role: i === 0 ? 'orchestrator' : 'coder',
    model: state.agents?.[driver]?.model && state.agents[driver].model !== 'default' ? state.agents[driver].model : null,
    bypass: Boolean(state.agents?.[driver]?.bypass),
    sessionId: state.agents?.[driver]?.sessionId || null,
    tokens: 0,
  }));
}

export function legacyAgentIds(firstState: BridgeEvent | null): Map<string, string> {
  if (!firstState || Array.isArray(firstState.team)) return new Map();
  return new Map(teamFromState(firstState).map((member) => [member.driver, member.id]));
}

/** Earlier conversations that have at least one message from the user, newest first. */
export function listConversations(logsDir: string): ConversationSummary[] {
  if (!fs.existsSync(logsDir)) return [];
  const out: ConversationSummary[] = [];
  for (const id of fs.readdirSync(logsDir)) {
    const file = path.join(logsDir, id, 'transcript.jsonl');
    if (!ID_PATTERN.test(id) || !fs.existsSync(file)) continue;
    const s = summarize(id, readEvents(file));
    if (s.userMessages > 0) out.push(s);
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  // Logs that continue the same agent session are one conversation: keep only the most recent.
  const seen = new Set<string>();
  return out.filter((c) => {
    const keys = c.sessionIds;
    const duplicate = keys.some((k) => seen.has(k));
    keys.forEach((k) => seen.add(k));
    return !duplicate;
  });
}

/** Take a conversation off the list. The folder is moved to logs/.removed, not deleted. */
export function removeConversation(logsDir: string, id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error('invalid conversation id');
  const from = path.join(logsDir, id);
  if (!fs.existsSync(from)) throw new Error(`conversation ${id} not found`);
  const bin = path.join(logsDir, '.removed');
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(from, path.join(bin, id));
}

/**
 * Load a conversation for replay: the events the page shows (without old state snapshots and CLI
 * noise), plus closing events for anything that was still open when the app stopped.
 */
export function loadConversation(
  logsDir: string,
  id: string,
): ConversationSummary & {
  events: BridgeEvent[];
  lastSeq: number;
  lastAgentId: number;
  retiredAgents: Map<string, AgentIdentity>;
} {
  if (!ID_PATTERN.test(id)) throw new Error('invalid conversation id');
  const file = path.join(logsDir, id, 'transcript.jsonl');
  if (!fs.existsSync(file)) throw new Error(`conversation ${id} not found`);
  const all = readEvents(file);
  const summary = summarize(id, all);

  let lastAgentId = 0;
  function rememberId(id: unknown) {
    if (typeof id !== 'string' || !/^a\d+$/.test(id)) return;
    const ordinal = Number(id.slice(1));
    if (Number.isSafeInteger(ordinal)) lastAgentId = Math.max(lastAgentId, ordinal);
  }

  const retiredAgents = new Map<string, AgentIdentity>();
  for (const event of all) {
    rememberId(event.agent);
    if (event.kind !== 'state') continue;
    if (Number.isSafeInteger(event.lastAgentId)) lastAgentId = Math.max(lastAgentId, event.lastAgentId);
    for (const members of [event.knownAgents, event.team]) {
      if (!Array.isArray(members)) continue;
      for (const member of members) {
        if (!member || typeof member.id !== 'string' || typeof member.name !== 'string') continue;
        const { id, name, driver, role } = member;
        rememberId(id);
        retiredAgents.set(id, { id, name, driver, role });
      }
    }
  }
  for (const spec of summary.team) retiredAgents.delete(spec.id);
  const events = all.filter((e) => typeof e.seq === 'number' && e.kind !== 'state' && e.kind !== 'stderr');
  let lastSeq = all.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  const lastAt = summary.lastAt || Date.now();

  // Older logs used the provider name as the agent id; map it to the ids of the rebuilt team.
  const legacy = legacyAgentIds(all.find((event) => event.kind === 'state') ?? null);
  if (legacy.size) {
    for (const e of events) {
      for (const k of ['agent', 'from']) if (legacy.has(e[k])) e[k] = legacy.get(e[k]);
      if (typeof e.to === 'string' && legacy.has(e.to)) e.to = legacy.get(e.to);
      if (Array.isArray(e.to)) e.to = e.to.map((id: string) => legacy.get(id) ?? id);
    }
  }

  const openApprovals = new Set<string>();
  const openTasks = new Map<string, string>();
  const openTurn: Record<string, boolean> = {};
  for (const e of events) {
    if (e.kind === 'taskQueued' && typeof e.id === 'string' && typeof e.agent === 'string') openTasks.set(e.id, e.agent);
    if (e.kind === 'turnEnd' || e.kind === 'tasksCancelled') for (const taskId of taskIdsFromLog(e.taskIds)) openTasks.delete(taskId);
    if (e.kind === 'approval' || e.kind === 'needRole' || e.kind === 'finalReview' || e.kind === 'recommendRoles')
      openApprovals.add(e.requestId);
    if (e.kind === 'needRoleClosed' || e.kind === 'finalReviewClosed' || e.kind === 'recommendRolesClosed')
      openApprovals.delete(e.requestId);
    if (e.kind === 'milestonePlanProposed' || e.kind === 'milestoneCommitProposed') openApprovals.add(e.requestId);
    if (e.kind === 'approvalClosed' || e.kind === 'milestoneDecisionClosed') openApprovals.delete(e.requestId);
    if (['delta', 'text', 'tool'].includes(e.kind) && e.agent) openTurn[e.agent] = true;
    if (e.kind === 'turnEnd') openTurn[e.agent] = false;
  }
  for (const requestId of openApprovals) {
    const id = String(requestId);
    const kind =
      id.startsWith('milestones-') || id.startsWith('milestone-commit-')
        ? 'milestoneDecisionClosed'
        : id.startsWith('recommend-')
          ? 'recommendRolesClosed'
          : id.startsWith('role-')
            ? 'needRoleClosed'
            : id.startsWith('final-')
              ? 'finalReviewClosed'
              : 'approvalClosed';
    events.push({ seq: ++lastSeq, at: lastAt, kind, requestId, decision: 'cancelled', action: 'cancelled' });
  }
  for (const [agent, open] of Object.entries(openTurn)) {
    if (open)
      events.push({ seq: ++lastSeq, at: lastAt, agent, kind: 'turnEnd', text: '', ok: false, detail: 'stopped when the app was closed' });
  }
  const interrupted = new Map<string, string[]>();
  for (const [taskId, agent] of openTasks) {
    if (!interrupted.has(agent)) interrupted.set(agent, []);
    interrupted.get(agent)?.push(taskId);
  }
  for (const [agent, taskIds] of interrupted) {
    events.push({ seq: ++lastSeq, at: lastAt, kind: 'tasksCancelled', agent, taskIds, interrupted: true });
  }
  return { ...summary, events, lastSeq, lastAgentId, retiredAgents };
}
