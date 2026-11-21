import { projectSnapshot } from '../workspace/git-context.ts';
// The team: creating, adding, removing and reconfiguring agents; role profiles; model lists.
import { flushMentionStreams } from './mention-stream.ts';
import type { Agent, AgentEvent, AgentSpec, Conversation, ModelInfo, TaskEvent } from '../core/types.ts';
import type { RuntimeStatus } from '../providers/accounts.ts';
import { S } from './state.ts';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { config, setting } from '../config/settings.ts';
import { argv } from '../config/args.ts';
import { publish, publishState } from './events.ts';
import { DRIVERS } from '../providers/registry.ts';
import { driverModelCache, providerRuntime } from './state.ts';
import { buildInstructions } from '../core/prompts.ts';
import { ClaudeAgent } from '../providers/claude.ts';
import { CodexAgent } from '../providers/codex.ts';
import { OpenCodeAgent } from '../providers/opencode.ts';
import { FakeAgent } from '../providers/fake.ts';
import { buildMatcher } from '../core/safety.ts';
import { wireAgent } from './conversation.ts';
import { captureProject } from './project.ts';
import { createWorktree } from '../workspace/worktree.ts';
import { globMatch } from '../core/roles.ts';
import { startAndWait, statusOf } from './agent-lifecycle.ts';
import { configureReviewMcp, revokeReviewClient } from './review-mcp.ts';
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

/**
 * Models of a provider before any agent of it exists: start a short-lived instance of its driver,
 * wait for its model list, and close it.
 */
