import { $, h } from '../core/dom.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';

export function teamOptions(data, select) {
  select.replaceChildren(new Option('Factory team', ''));
  for (const team of data.teams) select.add(new Option(team.name + (team.name === data.defaultTeamName ? ' (default)' : ''), team.name));
  select.value = data.defaultTeamName || '';
}
function action(name, fn) {
  const el = h('button', 'btn', name);
  el.onclick = async () => {
    el.disabled = true;
    try {
      await fn();
    } catch (e) {
      $('teamsMessage').textContent = e.message;
    } finally {
      el.disabled = false;
    }
  };
  return el;
}
function choice(label, items, value) {
  const field = h('label', 'field', label),
    select = h('select');
  for (const [key, text] of items) select.add(new Option(text, key));
  select.value = value;
  field.append(select);
  return { field, select };
}
async function draw() {
  const data = await api('teams'),
    list = $('teamTemplates');
  list.replaceChildren();
  for (const team of data.teams) {
    const section = h('section', 'form');
    section.append(h('h3', null, team.name + (team.name === data.defaultTeamName ? ' · Default' : '')));
    const changes = [];
    for (const member of team.members) {
      const editor = h('details');
      editor.append(h('summary', null, [member.name, member.role, member.driver, member.model].filter(Boolean).join(' · ')));
      const driver = choice(
        'Provider',
        store.catalog.drivers.map((d) => [d.id, d.label]),
        member.driver,
      );
      const role = choice(
        'Role',
        store.catalog.roles.map((r) => [r.id, r.name]),
        member.role,
      );
      const model = choice(
        'Model',
        [['', 'Provider default'], ...(member.model ? [[member.model, member.model]] : [])],
        member.model || '',
      );
      const effort = choice(
        'Effort',
        [['', 'Provider default'], ...(member.effort ? [[member.effort, member.effort]] : [])],
        member.effort || '',
      );
      const note = h('span', 'hint');
      editor.append(role.field, driver.field, model.field, effort.field, note);
      let request = 0,
        models = [];
      const updateEffort = () => {
        const old = effort.select.value;
        effort.select.replaceChildren(new Option('Provider default', ''));
        const item = models.find((m) => m.value === model.select.value || (!model.select.value && m.isDefault));
        for (const value of item?.efforts || []) effort.select.add(new Option(value, value));
        effort.select.value = [...effort.select.options].some((o) => o.value === old) ? old : '';
      };
      const load = async () => {
        const id = ++request,
          old = model.select.value;
        try {
          const result = await api('driverModels', { driver: driver.select.value });
          if (id !== request) return;
          models = result.models;
          model.select.replaceChildren(new Option('Provider default', ''));
          for (const m of models.filter((m) => !m.disabled && m.value !== 'default'))
            model.select.add(new Option(m.label || m.value, m.value));
          model.select.value = models.some((m) => m.value === old && !m.disabled) ? old : '';
          note.textContent = old && !model.select.value ? 'Saved model unavailable. Review the replacement before applying.' : '';
          updateEffort();
        } catch (e) {
          if (id === request) note.textContent = e.message;
        }
      };
      editor.ontoggle = () => {
        if (editor.open && !request) void load();
      };
      driver.select.onchange = load;
      model.select.onchange = updateEffort;
      changes.push(() => ({
        role: role.select.value,
        driver: driver.select.value,
        model: model.select.value || null,
        effort: effort.select.value || null,
      }));
      section.append(editor);
    }
    const modify = async (operation, extra = {}) => {
      await api('manageTeam', { operation, name: team.name, ...extra });
      await draw();
    };
    section.append(
      action('Apply', async () => {
        const conversationId = store.state?.conversationId;
        const result = await api('applyTeam', { name: team.name, conversationId, choices: changes.map((fn) => fn()) });
        if (!result.pending) {
          $('teamsDialog').close();
          return;
        }
        const msg = $('teamsMessage');
        msg.replaceChildren(
          h('p', null, result.pending.join(' · ')),
          action('Resolve in conversation', () => $('teamsDialog').close()),
          action('Stop all', async () => {
            if (confirm('Stop every agent and cancel outstanding decisions in this conversation?')) {
              await api('interrupt', { conversationId, cancelPending: true });
              msg.textContent = 'Stopped. Review the team and choose Apply again.';
            }
          }),
        );
      }),
      action('Rename', async () => {
        const newName = prompt('New team name', team.name);
        if (newName) await modify('rename', { newName });
      }),
      action('Set as default', () => modify('default')),
      action('Delete', () => confirm('Delete team “' + team.name + '”?') && modify('delete', { confirm: true })),
    );
    list.append(section);
  }
  if (!data.teams.length) list.append(h('p', 'hint', 'No saved teams yet.'));
  $('saveCurrentTeam').onclick = async () => {
    const name = prompt('Name for this team')?.trim();
    if (!name) return;
    const exists = data.teams.some((t) => t.name.toLowerCase() === name.toLowerCase());
    if (exists && !confirm('Replace the existing team?')) return;
    try {
      await api('manageTeam', { operation: 'save', name, replace: exists });
      await draw();
    } catch (e) {
      $('teamsMessage').textContent = e.message;
    }
  };
}
$('openTeams').onclick = async () => {
  $('teamsDialog').showModal();
  $('teamsMessage').textContent = '';
  try {
    await draw();
  } catch (e) {
    $('teamsMessage').textContent = e.message;
  }
};
