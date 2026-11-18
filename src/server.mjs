import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ClaudeAgent } from './claude-agent.mjs';
import { CodexAgent } from './codex-agent.mjs';
import { OpenCodeAgent } from './opencode-agent.mjs';
import { FakeAgent } from './fake-agent.mjs';
import { buildInstructions, rosterText, ROUTING_MODES } from './prompts.mjs';
import { buildMatcher, DEFAULT_DESTRUCTIVE_PATTERNS, DEFAULT_DELETION_PATTERNS } from './safety.mjs';
import { listConversations, loadConversation, removeConversation, LOGS_DIR_NAME } from './history.mjs';
import { loadRoles, isRecommended, globMatch } from './roles.mjs';
import os from 'node:os';
import { createWorktree } from './worktree.mjs';
import { PROVIDERS, cliStatus, mergeStatus, nextStep, openLoginTerminal } from './accounts.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
let LOGS_DIR = path.join(APP_DIR, LOGS_DIR_NAME);
const ROLES_DIR = path.join(APP_DIR, 'roles');
const DONE_MARKER = /^\s*\[\[DONE\]\]\s*$/m;

// ---------- configuration ----------
const argv = parseArgs(process.argv.slice(2));

// --log-file: write console output to a file ourselves. Shell redirection (cmd ">>") locks the file,
// so a restarted process could not write to it.
if (argv['log-file']) {
  const logPath = path.resolve(String(argv['log-file']));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const write = (...parts) => {
    try {
      fs.writeSync(fd, `${parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack : JSON.stringify(p))).join(' ')}\n`);
    } catch {
      // never let logging break the app
    }
  };
  console.log = write;
  console.error = write;
  write(`--- ${new Date().toISOString()} start (pid ${process.pid}) ---`);
}
const configPath = path.resolve(argv.config || path.join(APP_DIR, 'config.json'));
if (argv.logs) LOGS_DIR = path.resolve(argv.logs);
// config.json holds the shipped defaults; what the user changes in Settings is saved to config.local.json
// next to it (ignored by git), so personal settings never end up in the repository.
const localConfigPath = configPath.replace(/\.json$/i, '') + '.local.json';
const readJsonFile = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
let localConfig = readJsonFile(localConfigPath);
let config = { ...readJsonFile(configPath), ...localConfig };

/** Save user changes: merged into config.local.json, then into the running config. */
function saveLocalConfig(changes) {
  localConfig = { ...localConfig, ...changes };
  fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2) + '\n');
  config = { ...readJsonFile(configPath), ...localConfig };
}
const port = Number(argv.port ?? config.port ?? 0);
let roles = loadRoles(ROLES_DIR);

/** Settings that the Settings screen can change (saved to config.json). */
const SETTINGS = {
  userName: { type: 'string', default: 'the user' },
  routingMode: { type: 'enum', values: Object.keys(ROUTING_MODES), default: 'orchestrator' },
  autoRelay: { type: 'boolean', default: true },
  maxHops: { type: 'number', min: 0, default: 8 },
  tokenLimit: { type: 'number', min: 0, default: 0 },
  approvalTimeoutSec: { type: 'number', min: 0, default: 120 },
  bypassNewAgents: { type: 'boolean', default: false },
  warnOnExtraAgents: { type: 'boolean', default: true },
  missingRolePolicy: { type: 'enum', values: ['ask', 'closest'], default: 'ask' },
  maxReviewRounds: { type: 'number', min: 0, default: 2 },
  finalConfirmation: { type: 'boolean', default: true },
  sensitiveModelPatterns: { type: 'list', default: ['big-pickle', 'stealth', ':free', '-free'] },
  destructivePatterns: { type: 'list', default: DEFAULT_DESTRUCTIVE_PATTERNS },
  deletionPatterns: { type: 'list', default: DEFAULT_DELETION_PATTERNS },
  openBrowser: { type: 'boolean', default: true },
};
const setting = (key) => config[key] ?? SETTINGS[key].default;

const DRIVERS = {
  claude: { label: 'Claude Code', Agent: ClaudeAgent },
  codex: { label: 'Codex', Agent: CodexAgent },
  opencode: { label: 'OpenCode', Agent: OpenCodeAgent },
};
// Scripted provider for automated tests only.
if (config.enableFakeProvider) DRIVERS.fake = { label: 'Fake (tests)', Agent: FakeAgent };

/** Team used for a new conversation: config.defaultTeam, else the old mainAgent setting. */
function defaultTeam() {
  if (Array.isArray(config.defaultTeam) && config.defaultTeam.length) return config.defaultTeam.map((a) => ({ ...a }));
  const main = String(argv.main || config.mainAgent || 'claude').toLowerCase() === 'codex' ? 'codex' : 'claude';
  const other = main === 'claude' ? 'codex' : 'claude';
  return [
    { driver: main, role: 'orchestrator' },
    { driver: other, role: 'coder' },
  ];
}

/** What agents reported about their account while running: { driver: { state, detail, resetsAt } }. */
const providerRuntime = {};

/** Model lists per provider, for the "Add agent" form: { driver: { at, models } }. */
const driverModelCache = {};

/**
 * Models of a provider before any agent of it exists: start a short-lived instance of its driver,
 * wait for its model list, and close it.
 */
async function listDriverModels(driver) {
  const cached = driverModelCache[driver];
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models;
  const live = conv && Object.entries(conv.agents).find(([id]) => conv.team.find((a) => a.id === id)?.driver === driver)?.[1];
  if (live?.models?.length) return live.models;
  const { Agent } = DRIVERS[driver];
  const probe = new Agent({
    id: `probe-${driver}`,
    name: 'probe',
    cwd: conv?.workDir || process.cwd(),
    config: { ...(config[driver] || {}) },
    instructions: '',
  });
  try {
    const models = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no model list after 45 s')), 45000);
      probe.on('event', (ev) => {
        if (ev.kind === 'models') {
          clearTimeout(timer);
          resolve(probe.models || []);
        } else if (ev.kind === 'unavailable') {
          clearTimeout(timer);
          reject(new Error(ev.reason));
        }
      });
      Promise.resolve(probe.start()).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    driverModelCache[driver] = { at: Date.now(), models };
    return models;
  } finally {
    probe.shutdown().catch(() => {});
  }
}
const cliCache = {};

function providerBlocked(driver) {
  const r = providerRuntime[driver];
  if (!r || r.state === 'ok') return null;
  if (r.state === 'rate_limited' && r.resetsAt && r.resetsAt < Date.now()) return null;
  return r;
}

const relay = { auto: setting('autoRelay'), maxHops: Number(setting('maxHops')), hops: 0, halted: false };
const approvalTimers = new Map();

// ---------- event bus (SSE) ----------
let history = [];
const clients = new Set();
let seq = 0;

/** The open conversation: log folder, project folder, routing and the team of agents. */
let conv = null;

function publish(ev) {
  const full = { seq: ++seq, at: Date.now(), ...ev };
  history.push(full);
  if (history.length > 20000) history.splice(0, history.length - 20000);
  conv?.transcript.write(JSON.stringify(full) + '\n');
  if (full.kind === 'error') logError(full.agent ? agentName(full.agent) : 'bridge', full.text);
  const line = `data: ${JSON.stringify(full)}\n\n`;
  for (const res of clients) res.write(line);
}

