// Conversations dialog: restore, remove or start a conversation.
import { teamOptions } from './teams.js';
import { $, closeDialog, h } from '../core/dom.js';
import { roleOf, store } from '../core/store.js';
import { api } from '../core/api.js';
import { addSys } from './conversation-log.js';
export async function showConversations() {
  const list = $('convList');
  list.textContent = 'Loading…';
  $('newWorkDir').value = store.state?.workDir || '';
  $('convDialog').showModal();
  try {
    const [{ current, conversations }, teams] = await Promise.all([api('conversations'), api('teams')]);
    teamOptions(teams, $('newTeam'));
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
          if (
            store.state &&
            store.state.team.some((a) => a.busy) &&
            !confirm('An agent is still working. Stop it and switch conversation?')
          )
            return;
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
  if (store.state && store.state.team.some((a) => a.busy) && !confirm('An agent is still working. Stop it and start a new conversation?'))
    return;
  try {
    await api('new', { workDir: $('newWorkDir').value.trim(), teamName: $('newTeam').value });
    closeDialog('convDialog');
  } catch (e) {
    alert(e.message);
  }
};
