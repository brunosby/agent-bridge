import { $, h } from '../core/dom.js';
import { ACCOUNT_STATUS_TEXT } from '../core/agent-view.js';
import { store } from '../core/store.js';
import { api } from '../core/api.js';
import { addSys } from './conversation-log.js';

let accountsRequest = 0;
export async function renderAccounts(refresh = false) {
  const request = ++accountsRequest;
  const list = $('accountList');
  list.textContent = 'Checking…';
  try {
    const { accounts } = await api('accounts', { refresh });
    if (request !== accountsRequest) return;
    list.textContent = '';
    const count = accounts.filter((acc) => acc.state !== 'ok').length;
    $('accountsCount').hidden = !count;
    $('accountsCount').textContent = String(count);
    $('accountsCount').setAttribute('aria-label', count + (count === 1 ? ' provider needs attention' : ' providers need attention'));
    for (const acc of accounts) {
      const row = h('div', 'account');
      const [text, cls] = ACCOUNT_STATUS_TEXT[acc.state] || [acc.state, 'warn'];
      const head = h('div', 'acc-head');
      head.append(h('strong', null, acc.label), h('span', `state ${cls}`, text));
      if (acc.version) head.appendChild(h('span', 'hint', acc.version));
      row.appendChild(head);
      if (acc.detail) row.appendChild(h('div', 'hint', acc.detail));
      if (store.state?.signIn?.waiting?.includes(acc.driver)) row.appendChild(h('div', 'hint', 'Waiting for sign-in…'));
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
          b.title = 'Opens a terminal window that runs the sign-in command. Finish it there; Agent Bridge detects the sign-in.';
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
    if (request !== accountsRequest) return;
    $('accountsCount').hidden = true;
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