/** errors.log next to the transcript: one line per problem, for finding causes later. */
function logError(source, text) {
  if (!conv) return;
  try {
    fs.appendFileSync(
      path.join(conv.runDir, 'errors.log'),
      `${new Date().toISOString()} [${source}] ${String(text).replace(/\s+$/g, '')}\n`,
    );
  } catch {
    // logging must never break the app
  }
}

const agentName = (id) => conv?.team.find((a) => a.id === id)?.name || id;

function decorateModels(spec, agent) {
  const role = roles[spec.role];
  const sensitive = setting('sensitiveModelPatterns')
    .map((p) => safeRegex(p))
    .filter(Boolean);
  const blocked = providerBlocked(spec.driver);
  return (agent.models || []).map((m) => ({
    ...m,
    recommended: isRecommended(role, m),
    sensitive: sensitive.some((r) => r.test(`${m.value} ${m.label || ''}`)),
    disabled: Boolean(m.disabled) || !agent.available || Boolean(blocked),
    disabledReason: m.disabledReason || (!agent.available ? agent.unavailableReason : blocked ? blocked.detail || blocked.state : null),
  }));
}

function teamState() {
  return conv.team.map((spec) => {
    const a = conv.agents[spec.id];
    return {
      id: spec.id,
      name: spec.name,
      driver: spec.driver,
      driverLabel: DRIVERS[spec.driver]?.label || spec.driver,
      role: spec.role,
      cwd: a?.cwd || conv.workDir,
      worktree: spec.worktree || null,
      busy: Boolean(a?.busy),
      waitingApproval: a?.approvals?.size || 0,
      bypass: Boolean(spec.bypass),
      sessionId: a?.sessionId || a?.threadId || spec.sessionId || null,
      model: a?.model || 'default',
      effort: a?.effort || 'default',
      resolvedModel: a?.resolvedModel || null,
      models: a ? decorateModels(spec, a) : [],
      tokens: a?.tokens || 0,
      cachedTokens: a?.cachedTokens || 0,
      available: a ? a.available !== false : false,
      unavailableReason: a?.unavailableReason || null,
      account: providerBlocked(spec.driver),
    };
  });
}

function stateEvent() {
  const team = teamState();
  return {
    kind: 'state',
    conversationId: conv.id,
    workDir: conv.workDir,
    routingMode: conv.routingMode,
    relay: { ...relay },
    tokenLimit: Number(setting('tokenLimit')),
    totalTokens: team.reduce((s, a) => s + a.tokens, 0),
    totalCachedTokens: team.reduce((s, a) => s + a.cachedTokens, 0),
    team,
  };
}

function publishState() {
  if (!conv) return;
  publish(stateEvent());
}

/** A state snapshot sent before replaying history, so names and roles are known while it renders. */
function snapshotLine() {
  return conv ? `data: ${JSON.stringify({ seq: 0, at: Date.now(), ...stateEvent() })}\n\n` : '';
}

