import { workflowMarkers } from '../../public/js/core/workflow-markers.js';
import { checkGrowth, readTaskBlocks, requestSpec, stopWatching } from './task-workflow.ts';
import { closeShellApproval, mayBypassApproval, processShellApproval } from './shell-approvals.ts';
import { parseMilestoneMarkers } from '../../public/js/core/milestone-markers.js';
import {
  cancelMilestoneDecision,
  finishMilestone,
  observeMilestoneReview,
  offerMilestonePlan,
  restoreMilestoneViews,
} from './milestones.ts';
import { isTaskLifecycleKind, readAgentTaskEvent, taskIdsFromLog } from '../core/task-events.ts';
import { restoreProviderHandoffs, settleProviderHandoff } from './provider-handoff.ts';
// Conversation lifecycle: open, close, restore, wire agent events, approvals timeout, token limit, settings.
import type { Agent, AgentEvent, AgentSpec, Conversation, RoutingMode } from '../core/types.ts';
import { S } from './state.ts';
import fs from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { listConversations, loadConversation } from '../core/history.ts';
import { LOGS_DIR, SETTINGS, safeRegex, saveLocalConfig, setting } from '../config/settings.ts';
import { agentName, logError, publish, publishState, resetClients } from './events.ts';
import { ROUTING_MODES } from '../core/prompts.ts';
import { approvalTimers, cliCache, providerRuntime, relay } from './state.ts';
import { createAgent, defaultName, defaultTeam, startAgent, uniqueName } from './team.ts';
import { driverModelCache } from './state.ts';
import { DRIVERS } from '../providers/registry.ts';
import { completeBatch, cancelBatchPart, onTurnEnd, offerRecommendedRoles } from './routing.ts';
import { parseRoleMarkers } from '../../public/js/core/role-markers.js';
import { isTestCommand } from '../core/test-command.ts';
import { captureProject } from './project.ts';
import { buildMatcher } from '../core/safety.ts';
import { toMentionIds } from '../core/recipients.ts';
import { flushMentionStreams, recordMessageFragment } from './mention-stream.ts';
export interface OpenOptions {
  workDir: string;
  restoreId?: string | null;
  team?: Partial<AgentSpec>[];
  routingMode?: string;
}

