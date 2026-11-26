// Settings dialog: general settings, accounts and roles.
import { $, h } from '../core/dom.js';
import { renderAccounts, renderRoles } from './settings-providers.js';
import { store } from '../core/store.js';
import { api } from '../core/api.js';
import { loadCatalog } from '../main.js';
import { settingField } from './setting-field.js';
export const SETTING_LABELS = {
  progressLayout: ['Progress layout', 'Where to show progress for your latest request.'],
  userName: ['Your name', 'How the agents refer to you.'],
  routingMode: ['Default routing', 'Sets the routing mode for this conversation and new conversations.'],
  autoRelay: [
    'Manual mode: show replies without forwarding them',
    'Agents still reply in the chat, but nothing is forwarded to the next agent. Use Pause to stop the flow and keep the replies for later.',
  ],
  maxHops: [
    'Max hops',
    'Maximum agent hand-offs before the relay pauses. In orchestrator mode, only delegations from the orchestrator count. Medium tasks get twice the base limit and large tasks four times. Set 0 to disable automatic hand-offs.',
  ],
  tokenLimit: ['Token limit per conversation', 'Pause hand-offs when all agents together pass this many tokens (0 = no limit).'],
  approvalTimeoutSec: ['Approval timeout', 'Decline an unanswered approval after this time (0 = wait forever).'],
  bypassNewAgents: ['Bypass on for new agents', 'New agents start with bypass mode on.'],
  autoApproveReadOnly: [
    'Automatically approve read-only commands',
    'Allow supported literal reads in the workspace. Unrecognized commands still ask.',
  ],
  warnOnExtraAgents: ['Warn about token use when adding agents', ''],
  reviewDiffMaxChars: [
    'Maximum Reviewer diff size (characters)',
    '0 removes the character limit and can increase token use or fill the context window. Git still has time and memory limits.',
  ],
  maxReviewRounds: [
    'Review fix rounds',
    'How many times the Reviewer CHANGES REQUESTED answer goes back to the coder before the orchestrator reports to you.',
  ],
  summarizeAgentReplies: [
    'Send only agent summaries to the orchestrator',
    'Full replies stay in the chat. Replies without a complete summary are sent in full.',
  ],
  finalConfirmation: [
    'Ask me to approve the final result',
    'Show Approve / Ask for changes when the orchestrator finishes and files changed since your last message.',
  ],
  missingRolePolicy: [
    'When the orchestrator needs a missing role',
    'Ask me (add the role with a recommended model, or continue with the closest agent), or always continue with the closest agent.',
  ],
  sensitiveModelPatterns: [
    'Models with a data warning',
    'One pattern per line (regex). Matching models show ⚠ and a warning about sensitive code.',
  ],
  destructivePatterns: ['Destructive actions (always ask)', 'One regex per line. Bypass never approves these.'],
  deletionPatterns: ['Deletion commands', 'One regex per line. Bypass approves them only for single files inside the project folder.'],
  recommendRoles: ['Recommend roles', 'Let the orchestrator suggest additions to the team for substantial work.'],
  milestoneCommitMode: ['Commit at milestones', 'Ask before each commit or commit automatically after the approved checks.'],
  openBrowser: ['Open the browser at start', ''],
};

