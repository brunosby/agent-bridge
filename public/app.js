'use strict';

const TOKEN = document.querySelector('meta[name="bridge-token"]').content;
const $ = (id) => document.getElementById(id);
const log = $('log');

let state = null;
let catalog = { roles: [], drivers: [], routingModes: [], settings: {}, settingsSchema: {} };
let lastSeq = 0;
const bubbles = new Map(); // `${agent}|${key}` -> { el, body, text }
const tools = new Map(); // `${agent}|${key}` -> element
const approvals = new Map(); // requestId -> element
const cards = {}; // agent id -> card parts

// ---------- networking ----------
async function api(action, body = {}) {
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function connect() {
  const es = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === 'reset') {
      lastSeq = 0;
    } else if (ev.kind === 'state' && !ev.seq) {
      // snapshot sent before the history replay
    } else {
      if (ev.seq <= lastSeq) return; // replayed history after a reconnect
      lastSeq = ev.seq;
    }
    handle(ev);
  };
  es.onerror = () => addSys('Connection to the bridge lost. Retrying...', true);
}

// ---------- helpers ----------
function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
}
function append(el) {
  const stick = nearBottom();
  log.appendChild(el);
  if (stick) log.scrollTop = log.scrollHeight;
}
function keepScrolled(fn) {
  const stick = nearBottom();
  fn();
  if (stick) log.scrollTop = log.scrollHeight;
}
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function time(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function agentOf(id) {
  return state?.team?.find((a) => a.id === id);
}
function label(id) {
  return agentOf(id)?.name || { claude: 'Claude', codex: 'Codex' }[id] || id;
}
function driverOf(id) {
  return agentOf(id)?.driver || id;
}
function roleOf(id) {
  return catalog.roles.find((r) => r.id === id);
}
function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
function closeDialog(id) {
  $(id).close();
}

/** Minimal, safe markdown: fenced code, inline code, bold. Everything else is plain text. */
function renderMarkdown(container, text) {
  container.textContent = '';
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      const pre = h('pre');
      pre.appendChild(h('code', null, code.replace(/\n$/, '')));
      container.appendChild(pre);
      return;
    }
    if (!part.trim()) return;
    const p = h('p');
    for (const seg of part.replace(/^\n+|\n+$/g, '').split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!seg) continue;
      if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1) p.appendChild(h('code', null, seg.slice(1, -1)));
      else if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 3) p.appendChild(h('strong', null, seg.slice(2, -2)));
      else p.appendChild(document.createTextNode(seg));
    }
    container.appendChild(p);
  });
}

function bubble(agent, key, at) {
  const id = `${agent}|${key}`;
  let b = bubbles.get(id);
  if (!b) {
    const el = h('div', `msg agent drv-${driverOf(agent)} streaming`);
    el.dataset.agent = agent;
    const head = h('div', 'head');
    const role = roleOf(agentOf(agent)?.role)?.name;
    head.append(h('span', 'who', label(agent)), h('span', null, `${role ? `${role} · ` : ''}${time(at)}`));
    const body = h('div', 'body');
    el.append(head, body);
    b = { el, body, text: '' };
    bubbles.set(id, b);
    append(el);
  }
  return b;
}

function addSys(text, isError = false) {
  append(h('div', `sys${isError ? ' error' : ''}`, text));
}