function prepareConversation({ workDir, restoreId, team, routingMode }: OpenOptions) {
  let saved = null;
  if (restoreId) {
    saved = loadConversation(LOGS_DIR, restoreId);
    workDir = saved.workDir || workDir;
    team = saved.team?.length ? saved.team : team;
    routingMode = saved.routingMode || routingMode;
  }
  if (!fs.statSync(workDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Working directory does not exist: ${workDir}`);
  const id = restoreId || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(LOGS_DIR, id);
  fs.mkdirSync(runDir, { recursive: true });

  const file = path.join(runDir, 'transcript.jsonl');
  const transcript = fs.createWriteStream(file, { fd: fs.openSync(file, 'a') });
  const owner: Conversation = {
    id,
    runDir,
    transcript,
    workDir,
    routingMode: (routingMode && routingMode in ROUTING_MODES ? routingMode : setting('routingMode')) as RoutingMode,
    relay: { hops: 0, halted: Boolean(saved), userPaused: Boolean(saved) },
    stoppedTasks: new Set(),
    heldRelays: [],
    team: [],
    agents: {},
    nextAgent: saved?.lastAgentId || 0,
    retiredAgents: saved?.retiredAgents || new Map(),
    pendingAgentNames: new Set(),
    rosterVersion: 1,
    rosterSeen: {},
    pendingRoleNote: {},
    providerChanges: new Set(),
    providerHandoffs: restoreProviderHandoffs(saved?.events ?? [], team ?? []),
    lastSender: {},
    lastUserText: saved?.events.findLast((event) => event.kind === 'user' && typeof event.text === 'string')?.text,
    tasks: new Map(),
    refusedRoles: new Set(),
    roleDecisionVersion: 0,
    project: saved?.events.findLast((event) => event.kind === 'projectBaseline')?.project || {},
    testResults:
      saved?.events
        .filter((event) => event.kind === 'observedTest')
        .map((event) => event.result)
        .slice(-40) || [],
    possibleTests: new Map(),
    lastAnswerSeq: {},
  };
  transcript.once('error', (error) => {
    const text = 'Conversation history could not be saved: ' + error.message;
    console.error(text);
    if (!S.conv || S.conv === owner) publish({ kind: 'error', text });
  });
  try {
    for (const t of team || defaultTeam()) {
      const driver = DRIVERS[t.driver] ? t.driver : 'claude';
      const role = S.roles[t.role] ? t.role : 'coder';
      const spec = {
        id: t.id && /^a\d+$/.test(t.id) ? t.id : `a${owner.nextAgent + 1}`,
        name: uniqueName(t.name || defaultName(driver, role), Boolean(saved), owner),
        driver,
        role,
        model: t.model && t.model !== 'default' ? t.model : null,
        effort: t.effort && t.effort !== 'default' ? t.effort : null,
        bypass: Boolean(t.bypass),
        sessionId: saved ? t.sessionId || null : null,
        cachedTokens: saved ? t.cachedTokens || 0 : 0,
        tokens: saved ? t.tokens || 0 : 0,
        baseTokens: saved ? t.baseTokens : undefined,
        baseCachedTokens: saved ? t.baseCachedTokens : undefined,
        providerChangeId: saved ? t.providerChangeId : undefined,
        cwd: t.cwd && t.worktree && fs.existsSync(t.cwd) ? t.cwd : undefined,
        worktree: t.cwd && t.worktree && fs.existsSync(t.cwd) ? t.worktree : undefined,
      };
      owner.nextAgent = Math.max(owner.nextAgent, Number(spec.id.slice(1)));
      owner.team.push(spec);
      createAgent(spec, owner);
    }
    const activePaths = new Set([workDir, ...owner.team.flatMap((spec) => (spec.worktree && spec.cwd ? [spec.cwd] : []))]);
    owner.project = Object.fromEntries(Object.entries(owner.project).filter(([cwd]) => activePaths.has(cwd)));
    for (const cwd of activePaths) captureProject(owner, cwd, !saved);
    const workflow = saved?.events.findLast((event) => event.kind === 'workflowChanged');
    owner.plan = workflow?.plan ?? undefined;
    owner.succession = workflow?.succession ?? undefined;
    if (saved) restoreMilestoneViews(owner, saved.events.findLast((event) => event.kind === 'milestoneProgress')?.milestones);
    return { owner, saved };
  } catch (error) {
    transcript.destroy();
    throw error;
  }
}

function activateConversation({ owner, saved }: ReturnType<typeof prepareConversation>) {
  S.conv = owner;
  S.history = saved ? saved.events : [];
  S.seq = Math.max(S.seq, saved?.lastSeq || 0);
  if (!saved) publish({ kind: 'projectBaseline', project: owner.project });
  return { saved };
}

export function openConversation(options: OpenOptions) {
  return activateConversation(prepareConversation(options));
}

async function closeActiveConversation() {
  if (!S.conv) return true;
  const old = S.conv;
  stopWatching(old);
  flushMentionStreams(old);
  cancelMilestoneDecision(old, 'closed');
  S.conv = null as unknown as Conversation;
  for (const t of approvalTimers.values()) clearTimeout(t);
  approvalTimers.clear();
  await Promise.all(Object.values(old.agents).map((a) => a.shutdown().catch(() => {})));
  const drained = finished(old.transcript, { cleanup: true });
  old.transcript.end();
  return drained.then(
    () => true,
    () => false,
  );
}

let transition: Promise<unknown> = Promise.resolve();
let stopping = false;

function serializeTransition<T>(operation: () => Promise<T>) {
  const result = transition.then(operation);
  transition = result.catch(() => {});
  return result;
}

export function closeConversation() {
  stopping = true;
  return serializeTransition(closeActiveConversation);
}

export function startAgents() {
  for (const a of Object.values(S.conv.agents)) startAgent(a);
}

export function wireAgent(owner: Conversation, id: string, agent: Agent): void {
  let silence: NodeJS.Timeout | undefined;
  const changeId = owner.team.find((member) => member.id === id)?.providerChangeId;
  agent.on('event', async (event: AgentEvent) => {
    if (S.conv !== owner || owner.agents[id] !== agent) return; // late events from a closed conversation or replaced agent
    clearTimeout(silence);
    if (agent.busy && !agent.approvals.size && !['turnEnd', 'tasksCancelled', 'unavailable'].includes(event.kind)) {
      silence = setTimeout(() => {
        if (S.conv === owner && owner.agents[id] === agent && agent.busy && !agent.approvals.size)
          publish({
            kind: 'info',
            agent: id,
            text: 'No provider activity for two minutes. The turn is still open; you can wait or stop it.',
          });
      }, 120000);
      silence.unref();
    }
    if (event.kind === 'inputAccepted') {
      settleProviderHandoff(owner, id, taskIdsFromLog(event.taskIds), true);
      return;
    }
    // Provider message and tool keys are only unique within their own session.
    const ev = changeId && typeof event.key === 'string' ? { ...event, key: changeId + ':' + event.key } : event;
    if (
      (ev.kind === 'delta' || ev.kind === 'text') &&
      typeof ev.key === 'string' &&
      typeof ev.text === 'string' &&
      !recordMessageFragment(owner, id, ev.key, ev.text, ev.kind === 'text' && ev.final ? 'final' : ev.kind)
    )
      return;
    if (ev.kind === 'stderr') {
      if (!owner.transcript.destroyed) owner.transcript.write(JSON.stringify({ at: Date.now(), ...ev }) + '\n');
      if (/\b(error|panic|fatal|exception)\b/i.test(ev.text)) logError(agentName(id), `stderr: ${ev.text}`);
      return;
    }
    if (ev.kind === 'models') {
      const driver = owner.team.find((a) => a.id === id)?.driver;
      if (driver) driverModelCache[driver] = { at: Date.now(), models: agent.models || [] };
    }
    if (ev.kind === 'status' || ev.kind === 'session' || ev.kind === 'models') {
      publishState();
      return;
    }
    if (ev.kind === 'usage') {
      publishState();
      checkTokenLimit();
      return;
    }
    if (ev.kind === 'account') {
      const driver = owner.team.find((a) => a.id === id)?.driver;
      if (!driver) return;
      const prev = providerRuntime[driver];
      const changed = !prev || prev.state !== ev.state;
      providerRuntime[driver] = { state: ev.state, detail: ev.detail || null, resetsAt: ev.resetsAt || null };
      delete cliCache[driver];
      if (changed && ev.state !== 'ok') {
        logError(agentName(id), `account: ${ev.state} ${ev.detail || ''}`);
        const when = ev.resetsAt ? ` until ${new Date(ev.resetsAt).toLocaleString()}` : '';
        publish({
          kind: 'error',
          agent: id,
          text: `${DRIVERS[driver].label}: ${ev.state === 'rate_limited' ? `usage limit reached${when}` : 'the account has no access (plan inactive, invalid key or no credit)'}. Its models are disabled; see Settings > Accounts.`,
        });
      }
      if (changed) {
        owner.rosterVersion += 1;
        publishState();
      }
      const resetsAt = Number(ev.resetsAt);
      if (ev.state === 'rate_limited' && resetsAt > Date.now() && resetsAt - Date.now() < 2147483647) {
        const current = providerRuntime[driver];
        setTimeout(
          () => {
            if (providerRuntime[driver] !== current || !S.conv) return;
            S.conv.rosterVersion += 1;
            publishState();
          },
          Math.max(1, resetsAt - Date.now() + 10),
        ).unref();
      }
      return;
    }
    if (ev.kind === 'unavailable') {
      owner.rosterVersion += 1;
      cancelBatchPart(owner, id, 'not delivered: agent unavailable');
      logError(agentName(id), `unavailable: ${ev.reason}`);
      publish({
        kind: 'error',
        agent: id,
        text: `@${id} is unavailable: ${ev.reason} Its models are disabled until you press Retry.`,
      });
      publishState();
      return;
    }
    if (ev.kind === 'approval') {
      const hit = await agent
        .isDestructive?.({ command: ev.matchText, cwd: ev.cwd || agent.cwd, deletePaths: ev.deletePaths })
        .catch(() => 'Could not verify the requested operation. Review it before proceeding.');
      if (S.conv !== owner || owner.agents[id] !== agent || !agent.approvals.has(ev.requestId)) return;
      const spec = owner.team.find((member) => member.id === id);
      if (spec?.bypass && mayBypassApproval(ev, (S.roles[spec.role]?.canEdit ?? 'none') === 'none', Boolean(hit))) {
        agent.respondApproval(ev.requestId, 'accept');
        publish({ kind: 'autoApproved', agent: id, title: ev.title, detail: ev.detail });
        return;
      }
      const approved = processShellApproval(owner, agent, ev, Boolean(hit));
      if (approved) {
        publish({ kind: 'autoApproved', agent: id, title: approved, detail: approved });
        return;
      }
      if (hit) ev.warning = hit;
      ev.title = ev.title.replace(/^(Claude|Codex|OpenCode)\b/, '@' + id);
      armApprovalTimeout(id, ev);
    }
    if (ev.kind === 'approvalClosed') {
      closeShellApproval(owner, ev.requestId);
      clearTimeout(approvalTimers.get(ev.requestId));
      approvalTimers.delete(ev.requestId);
    }
    const lifecycle = isTaskLifecycleKind(ev.kind) ? readAgentTaskEvent(ev) : null;
    if (isTaskLifecycleKind(ev.kind) && !lifecycle) {
      publish({ kind: 'info', agent: id, text: 'Ignored a malformed provider task event.' });
      return;
    }
    const finishedTasks =
      lifecycle?.kind === 'turnEnd'
        ? lifecycle.taskIds.flatMap((taskId) => {
            const task = owner.tasks.get(taskId);
            return task?.agent === id ? [task] : [];
          })
        : [];
    if (lifecycle) {
      if (lifecycle.kind !== 'taskStarted') settleProviderHandoff(owner, id, lifecycle.taskIds, false);
      for (const taskId of lifecycle.taskIds) {
        const task = owner.tasks.get(taskId);
        if (task?.agent !== id) continue;
        if (lifecycle.kind === 'taskStarted') task.state = 'working';
        else owner.tasks.delete(taskId);
      }
    }
    const toolKey = id + '|' + ev.key;
    if (ev.kind === 'tool') {
      const title = String(ev.title || '');
      if (owner.changeMark && /^(?:edit|multiedit|notebookedit|write|fileChange|patch|apply_patch)$/i.test(title))
        owner.changeMark.editTools.set(toolKey, agent.cwd || owner.workDir);
      const activity = /^(?:bash|shell|commandExecution)$/i.test(title)
        ? 'running a command'
        : /^(?:edit|fileChange|write)$/i.test(title)
          ? 'editing files'
          : /^(?:read|readFile)$/i.test(title)
            ? 'reading files'
            : '';
      if (activity) {
        let changed = false;
        for (const task of owner.tasks.values()) {
          if (task.agent !== id || task.state !== 'working' || task.activity === activity) continue;
          task.activity = activity;
          changed = true;
        }
        if (changed) publishState();
      }
    }
    if (ev.kind === 'tool' && /^(?:Bash|shell|commandExecution)$/i.test(String(ev.title || '')) && isTestCommand(String(ev.detail || ''))) {
      owner.possibleTests.set(toolKey, agentName(id));
    }
    if (ev.kind === 'toolResult' && owner.changeMark) {
      const folder = owner.changeMark.editTools.get(toolKey);
      if (folder && ev.ok === true) owner.changeMark.editedFolders.add(folder);
      owner.changeMark.editTools.delete(toolKey);
    }
    if (ev.kind === 'toolResult' && typeof ev.ok === 'boolean' && owner.possibleTests.has(toolKey)) {
      const result = owner.possibleTests.get(toolKey) + (ev.ok ? ' · passed' : ' · failed');
      owner.possibleTests.delete(toolKey);
      owner.testResults = [...owner.testResults.slice(-39), result];
      publish({ kind: 'observedTest', result });
    }
    const workflow = ev.kind === 'turnEnd' && typeof ev.text === 'string' ? workflowMarkers(ev.text) : null;
    const milestone =
      (ev.kind === 'text' || ev.kind === 'turnEnd') && typeof ev.text === 'string'
        ? parseMilestoneMarkers(workflow?.text ?? ev.text)
        : null;
    const markers = milestone ? parseRoleMarkers(milestone.text) : null;
    const text = markers ? toMentionIds(markers.text, owner.team) : undefined;
    const clean = text !== undefined ? { ...ev, text } : ev;
    if (lifecycle?.kind === 'turnEnd' || (lifecycle?.kind === 'tasksCancelled' && !agent.busy)) flushMentionStreams(owner, id);
    const published = publish(clean);
    if (ev.kind === 'text' && ev.final && published.seq) owner.lastAnswerSeq[id] = published.seq;
    if (lifecycle?.kind === 'turnEnd') {
      const sourceSeq = owner.lastAnswerSeq[id] ?? published.seq;
      if (lifecycle.taskIds.some((task) => owner.stoppedTasks.has(task))) {
        for (const task of lifecycle.taskIds) owner.stoppedTasks.delete(task);
        delete owner.lastAnswerSeq[id];
        publishState();
        return;
      }
      delete owner.lastAnswerSeq[id];
      const plan = owner.plan;
      const currentTasks = plan ? finishedTasks.filter((task) => (task.sourceSeq ?? 0) >= plan.seq) : [];
      if (lifecycle.ok && owner.plan && currentTasks.length) {
        if (owner.plan.size === 'small') void checkGrowth(owner);
        const handled = readTaskBlocks(
          owner,
          id,
          workflow?.blocks || [],
          Boolean(text?.trim() || markers?.roles.length || milestone?.proposed),
          currentTasks.find((t) => t.specAttempt === 'correction')?.specAttempt ?? currentTasks.find((t) => t.specAttempt)?.specAttempt,
        );
        if (handled) {
          const batchId = owner.batch?.pending.get(id);
          if (batchId && lifecycle.taskIds.includes(batchId)) completeBatch(owner, id, batchId);
          publishState();
          return;
        }
      }
      if (markers?.incomplete) publish({ kind: 'info', agent: id, text: 'Incomplete role recommendation ignored.' });
      if (owner.plan?.size !== 'small' && markers?.roles.length && offerRecommendedRoles(owner, id, markers.roles)) return;
      const role = owner.team.find((member) => member.id === id)?.role;
      const delegatedReview =
        role === 'reviewer' &&
        finishedTasks.some(({ from }) => owner.team.some((member) => member.id === from && member.role === 'orchestrator'));
      if (delegatedReview) observeMilestoneReview(owner, lifecycle.ok ? (text ?? lifecycle.text) : 'CHANGES REQUESTED');
      if (milestone && owner.routingMode === 'orchestrator' && role === 'orchestrator' && finishedTasks.length && lifecycle.ok) {
        if (milestone.invalid) publish({ kind: 'info', agent: id, text: 'Ignored a malformed milestone declaration.' });
        else if (milestone.proposed) {
          try {
            if (owner.plan && owner.plan.size !== 'large') {
              publish({ kind: 'info', agent: id, text: 'Milestones require a large task. Change the task size to use them.' });
              return;
            }
            if (owner.plan && (!owner.plan.approved || owner.plan.awaitingSpecRevision)) {
              requestSpec(owner, id);
              return;
            }
            if (offerMilestonePlan(owner, id, milestone.proposed)) return;
          } catch (error) {
            publish({ kind: 'info', agent: id, text: error instanceof Error ? error.message : 'Invalid milestone plan.' });
          }
        } else if (milestone.number !== null) {
          void finishMilestone(owner, id, milestone.number, text?.trim() || '');
          return;
        }
      }
      onTurnEnd(id, { ...lifecycle, text: text ?? lifecycle.text, seq: published.seq, sourceSeq });
    }
    if (lifecycle?.kind === 'tasksCancelled') cancelBatchPart(owner, id, 'cancelled: provider interrupted the task', lifecycle.taskIds);
    if (ev.kind === 'taskStarted' || ev.kind === 'tasksCancelled') publishState();
  });
}

export function armApprovalTimeout(agentId: string, ev: AgentEvent): void {
  const sec = Number(setting('approvalTimeoutSec'));
  if (!(sec > 0)) return;
  ev.expiresAt = Date.now() + sec * 1000;
  const owner = S.conv;
  const agent = owner.agents[agentId];
  const timer = setTimeout(() => {
    approvalTimers.delete(ev.requestId);
    if (S.conv !== owner || owner.agents[agentId] !== agent) return;
    closeShellApproval(owner, ev.requestId);
    if (
      agent.respondApproval(
        ev.requestId,
        'decline',
        'No answer from the user in time, so this was declined automatically. Continue without it or ask the user.',
      )
    ) {
      publish({ kind: 'approvalClosed', requestId: ev.requestId, decision: 'timeout' });
      publishState();
    }
  }, sec * 1000);
  approvalTimers.set(ev.requestId, timer);
}

export function totalTokens() {
  return S.conv.team.reduce((sum, spec) => sum + (spec.baseTokens || 0) + (S.conv.agents[spec.id]?.tokens || 0), 0);
}

export function tokenLimitReached() {
  const limit = Number(setting('tokenLimit'));
  return limit > 0 && totalTokens() >= limit;
}

export function checkTokenLimit() {
  const limit = Number(setting('tokenLimit'));
  if (S.conv.relay.halted || !tokenLimitReached()) return false;
  S.conv.relay.halted = true;
  S.conv.relay.limitPause = 'tokens';
  publish({
    kind: 'system',
    text: `Token limit reached (${totalTokens().toLocaleString()} of ${limit.toLocaleString()}). Hand-offs are paused. Increase the limit or send a new message to continue.`,
  });
  publishState();
  return true;
}

async function switchConversation(options: OpenOptions) {
  const next = prepareConversation(options);
  const savedPrevious = await closeActiveConversation();
  activateConversation(next);
  resetClients();
  if (!savedPrevious) publish({ kind: 'error', text: 'The previous conversation history was not fully saved.' });
  return next.saved;
}

export function restoreConversation(id: string) {
  return serializeTransition(async () => {
    if (stopping) throw new Error('Agent Bridge is shutting down.');
    if (S.conv?.id === id) return;
    if (!listConversations(LOGS_DIR).some((c) => c.id === id)) throw new Error(`conversation ${id} not found`);
    const saved = await switchConversation({ workDir: process.cwd(), restoreId: id });
    const resumed = S.conv.team.filter((a) => a.sessionId).map((a) => '@' + a.id);
    publish({
      kind: 'system',
      text: `Restored conversation from ${new Date(saved?.startedAt || Date.now()).toLocaleString()} in ${S.conv.workDir} with ${S.conv.team.length} agent(s). ${resumed.length ? `${resumed.join(', ')} continue their sessions.` : 'No agent sessions were saved, so the agents start fresh.'} Relay is paused until you send a message.`,
    });
    startAgents();
    publishState();
  });
}

export function newConversation(workDir?: string) {
  return serializeTransition(async () => {
    if (stopping) throw new Error('Agent Bridge is shutting down.');
    const dir = path.resolve(workDir || S.conv?.workDir || process.cwd());
    await switchConversation({ workDir: dir });
    publish({
      kind: 'system',
      text: `New conversation in ${dir}. Team: ${S.conv.team.map((a) => `@${a.id} (${S.roles[a.role]?.name})`).join(', ')}.`,
    });
    startAgents();
    publishState();
  });
}

export function settingsView() {
  return Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, setting(k)]));
}

export function saveSettings(input: Record<string, any>): void {
  const next: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (!(key in input)) continue;
    let v = input[key];
    if (def.type === 'boolean') v = Boolean(v);
    else if (def.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || v < (def.min ?? -Infinity))
        throw new Error(`${key} must be a number${def.min !== undefined ? ` ≥ ${def.min}` : ''}`);
    } else if (def.type === 'enum') {
      if (!(def.values || []).includes(v)) throw new Error(`${key} must be one of ${(def.values || []).join(', ')}`);
    } else if (def.type === 'list') {
      v = (Array.isArray(v) ? v : String(v).split('\n')).map((s) => String(s).trim()).filter(Boolean);
      for (const p of v) if (!safeRegex(p)) throw new Error(`invalid pattern in ${key}: ${p}`);
    } else v = String(v);
    next[key] = v;
  }
  if (input.saveTeamAsDefault && S.conv) {
    next.defaultTeam = S.conv.team.map((a) => ({
      driver: a.driver,
      role: a.role,
      name: a.name,
      model: a.model || null,
      effort: a.effort || null,
      bypass: a.bypass,
    }));
  }
  saveLocalConfig(next);
  relay.auto = setting('autoRelay');
  relay.maxHops = Number(setting('maxHops'));
  if (S.conv) {
    S.conv.routingMode = 'routingMode' in input ? setting('routingMode') : S.conv.routingMode;
    for (const a of Object.values(S.conv.agents)) {
      a.isDestructive = buildMatcher({
        workDir: a.cwd,
        destructive: setting('destructivePatterns'),
        deletion: setting('deletionPatterns'),
      });
    }
  }
}
