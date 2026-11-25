import { openAddDialog } from './add-agent.js';
import { applyAgentAccent } from '../core/agent-accent.js';
// Cards pinned above the message box: approvals, missing roles and the final confirmation.
import { approvals, findMentionAgent, label, store } from '../core/store.js';
import { $, appendMentions, h, renderMarkdown, time } from '../core/dom.js';
import { api } from '../core/api.js';
import { addSys } from './conversation-log.js';

const nameViews = new WeakMap();

function agentText(tag, className, content, markdown = false) {
  const el = h(tag, className);
  el.classList.add('agent-name-text');
  const refresh = () => {
    const text = content();
    if (markdown) renderMarkdown(el, text, findMentionAgent);
    else {
      el.replaceChildren();
      appendMentions(el, text, findMentionAgent);
    }
  };
  nameViews.set(el, refresh);
  refresh();
  return el;
}

export function refreshApprovalNames() {
  for (const element of $('pending').querySelectorAll('.agent-name-text')) nameViews.get(element)?.();
}

/** Pending approvals stay pinned above the message box until answered. */
export function updatePending() {
  const n = approvals.size;
  $('pending').hidden = n === 0;
  const count = $('pendingCount');
  count.hidden = n === 0;
  count.textContent = n + (n === 1 ? ' pending request' : ' pending requests');
  const base = store.state ? `Agent Bridge · ${store.state.workDir}` : 'Agent Bridge';
  document.title = n ? `(${n}) Approval needed · ${base}` : base;
}

$('pendingCount').onclick = () => {
  const first = $('pending').querySelector('button');
  if (first) first.focus();
};

/** End of the work: the user approves the result or asks for changes. */
export function renderFinalReview(ev) {
  const el = h('div', 'approval final-review');
  el.dataset.title = 'Final confirmation';
  el.appendChild(agentText('div', 'title', () => `${label(ev.agent)} finished the work · ${time(ev.at)}`));
  if (ev.summary) {
    el.appendChild(agentText('div', 'body', () => (ev.summary.length > 1500 ? `${ev.summary.slice(0, 1500)}…` : ev.summary), true));
  }
  if (ev.project?.length || ev.tests?.length) {
    const evidence = h('details');
    evidence.appendChild(h('summary', null, 'Observed changes and test signals'));
    const content = h('div', 'body');
    for (const project of ev.project || []) {
      content.appendChild(h('h3', null, project.title));
      const status = {
        'no-git': 'Git metadata unavailable. File claims in the agent summary are unverified.',
        'no-baseline': 'No initial Git state was recorded.',
        partial: 'Only part of the Git history could be compared.',
      };
      if (status[project.status]) content.appendChild(h('p', null, status[project.status]));
      if (project.files.length) {
        const files = h('ul');
        for (const file of project.files)
          files.appendChild(
            h(
              'li',
              null,
              file.path +
                ' · ' +
                file.status +
                (file.preexisting ? ' · pre-existing; session changes cannot be attributed from status alone' : ''),
            ),
          );
        content.appendChild(files);
      } else if (project.status === 'ok') content.appendChild(h('p', null, 'No changes observed in the Git metadata.'));
    }
    if (ev.tests?.length) {
      const testList = h('ul');
      content.appendChild(h('h3', null, 'Commands identified as possible tests'));
      for (const result of ev.tests) testList.appendChild(h('li', null, result));
      content.appendChild(testList);
    }
    evidence.appendChild(content);
    el.appendChild(evidence);
  }
  const actions = h('div', 'actions');
  const ok = h('button', 'primary', 'Approve');
  ok.onclick = () => api('finalReview', { requestId: ev.requestId, action: 'approve' }).catch((e) => addSys(e.message, true));
  const ch = h('button', null, 'Ask for changes');
  ch.onclick = () =>
    api('finalReview', { requestId: ev.requestId, action: 'changes' })
      .then(() => {
        $('target').value = ev.agent;
        $('input').placeholder = `What should ${label(ev.agent)} change?`;
        $('input').focus();
      })
      .catch((e) => addSys(e.message, true));
  actions.append(ok, ch);
  el.appendChild(actions);
  approvals.set(ev.requestId, el);
  $('pending').appendChild(el);
  updatePending();
}