// ---------- events ----------
function handle(ev) {
  switch (ev.kind) {
    case 'reset':
      log.textContent = '';
      $('pending').textContent = '';
      bubbles.clear();
      tools.clear();
      approvals.clear();
      updatePending();
      break;
    case 'state':
      state = ev;
      renderState();
      break;
    case 'user': {
      const el = h('div', 'msg user');
      const head = h('div', 'head');
      head.append(h('span', 'who', 'You'), h('span', null, `→ ${(ev.to || []).map(label).join(' + ')} · ${time(ev.at)}`));
      const body = h('div', 'body');
      renderMarkdown(body, ev.text);
      el.append(head, body);
      append(el);
      break;
    }
    case 'routed':
      if (ev.relayed) append(h('div', 'route', `${label(ev.from)} → ${label(ev.to)} (hand-off ${ev.hop})`));
      break;
    case 'delta': {
      const b = bubble(ev.agent, ev.key, ev.at);
      b.text += ev.text;
      keepScrolled(() => renderMarkdown(b.body, b.text));
      break;
    }
    case 'text': {
      const b = bubble(ev.agent, ev.key, ev.at);
      b.text = ev.text;
      keepScrolled(() => renderMarkdown(b.body, b.text));
      if (ev.final) b.el.classList.remove('streaming');
      break;
    }
    case 'tool': {
      const el = h('div', `tool drv-${driverOf(ev.agent)}`);
      el.append(h('span', 'status', '…'), document.createTextNode(`${label(ev.agent)} · ${ev.title}${ev.detail ? `: ${ev.detail}` : ''}`));
      tools.set(`${ev.agent}|${ev.key}`, el);
      append(el);
      break;
    }
    case 'toolResult': {
      const el = tools.get(`${ev.agent}|${ev.key}`);
      if (!el) break;
      el.classList.add(ev.ok ? 'ok' : 'fail');
      el.querySelector('.status').textContent = ev.ok ? '✓' : '✗';
      if (!ev.ok && ev.detail) el.appendChild(h('span', 'err', ev.detail));
      break;
    }
    case 'turnEnd': {
      for (const [id, b] of bubbles) if (id.startsWith(`${ev.agent}|`)) b.el.classList.remove('streaming');
      const parts = [`${label(ev.agent)} finished its turn`];
      if (!ev.ok && ev.detail) parts.push(ev.detail);
      append(h('div', `turn-end${ev.ok ? '' : ' fail'}`, parts.join(' · ')));
      break;
    }
    case 'autoApproved':
      append(h('div', `tool drv-${driverOf(ev.agent)} ok`, `⚡ ${label(ev.agent)} auto-approved (bypass): ${ev.detail ? ev.detail.split('\n')[0] : ev.title}`));
      break;
    case 'approval':
      renderApproval(ev);
      break;
    case 'approvalClosed': {
      const el = approvals.get(ev.requestId);
      if (!el) break;
      approvals.delete(ev.requestId);
      el.remove();
      const names = { accept: 'allowed once', acceptForSession: 'allowed for the session', decline: 'declined', cancelled: 'cancelled', timeout: 'declined automatically (no answer in time)' };
      addSys(`${el.dataset.title} · ${names[ev.decision] || 'closed'}`);
      updatePending();
      break;
    }
    case 'system':
      addSys(ev.text);
      break;
    case 'info':
      addSys(`${label(ev.agent)}: ${ev.text}`);
      break;
    case 'error':
      addSys(`${ev.agent ? `${label(ev.agent)}: ` : ''}${ev.text}`, true);
      break;
    default:
      break;
  }
}

/** Pending approvals stay pinned above the message box until answered. */
function updatePending() {
  const n = approvals.size;
  $('pending').hidden = n === 0;
  const base = state ? `Agent Bridge · ${state.workDir}` : 'Agent Bridge';
  document.title = n ? `(${n}) Approval needed · ${base}` : base;
}

function renderApproval(ev) {
  const el = h('div', `approval drv-${driverOf(ev.agent)}`);
  el.dataset.title = ev.title;
  el.appendChild(h('div', 'title', `${ev.title} · ${time(ev.at)}${ev.expiresAt ? ` · declined automatically at ${time(ev.expiresAt)} if unanswered` : ''}`));
  if (ev.warning) el.appendChild(h('div', 'warning', `⚠ ${ev.warning}`));
  if (ev.detail) el.appendChild(h('pre', null, ev.detail));
  const actions = h('div', 'actions');
  const names = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline' };
  for (const d of ev.decisions) {
    const b = h('button', d === 'decline' ? 'danger' : 'primary', names[d] || d);
    b.onclick = () => api('approval', { requestId: ev.requestId, decision: d }).catch((e) => addSys(e.message, true));
    actions.appendChild(b);
  }
  el.appendChild(actions);
  approvals.set(ev.requestId, el);
  $('pending').appendChild(el);
  append(h('div', `tool drv-${driverOf(ev.agent)}`, `⏸ ${ev.title}: waiting for your approval (see below)`));
  updatePending();
}

