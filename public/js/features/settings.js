// Settings dialog: general settings, accounts and roles.
import { $, h } from '../core/dom.js';
import { ACCOUNT_STATUS_TEXT } from '../core/agent-view.js';
import { store } from '../core/store.js';
import { api } from '../core/api.js';
import { loadCatalog } from '../main.js';
import { addSys } from './conversation-log.js';
export const SETTING_LABELS = {
  userName: ['Your name', 'How the agents refer to you.'],
  routingMode: ['Default routing', 'Used by new conversations. The header switch changes only the open one.'],
  autoRelay: ['Auto-relay', 'Forward replies between agents automatically.'],
  maxHops: ['Max hand-offs', 'Pause after this many agent-to-agent hand-offs (0 = never relay).'],
  tokenLimit: ['Token limit per conversation', 'Pause hand-offs when all agents together pass this many tokens (0 = no limit).'],
  approvalTimeoutSec: ['Approval timeout (seconds)', 'Decline an unanswered approval after this time (0 = wait forever).'],
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

export function renderSettingsForm() {
  const form = $('settingsForm');
  form.textContent = '';
  for (const [key, def] of Object.entries(store.catalog.settingsSchema)) {
    if (key === 'milestoneCommitMode' && !store.state?.milestoneCommitAvailable) continue;
    const [title, hint] = SETTING_LABELS[key] || [key, ''];
    const value = store.catalog.settings[key];
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
          const m = store.catalog.routingModes.find((x) => x.id === v);
          const names = { ask: 'Ask me', closest: 'Continue with the closest agent', off: 'Off', automatic: 'Automatic' };
          input.appendChild(new Option(m ? m.label : names[v] || v, v));
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
    store.catalog.settings = r.settings;
    $('settingsMsg').textContent = 'Saved.';
    await loadCatalog();
  } catch (e) {
    $('settingsMsg').textContent = `Not saved: ${e.message}`;
  }
};

export async function renderAccounts(refresh = false) {
  const list = $('accountList');
  list.textContent = 'Checking…';
  try {
    const { accounts } = await api('accounts', { refresh });
    list.textContent = '';
    for (const acc of accounts) {
      const row = h('div', 'account');
      const [text, cls] = ACCOUNT_STATUS_TEXT[acc.state] || [acc.state, 'warn'];
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

export async function renderRoles() {
  const list = $('roleList');
  list.textContent = 'Loading…';
  let info = { installed: [], roles: {} };
  try {
    info = await api('skills');
  } catch (e) {
    addSys(`Could not list skills: ${e.message}`, true);
  }
  list.textContent = '';
  for (const r of store.catalog.roles) {
    const prof = info.roles[r.id] || { profile: r.profile || 'full', skillsOff: [], skillsOnly: null };
    const row = h('div', 'account');
    const head = h('div', 'acc-head');
    head.append(
      h('strong', null, r.name),
      h('span', 'hint', r.canEdit === 'none' ? 'read-only' : r.canEdit === 'tests' ? 'edits tests only' : 'edits files'),
    );
    row.append(head, h('div', null, r.summary));
    if (r.warning) row.append(h('p', 'err', r.warning));
    if (r.recommended?.label) row.appendChild(h('div', 'hint', `Recommended models: ${r.recommended.label}`));

    // Profile: full setup or lean (no hooks), plus skills switched off for this role.
    const pl = h('label', 'inline');
    pl.appendChild(document.createTextNode('Profile '));
    const ps = h('select');
    ps.append(
      new Option('Full (all your hooks, skills and plugins)', 'full'),
      new Option('Lean (no hooks; only the skills you tick)', 'lean'),
    );
    ps.value = prof.profile;
    pl.appendChild(ps);
    row.appendChild(pl);

    // Full roles: tick the skills to switch off. Lean roles: everything is blocked, tick the ones to allow.
    const skillBox = h('div', 'skills');
    const boxes = [];
    const lists = {
      full: new Set(prof.skillsOnly ? [] : prof.skillsOff),
      lean: new Set(prof.skillsOnly || []),
    };
    let shown = ps.value;
    const renderSkills = () => {
      skillBox.textContent = '';
      boxes.length = 0;
      if (!info.installed.length) {
        skillBox.appendChild(h('div', 'hint', 'No installed skills found yet (the list fills in once a Claude agent has started).'));
        return;
      }
      skillBox.appendChild(
        h(
          'div',
          'hint',
          shown === 'lean'
            ? 'Skills allowed for this role. Every other skill is blocked (Claude and OpenCode agents; Codex has no per-session switch):'
            : 'Skills switched off for this role (Claude and OpenCode agents; Codex has no per-session switch):',
        ),
      );
      for (const name of info.installed) {
        const l = h('label', 'check');
        const cb = h('input');
        cb.type = 'checkbox';
        cb.value = name;
        cb.checked = lists[shown].has(name);
        cb.onchange = () => (cb.checked ? lists[shown].add(name) : lists[shown].delete(name));
        l.append(cb, document.createTextNode(` ${name}`));
        skillBox.appendChild(l);
        boxes.push(cb);
      }
    };
    ps.onchange = () => {
      shown = ps.value;
      renderSkills();
    };
    renderSkills();
    row.appendChild(skillBox);

    const actions = h('div', 'actions');
    const msg = h('span', 'hint', prof.overridden ? 'Changed in Settings.' : 'Defaults from the role file.');
    const save = h('button', 'primary', 'Save');
    save.onclick = async () => {
      try {
        await api('roleProfile', { role: r.id, profile: ps.value, skillsOff: [...lists.full], skillsOn: [...lists.lean] });
        msg.textContent = 'Saved. Agents with this role pick it up (Claude restarts on the same session).';
      } catch (e) {
        msg.textContent = `Not saved: ${e.message}`;
      }
    };
    const reset = h('button', null, 'Reset to defaults');
    reset.onclick = async () => {
      await api('roleProfile', { role: r.id, reset: true }).catch((e) => (msg.textContent = e.message));
      renderRoles();
    };
    actions.append(msg, reset, save);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

export function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const p of ['general', 'accounts', 'roles']) $(`tab-${p}`).hidden = p !== name;
  if (name === 'accounts') renderAccounts();
  if (name === 'roles') renderRoles();
}

const tabs = [...document.querySelectorAll('.tab')];
for (const [index, tab] of tabs.entries()) {
  tab.onclick = () => showTab(tab.dataset.tab);
  tab.onkeydown = (event) => {
    const next = {
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].focus();
    showTab(tabs[next].dataset.tab);
  };
}
$('refreshAccounts').onclick = () => renderAccounts(true);
$('openSettings').onclick = async () => {
  await loadCatalog();
  renderSettingsForm();
  $('settingsMsg').textContent = '';
  $('saveTeam').checked = false;
  showTab('general');
  $('settingsDialog').showModal();
};