// Entries are ordered as they appear in each section.
export const SETTING_LAYOUT = {
  userName: ['general', 'You', 'string'],
  progressLayout: ['general', 'Layout', 'enum'],
  openBrowser: ['general', 'Start and notifications', 'boolean'],
  routingMode: ['flow', 'Routing', 'enum'],
  autoRelay: ['flow', 'Routing', 'boolean'],
  maxHops: ['flow', 'Limits', 'number', 'hand-offs'],
  tokenLimit: ['flow', 'Limits', 'number', 'tokens'],
  summarizeAgentReplies: ['flow', 'Orchestrator and review', 'boolean'],
  finalConfirmation: ['flow', 'Orchestrator and review', 'boolean'],
  maxReviewRounds: ['flow', 'Orchestrator and review', 'number', 'rounds'],
  reviewDiffMaxChars: ['flow', 'Orchestrator and review', 'number', 'characters'],
  recommendRoles: ['team', 'Roles', 'enum'],
  missingRolePolicy: ['team', 'Roles', 'enum'],
  warnOnExtraAgents: ['team', 'New agents', 'boolean'],
  bypassNewAgents: ['team', 'New agents', 'boolean'],
  approvalTimeoutSec: ['safety', 'Approvals', 'number', 'seconds'],
  autoApproveReadOnly: ['safety', 'Approvals', 'boolean'],
  destructivePatterns: ['safety', 'Rules', 'list'],
  deletionPatterns: ['safety', 'Rules', 'list'],
  sensitiveModelPatterns: ['safety', 'Rules', 'list'],
  milestoneCommitMode: ['project', 'Milestones', 'enum'],
};

const fields = new Map();
const form = $('settingsForm');
const dialog = $('settingsDialog');
const sectionMenu = $('settingsNav');
const nav = [...sectionMenu.querySelectorAll('[data-section]')];
let currentSection = 'general';
let saving = false;
let opening = 0;
let rolesLoaded = false;

function cardFor(section, title) {
  const pane = $('tab-' + section);
  let card = [...pane.querySelectorAll('[data-card]')].find((el) => el.dataset.card === title);
  if (!card) {
    card = h('div', 'settings-card');
    card.dataset.card = title;
    card.dataset.generated = '';
    card.append(h('h4', null, title));
    pane.insertBefore(card, pane.querySelector('[data-card]:not([data-generated])'));
  }
  return card;
}

export function renderSettingsForm() {
  const { settings, settingsSchema, routingModes } = store.catalog;
  for (const el of form.querySelectorAll('[data-generated]')) el.remove();
  fields.clear();
  for (const key of new Set([...Object.keys(SETTING_LAYOUT), ...Object.keys(settingsSchema)])) {
    if (!Object.hasOwn(settingsSchema, key)) continue;
    const def = settingsSchema[key];
    const [section, cardTitle, control, unit] = Object.hasOwn(SETTING_LAYOUT, key)
      ? SETTING_LAYOUT[key]
      : ['other', 'Additional settings', def.type];
    const [title, hint] = Object.hasOwn(SETTING_LABELS, key) ? SETTING_LABELS[key] : [key, ''];
    const card = cardFor(section, cardTitle);
    if (key === 'milestoneCommitMode' && !store.state?.milestoneCommitAvailable) {
      const row = h('div', 'setting-row', 'Commit at milestones requires a Git project in orchestrator mode.');
      row.dataset.search = (key + ' ' + row.textContent).toLowerCase();
      card.append(row);
      continue;
    }
    const field = settingField({ key, def, title, hint, control, unit, routingModes });
    const loaded = key === 'autoRelay' ? (store.state?.relay?.auto ?? settings[key]) : settings[key];
    field.write(loaded ?? def.default);
    fields.set(key, { ...field, section, initial: field.read() });
    field.row.dataset.generated = '';
    card.insertBefore(field.row, card.querySelector('.setting-row:not([data-generated])'));
  }
  const project = store.state?.project;
  $('settingsProject').textContent = [project?.name, project?.branch || (project?.detached ? 'Detached HEAD' : '')]
    .filter(Boolean)
    .join(' · ');
  nav.find((el) => el.dataset.section === 'other').hidden = !$('tab-other').querySelector('.setting-row');
  updateChanges();
}

