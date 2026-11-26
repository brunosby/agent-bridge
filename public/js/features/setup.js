import { $, h } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';

let revision = 0;
function control(label, run) {
  const el = h('button', 'btn', label);
  el.onclick = async () => {
    el.disabled = true;
    try {
      await run();
    } catch (e) {
      $('setupMessage').textContent = e.message;
    } finally {
      el.disabled = false;
    }
  };
  return el;
}
async function finish(members) {
  await api('setup', { action: 'finish', ...(members && { members }) });
  revision++;
  store.catalog.setupCompleted = true;
  $('setupDialog').close();
}
async function check(refresh = false) {
  const current = ++revision,
    list = $('setupItems'),
    team = $('setupTeam');
  list.textContent = 'Checking installed tools and accounts…';
  team.replaceChildren();
  $('setupMessage').textContent = '';
  const data = await api('setup', { action: 'status', refresh });
  if (current !== revision || !$('setupDialog').open) return;
  list.replaceChildren();
  for (const item of data.items) {
    const row = h('section', 'setup-item'),
      label = h('div');
    const freeOnly = item.id === 'opencode' && item.state === 'ok' && item.signedIn === false;
    label.append(
      h('strong', null, item.label),
      h('div', 'hint', [freeOnly ? 'Free models only' : item.state.replaceAll('_', ' '), item.version].filter(Boolean).join(' · ')),
    );
    if (item.id === 'git') label.append(h('small', null, 'Used for worktrees, milestones, publication checks and the Claude Bash tool.'));
    row.append(label);
    if (item.state === 'not_installed') {
      if (item.command)
        row.append(
          control('Install', async () => {
            if (confirm('Install ' + item.label + ' in a terminal?\n\n' + item.command))
              await api('setup', { action: 'install', id: item.id, confirm: true });
          }),
        );
      const guide = h('a', 'btn', 'Open install guide');
      guide.href = item.guide;
      guide.target = '_blank';
      guide.rel = 'noopener noreferrer';
      row.append(guide);
    } else if (item.id !== 'git' && (item.state !== 'ok' || freeOnly))
      row.append(control('Sign in', () => api('login', { driver: item.id })));
    list.append(row);
  }
  $('setupShortcut').hidden = !data.windows;
  if (refresh && data.items.some((item) => item.state === 'not_installed'))
    $('setupMessage').textContent = [
      data.pathWarning,
      'If a newly installed tool is missing, quit Agent Bridge (App > Quit) and open it again from the shortcut. Restart inherits the current PATH.',
    ]
      .filter(Boolean)
      .join(' ');
  const available = data.items.filter((item) => item.id !== 'git' && item.state === 'ok');
  if (!available.length) {
    team.append(h('p', 'hint', 'Sign in to a provider to suggest a starting team.'));
    return;
  }
  const choices = [];
  for (const [i, role] of ['orchestrator', 'coder', 'reviewer'].entries()) {
    const name = role[0].toUpperCase() + role.slice(1);
    const select = h('select'),
      field = h('label', 'field', name);
    for (const a of available) select.add(new Option(a.signedIn === false ? a.label + ' (free models only)' : a.label, a.id));
    select.add(new Option('Exclude from team', ''));
    select.value = available[i === 1 && available.length > 1 ? 1 : 0].id;
    field.append(select);
    team.append(field);
    choices.push(() => ({ role, driver: select.value, name }));
  }
  team.append(
    control('Save as default and finish', async () => {
      const members = choices.map((fn) => fn()).filter((m) => m.driver);
      if (!members.length) throw new Error('Choose at least one team member.');
      if (confirm('Use this team for new conversations?')) await finish(members);
    }),
  );
}
export function openSetup() {
  const dialog = $('setupDialog');
  if (!dialog || dialog.open) return;
  $('setupDesktop').checked = false;
  $('setupShortcut').hidden = true;
  dialog.showModal();
  void check().catch((e) => {
    $('setupMessage').textContent = e.message;
  });
}
if ($('setupDialog')) {
  $('runSetup').onclick = openSetup;
  $('setupRefresh').onclick = () =>
    check(true).catch((e) => {
      $('setupMessage').textContent = e.message;
    });
  $('setupSkip').onclick = $('setupDone').onclick = () =>
    finish().catch((e) => {
      $('setupMessage').textContent = e.message;
    });
  $('setupCreate').onclick = async () => {
    const desktop = $('setupDesktop').checked;
    if (!confirm('Create or update the Agent Bridge shortcut in the Start menu' + (desktop ? ' and on the desktop' : '') + '?')) return;
    try {
      await api('setup', { action: 'shortcut', desktop, confirm: true });
      $('setupMessage').textContent = 'Shortcut created.';
    } catch (e) {
      $('setupMessage').textContent = e.message;
    }
  };
}