function suggestedAgent(card, role, suggestion, show) {
  let preset = null;
  const customize = h('button', 'btn', 'Customize');
  const reset = h('button', 'btn', 'Restore suggestion');
  const error = h('div', 'hint');
  error.setAttribute('aria-live', 'polite');
  reset.hidden = true;
  function update(choice, modelLabel) {
    preset = choice;
    reset.hidden = !choice;
    error.textContent = '';
    const driver = store.catalog.drivers.find((item) => item.id === choice?.driver);
    const label = choice
      ? [driver?.label || choice.driver, modelLabel || choice.model, choice.name].filter(Boolean)
      : [suggestion.driverLabel, suggestion.modelLabel, suggestion.name].filter(Boolean);
    show(label.join(' \u00b7 '));
  }
  customize.onclick = () =>
    openAddDialog({
      mode: 'customize',
      role,
      preset: preset || suggestion,
      onConfirm: (choice, modelLabel) => {
        if (card.isConnected) update(choice, modelLabel);
      },
    });
  reset.onclick = () => update(null);
  update(null);
  return { customize, reset, error, options: () => preset || { role } };
}

/** The orchestrator needs a role nobody in the team has: add it (with a recommended model) or use the closest agent. */
export function renderNeedRole(ev) {
  const el = h('div', 'approval need-role');
  el.dataset.title = `Missing role: ${ev.roleName}`;
  el.appendChild(
    agentText('div', 'title', () => `${label(ev.agent)} needs a ${ev.roleName}, and nobody in the team has that role · ${time(ev.at)}`),
  );
  el.appendChild(h('div', 'hint', 'The relay is paused until you choose. The default choice can be set in Settings.'));
  const actions = h('div', 'actions');
  const add = h('button', 'primary');
  const choice = suggestedAgent(el, ev.role, ev.suggestion, (summary) => {
    add.textContent = 'Add ' + ev.roleName + ' (' + summary + ')';
  });
  add.onclick = async () => {
    const controls = [...actions.querySelectorAll('button')];
    for (const control of controls) control.disabled = true;
    choice.error.textContent = '';
    try {
      const result = await api('resolveRole', { ...choice.options(), requestId: ev.requestId, action: 'add' });
      if (result.invalid) choice.error.textContent = result.invalid.reason;
    } catch (error) {
      choice.error.textContent = error.message;
    } finally {
      for (const control of controls) control.disabled = false;
    }
  };
  actions.append(add, choice.customize, choice.reset);
  if (ev.closest) {
    const near = agentText(
      'button',
      null,
      () => `Continue with ${findMentionAgent(ev.closest.id)?.name || ev.closest.name} (${ev.closest.roleName}, closest)`,
    );
    near.onclick = () => api('resolveRole', { requestId: ev.requestId, action: 'closest' }).catch((e) => addSys(e.message, true));
    actions.appendChild(near);
  }
  const dismiss = h('button', 'danger', 'Dismiss');
  dismiss.onclick = () => api('resolveRole', { requestId: ev.requestId, action: 'dismiss' }).catch((e) => addSys(e.message, true));
  actions.appendChild(dismiss);
  el.append(actions, choice.error);
  approvals.set(ev.requestId, el);
  $('pending').appendChild(el);
  updatePending();
}