function updateChanges() {
  const changes = Object.create(null);
  const dirty = new Set();
  for (const [key, field] of fields) {
    const value = field.read();
    const changed = JSON.stringify(value) !== JSON.stringify(field.initial);
    field.row.classList.toggle('is-changed', changed);
    field.update();
    if (changed) {
      changes[key] = value;
      dirty.add(field.section);
    }
  }
  for (const tab of nav) tab.classList.toggle('is-changed', dirty.has(tab.dataset.section));
  const count = Object.keys(changes).length;
  $('settingsMsg').textContent = saving
    ? 'Saving…'
    : count
      ? count + (count === 1 ? ' unsaved change' : ' unsaved changes')
      : 'All changes saved.';
  $('saveSettings').disabled = $('discardSettings').disabled = saving || !count;
  return changes;
}
for (const event of ['input', 'change'])
  form.addEventListener(event, (e) => {
    if (e.target.closest('[data-key]')) updateChanges();
  });
$('discardSettings').onclick = () => {
  for (const field of fields.values()) field.write(field.initial);
  updateChanges();
};
$('saveSettings').onclick = async () => {
  const changes = updateChanges();
  if (saving || !Object.keys(changes).length) return;
  for (const key of Object.keys(changes)) {
    const field = fields.get(key);
    if (field.input.checkValidity && !field.input.checkValidity()) {
      showTab(field.section);
      field.input.reportValidity();
      return;
    }
  }
  saving = true;
  updateChanges();
  try {
    const { settings } = await api('settings', changes);
    store.catalog.settings = settings;
    for (const [key, value] of Object.entries(changes)) {
      const field = fields.get(key);
      field.initial = settings[key] ?? value;
      if (JSON.stringify(value) === JSON.stringify(field.read())) field.write(field.initial);
    }
    saving = false;
    updateChanges();
  } catch (error) {
    saving = false;
    updateChanges();
    $('settingsMsg').textContent = 'Not saved: ' + error.message;
  }
};
function canClose() {
  return !saving && (!Object.keys(updateChanges()).length || confirm('Discard unsaved settings?'));
}
$('closeSettings').onclick = () => {
  if (canClose()) dialog.close();
};
dialog.addEventListener('cancel', (event) => {
  if (!canClose()) event.preventDefault();
});