// ---------- header and agent cards ----------
function renderState() {
  const box = $('agents');
  const ids = state.team.map((a) => a.id);
  for (const id of Object.keys(cards)) {
    if (!ids.includes(id)) {
      cards[id].el.remove();
      delete cards[id];
    }
  }
  for (const a of state.team) renderCard(a);
  // keep card order and the add button last
  for (const id of ids) box.appendChild(cards[id].el);
  let add = $('addAgent');
  if (!add) {
    add = h('button', 'add-agent', '+ Add agent');
    add.id = 'addAgent';
    add.onclick = openAddDialog;
  }
  box.appendChild(add);

  const r = state.relay;
  $('auto').checked = r.auto;
  if (document.activeElement !== $('maxHops')) $('maxHops').value = r.maxHops;
  const pill = $('relayState');
  pill.textContent = r.halted ? `paused · ${r.hops}/${r.maxHops}` : `hops ${r.hops}/${r.maxHops}`;
  pill.classList.toggle('halted', r.halted);
  // Nobody can edit files: say so before the user asks for a change.
  const editors = state.team.filter((a) => roleOf(a.role)?.canEdit === 'all');
  let noEd = $('noEditor');
  if (!noEd) {
    noEd = h('div', 'warning-box');
    noEd.id = 'noEditor';
    $('agents').after(noEd);
  }
  noEd.textContent = 'No agent in this team can edit code (all roles are read-only or tests-only). Agents will only plan and review; add a Coder for changes.';
  noEd.hidden = editors.length > 0 || !catalog.roles.length;

  const tok = $('tokens');
  tok.textContent = `${fmtTokens(state.totalTokens)} tokens${state.tokenLimit ? ` / ${fmtTokens(state.tokenLimit)}` : ''}`;
  tok.classList.toggle('halted', Boolean(state.tokenLimit && state.totalTokens >= state.tokenLimit));
  if (document.activeElement !== $('routing')) $('routing').value = state.routingMode;
  renderTargets();
  updatePending();
}

function renderTargets() {
  const t = $('target');
  if (document.activeElement === t) return;
  const prev = t.value;
  t.textContent = '';
  const mode = catalog.routingModes.find((m) => m.id === state.routingMode);
  const orch = state.team.find((a) => a.role === 'orchestrator') || state.team[0];
  const autoLabel = state.routingMode === 'orchestrator' ? `Auto (${orch?.name || 'orchestrator'})` : `Auto (${state.team[0]?.name || 'first agent'})`;
  t.appendChild(new Option(autoLabel, 'auto'));
  for (const a of state.team) t.appendChild(new Option(a.name, a.id));
  t.appendChild(new Option('All agents', 'all'));
  t.title = mode ? `Routing: ${mode.label}. @Name in the message also picks the agent.` : '';
  t.value = [...t.options].some((o) => o.value === prev) ? prev : 'auto';
}