// ---------- team ----------
function uniqueName(base) {
  const clean =
    String(base || 'Agent')
      .replace(/[^\w-]/g, '')
      .slice(0, 24) || 'Agent';
  const taken = new Set(conv.team.map((a) => a.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}${i}`.toLowerCase())) return `${clean}${i}`;
}

function defaultName(driver, role) {
  const d = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[driver] || 'Agent';
  return `${d}-${roles[role]?.name || 'Agent'}`;
}

/** Create the agent process wrapper for one team member (the process itself starts lazily or on start()). */
function createAgent(spec) {
  const role = roles[spec.role] || roles.coder || Object.values(roles)[0];
  const readOnly = role?.canEdit === 'none';
  const cwd = spec.cwd || conv.workDir;
  const instructions = buildInstructions({
    name: spec.name,
    role,
    routingMode: conv.routingMode,
    workDir: cwd,
    userName: setting('userName'),
    extra: config[spec.driver]?.instructions,
  });
  const base = { ...(config[spec.driver] || {}) };
  if (spec.model && spec.model !== 'default') base.model = spec.model;
  if (spec.effort) base.effort = spec.effort;
  let agent;
  if (spec.driver === 'claude') {
    const promptFile = path.join(conv.runDir, `instructions-${spec.id}.txt`);
    fs.writeFileSync(promptFile, instructions);
    agent = new ClaudeAgent({
      id: spec.id,
      name: spec.name,
      cwd,
      config: { ...base, resumeSessionId: spec.sessionId || null },
      systemPromptFile: promptFile,
      readOnly,
      tokens: spec.tokens || 0,
      cachedTokens: spec.cachedTokens || 0,
      maxTurns: role?.maxTurns || null,
      ...roleProfile(spec.role),
    });
  } else if (spec.driver === 'codex') {
    agent = new CodexAgent({
      id: spec.id,
      name: spec.name,
      cwd,
      config: { ...base, resumeThreadId: spec.sessionId || null },
      instructions,
      readOnly,
      tokens: spec.tokens || 0,
      cachedTokens: spec.cachedTokens || 0,
    });
  } else if (spec.driver === 'opencode') {
    agent = new OpenCodeAgent({
      id: spec.id,
      name: spec.name,
      cwd,
      config: { ...base, resumeSessionId: spec.sessionId || null },
      instructions,
      readOnly,
      tokens: spec.tokens || 0,
      cachedTokens: spec.cachedTokens || 0,
      skillsOff: roleProfile(spec.role, true).skillsOff,
    });
  } else if (spec.driver === 'fake' && DRIVERS.fake) {
    agent = new FakeAgent({
      id: spec.id,
      name: spec.name,
      cwd,
      config: { ...(config.fake || {}), ...base, resumeSessionId: spec.sessionId || null },
      tokens: spec.tokens || 0,
      cachedTokens: spec.cachedTokens || 0,
    });
  } else {
    throw new Error(`unknown driver ${spec.driver}`);
  }
  agent.isDestructive = buildMatcher({ workDir: cwd, destructive: setting('destructivePatterns'), deletion: setting('deletionPatterns') });
  wireAgent(conv, spec.id, agent);
  conv.agents[spec.id] = agent;
  conv.rosterSeen[spec.id] = 0;
  return agent;
}

async function addAgent({ driver, role, name, model, effort, bypass, worktree }) {
  if (!DRIVERS[driver]) throw new Error(`unknown provider ${driver}`);
  if (!roles[role]) throw new Error(`unknown role ${role}`);
  const spec = {
    id: `a${++conv.nextAgent}`,
    name: uniqueName(name || defaultName(driver, role)),
    driver,
    role,
    model: model && model !== 'default' ? model : null,
    effort: effort && effort !== 'default' ? effort : null,
    bypass: bypass ?? Boolean(setting('bypassNewAgents')),
  };
  if (worktree) {
    const wt = await createWorktree({ repoDir: conv.workDir, conversationId: conv.id, agentName: spec.name });
    spec.cwd = wt.path;
    spec.worktree = wt;
    publish({ kind: 'system', text: `${spec.name} works in its own git worktree: ${wt.path} (branch ${wt.branch}).` });
  }
  conv.team.push(spec);
  conv.rosterVersion++;
  const agent = createAgent(spec);
  await startAgent(agent);
  publish({ kind: 'system', text: `Added ${spec.name} (${DRIVERS[driver].label}, ${roles[role].name}).` });
  publishState();
  return spec;
}

async function removeAgent(id) {
  const idx = conv.team.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('unknown agent');
  if (conv.team.length === 1) throw new Error('a conversation needs at least one agent');
  const [spec] = conv.team.splice(idx, 1);
  const agent = conv.agents[id];
  delete conv.agents[id];
  conv.rosterVersion++;
  await agent?.shutdown().catch(() => {});
  publish({ kind: 'system', text: `Removed ${spec.name}. Its session stays saved in the log.` });
  publishState();
}

async function setRole(id, roleId) {
  const spec = conv.team.find((a) => a.id === id);
  if (!spec || !roles[roleId]) throw new Error('unknown agent or role');
  spec.role = roleId;
  const role = roles[roleId];
  const agent = conv.agents[id];
  // New instructions for drivers that read them at start; a message for the session that is running.
  if (spec.driver === 'claude') {
    fs.writeFileSync(
      path.join(conv.runDir, `instructions-${id}.txt`),
      buildInstructions({
        name: spec.name,
        role,
        routingMode: conv.routingMode,
        workDir: agent.cwd,
        userName: setting('userName'),
        extra: config.claude?.instructions,
      }),
    );
  } else if (agent.setInstructions) {
    agent.setInstructions(
      buildInstructions({
        name: spec.name,
        role,
        routingMode: conv.routingMode,
        workDir: agent.cwd,
        userName: setting('userName'),
        extra: config[spec.driver]?.instructions,
      }),
    );
  }
  await agent.reconfigure({ readOnly: role.canEdit === 'none', maxTurns: role.maxTurns || null, ...roleProfile(roleId) });
  conv.pendingRoleNote[id] = `[Role change] From now on your role is ${role.name}. ${role.summary}\n${role.instructions}`;
  conv.rosterVersion++;
  publish({ kind: 'system', text: `${spec.name} is now ${role.name}.` });
  publishState();
}

async function startAgent(agent) {
  try {
    await agent.start();
  } catch {
    // start errors are reported by the agent itself (and mark it unavailable)
  }
}

// ---------- conversation lifecycle ----------
function openConversation({ workDir, restoreId, team, routingMode }) {
  let saved = null;
  if (restoreId) {
    saved = loadConversation(LOGS_DIR, restoreId);
    workDir = saved.workDir || workDir;
    team = saved.team?.length ? saved.team : team;
    routingMode = saved.routingMode || routingMode;
  }
  if (!fs.existsSync(workDir)) throw new Error(`Working directory does not exist: ${workDir}`);
  const id = restoreId || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(LOGS_DIR, id);
  fs.mkdirSync(runDir, { recursive: true });

  conv = {
    id,
    runDir,
    transcript: fs.createWriteStream(path.join(runDir, 'transcript.jsonl'), { flags: 'a' }),
    workDir,
    routingMode: ROUTING_MODES[routingMode] ? routingMode : setting('routingMode'),
    team: [],
    agents: {},
    nextAgent: 0,
    rosterVersion: 1,
    rosterSeen: {},
    pendingRoleNote: {},
    lastSender: {},
  };
  history = saved ? saved.events : [];
  seq = Math.max(seq, saved?.lastSeq || 0);
  relay.hops = 0;
  relay.halted = Boolean(saved);

  for (const t of team || defaultTeam()) {
    const driver = DRIVERS[t.driver] ? t.driver : 'claude';
    const role = roles[t.role] ? t.role : 'coder';
    const spec = {
      id: t.id && /^a\d+$/.test(t.id) ? t.id : `a${conv.nextAgent + 1}`,
      name: uniqueName(t.name || defaultName(driver, role)),
      driver,
      role,
      model: t.model && t.model !== 'default' ? t.model : null,
      effort: t.effort && t.effort !== 'default' ? t.effort : null,
      bypass: Boolean(t.bypass),
      sessionId: saved ? t.sessionId || null : null,
      cachedTokens: saved ? t.cachedTokens || 0 : 0,
      tokens: saved ? t.tokens || 0 : 0,
      cwd: t.cwd && t.worktree && fs.existsSync(t.cwd) ? t.cwd : undefined,
      worktree: t.cwd && t.worktree && fs.existsSync(t.cwd) ? t.worktree : undefined,
    };
    conv.nextAgent = Math.max(conv.nextAgent, Number(spec.id.slice(1)));
    conv.team.push(spec);
    createAgent(spec);
  }
  return { saved };
}

async function closeConversation() {
  if (!conv) return;
  const old = conv;
  conv = null;
  for (const t of approvalTimers.values()) clearTimeout(t);
  approvalTimers.clear();
  await Promise.all(Object.values(old.agents).map((a) => a.shutdown().catch(() => {})));
  old.transcript.end();
}

function startAgents() {
  for (const a of Object.values(conv.agents)) startAgent(a);
}

function resetClients() {
  for (const res of clients) {
    res.write(`data: ${JSON.stringify({ kind: 'reset' })}\n\n`);
    res.write(snapshotLine());
    for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
}

function wireAgent(owner, id, agent) {
  agent.on('event', (ev) => {
    if (conv !== owner || owner.agents[id] !== agent) return; // late events from a closed conversation or removed agent
    if (ev.kind === 'stderr') {
      owner.transcript.write(JSON.stringify({ at: Date.now(), ...ev }) + '\n');
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
      if (changed) publishState();
      return;
    }
    if (ev.kind === 'unavailable') {
      logError(agentName(id), `unavailable: ${ev.reason}`);
      publish({
        kind: 'error',
        agent: id,
        text: `${agentName(id)} is unavailable: ${ev.reason} Its models are disabled until you press Retry.`,
      });
      publishState();
      return;
    }
    if (ev.kind === 'approval') {
      const spec = owner.team.find((a) => a.id === id);
      const hit = agent.isDestructive({ command: ev.matchText, cwd: ev.cwd || agent.cwd, deletePaths: ev.deletePaths });
      if (spec?.bypass && !hit) {
        agent.respondApproval(ev.requestId, 'accept');
        publish({ kind: 'autoApproved', agent: id, title: ev.title, detail: ev.detail });
        return;
      }
      if (hit) ev.warning = hit;
      ev.title = ev.title.replace(/^(Claude|Codex|OpenCode)\b/, agentName(id));
      armApprovalTimeout(id, ev);
    }
    if (ev.kind === 'approvalClosed') clearTimeout(approvalTimers.get(ev.requestId));
    publish(ev);
    if (ev.kind === 'turnEnd') onTurnEnd(id, ev);
  });
}

function armApprovalTimeout(agentId, ev) {
  const sec = Number(setting('approvalTimeoutSec'));
  if (!(sec > 0)) return;
  ev.expiresAt = Date.now() + sec * 1000;
  const owner = conv;
  const timer = setTimeout(() => {
    approvalTimers.delete(ev.requestId);
    if (conv !== owner || !conv.agents[agentId]) return;
    if (
      conv.agents[agentId].respondApproval(
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

function totalTokens() {
  return Object.values(conv.agents).reduce((s, a) => s + (a.tokens || 0), 0);
}

function checkTokenLimit() {
  const limit = Number(setting('tokenLimit'));
  if (!(limit > 0) || relay.halted) return false;
  if (totalTokens() < limit) return false;
  relay.halted = true;
  publish({
    kind: 'system',
    text: `Token limit reached (${totalTokens().toLocaleString()} of ${limit.toLocaleString()}). Hand-offs are paused; send a message or press Resume to continue.`,
  });
  publishState();
  return true;
}

// ---------- routing ----------
function orchestratorId() {
  return (conv.team.find((a) => a.role === 'orchestrator') || conv.team[0])?.id;
}

/** @mentions of team members in a message, in order, without duplicates. */
function mentions(text, selfId) {
  const byName = new Map(conv.team.map((a) => [a.name.toLowerCase(), a.id]));
  const out = [];
  for (const m of String(text).matchAll(/@([\w-]+)/g)) {
    const id = byName.get(m[1].toLowerCase());
    if (id && id !== selfId && !out.includes(id)) out.push(id);
  }
  return out;
}

function nextInOrder(fromId, wrap) {
  const ids = conv.team.map((a) => a.id);
  const i = ids.indexOf(fromId);
  if (i < 0) return null;
  if (i + 1 < ids.length) return ids[i + 1];
  return wrap && ids.length > 1 ? ids[0] : null;
}

/** Who receives an agent's final message, by routing mode. Empty list = it is for the user. */
function routeTargets(fromId, text) {
  const mode = conv.routingMode;
  const ment = mentions(text, fromId);
  if (mode === 'orchestrator') {
    const orch = orchestratorId();
    if (fromId === orch) return ment;
    return orch && orch !== fromId ? [orch] : [];
  }
  if (mode === 'mentions') {
    if (ment.length) return ment;
    const back = conv.lastSender[fromId];
    return back && back !== 'user' && conv.agents[back] ? [back] : [];
  }
  if (mode === 'pipeline') return [nextInOrder(fromId, false)].filter(Boolean);
  if (mode === 'roundrobin') return [nextInOrder(fromId, true)].filter(Boolean);
  return [];
}

/**
 * Review rounds: each CHANGES REQUESTED from a Reviewer counts one round; APPROVED resets the count.
 * Past maxReviewRounds the orchestrator is told to stop the fix loop and report to the user instead.
 */
function reviewNote(fromId, text) {
  if (conv.team.find((a) => a.id === fromId)?.role !== 'reviewer' || !text) return text;
  if (/^\W*APPROVED/i.test(text)) {
    conv.reviewRounds = 0;
    return text;
  }
  if (!/^\W*CHANGES REQUESTED/i.test(text)) return text;
  conv.reviewRounds = (conv.reviewRounds || 0) + 1;
  const max = Number(setting('maxReviewRounds'));
  if (conv.reviewRounds > max) {
    publish({
      kind: 'system',
      text: `The Reviewer still requests changes after ${max} fix round(s). ${agentName(orchestratorId())} will report to you instead of starting another round.`,
    });
    logError('bridge', `review round limit (${max}) reached`);
    return `${text}\n\n[Agent Bridge: review round limit (${max}) reached. Do not send this back to the coder. Summarize for the user what was done and the open findings, and end with [[DONE]].]`;
  }
  return `${text}\n\n[Agent Bridge: review round ${conv.reviewRounds} of ${max}. Send the findings to the coder.]`;
}

function onTurnEnd(fromId, ev) {
  const text = reviewNote(fromId, (ev.text || '').trim());
  const orch = orchestratorId();

  // Orchestrator mode: results of the agents the orchestrator delegated to are collected and delivered
  // in one message once all of them have finished (one orchestrator turn instead of one per result).
  if (conv.routingMode === 'orchestrator' && fromId !== orch && conv.batch?.pending.has(fromId)) {
    conv.batch.pending.delete(fromId);
    conv.batch.results.push({ from: fromId, text: text || `(no answer${ev.detail ? `: ${ev.detail}` : ''})` });
    if (conv.batch.pending.size) {
      publish({
        kind: 'system',
        text: `${agentName(fromId)} finished. Waiting for ${[...conv.batch.pending].map(agentName).join(', ')} before passing the results to ${agentName(orch)}.`,
      });
      return;
    }
    const results = conv.batch.results;
    conv.batch = null;
    if (!relay.auto || relay.halted || checkTokenLimit()) return;
    relay.hops += 1;
    const body = results.map((r) => `[Message from ${agentName(r.from)}]\n${r.text}`).join('\n\n');
    deliver(orch, results.length > 1 ? `[Results from ${results.length} agents]\n\n${body}` : body, { from: results[0].from });
    return;
  }
  if (!text) return;

  if (fromId === orch && handleNeedRole(fromId, text)) return;

  // In orchestrator mode only the orchestrator closes the work; a worker's [[DONE]] still goes back to it.
  const closes = conv.routingMode !== 'orchestrator' || fromId === orch;
  if (DONE_MARKER.test(text) && closes) {
    relay.halted = true;
    publish({ kind: 'system', text: `${agentName(fromId)} marked the work as done. Waiting for you.` });
    // Final confirmation: the user approves the result or asks for changes.
    if (setting('finalConfirmation') && conv.routingMode === 'orchestrator') {
      const requestId = `final-${Date.now()}`;
      conv.pendingFinal = requestId;
      publish({ kind: 'finalReview', agent: fromId, requestId, summary: text.replace(DONE_MARKER, '').trim() });
    }
    conv.reviewRounds = 0;
    publishState();
    return;
  }
  if (!relay.auto || relay.halted) return;
  if (checkTokenLimit()) return;
  const targets = routeTargets(fromId, text).filter((t) => conv.agents[t]);
  if (!targets.length) {
    publish({ kind: 'system', text: `${agentName(fromId)} replied to you.` });
    return;
  }
  if (relay.hops + targets.length > relay.maxHops) {
    relay.halted = true;
    publish({
      kind: 'system',
      text: `Relay paused after ${relay.hops} hand-offs (limit ${relay.maxHops}). Send a message or press Resume to continue.`,
    });
    publishState();
    return;
  }
  if (conv.routingMode === 'orchestrator' && fromId === orch) {
    conv.batch = conv.batch || { pending: new Set(), results: [] };
    for (const t of targets) conv.batch.pending.add(t);
  }
  for (const to of targets) {
    relay.hops += 1;
    deliver(to, `[Message from ${agentName(fromId)}]\n${text}`, { from: fromId });
  }
}

// ---------- role profiles and skills ----------

/**
 * Skills installed for Claude Code: plugin skills ("plugin:skill", reported by Claude's initialize answer)
 * and personal skills in ~/.claude/skills. Codex skills cannot be switched per session, so they are not listed.
 */
function installedSkills() {
  const names = new Set();
  for (const a of Object.values(conv?.agents || {})) {
    for (const c of a.commands || []) if (c.name.includes(':')) names.add(c.name);
  }
  // Plugin skills straight from the installed plugins, so the list is known before any Claude agent starts.
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(installed.plugins || {})) {
      const plugin = key.split('@')[0];
      for (const e of [].concat(entries || [])) {
        const dir = path.join(e.installPath || '', 'skills');
        if (!e.installPath || !fs.existsSync(dir)) continue;
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          if (d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) names.add(`${plugin}:${d.name}`);
        }
      }
    }
  } catch {
    // no plugins installed
  }
  const base = path.join(os.homedir(), '.claude', 'skills');
  const scan = (dir) => {
    try {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) names.add(d.name);
        else if (d.name === 'synced') scan(path.join(dir, d.name));
      }
    } catch {
      // no personal skills
    }
  };
  scan(base);
  return [...names].sort();
}

/**
 * Profile of a role: "full" (the user's whole setup) or "lean" (no hooks), and the skills switched off.
 * Settings > Roles can override the role file (config.roleOverrides[roleId] = { profile, skillsOff }).
 * With keepPatterns, the role's patterns are returned too (OpenCode accepts patterns directly).
 */
function roleProfile(roleId, keepPatterns = false) {
  const role = roles[roleId];
  const o = config.roleOverrides?.[roleId];
  const profile = o?.profile || role?.profile || 'full';
  let skillsOff;
  if (Array.isArray(o?.skillsOff)) skillsOff = o.skillsOff;
  else {
    const patterns = role?.skillsOff || [];
    skillsOff = installedSkills().filter((n) => patterns.some((p) => globMatch(p, n)));
    if (keepPatterns) skillsOff = [...new Set([...skillsOff, ...patterns])];
  }
  return { profile, skillsOff };
}

// ---------- missing roles ----------
const NEED_ROLE = /\[\[NEED_ROLE:\s*([\w-]+)\s*\]\]/i;

/** Closest agent for a missing role: the role's fallback list, then the orchestrator. */
function closestAgent(roleId) {
  for (const fb of roles[roleId]?.fallback || []) {
    const a = conv.team.find((x) => x.role === fb);
    if (a) return a;
  }
  return conv.team.find((x) => x.id === orchestratorId());
}

/** Provider and model to suggest for a role: the first available model recommended for it. */
function suggestFor(roleId) {
  const role = roles[roleId];
  for (const driver of Object.keys(DRIVERS)) {
    const models = driverModelCache[driver]?.models || [];
    const m = models.find((x) => x.value !== 'default' && !x.disabled && isRecommended(role, x));
    if (m && !providerBlocked(driver)) return { driver, model: m.value, modelLabel: m.label || m.value };
  }
  // No recommended model known: use the provider of the first agent in the team.
  const driver = conv.team[0]?.driver || 'claude';
  return { driver, model: null, modelLabel: 'default model' };
}

/** The orchestrator asked for a role nobody has. Ask the user (default) or continue with the closest agent. */
function handleNeedRole(fromId, text) {
  const m = NEED_ROLE.exec(text);
  if (!m) return false;
  const roleId = m[1].toLowerCase();
  const existing = conv.team.find((a) => a.role === roleId);
  if (!roles[roleId] || existing) {
    deliver(
      fromId,
      `[Message from Agent Bridge]\n${existing ? `@${existing.name} already has the ${roles[roleId].name} role; delegate to it.` : `"${roleId}" is not a role in this app. Roles: ${Object.keys(roles).join(', ')}.`}`,
      { from: 'user' },
    );
    return true;
  }
  const closest = closestAgent(roleId);
  if (setting('missingRolePolicy') === 'closest') {
    resolveMissingRole(roleId, 'closest');
    return true;
  }
  relay.halted = true;
  const sug = suggestFor(roleId);
  const requestId = `role-${Date.now()}`;
  conv.pendingRoleRequest = { requestId, roleId };
  publish({
    kind: 'needRole',
    agent: fromId,
    requestId,
    role: roleId,
    roleName: roles[roleId].name,
    suggestion: { ...sug, driverLabel: DRIVERS[sug.driver].label },
    closest: closest ? { id: closest.id, name: closest.name, roleName: roles[closest.role]?.name } : null,
  });
  publishState();
  return true;
}

async function resolveMissingRole(roleId, action) {
  const role = roles[roleId];
  const orch = orchestratorId();
  conv.pendingRoleRequest = null;
  relay.halted = false;
  relay.hops = 0;
  if (action === 'add') {
    const sug = suggestFor(roleId);
    const spec = await addAgent({ driver: sug.driver, role: roleId, model: sug.model });
    publish({ kind: 'system', text: `Added ${spec.name} for the missing ${role.name} role.` });
    deliver(orch, `[Message from ${setting('userName')}]\nI added @${spec.name} as ${role.name}. Continue and delegate that work to it.`, {
      from: 'user',
    });
  } else {
    const closest = closestAgent(roleId);
    publish({
      kind: 'system',
      text: `No ${role.name} added: continuing with ${closest?.name || 'the orchestrator'} as the closest agent.`,
    });
    logError('bridge', `missing role ${roleId}: continued with ${closest?.name || 'orchestrator'}`);
    deliver(
      orch,
      `[Message from ${setting('userName')}]\nNo ${role.name} will be added. ${closest && closest.id !== orch ? `Give that work to @${closest.name} (${roles[closest.role]?.name}), the closest role in the team.` : 'Handle that part yourself as far as your role allows, and tell me what is left.'}`,
      { from: 'user' },
    );
  }
  publishState();
}

/** Send a message to one agent, adding the team roster or a role note when they changed. */
function deliver(toId, text, { from }) {
  const agent = conv.agents[toId];
  if (!agent) return;
  const blocked = providerBlocked(conv.team.find((a) => a.id === toId)?.driver);
  if (blocked) {
    publish({ kind: 'error', agent: toId, text: `${agentName(toId)} was skipped: ${blocked.detail || blocked.state}.` });
    return;
  }
  if (agent.available === false) {
    publish({
      kind: 'error',
      agent: toId,
      text: `${agentName(toId)} is unavailable, so the message was not delivered. ${agent.unavailableReason || ''}`,
    });
    return;
  }
  const extras = [];
  if (conv.pendingRoleNote[toId]) {
    extras.push(conv.pendingRoleNote[toId]);
    delete conv.pendingRoleNote[toId];
  }
  if ((conv.rosterSeen[toId] || 0) < conv.rosterVersion) {
    const team = conv.team.map((a) => ({
      id: a.id,
      name: a.name,
      roleName: roles[a.role]?.name || a.role,
      canEdit: roles[a.role]?.canEdit || 'all',
      model: conv.agents[a.id]?.resolvedModel || conv.agents[a.id]?.model,
    }));
    extras.push(rosterText(team, toId, conv.routingMode));
    conv.rosterSeen[toId] = conv.rosterVersion;
  }
  // Roles with context "diff" (Reviewer) get the original request and the current changes, so they
  // review what changed instead of reading the whole conversation.
  const spec = conv.team.find((a) => a.id === toId);
  if (roles[spec?.role]?.context === 'diff' && from !== 'user') {
    extras.push(`[Original request from ${setting('userName')}]\n${conv.lastUserText || '(not available)'}`);
    extras.push(diffContext(agent.cwd || conv.workDir));
  }
  conv.lastSender[toId] = from;
  if (from !== 'user') publish({ kind: 'routed', from, to: toId, relayed: true, hop: relay.hops });
  agent.send(extras.length ? `${extras.join('\n\n')}\n\n${text}` : text);
}

/** git diff of the working tree (tracked changes + list of new files), trimmed to a reasonable size. */
function diffContext(dir) {
  const git = (args) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0)
    return '[Current changes]\n(The project folder is not a git repository: read the files the coder reported as changed.)';
  const diff = git(['diff', 'HEAD', '--no-color']).stdout || '';
  const untracked = (git(['ls-files', '--others', '--exclude-standard']).stdout || '').trim();
  const limit = 40000;
  const body = diff.length > limit ? `${diff.slice(0, limit)}\n... (diff cut at ${limit} characters; run git diff for the rest)` : diff;
  return `[Current changes (git diff HEAD)]\n${body.trim() ? `\`\`\`diff\n${body.trim()}\n\`\`\`` : '(no changes to tracked files)'}${untracked ? `\nNew files not in git yet:\n${untracked}` : ''}`;
}

function userSend(text, target) {
  conv.lastUserText = text;
  let targets;
  if (target === 'all') targets = conv.team.map((a) => a.id);
  else if (!target || target === 'auto') {
    // Only @mentions at the very start pick the receiver; mentions inside the text are instructions.
    const lead = (String(text).match(/^\s*(?:@[\w-]+[\s,:]*)+/) || [''])[0];
    const ment = mentions(lead, null);
    targets = ment.length ? ment : [conv.routingMode === 'orchestrator' ? orchestratorId() : conv.team[0]?.id];
  } else targets = [target];
  targets = targets.filter((t) => conv.agents[t]);
  if (!targets.length) throw new Error('no agent to receive this message');
  relay.hops = 0;
  relay.halted = false;
  publish({ kind: 'user', text, to: targets });
  const note = targets.length > 1 ? ` (sent to ${targets.length} agents)` : '';
  for (const t of targets) deliver(t, `[Message from ${setting('userName')}${note}]\n${text}`, { from: 'user' });
  publishState();
}

async function restoreConversation(id) {
  if (!listConversations(LOGS_DIR).some((c) => c.id === id)) throw new Error(`conversation ${id} not found`);
  await closeConversation();
  const { saved } = openConversation({ workDir: process.cwd(), restoreId: id });
  resetClients();
  const resumed = conv.team.filter((a) => a.sessionId).map((a) => a.name);
  publish({
    kind: 'system',
    text: `Restored conversation from ${new Date(saved.startedAt).toLocaleString()} in ${conv.workDir} with ${conv.team.length} agent(s). ${resumed.length ? `${resumed.join(', ')} continue their sessions.` : 'No agent sessions were saved, so the agents start fresh.'} Relay is paused until you send a message.`,
  });
  startAgents();
  publishState();
}

async function newConversation(workDir) {
  const dir = path.resolve(workDir || conv?.workDir || process.cwd());
  if (!fs.existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`);
  await closeConversation();
  openConversation({ workDir: dir });
  resetClients();
  publish({
    kind: 'system',
    text: `New conversation in ${dir}. Team: ${conv.team.map((a) => `${a.name} (${roles[a.role]?.name})`).join(', ')}.`,
  });
  startAgents();
  publishState();
}