export function renderRoleRecommendation(ev) {
  const el = h('div', 'approval');
  el.dataset.title = 'Role recommendation';
  el.append(agentText('div', 'title', () => label(ev.agent) + ' recommends adding roles'));
  const fields = h('div', 'form');
  const choices = ev.roles.map(({ id, name, reason, suggestion }) => {
    const check = h('input');
    check.type = 'checkbox';
    check.checked = true;
    const row = h('label', 'check');

    const title = h('span');
    const choice = suggestedAgent(el, id, suggestion, (summary) => {
      title.textContent = name + ' (' + summary + ')';
    });
    const options = h('div', 'actions');
    options.append(choice.customize, choice.reset);
    row.append(check, title);
    fields.append(
      row,
      agentText('div', 'hint', () => reason),
      options,
      choice.error,
    );
    return { id, check, ...choice };
  });
  el.append(fields);
  const actions = h('div', 'actions');
  const add = h('button', 'primary', 'Add selected');
  const keep = h('button', '', 'Keep current team');
  async function resolve(selected) {
    add.disabled = keep.disabled = true;
    for (const choice of choices) {
      choice.check.disabled = choice.customize.disabled = choice.reset.disabled = true;
      choice.error.textContent = '';
    }
    try {
      const result = await api('resolveRecommendedRoles', { requestId: ev.requestId, selected });
      if (result.invalid) {
        const choice = choices.find(({ id }) => id === result.invalid.role);
        if (choice) choice.error.textContent = result.invalid.reason;
      }
    } catch (error) {
      addSys(error.message, true);
    } finally {
      add.disabled = keep.disabled = false;
      for (const choice of choices) choice.check.disabled = choice.customize.disabled = choice.reset.disabled = false;
    }
  }
  add.onclick = () => resolve(choices.filter(({ check }) => check.checked).map((choice) => choice.options()));
  keep.onclick = () => resolve([]);
  actions.append(add, keep);
  el.append(actions);
  approvals.set(ev.requestId, el);
  $('pending').append(el);
  updatePending();
}

function findingLocation(finding) {
  return finding.rule + ' · ' + finding.commit.slice(0, 12) + ' · ' + finding.file + (finding.line ? ' line ' + finding.line : '');
}

export function renderApproval(ev) {
  approvals.get(ev.requestId)?.remove();
  const el = h('div', 'approval');
  applyAgentAccent(el, ev.agent);
  el.dataset.title = ev.title;
  el.appendChild(
    agentText(
      'div',
      'title',
      () => `${ev.title} · ${time(ev.at)}${ev.expiresAt ? ` · declined automatically at ${time(ev.expiresAt)} if unanswered` : ''}`,
    ),
  );
  if (ev.warning) el.appendChild(h('div', 'warning', `⚠ ${ev.warning}`));
  if (ev.publicationScope) {
    const scope = h('details');
    scope.append(h('summary', null, 'Publication scope'), h('pre', null, ev.publicationScope));
    el.appendChild(scope);
  }
  if (ev.appliedExceptions?.length) {
    el.appendChild(h('strong', null, 'Applied exceptions'));
    const list = h('ul');
    for (const finding of ev.appliedExceptions) list.appendChild(h('li', null, findingLocation(finding) + ' · ' + finding.reason));
    el.appendChild(list);
  }
  for (const finding of ev.findings || []) {
    const row = h('div', 'warning');
    const exception = h('button', null, 'Allow this finding');
    const reason = h('select');
    ['false positive', 'test fixture'].forEach((value) => reason.appendChild(new Option(value, value)));
    exception.onclick = () => {
      if (confirm('Allow only this finding for the selected reason?'))
        api('publicationException', { requestId: ev.requestId, finding: finding.id, reason: reason.value }).catch((e) =>
          addSys(e.message, true),
        );
    };
    row.append(h('span', null, findingLocation(finding)), reason, exception);
    el.appendChild(row);
  }
  const scope = ev.decisions.includes('acceptForSession') ? 'Once or for this session' : 'Once';
  el.appendChild(agentText('div', 'hint', () => label(ev.agent) + ' · ' + scope + (ev.cwd ? ' · ' + ev.cwd : '')));
  if (ev.detail) {
    const details = h('details');
    details.append(h('summary', null, 'Technical details'), h('pre', null, ev.detail));
    el.appendChild(details);
  }
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
  updatePending();
}
