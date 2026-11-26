import { h } from '../core/dom.js';
import { hopBudget } from '../core/hop-budget.js';

const names = {
  sidebar: 'Right sidebar',
  top: 'Above the chat',
  ask: 'Ask me',
  closest: 'Closest agent',
  off: 'Off',
  automatic: 'Automatic',
};

export function settingField({ key, def, title, hint, control, unit, routingModes }) {
  const row = h(control === 'list' ? 'details' : 'div', 'setting-row');
  const copy = h('div', 'setting-copy');
  const caption = h(control === 'list' ? 'summary' : 'label', 'setting-label', title);
  const description = h('p', 'hint', hint);
  description.id = 'setting-hint-' + key;
  const id = 'setting-' + key;
  const group = control === 'enum' && def.values.length <= 3;
  const input = h(group ? 'div' : control === 'enum' ? 'select' : control === 'list' ? 'textarea' : 'input');
  const controls = h('div', 'setting-control');
  input.dataset.key = key;
  input.id = id;
  caption.id = id + '-title';
  if (control !== 'list') caption.htmlFor = id;
  input.setAttribute('aria-labelledby', caption.id);
  if (hint) input.setAttribute('aria-describedby', description.id);
  if (control === 'list') {
    row.append(caption);
    input.rows = 4;
  } else copy.append(caption);
  if (hint) copy.append(description);
  row.append(copy, controls);
  controls.append(input);
  if (control === 'boolean') {
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
  } else if (control === 'enum') {
    if (group) {
      input.className = 'setting-segments';
      input.setAttribute('role', 'radiogroup');
    }
    for (const value of def.values) {
      const label = routingModes.find((mode) => mode.id === value)?.label ?? names[value] ?? value;
      if (group) {
        const option = h('label');
        const radio = h('input');
        radio.type = 'radio';
        radio.name = id;
        radio.value = value;
        option.append(radio, h('span', null, label));
        input.append(option);
      } else {
        const option = h('option', null, label);
        option.value = value;
        input.append(option);
      }
    }
  } else if (control === 'number') {
    input.type = 'number';
    if (def.min !== undefined) input.min = def.min;
    input.required = true;
  }
  const unitText = h('span', 'hint', unit);
  if (unit) controls.append(unitText);
  const preview = h('p', 'setting-preview');
  if (key === 'maxHops' || key === 'bypassNewAgents') copy.append(preview);
  function read() {
    if (group) return [...input.querySelectorAll('input')].find((radio) => radio.checked)?.value;
    if (control === 'boolean') return key === 'autoRelay' ? !input.checked : input.checked;
    if (control === 'list')
      return input.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (control === 'number') return input.value === '' ? null : Number(input.value);
    return input.value;
  }
  function write(value) {
    if (group) for (const radio of input.querySelectorAll('input')) radio.checked = radio.value === value;
    else if (control === 'boolean') input.checked = key === 'autoRelay' ? !value : Boolean(value);
    else input.value = control === 'list' ? (value || []).join('\n') : (value ?? '');
  }
  function update() {
    const value = read();
    if (control === 'list') caption.textContent = title + ' · ' + value.length + (value.length === 1 ? ' pattern' : ' patterns');
    if (key === 'tokenLimit') unitText.textContent = value === 0 ? 'no limit' : unit;
    if (key === 'maxHops')
      preview.textContent =
        value === null || value < 0
          ? ''
          : value === 0
            ? 'Automatic hand-offs off'
            : ['small', 'medium', 'large']
                .map(
                  (size, i) => (i === 0 ? 'Small task' : size) + ' ' + hopBudget('orchestrator', value, { size, classified: true }).limit,
                )
                .join(' · ');
    if (key === 'bypassNewAgents') {
      preview.classList.add('setting-warning');
      preview.textContent = 'Every new agent will start with bypass on.';
      preview.hidden = !value;
    }
  }
  row.dataset.search = [title, hint, key].join(' ').toLowerCase();
  return { row, input, read, write, update };
}