function filterSettings() {
  const query = $('settingsSearch').value.trim().toLowerCase();
  let any = false;
  for (const tab of nav) {
    const section = tab.dataset.section;
    const pane = $('tab-' + section);
    let found = false;
    const sectionMatch = tab.firstChild.textContent.toLowerCase().includes(query);
    for (const card of pane.querySelectorAll('[data-card]')) {
      let matched = false;
      for (const row of card.querySelectorAll('.setting-row')) {
        const hit = !query || sectionMatch || (row.dataset.search ?? row.textContent.toLowerCase()).includes(query);
        row.hidden = !hit;
        if (row.tagName === 'DETAILS') {
          if (query && !row.hasAttribute('data-was-open')) row.dataset.wasOpen = String(row.open);
          if (query && hit) row.open = true;
          if (!query && row.hasAttribute('data-was-open')) {
            row.open = row.dataset.wasOpen === 'true';
            delete row.dataset.wasOpen;
          }
        }
        matched ||= hit;
      }
      card.hidden = !matched;
      found ||= matched;
    }
    if (section === 'accounts' || section === 'roles') {
      found = sectionMatch || pane.querySelector('.section-lead').textContent.toLowerCase().includes(query);
      for (const row of pane.querySelectorAll('.account')) {
        row.hidden = !!query && !sectionMatch && !row.textContent.toLowerCase().includes(query);
        if (!row.hidden) found = true;
      }
    }
    pane.hidden = tab.hidden || (query ? !found : section !== currentSection);
    any ||= !pane.hidden;
    if (!query && section === currentSection) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('settingsEmpty').hidden = any;
}
function loadRolesOnce() {
  if (rolesLoaded) return;
  rolesLoaded = true;
  void renderRoles().then(filterSettings);
}
function revealActiveTab() {
  if (!dialog.open || sectionMenu.scrollWidth <= sectionMenu.clientWidth) return;
  sectionMenu.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
globalThis.window?.addEventListener('resize', revealActiveTab);

export function showTab(name) {
  currentSection = name;
  $('settingsSearch').value = '';
  if (name === 'roles') loadRolesOnce();
  filterSettings();
  revealActiveTab();
  form.scrollTop = 0;
}
for (const tab of nav) {
  tab.onclick = () => showTab(tab.dataset.section);
  tab.onkeydown = (event) => {
    const visible = nav.filter((item) => !item.hidden);
    const index = visible.indexOf(tab);
    const offset = { ArrowDown: 1, ArrowRight: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const next =
      event.key === 'Home'
        ? visible[0]
        : event.key === 'End'
          ? visible.at(-1)
          : offset
            ? visible[(index + offset + visible.length) % visible.length]
            : null;
    if (!next) return;
    event.preventDefault();
    next.focus();
    showTab(next.dataset.section);
  };
}
$('settingsSearch').oninput = () => {
  if ($('settingsSearch').value.trim()) loadRolesOnce();
  filterSettings();
  revealActiveTab();
  form.scrollTop = 0;
};
$('refreshAccounts').onclick = () => renderAccounts(true).then(filterSettings);
// Follow a sign-in started from this dialog: refresh when it starts or ends, and when the user comes back to the page.
let lastAccountsFocus = 0;
const accountsVisible = () => $('settingsDialog').open && !$('accountList').closest('[hidden]');
globalThis.window?.addEventListener('bridge-sign-in', () => {
  if (accountsVisible()) void renderAccounts(true).then(filterSettings);
});
const accountsReturn = () => {
  if (document.visibilityState === 'hidden' || !accountsVisible() || Date.now() - lastAccountsFocus < 10000) return;
  lastAccountsFocus = Date.now();
  void renderAccounts(true).then(filterSettings);
};
globalThis.window?.addEventListener('focus', accountsReturn);
document.addEventListener('visibilitychange', accountsReturn);
async function loadHook(session, conversationId) {
  const label = $('hookStatus');
  const button = $('changeHook');
  const current = () => session === opening && dialog.open && conversationId === store.state?.conversationId;
  button.hidden = true;
  if (!store.state?.project?.git) {
    label.textContent = 'This project is not a Git repository.';
    return;
  }
  label.textContent = 'Checking…';
  function render(status) {
    label.textContent = status.enabled ? 'Installed' : status.existing ? 'Another hook exists' : 'Not installed';
    button.textContent = status.enabled ? 'Remove' : 'Install';
    button.hidden = false;
    button.disabled = false;
    button.onclick = async () => {
      if (!current()) {
        label.textContent = 'Reopen Settings for the current project.';
        button.hidden = true;
        return;
      }
      if (status.existing && !status.enabled && !confirm('Back up the existing pre-push hook and replace it with the Agent Bridge check?'))
        return;
      button.disabled = true;
      try {
        const next = await api('publicationHook', { enabled: !status.enabled, signature: status.signature, conversationId });
        if (current()) render(next);
      } catch (error) {
        if (current()) {
          label.textContent = error.message;
          button.disabled = false;
        }
      }
    };
  }
  try {
    const status = await api('publicationHook');
    if (current()) render(status);
  } catch (error) {
    if (current()) label.textContent = 'Pre-push hook unavailable. ' + error.message;
  }
}
async function openSettings(focusManualMode = false) {
  const session = ++opening;
  await loadCatalog();
  if (session !== opening) return;
  rolesLoaded = false;
  $('roleList').replaceChildren();
  renderSettingsForm();
  dialog.showModal();
  showTab(focusManualMode ? 'flow' : 'general');
  if (focusManualMode) fields.get('autoRelay')?.input.focus();
  else $('settingsSearch').focus();
  void renderAccounts().then(filterSettings);
  await loadHook(session, store.state?.conversationId);
}
$('openSettings').onclick = () => openSettings();
$('manualModeSettings').onclick = () => openSettings(true);
