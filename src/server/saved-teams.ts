import { config, localConfig, saveLocalConfig } from '../config/settings.ts';
import type { AgentSpec, Conversation } from '../core/types.ts';
import { S } from './state.ts';
import { DRIVERS } from '../providers/registry.ts';
import { buildAgent, installAgent, startAgent, validateAgentChoice, defaultName, validateNameFormat, providerBlocked } from './team.ts';
import { cliStatus, PROVIDERS } from '../providers/accounts.ts';
import { pendingWork } from './request-progress.ts';
import { agentOperationPending } from './agent-lifecycle.ts';
import { hasPendingSend } from './routing.ts';
import { revokeReviewClient } from './review-mcp.ts';
import { publish, publishState } from './events.ts';

type Member = Pick<AgentSpec, 'name' | 'driver' | 'role' | 'model' | 'effort'>;
type Template = { name: string; members: Member[] };
export function templateMembers(members: Partial<AgentSpec>[], validate = true): Member[] {
  if (!Array.isArray(members) || !members.length) throw new Error('A team needs at least one agent.');
  const names = new Set<string>();
  return members.map((a) => {
    if (!a || typeof a.driver !== 'string' || typeof a.role !== 'string') throw new Error('Invalid team member.');
    if (validate && !Object.hasOwn(DRIVERS, a.driver)) throw new Error('Unknown provider.');
    if (validate && !Object.hasOwn(S.roles, a.role)) throw new Error('Unknown role: ' + a.role);
    const name = validateNameFormat(a.name || defaultName(a.driver, a.role));
    if (names.has(name.toLowerCase())) throw new Error('Agent names must be unique.');
    names.add(name.toLowerCase());
    return { name, role: a.role, driver: a.driver, model: a.model || null, effort: a.effort || null };
  });
}
export function savedTeams(): { teams: Template[]; defaultTeamName: string | null } {
  if (Array.isArray(config.teams)) return { teams: config.teams, defaultTeamName: config.defaultTeamName || null };
  if (Array.isArray(localConfig.defaultTeam) && localConfig.defaultTeam.length) {
    const teams = [{ name: 'Padrão', members: templateMembers(localConfig.defaultTeam, false) }];
    saveLocalConfig({ teams, defaultTeamName: 'Padrão' });
    return { teams, defaultTeamName: 'Padrão' };
  }
  return { teams: [], defaultTeamName: null };
}
export function chosenTeam(name: unknown) {
  const { teams, defaultTeamName } = savedTeams();
  const key = name === undefined ? defaultTeamName : name;
  if (key === null || key === '') return undefined;
  const item = teams.find((t) => t.name === key);
  if (!item) throw new Error('This saved team no longer exists.');
  return item.members.map((a) => ({ ...a, bypass: false }));
}
function teamName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64 || /[\r\n\t]/.test(value))
    throw new Error('Enter a team name of 1 to 64 characters.');
  return value.trim();
}
export function manageTeam(body: Record<string, unknown>, source = S.conv.team) {
  const current = savedTeams();
  let teams = [...current.teams];
  let defaultTeamName = current.defaultTeamName;
  const name = teamName(body.name);
  const item = teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (body.operation === 'save') {
    if (item && body.replace !== true) throw new Error('This team already exists. Confirm replacement.');
    const members = templateMembers(source);
    teams = item ? teams.map((t) => (t === item ? { ...t, members } : t)) : [...teams, { name, members }];
  } else {
    if (!item) throw new Error('Unknown saved team.');
    if (body.operation === 'rename') {
      const next = teamName(body.newName);
      if (teams.some((t) => t !== item && t.name.toLowerCase() === next.toLowerCase())) throw new Error('This team name already exists.');
      teams = teams.map((t) => (t === item ? { ...t, name: next } : t));
      if (defaultTeamName === item.name) defaultTeamName = next;
    } else if (body.operation === 'default') defaultTeamName = item.name;
    else if (body.operation === 'delete' && body.confirm === true) {
      teams = teams.filter((t) => t !== item);
      if (defaultTeamName === item.name) defaultTeamName = null;
    } else throw new Error('Unknown or unconfirmed team action.');
  }
  saveLocalConfig({ teams, defaultTeamName });
  return { teams, defaultTeamName };
}
function blockers(owner: Conversation) {
  const items = pendingWork(owner).map((w) => w.reason);
  if (hasPendingSend(owner) || owner.pendingAgentNames.size || Object.values(owner.agents).some(agentOperationPending))
    items.push('An agent or delivery is being updated.');
  if (!owner.relay.halted) items.push('Pause the conversation before applying a team.');
  return [...new Set(items)];
}
export async function applyTeam(body: Record<string, any>) {
  const owner = S.conv;
  if (owner.id !== body.conversationId) throw new Error('The conversation changed.');
  const template = chosenTeam(body.name);
  if (!template) throw new Error('Choose a saved team.');
  const pending = blockers(owner);
  if (pending.length) return { pending };
  const version = owner.rosterVersion;
  const checked = new Map<string, Promise<boolean>>();
  const choices = await Promise.all(
    template.map(async (a, i) => {
      const patch = body.choices?.[i] || {};
      const input = {
        driver: patch.driver ?? a.driver,
        model: patch.model === undefined ? a.model : patch.model,
        effort: patch.effort === undefined ? a.effort : patch.effort,
        role: patch.role ?? a.role,
      };
      try {
        const choice = await validateAgentChoice(owner, input);
        if (Object.hasOwn(PROVIDERS, choice.driver)) {
          if (!checked.has(choice.driver))
            checked.set(
              choice.driver,
              cliStatus(choice.driver, config[choice.driver]).then((s) => s.state === 'ok' && !providerBlocked(choice.driver)),
            );
          if (!(await checked.get(choice.driver))) throw new Error('Provider is unavailable. Choose another.');
        }
        return { driver: choice.driver, role: choice.role, model: choice.model, effort: choice.effort, name: a.name };
      } catch (e) {
        throw new Error(a.name + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    }),
  );
  if (owner !== S.conv || version !== owner.rosterVersion || JSON.stringify(template) !== JSON.stringify(chosenTeam(body.name)))
    throw new Error('The team changed. Review the choices again.');
  const remaining = blockers(owner);
  if (remaining.length) return { pending: remaining };
  // Build every replacement first. Publish a single roster change before awaiting process shutdown.
  const next = choices.map((a, i) => ({ ...a, id: 'a' + (owner.nextAgent + i + 1), bypass: false }));
  const replacements = next.map((spec) => buildAgent(owner, spec));
  const previous = Object.values(owner.agents);
  for (const { id, name, role, driver } of owner.team) {
    owner.retiredAgents.set(id, { id, name, role, driver });
    revokeReviewClient(owner, id);
    owner.providerHandoffs.delete(id);
  }
  owner.team = next;
  owner.agents = {};
  owner.nextAgent += next.length;
  owner.rosterVersion++;
  for (const a of replacements) installAgent(owner, a);
  publish({ kind: 'system', text: 'Applied team ' + body.name + '.' });
  publishState();
  await Promise.all(previous.map((a) => a.shutdown().catch(() => {})));
  if (owner === S.conv) for (const a of replacements) if (owner.agents[a.id] === a) void startAgent(a);
  return { ok: true };
}