// ---------- settings ----------
function settingsView() {
  return Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, setting(k)]));
}

function saveSettings(input) {
  const next = {};
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (!(key in input)) continue;
    let v = input[key];
    if (def.type === 'boolean') v = Boolean(v);
    else if (def.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || v < (def.min ?? -Infinity))
        throw new Error(`${key} must be a number${def.min !== undefined ? ` ≥ ${def.min}` : ''}`);
    } else if (def.type === 'enum') {
      if (!def.values.includes(v)) throw new Error(`${key} must be one of ${def.values.join(', ')}`);
    } else if (def.type === 'list') {
      v = (Array.isArray(v) ? v : String(v).split('\n')).map((s) => String(s).trim()).filter(Boolean);
      for (const p of v) if (!safeRegex(p)) throw new Error(`invalid pattern in ${key}: ${p}`);
    } else v = String(v);
    next[key] = v;
  }
  if (input.saveTeamAsDefault && conv) {
    next.defaultTeam = conv.team.map((a) => ({
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
  if (conv) {
    conv.routingMode = 'routingMode' in input ? setting('routingMode') : conv.routingMode;
    for (const a of Object.values(conv.agents)) {
      a.isDestructive = buildMatcher({
        workDir: a.cwd,
        destructive: setting('destructivePatterns'),
        deletion: setting('deletionPatterns'),
      });
    }
  }
}

// ---------- HTTP ----------
const token = crypto.randomBytes(18).toString('hex');
const SRC_DIR = path.join(APP_DIR, 'src');
const codeHash = () => {
  const h = crypto.createHash('sha1');
  for (const f of fs
    .readdirSync(SRC_DIR)
    .filter((n) => n.endsWith('.mjs'))
    .sort())
    h.update(f).update(fs.readFileSync(path.join(SRC_DIR, f)));
  return h.digest('hex');
};
const bootHash = codeHash();
let warnedOutdated = false;
const codeChanged = () => {
  try {
    return codeHash() !== bootHash;
  } catch {
    return false;
  }
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/events') {
      if (url.searchParams.get('token') !== token) return send(res, 403, 'forbidden');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(snapshotLine());
      for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      publishState();
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-bridge-token'] !== token) return send(res, 403, 'forbidden');
      const body = await readJson(req);
      return send(res, 200, JSON.stringify(await api(url.pathname.slice(5), body)), 'application/json');
    }
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    send(res, 404, 'not found');
  } catch (err) {
    logError('bridge', `${req.method} ${req.url}: ${err.stack || err.message}`);
    send(res, 400, JSON.stringify({ error: err.message }), 'application/json');
  }
});

