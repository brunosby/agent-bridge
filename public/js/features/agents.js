// Header: agent cards (role, model, effort, bypass), relay status and the message target menu.
import { $, fmtTokens, h } from '../core/dom.js';
import { agentOf, cards, roleOf, store } from '../core/store.js';
import { openAddDialog } from './add-agent.js';
import { updatePending } from './approvals.js';
import { api } from '../core/api.js';
import { addSys, jumpToSequence } from './conversation-log.js';
const detailsDialog = $('agentDetails');

$('addAgent').onclick = openAddDialog;

export function renderState() {
  const box = $('agents');
  const ids = store.state.team.map((a) => a.id);
  for (const id of Object.keys(cards)) {
    if (!ids.includes(id)) {
      if (detailsDialog.open && detailsDialog.dataset.agent === id) detailsDialog.close();
      cards[id].el.remove();
      delete cards[id];
    }
  }
  for (const a of store.state.team) renderCard(a);
  // Preserve focus when state updates without changing team order.
  for (const [index, id] of ids.entries()) {
    const card = cards[id].el;
    if (box.children[index] !== card) box.insertBefore(card, box.children[index] || null);
  }

  const project = store.state.project;
  $('projectContext').textContent = project
    ? [project.name, project.branch || (project.detached ? 'Detached HEAD' : project.git ? 'Git' : 'No Git')].join(' · ')
    : '';
  const r = store.state.relay;
  $('auto').checked = r.auto;
  if (document.activeElement !== $('maxHops')) $('maxHops').value = r.maxHops;
  const pill = $('relayState');
  pill.textContent = r.halted ? `paused · ${r.hops}/${r.maxHops}` : `hops ${r.hops}/${r.maxHops}`;
  pill.classList.toggle('halted', r.halted);
  // Nobody can edit files: say so before the user asks for a change.
  const hasEditor = store.state.team.some((a) => roleOf(a.role)?.canEdit === 'all');
  $('noEditor').hidden = hasEditor || !store.catalog.roles.length;

  const tok = $('tokens');
  tok.textContent = `${fmtTokens(store.state.totalTokens)} new tokens${store.state.tokenLimit ? ` / ${fmtTokens(store.state.tokenLimit)}` : ''} · ${fmtTokens(store.state.totalCachedTokens || 0)} cached`;
  tok.title =
    'New tokens = input, output and cache writes (what the token limit counts). Cached = tokens read from the prompt cache, which cost much less.';
  tok.classList.toggle('halted', Boolean(store.state.tokenLimit && store.state.totalTokens >= store.state.tokenLimit));
  if (document.activeElement !== $('routing')) $('routing').value = store.state.routingMode;
  renderTargets();
  updatePending();
}

export function renderTargets() {
  const t = $('target');
  if (document.activeElement === t) return;
  const prev = t.value;
  t.textContent = '';
  const mode = store.catalog.routingModes.find((m) => m.id === store.state.routingMode);
  const orch = store.state.team.find((a) => a.role === 'orchestrator') || store.state.team[0];
  const autoLabel =
    store.state.routingMode === 'orchestrator'
      ? `Auto (${orch?.name || 'orchestrator'})`
      : `Auto (${store.state.team[0]?.name || 'first agent'})`;
  t.appendChild(new Option(autoLabel, 'auto'));
  for (const a of store.state.team) t.appendChild(new Option(a.name, a.id));
  t.appendChild(new Option('All agents', 'all'));
  t.title = mode ? `Routing: ${mode.label}. Start the message with @Name to pick an agent.` : '';
  t.value = [...t.options].some((o) => o.value === prev) ? prev : 'auto';
}

/**
 * Model shown on the card: a short name for the second line and the full id for the tooltip.
 * "Default" resolves to the model the provider actually runs, when it reports one.
 */
