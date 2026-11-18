import fs from 'node:fs';
import path from 'node:path';

/** Every run writes logs/<id>/transcript.jsonl; this module reads them back. */
export const LOGS_DIR_NAME = 'logs';
const ID_PATTERN = /^[0-9A-Za-z_-]+$/;

function readEvents(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line cut short when the app was closed
    }
  }
  return out;
}

function summarize(id, events) {
  let state = null;
  let first = null;
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
    sessionIds: team.map((a) => a.sessionId).filter(Boolean),
  };
}

/** The team saved in a state snapshot. Older logs had two fixed agents (claude main/peer, codex). */
function teamFromState(state) {
  if (!state) return [];
  if (Array.isArray(state.team)) {
    return state.team.map((a) => ({
      id: a.id,
      name: a.name,
      driver: a.driver,
      role: a.role,
      model: a.model && a.model !== 'default' ? a.model : null,
      effort: a.effort && a.effort !== 'default' ? a.effort : null,
      bypass: Boolean(a.bypass),
      sessionId: a.sessionId || null,
      tokens: a.tokens || 0,
      cachedTokens: a.cachedTokens || 0,
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

/** Earlier conversations that have at least one message from the user, newest first. */
export function listConversations(logsDir) {
  if (!fs.existsSync(logsDir)) return [];
  const out = [];
  for (const id of fs.readdirSync(logsDir)) {
    const file = path.join(logsDir, id, 'transcript.jsonl');
    if (!ID_PATTERN.test(id) || !fs.existsSync(file)) continue;
    const s = summarize(id, readEvents(file));
    if (s.userMessages > 0) out.push(s);
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  // Logs that continue the same agent session are one conversation: keep only the most recent.
  const seen = new Set();
  return out.filter((c) => {
    const keys = c.sessionIds;
    const duplicate = keys.some((k) => seen.has(k));
    keys.forEach((k) => seen.add(k));
    return !duplicate;
  });
}

/** Take a conversation off the list. The folder is moved to logs/.removed, not deleted. */
export function removeConversation(logsDir, id) {
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
export function loadConversation(logsDir, id) {
  if (!ID_PATTERN.test(id)) throw new Error('invalid conversation id');
  const file = path.join(logsDir, id, 'transcript.jsonl');
  if (!fs.existsSync(file)) throw new Error(`conversation ${id} not found`);
  const all = readEvents(file);
  const summary = summarize(id, all);
  const events = all.filter((e) => typeof e.seq === 'number' && e.kind !== 'state' && e.kind !== 'stderr');
  let lastSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  const lastAt = summary.lastAt || Date.now();

  // Older logs used the provider name as the agent id; map it to the ids of the rebuilt team.
  const legacy = Object.fromEntries(summary.team.filter((a) => a.driver).map((a) => [a.driver, a.id]));
  const hasLegacyIds = events.some((e) => e.agent === 'claude' || e.agent === 'codex');
  if (hasLegacyIds) {
    for (const e of events) {
      for (const k of ['agent', 'from']) if (legacy[e[k]]) e[k] = legacy[e[k]];
      if (typeof e.to === 'string' && legacy[e.to]) e.to = legacy[e.to];
      if (Array.isArray(e.to)) e.to = e.to.map((t) => legacy[t] || t);
    }
  }

  const openApprovals = new Set();
  const openTurn = {};
  for (const e of events) {
    if (e.kind === 'approval' || e.kind === 'needRole' || e.kind === 'finalReview') openApprovals.add(e.requestId);
    if (e.kind === 'needRoleClosed' || e.kind === 'finalReviewClosed') openApprovals.delete(e.requestId);
    if (e.kind === 'approvalClosed') openApprovals.delete(e.requestId);
    if (['delta', 'text', 'tool'].includes(e.kind) && e.agent) openTurn[e.agent] = true;
    if (e.kind === 'turnEnd') openTurn[e.agent] = false;
  }
  for (const requestId of openApprovals) {
    const id = String(requestId);
    const kind = id.startsWith('role-') ? 'needRoleClosed' : id.startsWith('final-') ? 'finalReviewClosed' : 'approvalClosed';
    events.push({ seq: ++lastSeq, at: lastAt, kind, requestId, decision: 'cancelled', action: 'cancelled' });
  }
  for (const [agent, open] of Object.entries(openTurn)) {
    if (open)
      events.push({ seq: ++lastSeq, at: lastAt, agent, kind: 'turnEnd', text: '', ok: false, detail: 'stopped when the app was closed' });
  }
  return { ...summary, events, lastSeq };
}