async function api(action, body) {
  const agents = conv?.agents || {};
  const agentOf = (id) => {
    const a = agents[id];
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  };
  switch (action) {
    case 'catalog':
      return {
        roles: Object.values(roles).map(({ instructions: _instructions, ...r }) => r),
        drivers: Object.entries(DRIVERS).map(([id, d]) => ({
          id,
          label: d.label,
          ...(d.Agent.probe ? d.Agent.probe(config[id]) : { available: true }),
        })),
        routingModes: Object.entries(ROUTING_MODES).map(([id, m]) => ({ id, label: m.label, rule: m.rule })),
        settings: settingsView(),
        settingsSchema: SETTINGS,
      };
    case 'send':
      if (!body.text?.trim()) throw new Error('empty message');
      userSend(body.text, body.target);
      return { ok: true };
    case 'relay':
      if (typeof body.auto === 'boolean') relay.auto = body.auto;
      if (Number.isFinite(body.maxHops) && body.maxHops >= 0) relay.maxHops = body.maxHops;
      if (body.resume) {
        relay.halted = false;
        relay.hops = 0;
      }
      if (body.pause) relay.halted = true;
      publishState();
      return { ok: true };
    case 'routing':
      if (!ROUTING_MODES[body.mode]) throw new Error('unknown routing mode');
      conv.routingMode = body.mode;
      conv.rosterVersion++;
      publish({ kind: 'system', text: `Routing: ${ROUTING_MODES[body.mode].label}. ${ROUTING_MODES[body.mode].rule}` });
      publishState();
      return { ok: true };
    case 'finalReview': {
      if (conv.pendingFinal !== body.requestId) throw new Error('this confirmation is no longer pending');
      conv.pendingFinal = null;
      publish({ kind: 'finalReviewClosed', requestId: body.requestId, action: body.action });
      if (body.action === 'approve') {
        publish({ kind: 'system', text: `${setting('userName')} approved the result.` });
        logError('bridge', 'final result approved by the user');
      } else {
        publish({ kind: 'system', text: `${setting('userName')} asked for changes: write what to change in the message box.` });
      }
      return { ok: true };
    }
    case 'skills':
      return {
        installed: installedSkills(),
        roles: Object.fromEntries(
          Object.keys(roles).map((id) => [id, { ...roleProfile(id), overridden: Boolean(config.roleOverrides?.[id]) }]),
        ),
      };
    case 'roleProfile': {
      if (!roles[body.role]) throw new Error('unknown role');
      const roleOverrides = { ...(config.roleOverrides || {}) };
      if (body.reset) delete roleOverrides[body.role];
      else roleOverrides[body.role] = { profile: body.profile === 'lean' ? 'lean' : 'full', skillsOff: (body.skillsOff || []).map(String) };
      saveLocalConfig({ roleOverrides });
      // Apply to the agents that have this role (Claude restarts on the same session when idle).
      for (const spec of conv.team.filter((a) => a.role === body.role)) {
        await conv.agents[spec.id]?.reconfigure({
          readOnly: roles[body.role].canEdit === 'none',
          maxTurns: roles[body.role].maxTurns || null,
          ...roleProfile(body.role),
        });
      }
      publish({
        kind: 'system',
        text: `Profile for ${roles[body.role].name} saved: ${roleProfile(body.role).profile}, ${roleProfile(body.role).skillsOff.length} skill(s) off.`,
      });
      return { ok: true };
    }
    case 'resolveRole': {
      if (!conv.pendingRoleRequest || conv.pendingRoleRequest.requestId !== body.requestId)
        throw new Error('this request is no longer pending');
      const { requestId, roleId } = conv.pendingRoleRequest;
      publish({ kind: 'needRoleClosed', requestId, action: body.action });
      if (body.action === 'add' || body.action === 'closest') await resolveMissingRole(roleId, body.action);
      else conv.pendingRoleRequest = null;
      return { ok: true };
    }
    case 'interrupt': {
      if (conv.batch) conv.batch = null;
      relay.halted = true;
      const ids = body.agent ? [body.agent] : Object.keys(agents);
      await Promise.all(ids.map((id) => agents[id]?.interrupt()));
      publish({ kind: 'system', text: `Stopped ${ids.map(agentName).join(', ')}. Relay paused.` });
      publishState();
      return { ok: true };
    }
    case 'model': {
      const agent = agentOf(body.agent);
      const model = String(body.model || 'default');
      const entry = (agent.models || []).find((m) => m.value === model);
      if (model !== 'default' && !entry) throw new Error(`model ${model} is not in ${agentName(body.agent)}'s list`);
      if (entry?.disabled) throw new Error(`model ${model} is not available: ${entry.disabledReason || 'not enabled for this account'}`);
      await agent.setModel(model);
      const spec = conv.team.find((a) => a.id === body.agent);
      spec.model = model === 'default' ? null : model;
      // Keep the effort only if the new model supports it.
      const efforts = (entry || (agent.models || []).find((m) => m.isDefault || m.value === 'default'))?.efforts || [];
      if (spec.effort && !efforts.includes(spec.effort)) {
        spec.effort = null;
        await agent.setEffort(null).catch(() => {});
      }
      conv.rosterVersion++;
      publishState();
      return { ok: true };
    }
    case 'effort': {
      const agent = agentOf(body.agent);
      const spec = conv.team.find((a) => a.id === body.agent);
      const effort = String(body.effort || 'default');
      if (effort !== 'default') {
        const current =
          (agent.models || []).find((m) => m.value === (agent.model || 'default')) || (agent.models || []).find((m) => m.isDefault);
        if (!current?.efforts?.includes(effort)) throw new Error(`the model does not support effort "${effort}"`);
      }
      await agent.setEffort(effort);
      spec.effort = effort === 'default' ? null : effort;
      publish({ kind: 'system', text: `${spec.name}: effort ${effort}.` });
      publishState();
      return { ok: true };
    }
    case 'role':
      await setRole(body.agent, body.role);
      return { ok: true };
    case 'bypass': {
      const spec = conv.team.find((a) => a.id === body.agent);
      if (!spec) throw new Error(`unknown agent ${body.agent}`);
      spec.bypass = Boolean(body.on);
      publish({
        kind: 'system',
        text: spec.bypass
          ? `Bypass on for ${spec.name}: approvals are accepted automatically, except destructive actions and deletions outside the project folder.`
          : `Bypass off for ${spec.name}.`,
      });
      publishState();
      return { ok: true };
    }
    case 'approval': {
      const owner = Object.keys(agents).find((id) => agents[id].approvals?.has(body.requestId));
      if (!owner) throw new Error('this request is no longer pending');
      agents[owner].respondApproval(body.requestId, body.decision);
      clearTimeout(approvalTimers.get(body.requestId));
      approvalTimers.delete(body.requestId);
      publish({ kind: 'approvalClosed', requestId: body.requestId, decision: body.decision });
      return { ok: true };
    }
    case 'driverModels': {
      if (!DRIVERS[body.driver]) throw new Error('unknown provider');
      const sensitive = setting('sensitiveModelPatterns')
        .map((p) => safeRegex(p))
        .filter(Boolean);
      const blocked = providerBlocked(body.driver);
      const models = (await listDriverModels(body.driver)).map((m) => ({
        ...m,
        sensitive: sensitive.some((r) => r.test(`${m.value} ${m.label || ''}`)),
        disabled: Boolean(m.disabled) || Boolean(blocked),
        disabledReason: m.disabledReason || (blocked ? blocked.detail || blocked.state : null),
      }));
      return { models };
    }
    case 'addAgent':
      return { ok: true, agent: await addAgent(body) };
    case 'removeAgent':
      await removeAgent(body.agent);
      return { ok: true };
    case 'retry': {
      const agent = agentOf(body.agent);
      publish({ kind: 'system', text: `Retrying ${agentName(body.agent)}...` });
      await agent.restart();
      publishState();
      return { ok: true };
    }
    case 'settings':
      saveSettings(body || {});
      roles = loadRoles(ROLES_DIR);
      publish({ kind: 'system', text: 'Settings saved.' });
      publishState();
      return { ok: true, settings: settingsView() };
    case 'accounts': {
      const out = [];
      for (const driver of Object.keys(PROVIDERS)) {
        if (body.refresh || !cliCache[driver] || Date.now() - cliCache[driver].at > 30000) {
          cliCache[driver] = { at: Date.now(), status: await cliStatus(driver, config[driver]) };
        }
        const status = mergeStatus(cliCache[driver].status, providerBlocked(driver));
        out.push({ driver, label: PROVIDERS[driver].label, ...status, next: nextStep(driver, status) });
      }
      return { accounts: out };
    }
    case 'login': {
      if (!PROVIDERS[body.driver]) throw new Error('unknown provider');
      const command = openLoginTerminal(body.driver, config[body.driver]);
      delete providerRuntime[body.driver];
      delete cliCache[body.driver];
      publish({
        kind: 'system',
        text: `Opened a terminal running "${command}". Finish the sign-in there, then press Check again in Settings > Accounts.`,
      });
      return { ok: true };
    }
    case 'conversations':
      return { current: conv?.id || null, conversations: listConversations(LOGS_DIR) };
    case 'restore':
      await restoreConversation(String(body.id || ''));
      return { ok: true };
    case 'remove': {
      const id = String(body.id || '');
      if (id === conv?.id) throw new Error('this conversation is open now');
      removeConversation(LOGS_DIR, id);
      return { ok: true };
    }
    case 'restart':
      publish({ kind: 'system', text: 'Restarting Agent Bridge... the page reloads by itself.' });
      setTimeout(() => restartServer().catch((err) => logError('bridge', `restart failed: ${err.stack || err}`)), 100);
      return { ok: true };
    case 'quit':
      publish({ kind: 'system', text: 'Agent Bridge is closing. Start it again from Agent Bridge.vbs (or agent-bridge.cmd).' });
      setTimeout(() => shutdown(), 100);
      return { ok: true };
    case 'new':
      await newConversation(body.workDir);
      return { ok: true };
    default:
      throw new Error(
        `unknown action ${action}${codeChanged() ? '. The app was updated after it started: press Restart at the top of the page.' : ''}`,
      );
  }
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return send(res, 404, 'not found');
  let content = fs.readFileSync(file);
  if (rel === 'index.html') {
    content = Buffer.from(content.toString('utf8').replace('__BRIDGE_TOKEN__', token));
    if (codeChanged() && !warnedOutdated) {
      warnedOutdated = true;
      publish({
        kind: 'error',
        text: 'Agent Bridge was updated after it started, so new buttons may not work. Press Restart at the top of the page.',
      });
    }
  }
  send(res, 200, content, MIME[path.extname(file)] || 'application/octet-stream');
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function safeRegex(p) {
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

// ---------- start ----------
let restoreId = null;
if (argv.resume) {
  const list = listConversations(LOGS_DIR);
  restoreId = argv.resume === true ? list[0]?.id : String(argv.resume);
  const exists = restoreId && (list.some((c) => c.id === restoreId) || fs.existsSync(path.join(LOGS_DIR, restoreId, 'transcript.jsonl')));
  if (!exists) fail(argv.resume === true ? 'no earlier conversation to resume' : `conversation ${argv.resume} not found in ${LOGS_DIR}`);
}

try {
  const { saved } = openConversation({ workDir: path.resolve(argv.cwd || config.workDir || process.cwd()), restoreId });
  if (saved)
    publish({
      kind: 'system',
      text: `Restored conversation from ${new Date(saved.startedAt).toLocaleString()} with ${conv.team.length} agent(s). Relay is paused until you send a message.`,
    });
} catch (err) {
  fail(err.message);
}

process.on('uncaughtException', (err) => {
  logError('bridge', `uncaught: ${err.stack || err.message}`);
  console.error(err);
});
process.on('unhandledRejection', (err) => {
  logError('bridge', `unhandled rejection: ${err?.stack || err}`);
});

// After a restart the old process may still hold the port for a moment: retry for a few seconds.
let listenTries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && argv['wait-port'] && listenTries++ < 40) {
    setTimeout(() => server.listen(port, '127.0.0.1'), 250);
    return;
  }
  fail(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is Agent Bridge already running?` : err.message);
});

server.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Agent Bridge running at ${address}`);
  console.log(`Working directory: ${conv.workDir}`);
  console.log(`Team: ${conv.team.map((a) => `${a.name} (${a.driver}, ${a.role})`).join(', ')}`);
  console.log(`Transcript: ${path.join(conv.runDir, 'transcript.jsonl')}`);
  console.log('Stop or restart from the buttons at the top of the page (or Ctrl+C here).');
  if (!restoreId)
    publish({
      kind: 'system',
      text: `Session started in ${conv.workDir}. Team: ${conv.team.map((a) => `${a.name} (${roles[a.role]?.name})`).join(', ')}. Routing: ${ROUTING_MODES[conv.routingMode].label}.`,
    });
  startAgents();
  publishState();
  if (!argv['no-open'] && setting('openBrowser') !== false) openBrowser(address);
});