function renderCard(a) {
  let c = cards[a.id];
  if (!c) {
    const el = h('div', 'card');
    const top = h('div', 'card-top');
    const dot = h('span', 'dot');
    const name = h('span', 'name');
    const drv = h('span', 'badge');
    const status = h('span', 'status');
    const tokens = h('span', 'tok');
    const stop = h('button', 'mini', 'Stop');
    stop.onclick = () => api('interrupt', { agent: a.id }).catch((e) => addSys(e.message, true));
    const retry = h('button', 'mini', 'Retry');
    retry.onclick = () => api('retry', { agent: a.id }).catch((e) => addSys(e.message, true));
    const remove = h('button', 'mini danger', '✕');
    remove.title = 'Remove this agent from the conversation';
    remove.onclick = () => {
      if (confirm(`Remove ${a.name} from the conversation?`)) api('removeAgent', { agent: a.id }).catch((e) => alert(e.message));
    };
    top.append(dot, name, drv, status, tokens, stop, retry, remove);

    const row = h('div', 'card-row');
    const role = h('select', 'role');
    role.title = 'Role of this agent';
    role.onchange = () => api('role', { agent: a.id, role: role.value }).then(() => role.blur()).catch((e) => addSys(e.message, true));
    const model = h('select', 'model');
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
    el.append(top, row, rec, warn);
    c = cards[a.id] = { el, dot, name, drv, status, tokens, stop, retry, role, model, effort, bypass, rec, warn };
  }
  c.el.className = `card drv-${a.driver}${a.busy ? ' busy' : ''}${a.waitingApproval ? ' waiting' : ''}${a.bypass ? ' bypass-on' : ''}${!a.available || a.account ? ' unavailable' : ''}`;
  c.name.textContent = a.name;
  c.drv.textContent = a.driverLabel;
  c.el.title = `${a.sessionId ? `Session: ${a.sessionId}` : 'No session yet'}${a.worktree ? `\nWorktree: ${a.cwd} (branch ${a.worktree.branch})` : ''}`;
  c.status.textContent = !a.available ? 'unavailable' : a.account ? (a.account.state === 'rate_limited' ? 'usage limit' : 'no access') : a.waitingApproval ? 'waiting for approval' : a.busy ? 'working' : 'idle';
  c.tokens.textContent = `${fmtTokens(a.tokens)} tok`;
  c.stop.disabled = !a.busy;
  c.retry.hidden = a.available;
  c.bypass.checked = a.bypass;

  // role select
  if (document.activeElement !== c.role) {
    const sig = JSON.stringify([a.role, catalog.roles.map((r) => r.id)]);
    if (c.role.dataset.sig !== sig) {
      c.role.dataset.sig = sig;
      c.role.textContent = '';
      for (const r of catalog.roles) {
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
      const sorted = a.models.filter((m) => m.value !== 'default').sort((x, y) => Number(x.disabled) - Number(y.disabled) || Number(y.recommended) - Number(x.recommended));
      for (const m of sorted) {
        const name = m.label && m.label !== m.value ? `${m.label} · ${m.value}` : m.value;
        const o = new Option(`${m.recommended ? '★ ' : ''}${m.sensitive ? '⚠ ' : ''}${name}${m.disabled ? ' (unavailable)' : ''}`, m.value);
        o.disabled = m.disabled;
        o.title = [m.description, m.disabledReason, m.sensitive ? 'Free/stealth model: your prompts may be used to train it. Avoid sensitive code.' : ''].filter(Boolean).join('\n');
        c.model.appendChild(o);
      }
      if (!a.models.length) c.model.appendChild(new Option(a.available ? 'Loading models…' : 'Unavailable', '', false, false)).disabled = true;
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
      c.effort.appendChild(new Option(levels.length ? `Effort: default${selected?.defaultEffort ? ` (${selected.defaultEffort})` : ''}` : 'Effort: n/a', 'default'));
      for (const l of levels) c.effort.appendChild(new Option(`Effort: ${l}`, l));
      c.effort.value = levels.includes(a.effort) ? a.effort : 'default';
      c.effort.disabled = !levels.length || !a.available;
      c.effort.title = levels.length ? 'Reasoning effort (only the levels this model supports)' : 'This model does not expose an effort setting';
    }
  }

  // warnings
  const warnings = [];
  if (!a.available) warnings.push(`Unavailable: ${a.unavailableReason || 'the provider did not start'}. Press Retry after fixing it (Settings > Accounts).`);
  if (a.account) warnings.push(a.account.state === 'rate_limited' ? `Usage limit reached${a.account.resetsAt ? ` until ${new Date(a.account.resetsAt).toLocaleString()}` : ''}.` : `No access: ${a.account.detail || 'check the plan or sign in again'} (Settings > Accounts).`);
  const current = a.models.find((m) => m.value === a.model) || (a.model === 'default' ? a.models.find((m) => m.isDefault || m.value === a.resolvedModel) : null);
  if (current?.sensitive) warnings.push(`⚠ ${current.label || current.value} is a free/stealth model: your prompts may be used for training. Avoid sensitive code${a.role === 'orchestrator' ? ', and remember the orchestrator sees the whole task' : ''}.`);
  c.warn.textContent = warnings.join(' ');
  c.warn.hidden = !warnings.length;
}

// ---------- add agent ----------
function openAddDialog() {
  const d = $('addDriver');
  d.textContent = '';
  for (const drv of catalog.drivers) {
    const o = new Option(`${drv.label}${drv.available ? '' : ' (not installed)'}`, drv.id);
    o.disabled = !drv.available;
    o.title = drv.reason || '';
    d.appendChild(o);
  }
  d.value = catalog.drivers.find((x) => x.available)?.id || '';
  const r = $('addRole');
  r.textContent = '';
  for (const role of catalog.roles) r.appendChild(new Option(role.name, role.id));
  r.value = 'coder';
  nameEdited = false;
  modelChosen = false;
  $('addBypass').checked = Boolean(catalog.settings.bypassNewAgents);
  $('addWorktree').checked = false;
  updateAddHints();
  refreshName();
  loadAddModels();
  $('addDialog').showModal();
}

// ----- name: "Provider-Role" by default, until the user types their own -----
let nameEdited = false;
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

function suggestName() {
  const base = `${PROVIDER_NAMES[$('addDriver').value] || 'Agent'}-${roleOf($('addRole').value)?.name || 'Agent'}`;
  const taken = new Set(state.team.map((a) => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

function refreshName() {
  if (!nameEdited) $('addName').value = suggestName();
}

$('addName').addEventListener('input', () => {
  nameEdited = $('addName').value.trim() !== '';
  if (!nameEdited) refreshName();
});

// ----- model and effort: list from the provider, ★ for the chosen role -----
let addModels = [];
let modelChosen = false; // true once the user picks a model by hand
let addModelsReq = 0;

async function loadAddModels() {
  const req = ++addModelsReq;
  const sel = $('addModel');
  sel.textContent = '';
  sel.appendChild(new Option('Loading models…', 'default'));
  sel.disabled = true;
  renderAddEffort();
  try {
    const { models } = await api('driverModels', { driver: $('addDriver').value });
    if (req !== addModelsReq) return; // provider changed meanwhile
    addModels = models;
  } catch (e) {
    if (req !== addModelsReq) return;
    addModels = [];
    $('addModelHint').textContent = `Could not load the models: ${e.message}. The agent will use the provider's default model.`;
  }
  renderAddModels();
}

function matchesRole(role, m) {
  const text = `${m.value} ${m.label || ''} ${m.resolved || ''}`;
  return (role?.recommended?.patterns || []).some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}

function renderAddModels() {
  const sel = $('addModel');
  const prev = sel.value;
  const role = roleOf($('addRole').value);
  sel.textContent = '';
  const def = addModels.find((m) => m.value === 'default' || m.isDefault);
  const defName = def ? def.resolved || def.label || def.value : '';
  sel.appendChild(new Option(`Default${defName ? ` (${defName})` : ''}`, 'default'));
  const list = addModels
    .filter((m) => m.value !== 'default')
    .map((m) => ({ ...m, recommended: matchesRole(role, m) }))
    .sort((x, y) => Number(x.disabled) - Number(y.disabled) || Number(y.recommended) - Number(x.recommended));
  for (const m of list) {
    const name = m.label && m.label !== m.value ? `${m.label} · ${m.value}` : m.value;
    const o = new Option(`${m.recommended ? '★ ' : ''}${m.sensitive ? '⚠ ' : ''}${name}${m.disabled ? ' (unavailable)' : ''}`, m.value);
    o.disabled = Boolean(m.disabled);
    o.title = [m.description, m.disabledReason].filter(Boolean).join('\n');
    sel.appendChild(o);
  }
  // Keep the user's choice; otherwise pick the first recommended model that is available.
  const keep = modelChosen && [...sel.options].find((o) => o.value === prev && !o.disabled);
  const firstRec = list.find((m) => m.recommended && !m.disabled);
  sel.value = keep ? prev : firstRec ? firstRec.value : 'default';
  sel.disabled = false;
  renderAddEffort();
  renderAddRoles();
}

function renderAddEffort() {
  const sel = $('addEffort');
  const chosen = addModels.find((m) => m.value === $('addModel').value) || addModels.find((m) => m.value === 'default' || m.isDefault);
  const levels = chosen?.efforts || [];
  const prev = sel.value;
  sel.textContent = '';
  sel.appendChild(new Option(levels.length ? `Default${chosen?.defaultEffort ? ` (${chosen.defaultEffort})` : ''}` : 'Not available for this model', 'default'));
  for (const l of levels) sel.appendChild(new Option(l, l));
  sel.value = levels.includes(prev) ? prev : 'default';
  sel.disabled = !levels.length;
  const m = addModels.find((x) => x.value === $('addModel').value);
  $('addModelHint').textContent = `★ in the model menu = recommended for the chosen role; ★ in the role menu = roles that recommend the chosen model.${m?.sensitive ? ' ⚠ Free/stealth model: your prompts may be used for training. Avoid sensitive code.' : ''}`;
}

$('addModel').onchange = () => {
  modelChosen = true;
  renderAddEffort();
  renderAddRoles();
};

/** Role menu: ★ marks the roles that recommend the selected model (the reverse of the ★ in the model menu). */
function renderAddRoles() {
  const sel = $('addRole');
  const value = sel.value;
  const chosen = addModels.find((m) => m.value === $('addModel').value) || addModels.find((m) => m.value === 'default' || m.isDefault);
  for (const o of sel.options) {
    const role = roleOf(o.value);
    const rec = chosen && matchesRole(role, chosen);
    o.textContent = `${rec ? '★ ' : ''}${role?.name || o.value}`;
    o.title = `${role?.summary || ''}${role?.recommended?.label ? `
Recommended models: ${role.recommended.label}` : ''}`;
  }
  sel.value = value;
}

function updateAddHints() {
  const role = roleOf($('addRole').value);
  $('addRoleHint').textContent = role ? `${role.summary}${role.recommended?.label ? ` Recommended models: ${role.recommended.label}.` : ''}${role.canEdit === 'none' ? ' Read-only: this role does not edit files.' : ''}` : '';
  const driver = $('addDriver').value;
  const same = state.team.filter((a) => a.driver === driver).length;
  const w = $('addWarning');
  const msgs = [];
  if (catalog.settings.warnOnExtraAgents !== false && state.team.length >= 2) {
    msgs.push(`This will be agent number ${state.team.length + 1}. Every agent spends its own tokens, and each hand-off is a paid turn.`);
  }
  if (same) msgs.push(`There ${same === 1 ? 'is already 1 agent' : `are already ${same} agents`} on this provider: they share the same plan quota and reach its usage limit sooner.`);
  w.textContent = msgs.join(' ');
  w.hidden = !msgs.length;
}

$('addDriver').onchange = () => {
  updateAddHints();
  refreshName();
  loadAddModels();
};
$('addRole').onchange = () => {
  updateAddHints();
  refreshName();
  renderAddModels();
};
$('addConfirm').onclick = async () => {
  const b = $('addConfirm');
  b.disabled = true;
  try {
    await api('addAgent', {
      driver: $('addDriver').value,
      role: $('addRole').value,
      name: $('addName').value.trim() || undefined,
      model: $('addModel').value,
      effort: $('addEffort').value,
      bypass: $('addBypass').checked,
      worktree: $('addWorktree').checked,
    });
    closeDialog('addDialog');
  } catch (e) {
    alert(e.message);
  } finally {
    b.disabled = false;
  }
};

// ---------- settings ----------
const SETTING_LABELS = {
  userName: ['Your name', 'How the agents refer to you.'],
  routingMode: ['Default routing', 'Used by new conversations. The header switch changes only the open one.'],
  autoRelay: ['Auto-relay', 'Forward replies between agents automatically.'],
  maxHops: ['Max hand-offs', 'Pause after this many agent-to-agent hand-offs (0 = never relay).'],
  tokenLimit: ['Token limit per conversation', 'Pause hand-offs when all agents together pass this many tokens (0 = no limit).'],
  approvalTimeoutSec: ['Approval timeout (seconds)', 'Decline an unanswered approval after this time (0 = wait forever).'],
  bypassNewAgents: ['Bypass on for new agents', 'New agents start with bypass mode on.'],
  warnOnExtraAgents: ['Warn about token use when adding agents', ''],
  sensitiveModelPatterns: ['Models with a data warning', 'One pattern per line (regex). Matching models show ⚠ and a warning about sensitive code.'],
  destructivePatterns: ['Destructive actions (always ask)', 'One regex per line. Bypass never approves these.'],
  deletionPatterns: ['Deletion commands', 'One regex per line. Bypass approves them only for single files inside the project folder.'],
  openBrowser: ['Open the browser at start', ''],
};

function renderSettingsForm() {
  const form = $('settingsForm');
  form.textContent = '';
  for (const [key, def] of Object.entries(catalog.settingsSchema)) {
    const [title, hint] = SETTING_LABELS[key] || [key, ''];
    const value = catalog.settings[key];
    let input;
    if (def.type === 'boolean') {
      const lab = h('label', 'check');
      input = h('input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      lab.append(input, document.createTextNode(` ${title}`));
      form.appendChild(lab);
    } else {
      const lab = h('label', null, title);
      if (def.type === 'enum') {
        input = h('select');
        for (const v of def.values) {
          const m = catalog.routingModes.find((x) => x.id === v);
          input.appendChild(new Option(m ? m.label : v, v));
        }
        input.value = value;
      } else if (def.type === 'list') {
        input = h('textarea');
        input.rows = 4;
        input.value = (value || []).join('\n');
      } else {
        input = h('input');
        input.type = def.type === 'number' ? 'number' : 'text';
        input.value = value ?? '';
      }
      lab.appendChild(input);
      form.appendChild(lab);
    }
    input.dataset.key = key;
    input.dataset.type = def.type;
    if (hint) form.appendChild(h('div', 'hint', hint));
  }
}

$('saveSettings').onclick = async () => {
  const out = {};
  for (const el of $('settingsForm').querySelectorAll('[data-key]')) {
    const t = el.dataset.type;
    out[el.dataset.key] = t === 'boolean' ? el.checked : t === 'number' ? Number(el.value) : t === 'list' ? el.value.split('\n') : el.value;
  }
  out.saveTeamAsDefault = $('saveTeam').checked;
  try {
    const r = await api('settings', out);
    catalog.settings = r.settings;
    $('settingsMsg').textContent = 'Saved.';
    await loadCatalog();
  } catch (e) {
    $('settingsMsg').textContent = `Not saved: ${e.message}`;
  }
};

const STATE_TEXT = {
  ok: ['Ready', 'ok'],
  not_installed: ['Not installed', 'bad'],
  logged_out: ['Installed, not signed in', 'warn'],
  no_access: ['Signed in, no access', 'bad'],
  rate_limited: ['Usage limit reached', 'warn'],
  unknown: ['Unknown', 'warn'],
};

async function renderAccounts(refresh = false) {
  const list = $('accountList');
  list.textContent = 'Checking…';
  try {
    const { accounts } = await api('accounts', { refresh });
    list.textContent = '';
    for (const acc of accounts) {
      const row = h('div', 'account');
      const [text, cls] = STATE_TEXT[acc.state] || [acc.state, 'warn'];
      const head = h('div', 'acc-head');
      head.append(h('strong', null, acc.label), h('span', `state ${cls}`, text));
      if (acc.version) head.appendChild(h('span', 'hint', acc.version));
      row.appendChild(head);
      if (acc.detail) row.appendChild(h('div', 'hint', acc.detail));
      if (acc.next) {
        const step = h('div', 'next');
        step.appendChild(h('div', null, acc.next.text));
        if (acc.next.command) {
          const cmd = h('div', 'cmd');
          cmd.appendChild(h('code', null, acc.next.command));
          const copy = h('button', 'mini', 'Copy');
          copy.onclick = () => navigator.clipboard.writeText(acc.next.command).then(() => (copy.textContent = 'Copied'));
          cmd.appendChild(copy);
          step.appendChild(cmd);
        }
        if (acc.next.docs) {
          const a = h('a', null, 'Official instructions');
          a.href = acc.next.docs;
          a.target = '_blank';
          a.rel = 'noopener';
          step.appendChild(a);
        }
        if (acc.next.action === 'login') {
          const b = h('button', 'primary', acc.state === 'logged_out' ? 'Sign in' : 'Sign in again');
          b.title = 'Opens a terminal window that runs the sign-in command. Finish it there, then press Check again.';
          b.onclick = () => api('login', { driver: acc.driver }).catch((e) => alert(e.message));
          step.appendChild(b);
        }
        row.appendChild(step);
      } else if (acc.state === 'ok') {
        const b = h('button', 'mini', 'Switch account');
        b.onclick = () => api('login', { driver: acc.driver }).catch((e) => alert(e.message));
        row.appendChild(b);
      }
      list.appendChild(row);
    }
  } catch (e) {
    list.textContent = `Could not check accounts: ${e.message}`;
  }
}

function renderRoles() {
  const list = $('roleList');
  list.textContent = '';
  for (const r of catalog.roles) {
    const row = h('div', 'account');
    const head = h('div', 'acc-head');
    head.append(h('strong', null, r.name), h('span', 'hint', r.canEdit === 'none' ? 'read-only' : r.canEdit === 'tests' ? 'edits tests only' : 'edits files'));
    row.append(head, h('div', null, r.summary));
    if (r.recommended?.label) row.appendChild(h('div', 'hint', `Recommended models: ${r.recommended.label}`));
    list.appendChild(row);
  }
}

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of ['general', 'accounts', 'roles']) $(`tab-${p}`).hidden = p !== name;
  if (name === 'accounts') renderAccounts();
  if (name === 'roles') renderRoles();
}

for (const t of document.querySelectorAll('.tab')) t.onclick = () => showTab(t.dataset.tab);
$('refreshAccounts').onclick = () => renderAccounts(true);
$('openSettings').onclick = async () => {
  await loadCatalog();
  renderSettingsForm();
  $('settingsMsg').textContent = '';
  $('saveTeam').checked = false;
  showTab('general');
  $('settingsDialog').showModal();
};

// ---------- conversations ----------
async function showConversations() {
  const list = $('convList');
  list.textContent = 'Loading…';
  $('newWorkDir').value = state?.workDir || '';
  $('convDialog').showModal();
  try {
    const { current, conversations } = await api('conversations');
    list.textContent = '';
    if (!conversations.length) list.appendChild(h('div', 'hint', 'No earlier conversations yet.'));
    for (const c of conversations) {
      const row = h('div', `conv${c.id === current ? ' current' : ''}`);
      const info = h('div', 'info');
      info.appendChild(h('div', 'title', c.title || '(no message)'));
      const when = c.lastAt ? new Date(c.lastAt).toLocaleString() : '';
      const team = (c.team || []).map((a) => `${a.name} (${roleOf(a.role)?.name || a.role})`).join(', ');
      info.appendChild(h('div', 'meta', `${when} · ${c.workDir || '?'} · ${c.userMessages} message(s) · ${team}`));
      row.appendChild(info);
      if (c.id === current) row.appendChild(h('span', 'pill', 'open now'));
      else {
        const b = h('button', 'primary', 'Restore');
        b.onclick = async () => {
          if (state && state.team.some((a) => a.busy) && !confirm('An agent is still working. Stop it and switch conversation?')) return;
          b.disabled = true;
          b.textContent = 'Restoring…';
          try {
            await api('restore', { id: c.id });
            closeDialog('convDialog');
          } catch (e) {
            addSys(`Restore failed: ${e.message}`, true);
            b.disabled = false;
            b.textContent = 'Restore';
          }
        };
        const rm = h('button', 'danger', 'Remove');
        rm.title = 'Take this conversation off the list (its log is moved to logs\\.removed, not deleted)';
        rm.onclick = async () => {
          if (!confirm(`Remove "${c.title.slice(0, 60)}" from the list?`)) return;
          try {
            await api('remove', { id: c.id });
            row.remove();
          } catch (e) {
            alert(e.message);
          }
        };
        row.append(b, rm);
      }
      list.appendChild(row);
    }
  } catch (e) {
    list.textContent = `Could not load conversations: ${e.message}`;
  }
}

$('openConversations').onclick = showConversations;
$('newConversation').onclick = async () => {
  if (state && state.team.some((a) => a.busy) && !confirm('An agent is still working. Stop it and start a new conversation?')) return;
  try {
    await api('new', { workDir: $('newWorkDir').value.trim() });
    closeDialog('convDialog');
  } catch (e) {
    alert(e.message);
  }
};

// ---------- composer and header controls ----------
async function sendMessage() {
  const text = $('input').value;
  if (!text.trim()) return;
  $('send').disabled = true;
  try {
    await api('send', { text, target: $('target').value });
    $('input').value = '';
  } catch (e) {
    addSys(`Send failed: ${e.message}`, true);
  } finally {
    $('send').disabled = false;
    $('input').focus();
  }
}

$('send').onclick = sendMessage;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
});
$('auto').onchange = (e) => api('relay', { auto: e.target.checked });
$('maxHops').onchange = (e) => api('relay', { maxHops: Number(e.target.value) });
$('routing').onchange = (e) => api('routing', { mode: e.target.value }).then(() => e.target.blur()).catch((err) => addSys(err.message, true));
$('resume').onclick = () => api('relay', { resume: true });
$('pause').onclick = () => api('relay', { pause: true });
$('stopAll').onclick = () => api('interrupt', {});
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => closeDialog(b.dataset.close);

// ---------- restart / quit (there is no console window to close) ----------
function busyConfirm(what) {
  return !(state && state.team.some((a) => a.busy)) || confirm(`An agent is still working. ${what} anyway?`);
}

$('restartApp').onclick = async () => {
  if (!busyConfirm('Restart')) return;
  try {
    await api('restart');
  } catch (e) {
    return addSys(`Restart failed: ${e.message}`, true);
  }
  addSys('Restarting... this page reloads when Agent Bridge is back.');
  // The new process uses the same address with a new access token, so the page has to reload.
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (res.ok) return location.reload();
    } catch {
      // still restarting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  addSys('Agent Bridge did not come back. Check logs\\server.log and start it again.', true);
};

$('quitApp').onclick = async () => {
  if (!busyConfirm('Quit') || !confirm('Close Agent Bridge and all agents?')) return;
  await api('quit').catch(() => {});
  document.body.innerHTML = '<div class="closed-page"><h2>Agent Bridge is closed</h2><p>Start it again with <code>Agent Bridge.vbs</code>. Conversations can be restored from the Conversations button.</p></div>';
};

async function loadCatalog() {
  catalog = await api('catalog');
  const r = $('routing');
  const v = r.value;
  r.textContent = '';
  for (const m of catalog.routingModes) {
    const o = new Option(m.label, m.id);
    o.title = m.rule;
    r.appendChild(o);
  }
  r.value = state?.routingMode || v || 'orchestrator';
  for (const c of Object.values(cards)) c.role.dataset.sig = '';
  if (state) renderState();
}

loadCatalog()
  .catch((e) => addSys(`Could not load settings: ${e.message}`, true))
  .finally(connect);
