// API actions called by the page.
import type { Agent, RoutingMode } from '../core/types.ts';
import { S } from './state.ts';
import { agentName, logError, publish, publishState } from './events.ts';
import { DRIVERS } from '../providers/registry.ts';
import { LOGS_DIR, ROLES_DIR, SETTINGS, config, safeRegex, saveLocalConfig, setting } from '../config/settings.ts';
import { ROUTING_MODES } from '../core/prompts.ts';
import { newConversation, restoreConversation, saveSettings, settingsView } from './conversation.ts';
import { resolveMissingRole, userSend, userTargets } from './routing.ts';
import { approvalTimers, cliCache, providerRuntime, relay } from './state.ts';
import {
  type AddAgentInput,
  addAgent,
  installedSkills,
  listDriverModels,
  providerBlocked,
  removeAgent,
  roleProfile,
  setRole,
} from './team.ts';
import { loadRoles } from '../core/roles.ts';
import { PROVIDERS, cliStatus, mergeStatus, nextStep, openLoginTerminal } from '../providers/accounts.ts';
import { listConversations, removeConversation } from '../core/history.ts';
import { searchSavedTranscript } from '../core/transcript-search.ts';
import { restartServer, shutdown } from '../cli/main.ts';
import { codeChanged } from './http.ts';
/** Handle one API call from the page. Returns the JSON answer; throws to send an error. */
export async function api(action: string, body: Record<string, any>): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected a JSON object');
  const agents = S.conv?.agents || {};
  const agentOf = (id: string): Agent => {
    const a = agents[id];
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  };
  switch (action) {
    case 'catalog':
      return {
        roles: Object.values(S.roles).map(({ instructions: _instructions, ...r }) => r),
        drivers: Object.entries(DRIVERS).map(([id, d]) => ({
          id,
          label: d.label,
          ...(d.probe ? d.probe(config[id]) : { available: true }),
        })),
        routingModes: Object.entries(ROUTING_MODES).map(([id, m]) => ({ id, label: m.label, rule: m.rule })),
        settings: settingsView(),
        settingsSchema: SETTINGS,
      };
    case 'previewTarget': {
      const prefix = typeof body.prefix === 'string' ? body.prefix : '';
      const ids = userTargets(body.target, prefix);
      const selection = prefix ? userTargets(body.target) : ids;
      return {
        changedByMention: ids.length !== selection.length || ids.some((id, index) => id !== selection[index]),
        targets: ids.map((id) => ({
          id,
          name: agentName(id),
          available: agents[id].available !== false && !providerBlocked(S.conv.team.find((a) => a.id === id)?.driver),
        })),
      };
    }
    case 'send':
      if (body.conversationId && body.conversationId !== S.conv.id) throw new Error('conversation changed before sending');
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
    case 'routing': {
      if (!(body.mode in ROUTING_MODES)) throw new Error('unknown routing mode');
      const mode = ROUTING_MODES[body.mode as RoutingMode];
      S.conv.routingMode = body.mode;
      S.conv.rosterVersion++;
      publish({ kind: 'system', text: `Routing: ${mode.label}. ${mode.rule}` });
      publishState();
      return { ok: true };
    }
    case 'finalReview': {
      if (S.conv.pendingFinal !== body.requestId) throw new Error('this confirmation is no longer pending');
      S.conv.pendingFinal = null;
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
          Object.keys(S.roles).map((id) => [id, { ...roleProfile(id), overridden: Boolean(config.roleOverrides?.[id]) }]),
        ),
      };
    case 'roleProfile': {
      if (!S.roles[body.role]) throw new Error('unknown role');
      const roleOverrides = { ...(config.roleOverrides || {}) };
      if (body.reset) delete roleOverrides[body.role];
      else
        roleOverrides[body.role] = {
          profile: body.profile === 'lean' ? 'lean' : 'full',
          skillsOff: (body.skillsOff || []).map(String),
          skillsOn: (body.skillsOn || []).map(String),
        };
      saveLocalConfig({ roleOverrides });
      // Apply to the agents that have this role (Claude restarts on the same session when idle).
      for (const spec of S.conv.team.filter((a) => a.role === body.role)) {
        await S.conv.agents[spec.id]?.reconfigure({
          readOnly: S.roles[body.role].canEdit === 'none',
          maxTurns: S.roles[body.role].maxTurns || null,
          ...roleProfile(body.role),
        });
      }
      publish({
        kind: 'system',
        text: (() => {
          const rp = roleProfile(body.role);
          const skills = rp.skillsOnly
            ? `${rp.skillsOnly.length} skill(s) allowed, the rest blocked`
            : `${rp.skillsOff.length} skill(s) off`;
          return `Profile for ${S.roles[body.role].name} saved: ${rp.profile}, ${skills}.`;
        })(),
      });
      return { ok: true };
    }
    case 'resolveRole': {
      const { action: decision, requestId: requestedId } = body;
      if (decision !== 'add' && decision !== 'closest' && decision !== 'dismiss') throw new Error('unknown role decision');
      if (typeof requestedId !== 'string' || !requestedId) throw new Error('missing role request id');
      if (!S.conv.pendingRoleRequest || S.conv.pendingRoleRequest.requestId !== requestedId)
        throw new Error('this request is no longer pending');
      const { requestId, roleId } = S.conv.pendingRoleRequest;
      publish({ kind: 'needRoleClosed', requestId, action: decision });
      if (decision === 'add' || decision === 'closest') await resolveMissingRole(roleId, decision);
      else S.conv.pendingRoleRequest = null;
      return { ok: true };
    }
    case 'interrupt': {
      if (S.conv.batch) S.conv.batch = null;
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
      const spec = S.conv.team.find((a) => a.id === body.agent);
      if (!spec) throw new Error(`unknown agent ${body.agent}`);
      spec.model = model === 'default' ? null : model;
      // Keep the effort only if the new model supports it.
      const efforts = (entry || (agent.models || []).find((m) => m.isDefault || m.value === 'default'))?.efforts || [];
      if (spec.effort && !efforts.includes(spec.effort)) {
        spec.effort = null;
        await agent.setEffort(null).catch(() => {});
      }
      S.conv.rosterVersion++;
      publishState();
      return { ok: true };
    }
    case 'effort': {
      const agent = agentOf(body.agent);
      const spec = S.conv.team.find((a) => a.id === body.agent);
      if (!spec) throw new Error(`unknown agent ${body.agent}`);
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
      const spec = S.conv.team.find((a) => a.id === body.agent);
      if (!spec) throw new Error(`unknown agent ${body.agent}`);
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
      const sensitive = (setting('sensitiveModelPatterns') as string[]).map((p) => safeRegex(p)).filter((x): x is RegExp => x !== null);
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
      return { ok: true, agent: await addAgent(body as AddAgentInput) };
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
      S.roles = loadRoles(ROLES_DIR);
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
    case 'searchTranscript': {
      const owner = S.conv;
      if (!owner) throw new Error('no conversation is open');
      const result = await searchSavedTranscript(LOGS_DIR, owner, body);
      if (S.conv !== owner) throw new Error('conversation changed during search');
      return result;
    }
    case 'conversations':
      return { current: S.conv?.id || null, conversations: listConversations(LOGS_DIR) };
    case 'restore':
      await restoreConversation(String(body.id || ''));
      return { ok: true };
    case 'remove': {
      const id = String(body.id || '');
      if (id === S.conv?.id) throw new Error('this conversation is open now');
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