async function shutdown() {
  console.log('\nShutting down agents...');
  // Stop accepting requests first, so the page sees the app as closed right away.
  server.close();
  for (const res of clients) res.end();
  await closeConversation();
  process.exit(0);
}

/**
 * Restart from the page: start a new server process on the same port that resumes this conversation,
 * then exit. Used instead of closing the console window (which does not exist with the hidden launcher).
 */
async function restartServer() {
  const keep = [];
  const skip = new Set(['resume', 'port', 'cwd', 'no-open', 'main']);
  for (const [k, v] of Object.entries(argv)) if (!skip.has(k)) keep.push(`--${k}`, ...(v === true ? [] : [String(v)]));
  const childArgs = [
    path.join(APP_DIR, 'src', 'server.mjs'),
    ...keep,
    '--resume',
    conv.id,
    '--port',
    String(server.address().port),
    '--no-open',
    '--wait-port',
  ];
  await closeConversation();
  // End the open event streams first: server.close() waits for every connection, and a browser tab
  // keeps its event stream open, so closing before ending them never finished.
  for (const res of clients) res.end();
  clients.clear();
  server.closeAllConnections?.();
  await new Promise((r) => {
    const t = setTimeout(r, 3000);
    server.close(() => {
      clearTimeout(t);
      r();
    });
  });
  // The new process writes its own log (--log-file); without one, use the app's logs/server.log.
  if (!argv['log-file']) childArgs.push('--log-file', path.join(APP_DIR, 'logs', 'server.log'));
  const child = spawn(process.execPath, childArgs, { cwd: process.cwd(), detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(msg) {
  console.error(`agent-bridge: ${msg}`);
  // Started by the hidden launcher: nobody sees the console, so show the error in a message box.
  if (argv.hidden && process.platform === 'win32') {
    const text = `Agent Bridge could not start:\n\n${msg}`.replace(/'/g, "''");
    try {
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Agent Bridge') | Out-Null`,
        ],
        { windowsHide: true, timeout: 600000 },
      );
    } catch {
      // nothing else to do
    }
  }
  process.exit(1);
}
