// "Add agent" dialog.
import { $, closeDialog } from '../core/dom.js';
import { roleOf, store } from '../core/store.js';
import { api } from '../core/api.js';
export function openAddDialog() {
  const d = $('addDriver');
  d.textContent = '';
  for (const drv of store.catalog.drivers) {
    const o = new Option(`${drv.label}${drv.available ? '' : ' (not installed)'}`, drv.id);
    o.disabled = !drv.available;
    o.title = drv.reason || '';
    d.appendChild(o);
  }
  d.value = store.catalog.drivers.find((x) => x.available)?.id || '';
  const r = $('addRole');
  r.textContent = '';
  for (const role of store.catalog.roles) r.appendChild(new Option(role.name, role.id));
  r.value = 'coder';
  nameEdited = false;
  modelChosen = false;
  $('addBypass').checked = Boolean(store.catalog.settings.bypassNewAgents);
  $('addWorktree').checked = false;
  updateAddHints();
  refreshName();
  loadAddModels();
  $('addDialog').showModal();
}

// ----- name: "Provider-Role" by default, until the user types their own -----
export let nameEdited = false;
export const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

export function suggestName() {
  const base = `${PROVIDER_NAMES[$('addDriver').value] || 'Agent'}-${roleOf($('addRole').value)?.name || 'Agent'}`;
  const taken = new Set(store.state.team.map((a) => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

export function refreshName() {
  if (!nameEdited) $('addName').value = suggestName();
}

$('addName').addEventListener('input', () => {
  nameEdited = $('addName').value.trim() !== '';
  if (!nameEdited) refreshName();
});

// ----- model and effort: list from the provider, ★ for the chosen role -----
export let addModels = [];
export let modelChosen = false; // true once the user picks a model by hand
export let addModelsReq = 0;

export async function loadAddModels() {
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

export function matchesRole(role, m) {
  const text = `${m.value} ${m.label || ''} ${m.resolved || ''}`;
  return (role?.recommended?.patterns || []).some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}

export function renderAddModels() {
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

export function renderAddEffort() {
  const sel = $('addEffort');
  const chosen = addModels.find((m) => m.value === $('addModel').value) || addModels.find((m) => m.value === 'default' || m.isDefault);
  const levels = chosen?.efforts || [];
  const prev = sel.value;
  sel.textContent = '';
  sel.appendChild(
    new Option(
      levels.length ? `Default${chosen?.defaultEffort ? ` (${chosen.defaultEffort})` : ''}` : 'Not available for this model',
      'default',
    ),
  );
  for (const l of levels) sel.appendChild(new Option(l, l));
  sel.value = levels.includes(prev) ? prev : 'default';
  sel.disabled = !levels.length;
  const m = addModels.find((x) => x.value === $('addModel').value);
  $('addModelHint').textContent =
    `★ in the model menu = recommended for the chosen role; ★ in the role menu = roles that recommend the chosen model.${m?.sensitive ? ' ⚠ Free/stealth model: your prompts may be used for training. Avoid sensitive code.' : ''}`;
}

$('addModel').onchange = () => {
  modelChosen = true;
  renderAddEffort();
  renderAddRoles();
};

/** Role menu: ★ marks the roles that recommend the selected model (the reverse of the ★ in the model menu). */
export function renderAddRoles() {
  const sel = $('addRole');
  const value = sel.value;
  const chosen = addModels.find((m) => m.value === $('addModel').value) || addModels.find((m) => m.value === 'default' || m.isDefault);
  for (const o of sel.options) {
    const role = roleOf(o.value);
    const rec = chosen && matchesRole(role, chosen);
    o.textContent = `${rec ? '★ ' : ''}${role?.name || o.value}`;
    o.title = `${role?.summary || ''}${
      role?.recommended?.label
        ? `
Recommended models: ${role.recommended.label}`
        : ''
    }`;
  }
  sel.value = value;
}

export function updateAddHints() {
  const role = roleOf($('addRole').value);
  $('addRoleHint').textContent = role
    ? `${role.summary}${role.recommended?.label ? ` Recommended models: ${role.recommended.label}.` : ''}${role.canEdit === 'none' ? ' Read-only: this role does not edit files.' : ''}`
    : '';
  const driver = $('addDriver').value;
  const same = store.state.team.filter((a) => a.driver === driver).length;
  const w = $('addWarning');
  const msgs = [];
  if (store.catalog.settings.warnOnExtraAgents !== false && store.state.team.length >= 2) {
    msgs.push(
      `This will be agent number ${store.state.team.length + 1}. Every agent spends its own tokens, and each hand-off is a paid turn.`,
    );
  }
  const addRoleObj = roleOf($('addRole').value);
  const editors = store.state.team.filter((a) => roleOf(a.role)?.canEdit === 'all' && !a.worktree);
  if (addRoleObj?.canEdit === 'all' && editors.length && !$('addWorktree').checked) {
    msgs.push(
      `${editors.map((a) => a.name).join(', ')} already edit${editors.length === 1 ? 's' : ''} this folder. Two agents editing the same files make conflicting changes: tick "Own git worktree" or give them separate areas.`,
    );
  }
  if (same)
    msgs.push(
      `There ${same === 1 ? 'is already 1 agent' : `are already ${same} agents`} on this provider: they share the same plan quota and reach its usage limit sooner.`,
    );
  w.textContent = msgs.join(' ');
  w.hidden = !msgs.length;
}

$('addWorktree').onchange = updateAddHints;
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