export async function listDriverModels(driver: string): Promise<ModelInfo[]> {
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
    const models = await new Promise<ModelInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no model list after 45 s')), 45000);
      probe.on('event', (ev: AgentEvent) => {
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

export function providerBlocked(driver: string | undefined): RuntimeStatus | null {
  const r = driver ? providerRuntime[driver] : undefined;
  if (!r || r.state === 'ok') return null;
  if (r.state === 'rate_limited' && r.resetsAt && r.resetsAt < Date.now()) return null;
  return r;
}

export function statusFor(owner: Conversation, id: string) {
  return statusOf(owner.agents[id], providerBlocked(owner.team.find((spec) => spec.id === id)?.driver));
}

const RESERVED_AGENT_NAME = /^a\d+$/i;
const MAX_AGENT_NAME = 24;

function nameTaken(name: string, except?: string): boolean {
  const key = name.toLowerCase();
  return S.conv.pendingAgentNames.has(key) || S.conv.team.some((member) => member.id !== except && member.name.toLowerCase() === key);
}

export function uniqueName(base: string, preserveLegacyName = false): string {
  const clean =
    String(base || 'Agent')
      .replace(/[^\w-]/g, '')
      .slice(0, MAX_AGENT_NAME) || 'Agent';
  if (!nameTaken(clean) && (preserveLegacyName || !RESERVED_AGENT_NAME.test(clean))) return clean;
  for (let i = 2; ; i++) {
    const suffix = '-' + i;
    const name = clean.slice(0, MAX_AGENT_NAME - suffix.length) + suffix;
    if (!nameTaken(name)) return name;
  }
}

function validAgentName(value: string, except?: string): string {
  const name = value.trim();
  if (!/^[\w-]{1,24}$/.test(name)) throw new Error('Enter an agent name of 1 to 24 letters, digits, underscores or hyphens.');
  if (RESERVED_AGENT_NAME.test(name)) throw new Error('Names such as a2 are reserved for agent IDs.');
  if (nameTaken(name, except)) throw new Error('An agent already uses that name.');
  return name;
}

export function defaultName(driver: string, role: string): string {
  const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
  const d = names[driver] || 'Agent';
  return `${d}-${S.roles[role]?.name || 'Agent'}`;
}

/** Create the agent process wrapper for one team member (the process itself starts lazily or on start()). */
export function createAgent(spec: AgentSpec): Agent {
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
  const owner = S.conv;
  const base = {
    ...(config[spec.driver] || {}),
    reviewMcp: () => configureReviewMcp(owner, spec.id, () => S.roles[spec.role]?.context === 'diff'),
  };
  if (spec.model && spec.model !== 'default') base.model = spec.model;
  if (spec.effort) base.effort = spec.effort;
  let agent: Agent;
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
      ...roleProfile(spec.role, true),
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

export interface AddAgentInput {
  driver: string;
  role: string;
  name?: string;
  model?: string | null;
  effort?: string | null;
  bypass?: boolean;
  worktree?: boolean;
}

export async function validateAgentChoice(owner: Conversation, input: Record<string, unknown>): Promise<AddAgentInput> {
  const { driver, role, name, model, effort, bypass, worktree } = input;
  if (typeof driver !== 'string' || !Object.hasOwn(DRIVERS, driver)) throw new Error('Unknown provider.');
  if (typeof role !== 'string' || !Object.hasOwn(S.roles, role)) throw new Error('Unknown role.');
  if (name !== undefined && typeof name !== 'string') throw new Error('Invalid agent name.');
  if (model != null && (typeof model !== 'string' || !model.trim())) throw new Error('Invalid model.');
  if (effort != null && (typeof effort !== 'string' || !effort.trim())) throw new Error('Invalid effort.');
  if (bypass !== undefined && typeof bypass !== 'boolean') throw new Error('Invalid bypass choice.');
  if (worktree !== undefined && typeof worktree !== 'boolean') throw new Error('Invalid worktree choice.');
  if (worktree && !projectSnapshot(owner.workDir)?.head) throw new Error('A separate worktree needs a Git repository with a commit.');

  const modelId = model === 'default' ? null : model;
  const level = effort === 'default' ? null : effort;
  if (modelId || level) {
    const models = await listDriverModels(driver);
    const blocked = providerBlocked(driver);
    if (blocked) throw new Error(blocked.detail || 'This provider is currently unavailable.');
    const entry = modelId
      ? models.find((item) => item.value === modelId)
      : models.find((item) => item.value === 'default' || item.isDefault);
    if (modelId && (!entry || entry.disabled)) throw new Error('The selected model is unavailable for this provider.');
    if (level && !entry?.efforts?.includes(level)) throw new Error('The selected model does not support this effort.');
  }
  if (S.conv !== owner) throw new Error('The conversation changed while validating this agent.');
  return { driver, role, name: name === undefined ? undefined : validAgentName(name), model: modelId, effort: level, bypass, worktree };
}

export async function addAgent(
  { driver, role, name, model, effort, bypass, worktree }: AddAgentInput,
  waitUntilReady = false,
): Promise<AgentSpec> {
  const owner = S.conv;
  if (!Object.hasOwn(DRIVERS, driver)) throw new Error(`unknown provider ${driver}`);
  if (!Object.hasOwn(S.roles, role)) throw new Error(`unknown role ${role}`);
  const spec: AgentSpec = {
    name: name === undefined ? uniqueName(defaultName(driver, role)) : validAgentName(name),
    id: `a${++owner.nextAgent}`,
    driver,
    role,
    model: model && model !== 'default' ? model : null,
    effort: effort && effort !== 'default' ? effort : null,
    bypass: bypass ?? Boolean(setting('bypassNewAgents')),
  };
  if (worktree) {
    const key = spec.name.toLowerCase();
    owner.pendingAgentNames.add(key);
    const wt = await createWorktree({ repoDir: owner.workDir, conversationId: owner.id, agentId: spec.id }).finally(() =>
      owner.pendingAgentNames.delete(key),
    );
    if (S.conv !== owner) throw new Error('conversation changed while creating the worktree');
    spec.cwd = wt.path;
    spec.worktree = wt;
    captureProject(S.conv, wt.path, true);
    publish({ kind: 'projectBaseline', project: S.conv.project });
    publish({ kind: 'system', text: `@${spec.id} works in its own git worktree: ${wt.path} (branch ${wt.branch}).` });
  }
  S.conv.team.push(spec);
  S.conv.rosterVersion++;
  const agent = createAgent(spec);
  const ready = startAgent(agent);
  if (waitUntilReady) await ready;
  if (S.conv !== owner || owner.agents[spec.id] !== agent) return spec;
  publish({ kind: 'system', text: `Added @${spec.id} (${DRIVERS[driver].label}, ${S.roles[role].name}).` });
  publishState();
  return spec;
}

export async function removeAgent(id: string): Promise<void> {
  const owner = S.conv;
  const idx = S.conv.team.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('unknown agent');
  if (S.conv.team.length === 1) throw new Error('a conversation needs at least one agent');
  flushMentionStreams(owner, id);
  const [spec] = owner.team.splice(idx, 1);
  owner.retiredAgents.set(id, { id, name: spec.name, driver: spec.driver, role: spec.role });
  const agent = S.conv.agents[id];
  revokeReviewClient(owner, id);
  delete S.conv.agents[id];
  const taskIds = [...S.conv.tasks.values()].filter((task) => task.agent === id).map((task) => task.id);
  for (const taskId of taskIds) S.conv.tasks.delete(taskId);
  if (taskIds.length) publish({ kind: 'tasksCancelled', agent: id, taskIds } satisfies TaskEvent);
  S.conv.rosterVersion++;
  await agent?.shutdown().catch(() => {});
  if (S.conv !== owner) return;
  publish({ kind: 'system', text: `Removed @${spec.id}. Its session stays saved in the log.` });
  publishState();
}

function refreshAgentInstructions(spec: AgentSpec, agent: Agent): void {
  const role = S.roles[spec.role];
  if (spec.driver === 'claude') {
    fs.writeFileSync(
      path.join(S.conv.runDir, `instructions-${spec.id}.txt`),
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
}

export function renameAgent(id: string, value: string): void {
  const owner = S.conv;
  const spec = owner.team.find((member) => member.id === id);
  const agent = owner.agents[id];
  if (!spec || !agent) throw new Error('unknown agent');
  const name = validAgentName(value, id);
  if (spec.name === name) return;
  refreshAgentInstructions({ ...spec, name }, agent);
  spec.name = agent.name = name;
  owner.rosterVersion++;
  owner.pendingRoleNote[id] = [
    owner.pendingRoleNote[id],
    '[Name update] Your display name is now ' + name + '. Your mention ID remains @' + id + '.',
  ]
    .filter(Boolean)
    .join('\n');
  publish({ kind: 'system', text: 'Renamed @' + id + '.', agent: id });
  publishState();
  void agent.syncThreadName?.().catch((error: unknown) => {
    if (S.conv === owner && owner.agents[id] === agent)
      publish({ kind: 'info', agent: id, text: 'Could not update the Codex thread title: ' + String(error) });
  });
}

export async function setRole(id: string, roleId: string): Promise<void> {
  const spec = S.conv.team.find((a) => a.id === id);
  if (!spec || !Object.hasOwn(S.roles, roleId)) throw new Error('unknown agent or role');
  spec.role = roleId;
  const role = S.roles[roleId];
  const agent = S.conv.agents[id];
  refreshAgentInstructions(spec, agent);
  await agent.reconfigure({ readOnly: role.canEdit === 'none', maxTurns: role.maxTurns || null, ...roleProfile(roleId) });
  S.conv.pendingRoleNote[id] = `[Role change] From now on your role is ${role.name}. ${role.summary}\n${role.instructions}`;
  S.conv.rosterVersion++;
  publish({ kind: 'system', text: `@${spec.id} is now ${role.name}.` });
  publishState();
}

export function startAgent(agent: Agent, launch = () => agent.start()): Promise<boolean> {
  const owner = S.conv;
  return startAndWait(agent, launch, () => {
    if (S.conv !== owner || owner.agents[agent.id] !== agent) return;
    owner.rosterVersion += 1;
    publishState();
  });
}

/**
 * Skills installed for Claude Code: plugin skills ("plugin:skill", reported by Claude's initialize answer)
 * and personal skills in ~/.claude/skills. Codex skills cannot be switched per session, so they are not listed.
 */
export function installedSkills(): string[] {
  const names = new Set<string>();
  for (const a of Object.values(S.conv?.agents || {})) {
    for (const c of a.commands || []) if (c.name.includes(':')) names.add(c.name);
  }
  // Plugin skills straight from the installed plugins, so the list is known before any Claude agent starts.
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(installed.plugins || {})) {
      const plugin = key.split('@')[0];
      for (const e of ([] as { installPath?: string }[]).concat((entries as { installPath?: string }[]) || [])) {
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
  const scan = (dir: string): void => {
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
 * Profile of a role: "full" (the user's whole setup) or "lean" (no hooks), and its skills.
 * Full roles use a deny-list (skillsOff). Lean roles use an allow-list (skillsOnly): every skill is
 * blocked except the ones ticked in Settings > Roles, so a support role cannot pull in a workflow
 * skill that fights its job (for example a research skill that writes files in a read-only role).
 * Settings > Roles can override the role file (config.roleOverrides[roleId] = { profile, skillsOff, skillsOn }).
 * With keepPatterns, the role's patterns are returned too (OpenCode accepts patterns directly).
 */
export function roleProfile(
  roleId: string,
  keepPatterns = false,
): { profile: 'full' | 'lean'; skillsOff: string[]; skillsOnly: string[] | null } {
  const role = S.roles[roleId];
  const o = config.roleOverrides?.[roleId];
  const profile = o?.profile || role?.profile || 'full';
  if (profile === 'lean') {
    const allowed: string[] = Array.isArray(o?.skillsOn) ? o.skillsOn : role?.skillsOn || [];
    const installed = installedSkills();
    const skillsOnly = installed.filter((n) => allowed.some((p: string) => globMatch(p, n)));
    if (keepPatterns) skillsOnly.push(...allowed.filter((p) => !skillsOnly.includes(p)));
    return { profile, skillsOff: installed.filter((n) => !skillsOnly.includes(n)), skillsOnly };
  }
  let skillsOff: string[];
  if (Array.isArray(o?.skillsOff)) skillsOff = o.skillsOff;
  else {
    const patterns = role?.skillsOff || [];
    skillsOff = installedSkills().filter((n) => patterns.some((p: string) => globMatch(p, n)));
    if (keepPatterns) skillsOff = [...new Set([...skillsOff, ...patterns])];
  }
  return { profile, skillsOff, skillsOnly: null };
}