function modelInfo(a) {
  const models = a.models || [];
  const isDefault = !a.model || a.model === 'default';
  const selected = isDefault
    ? models.find((m) => m.value === 'default') || models.find((m) => m.isDefault)
    : models.find((m) => m.value === a.model);
  const selectedId = isDefault ? (selected?.value !== 'default' ? selected?.value : '') : a.model;
  const full = (isDefault && a.resolvedModel) || selected?.resolved || selectedId || '';
  const entry = isDefault ? models.find((m) => m.value !== 'default' && (m.value === full || m.resolved === full)) : selected;
  const label = entry?.label && !/^default\b/i.test(entry.label) ? entry.label : full;
  const short = label
    .replace(/^[^:/]+:\s+|^[^:/\s]+\/(?=\S)/, '') // "Provider: Name" or "provider/model"
    .replace(/\s*\((free|recommended)\)$/i, '')
    .trim();
  return { short, full };
}

export function renderCard(a) {
  let c = cards[a.id];
  if (!c) {
    const el = h('button', 'card');
    el.type = 'button';
    el.setAttribute('aria-haspopup', 'dialog');
    const name = h('span', 'name');
    const roleName = h('span', 'card-role');
    const drv = h('span', 'badge');
    const status = h('span', 'status');
    const tokens = h('span', 'tok');
    const stop = h('button', 'btn', 'Stop');
    stop.onclick = () => api('interrupt', { agent: a.id }).catch((e) => addSys(e.message, true));
    const retry = h('button', 'btn', 'Retry');
    retry.onclick = () => api('retry', { agent: a.id }).catch((e) => addSys(e.message, true));
    const remove = h('button', 'btn btn--danger', 'Remove agent');
    remove.title = 'Remove this agent from the conversation';
    remove.onclick = () => {
      if (confirm(`Remove ${a.name} from the conversation?`)) api('removeAgent', { agent: a.id }).catch((e) => alert(e.message));
    };
    el.append(name, roleName, status);

    const row = h('div', 'card-row');
    const role = h('select', 'role');
    role.setAttribute('aria-label', 'Role');
    role.title = 'Role of this agent';
    role.onchange = () =>
      api('role', { agent: a.id, role: role.value })
        .then(() => role.blur())
        .catch((e) => addSys(e.message, true));
    const model = h('select', 'model');
    model.setAttribute('aria-label', 'Model');
    model.title = 'Model (list from your account). ★ recommended for the role · ⚠ may use your data';
    model.onchange = () =>
      api('model', { agent: a.id, model: model.value })
        .then(() => model.blur())
        .catch((e) => {
          addSys(`Model change failed: ${e.message}`, true);
          model.dataset.sig = '';
          renderCard(agentOf(a.id));
        });
    const effort = h('select', 'effort');
    effort.setAttribute('aria-label', 'Reasoning effort');
    effort.title = 'Reasoning effort (only the levels this model supports)';
    effort.onchange = () =>
      api('effort', { agent: a.id, effort: effort.value })
        .then(() => effort.blur())
        .catch((e) => {
          addSys(`Effort change failed: ${e.message}`, true);
          effort.dataset.sig = '';
          renderCard(agentOf(a.id));
        });
    const bypassLabel = h('label', 'bypass');
    bypassLabel.title = 'Approve requests automatically, except destructive actions and deletions outside the project folder';
    const bypass = h('input');
    bypass.type = 'checkbox';
    bypass.onchange = () => api('bypass', { agent: a.id, on: bypass.checked }).catch((e) => addSys(e.message, true));
    bypassLabel.append(bypass, document.createTextNode(' Bypass'));
    row.append(role, model, effort, bypassLabel);

    const rec = h('div', 'rec');
    const warn = h('div', 'card-warn');
    const details = h('div', 'agent-details');
    const meta = h('div', 'agent-details__meta');
    const taskLink = h('button', 'btn', 'Go to task message');
    taskLink.onclick = () => {
      detailsDialog.close();
      if (!jumpToSequence(Number(taskLink.dataset.seq))) addSys('The task message is outside the loaded history.');
    };
    meta.append(drv, tokens, taskLink);
    const actions = h('div', 'agent-details__actions');
    actions.append(stop, retry, remove);
    details.append(meta, warn, row, rec, actions);

    el.onclick = () => {
      detailsDialog.dataset.agent = a.id;
      $('agentDetailsTitle').textContent = name.textContent;
      $('agentDetailsBody').replaceChildren(details);
      detailsDialog.showModal();
    };
    c = cards[a.id] = { el, name, roleName, details, taskLink, drv, status, tokens, stop, retry, role, model, effort, bypass, rec, warn };
  }
  c.el.className = `card drv-${a.driver}${a.busy ? ' busy' : ''}${a.waitingApproval ? ' waiting' : ''}${!a.available || a.account ? ' unavailable' : ''}`;
  c.details.classList.toggle('bypass-on', a.bypass);
  c.name.textContent = a.name;
  const roleLabel = roleOf(a.role)?.name || a.role;
  const shown = modelInfo(a);
  c.roleName.textContent = shown.short ? `${roleLabel} · ${shown.short}` : roleLabel;
  c.roleName.title = [shown.full && `Model: ${shown.full}`, `Effort: ${a.effort && a.effort !== 'default' ? a.effort : 'default'}`]
    .filter(Boolean)
    .join('\n');
  if (detailsDialog.open && detailsDialog.dataset.agent === a.id) $('agentDetailsTitle').textContent = a.name;
  c.drv.textContent = a.driverLabel;
  c.details.title = `${a.sessionId ? `Session: ${a.sessionId}` : 'No session yet'}${a.worktree ? `\nWorktree: ${a.cwd} (branch ${a.worktree.branch})` : ''}`;
  c.status.textContent = !a.available
    ? 'unavailable'
    : a.account
      ? a.account.state === 'rate_limited'
        ? 'usage limit'
        : 'no access'
      : a.waitingApproval
        ? 'waiting for approval'
        : a.busy
          ? 'working'
          : 'idle';
  const tasks = (store.state.tasks || []).filter((task) => task.agent === a.id);
  const working = tasks.filter((task) => task.state === 'working');
  const task = working[0] || tasks[0];
  if (task && a.available && !a.account && !a.waitingApproval) {
    c.status.textContent = working.length ? (working[0].activity || 'working') + ' · ' + working.length : 'queued · ' + tasks.length;
  }
  c.taskLink.hidden = !task?.sourceSeq;
  c.taskLink.dataset.seq = task?.sourceSeq || '';
  c.tokens.textContent = `${fmtTokens(a.tokens)} tok${a.cachedTokens ? ` (+${fmtTokens(a.cachedTokens)} cache)` : ''}`;
  c.stop.disabled = !a.busy;
  c.retry.hidden = a.available;
  c.bypass.checked = a.bypass;

  // role select
  if (document.activeElement !== c.role) {
    const sig = JSON.stringify([a.role, store.catalog.roles.map((r) => r.id)]);
    if (c.role.dataset.sig !== sig) {
      c.role.dataset.sig = sig;
      c.role.textContent = '';
      for (const r of store.catalog.roles) {
        const o = new Option(r.name, r.id);
        o.title = r.summary;
        c.role.appendChild(o);
      }
      c.role.value = a.role;
    }
  }
  const role = roleOf(a.role);
  c.rec.textContent = role?.recommended?.label ? `Recommended for ${role.name}: ${role.recommended.label}` : '';

  // model select
  if (document.activeElement !== c.model) {
    const sig = JSON.stringify([a.model, a.resolvedModel, a.available, a.models.map((m) => [m.value, m.disabled, m.recommended])]);
    if (c.model.dataset.sig !== sig) {
      c.model.dataset.sig = sig;
      c.model.textContent = '';
      const def = a.models.find((m) => m.value === 'default' || m.isDefault);
      const defName = def ? def.resolved || def.label || def.value : a.model === 'default' ? a.resolvedModel : null;
      c.model.appendChild(new Option(`Default${defName ? ` (${defName})` : ''}`, 'default'));
      const sorted = a.models
        .filter((m) => m.value !== 'default')
        .sort((x, y) => Number(x.disabled) - Number(y.disabled) || Number(y.recommended) - Number(x.recommended));
      for (const m of sorted) {
        const name = m.label && m.label !== m.value ? `${m.label} · ${m.value}` : m.value;
        const o = new Option(`${m.recommended ? '★ ' : ''}${m.sensitive ? '⚠ ' : ''}${name}${m.disabled ? ' (unavailable)' : ''}`, m.value);
        o.disabled = m.disabled;
        o.title = [
          m.description,
          m.disabledReason,
          m.sensitive ? 'Free/stealth model: your prompts may be used to train it. Avoid sensitive code.' : '',
        ]
          .filter(Boolean)
          .join('\n');
        c.model.appendChild(o);
      }
      if (!a.models.length)
        c.model.appendChild(new Option(a.available ? 'Loading models…' : 'Unavailable', '', false, false)).disabled = true;
      c.model.value = a.model;
      c.model.disabled = !a.available;
    }
  }

  // effort select: levels of the selected model (or of the default model)
  const selected = a.models.find((m) => m.value === a.model) || a.models.find((m) => m.value === 'default' || m.isDefault);
  const levels = selected?.efforts || [];
  if (document.activeElement !== c.effort) {
    const sig = JSON.stringify([a.effort, levels, selected?.defaultEffort]);
    if (c.effort.dataset.sig !== sig) {
      c.effort.dataset.sig = sig;
      c.effort.textContent = '';
      c.effort.appendChild(
        new Option(
          levels.length ? `Effort: default${selected?.defaultEffort ? ` (${selected.defaultEffort})` : ''}` : 'Effort: n/a',
          'default',
        ),
      );
      for (const l of levels) c.effort.appendChild(new Option(`Effort: ${l}`, l));
      c.effort.value = levels.includes(a.effort) ? a.effort : 'default';
      c.effort.disabled = !levels.length || !a.available;
      c.effort.title = levels.length
        ? 'Reasoning effort (only the levels this model supports)'
        : 'This model does not expose an effort setting';
    }
  }

  // warnings
  const warnings = [];
  if (!a.available)
    warnings.push(
      `Unavailable: ${a.unavailableReason || 'the provider did not start'}. Press Retry after fixing it (Settings > Accounts).`,
    );
  if (a.account)
    warnings.push(
      a.account.state === 'rate_limited'
        ? `Usage limit reached${a.account.resetsAt ? ` until ${new Date(a.account.resetsAt).toLocaleString()}` : ''}.`
        : `No access: ${a.account.detail || 'check the plan or sign in again'} (Settings > Accounts).`,
    );
  const current =
    a.models.find((m) => m.value === a.model) ||
    (a.model === 'default' ? a.models.find((m) => m.isDefault || m.value === a.resolvedModel) : null);
  if (current?.sensitive)
    warnings.push(
      `⚠ ${current.label || current.value} is a free/stealth model: your prompts may be used for training. Avoid sensitive code${a.role === 'orchestrator' ? ', and remember the orchestrator sees the whole task' : ''}.`,
    );
  // Research reads long pages; a smaller window fills up and OpenCode then summarises the conversation.
  if (a.role === 'researcher' && current?.contextWindow && current.contextWindow <= 200000)
    warnings.push(
      `Context window of ${Math.round(current.contextWindow / 1000)}k tokens: long pages can fill it and make the agent lose earlier findings. A model with a larger window suits research better.`,
    );
  c.warn.textContent = warnings.join(' ');
  c.warn.hidden = !warnings.length;
}
