// The team: creating, adding, removing and reconfiguring agents; role profiles; model lists.
import { S } from './state.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { config, setting } from '../config/settings.mjs';
import { argv } from '../config/args.mjs';
import { publish, publishState } from './events.mjs';
import { DRIVERS } from '../providers/registry.mjs';
import { providerRuntime } from './state.mjs';
import { buildInstructions } from '../core/prompts.mjs';
import { ClaudeAgent } from '../providers/claude.mjs';
import { CodexAgent } from '../providers/codex.mjs';
import { OpenCodeAgent } from '../providers/opencode.mjs';
import { FakeAgent } from '../providers/fake.mjs';
import { buildMatcher } from '../core/safety.mjs';
import { wireAgent } from './conversation.mjs';
import { createWorktree } from '../workspace/worktree.mjs';
import { globMatch } from '../core/roles.mjs';
/** Team used for a new conversation: config.defaultTeam, else the old mainAgent setting. */
export function defaultTeam() {
  if (Array.isArray(config.defaultTeam) && config.defaultTeam.length) return config.defaultTeam.map((a) => ({ ...a }));
  const main = String(argv.main || config.mainAgent || 'claude').toLowerCase() === 'codex' ? 'codex' : 'claude';
  const other = main === 'claude' ? 'codex' : 'claude';
  return [
    { driver: main, role: 'orchestrator' },
    { driver: other, role: 'coder' },
  ];
}

/** Model lists per provider, for the "Add agent" form: { driver: { at, models } }. */
export const driverModelCache = {};

/**
 * Models of a provider before any agent of it exists: start a short-lived instance of its driver,
 * wait for its model list, and close it.
 */
export async function listDriverModels(driver) {
  const cached = driverModelCache[driver];
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models;
  const live = S.conv && Object.entries(S.conv.agents).find(([id]) => S.conv.team.find((a) => a.id === id)?.driver === driver)?.[1];
  if (live?.models?.length) return live.models;
  const { Agent } = DRIVERS[driver];
  const probe = new Agent({
    id: `probe-${driver}`,
    name: 'probe',
    cwd: S.conv?.workDir || process.cwd(),
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
export const cliCache = {};

export function providerBlocked(driver) {
  const r = providerRuntime[driver];
  if (!r || r.state === 'ok') return null;
  if (r.state === 'rate_limited' && r.resetsAt && r.resetsAt < Date.now()) return null;
  return r;
}

export function uniqueName(base) {
  const clean =
    String(base || 'Agent')
      .replace(/[^\w-]/g, '')
      .slice(0, 24) || 'Agent';
  const taken = new Set(S.conv.team.map((a) => a.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}${i}`.toLowerCase())) return `${clean}${i}`;
}

export function defaultName(driver, role) {
  const d = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[driver] || 'Agent';
  return `${d}-${S.roles[role]?.name || 'Agent'}`;
}

/** Create the agent process wrapper for one team member (the process itself starts lazily or on start()). */
export function createAgent(spec) {
  const role = S.roles[spec.role] || S.roles.coder || Object.values(S.roles)[0];
  const readOnly = role?.canEdit === 'none';
  const cwd = spec.cwd || S.conv.workDir;
  const instructions = buildInstructions({
    name: spec.name,
    role,
    routingMode: S.conv.routingMode,
    workDir: cwd,
    userName: setting('userName'),
    extra: config[spec.driver]?.instructions,
  });
  const base = { ...(config[spec.driver] || {}) };
  if (spec.model && spec.model !== 'default') base.model = spec.model;
  if (spec.effort) base.effort = spec.effort;
  let agent;
  if (spec.driver === 'claude') {
    const promptFile = path.join(S.conv.runDir, `instructions-${spec.id}.txt`);
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
  wireAgent(S.conv, spec.id, agent);
  S.conv.agents[spec.id] = agent;
  S.conv.rosterSeen[spec.id] = 0;
  return agent;
}

export async function addAgent({ driver, role, name, model, effort, bypass, worktree }) {
  if (!DRIVERS[driver]) throw new Error(`unknown provider ${driver}`);
  if (!S.roles[role]) throw new Error(`unknown role ${role}`);
  const spec = {
    id: `a${++S.conv.nextAgent}`,
    name: uniqueName(name || defaultName(driver, role)),
    driver,
    role,
    model: model && model !== 'default' ? model : null,
    effort: effort && effort !== 'default' ? effort : null,
    bypass: bypass ?? Boolean(setting('bypassNewAgents')),
  };
  if (worktree) {
    const wt = await createWorktree({ repoDir: S.conv.workDir, conversationId: S.conv.id, agentName: spec.name });
    spec.cwd = wt.path;
    spec.worktree = wt;
    publish({ kind: 'system', text: `${spec.name} works in its own git worktree: ${wt.path} (branch ${wt.branch}).` });
  }
  S.conv.team.push(spec);
  S.conv.rosterVersion++;
  const agent = createAgent(spec);
  await startAgent(agent);
  publish({ kind: 'system', text: `Added ${spec.name} (${DRIVERS[driver].label}, ${S.roles[role].name}).` });
  publishState();
  return spec;
}

export async function removeAgent(id) {
  const idx = S.conv.team.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('unknown agent');
  if (S.conv.team.length === 1) throw new Error('a conversation needs at least one agent');
  const [spec] = S.conv.team.splice(idx, 1);
  const agent = S.conv.agents[id];
  delete S.conv.agents[id];
  S.conv.rosterVersion++;
  await agent?.shutdown().catch(() => {});
  publish({ kind: 'system', text: `Removed ${spec.name}. Its session stays saved in the log.` });
  publishState();
}

export async function setRole(id, roleId) {
  const spec = S.conv.team.find((a) => a.id === id);
  if (!spec || !S.roles[roleId]) throw new Error('unknown agent or role');
  spec.role = roleId;
  const role = S.roles[roleId];
  const agent = S.conv.agents[id];
  // New instructions for drivers that read them at start; a message for the session that is running.
  if (spec.driver === 'claude') {
    fs.writeFileSync(
      path.join(S.conv.runDir, `instructions-${id}.txt`),
      buildInstructions({
        name: spec.name,
        role,
        routingMode: S.conv.routingMode,
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
        routingMode: S.conv.routingMode,
        workDir: agent.cwd,
        userName: setting('userName'),
        extra: config[spec.driver]?.instructions,
      }),
    );
  }
  await agent.reconfigure({ readOnly: role.canEdit === 'none', maxTurns: role.maxTurns || null, ...roleProfile(roleId) });
  S.conv.pendingRoleNote[id] = `[Role change] From now on your role is ${role.name}. ${role.summary}\n${role.instructions}`;
  S.conv.rosterVersion++;
  publish({ kind: 'system', text: `${spec.name} is now ${role.name}.` });
  publishState();
}

export async function startAgent(agent) {
  try {
    await agent.start();
  } catch {
    // start errors are reported by the agent itself (and mark it unavailable)
  }
}

/**
 * Skills installed for Claude Code: plugin skills ("plugin:skill", reported by Claude's initialize answer)
 * and personal skills in ~/.claude/skills. Codex skills cannot be switched per session, so they are not listed.
 */
export function installedSkills() {
  const names = new Set();
  for (const a of Object.values(S.conv?.agents || {})) {
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
export function roleProfile(roleId, keepPatterns = false) {
  const role = S.roles[roleId];
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
