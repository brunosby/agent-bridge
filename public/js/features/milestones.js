import { $, h } from '../core/dom.js';
import { api } from '../core/api.js';

const statusLabels = {
  pending: 'Pending',
  working: 'In progress',
  checking: 'Checking',
  waiting_for_commit: 'Awaiting approval',
  blocked: 'Blocked',
  committed: 'Committed',
};

let displayed = '';

export function renderMilestoneProgress(milestones = []) {
  const signature = JSON.stringify(milestones);
  if (signature === displayed) return;
  displayed = signature;
  const panel = $('milestonePanel');
  const list = $('milestoneList');
  panel.hidden = !milestones.length;
  list.replaceChildren();
  if (!milestones.length) return;
  const done = milestones.filter((item) => item.status === 'committed').length;
  $('milestoneSummary').textContent = 'Milestones (' + done + '/' + milestones.length + ')';
  for (const item of milestones) {
    const row = h('li');
    row.append(h('strong', null, item.title), h('span', 'pill', statusLabels[item.status] || item.status));
    row.append(h('div', 'hint', item.detail || item.criterion));
    for (const record of item.commits || []) row.append(h('div', 'hint', record.workspace + ' · ' + record.head.slice(0, 7)));
    list.append(row);
  }
}

function card(title) {
  const item = h('div', 'approval');
  item.dataset.title = title;
  item.append(h('div', 'title', title));
  return item;
}

function attachActions(item, route, requestId, approveText, dismissText, values) {
  const actions = h('div', 'actions');
  const message = h('output', 'hint');
  message.setAttribute('aria-live', 'polite');
  const approve = h('button', 'primary', approveText);
  const dismiss = h('button', 'btn', dismissText);
  async function send(action) {
    approve.disabled = dismiss.disabled = true;
    message.textContent = '';
    try {
      await api(route, { requestId, action, ...(action === 'approve' ? values() : {}) });
    } catch (error) {
      message.textContent = error.message;
      approve.disabled = dismiss.disabled = false;
    }
  }
  approve.onclick = () => send('approve');
  dismiss.onclick = () => send('dismiss');
  actions.append(message, approve, dismiss);
  item.append(actions);
}

export function milestonePlanCard(event) {
  const item = card('Review the milestone plan');
  const fields = h('div', 'form');
  const makeField = (label, value, limit, multiline = false) => {
    const row = h('label', null, label);
    const field = h(multiline ? 'textarea' : 'input');
    field.value = value;
    field.maxLength = limit;
    if (multiline) field.rows = 2;
    row.append(field);
    fields.append(row);
    return field;
  };
  const steps = event.milestones.map((step, index) => ({
    title: makeField('Milestone ' + (index + 1), step.title, 100),
    criterion: makeField('Completion criterion', step.criterion, 320, true),
  }));
  const command = makeField('Verification command for this project (optional)', event.command || '', 400);
  fields.append(
    h(
      'div',
      'hint',
      event.commandSaved
        ? 'This command was saved for this project.'
        : 'The app runs this command when checking each milestone. Leave it blank to skip it.',
    ),
  );
  item.append(fields);
  attachActions(item, 'resolveMilestonePlan', event.requestId, 'Approve milestones', 'Continue without milestones', () => ({
    milestones: steps.map((step) => ({ title: step.title.value, criterion: step.criterion.value })),
    command: command.value,
  }));
  return item;
}

export function milestoneCommitCard(event) {
  const item = card('Approve milestone ' + event.milestone.number + ' commit');
  item.append(h('div', 'body', event.message), h('div', 'hint', 'Completion criterion · ' + event.milestone.criterion));
  for (const group of event.files) {
    item.append(h('strong', null, group.workspace));
    const list = h('ul');
    for (const file of group.paths) list.append(h('li', null, file));
    item.append(list);
  }
  attachActions(item, 'resolveMilestoneCommit', event.requestId, 'Create commit', 'Decline commit', () => ({}));
  return item;
}
