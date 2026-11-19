// Cards pinned above the message box: approvals, missing roles and the final confirmation.
import { approvals, driverOf, label, store } from '../core/store.js';
import { $, h, renderMarkdown, time } from '../core/dom.js';
import { api } from '../core/api.js';
import { addSys } from './conversation-log.js';
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
  el.appendChild(h('div', 'title', `${label(ev.agent)} finished the work · ${time(ev.at)}`));
  if (ev.summary) {
    const body = h('div', 'body');
    renderMarkdown(body, ev.summary.length > 1500 ? `${ev.summary.slice(0, 1500)}…` : ev.summary);
    el.appendChild(body);
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

/** The orchestrator needs a role nobody in the team has: add it (with a recommended model) or use the closest agent. */
export function renderNeedRole(ev) {
  const el = h('div', 'approval need-role');
  el.dataset.title = `Missing role: ${ev.roleName}`;
  el.appendChild(h('div', 'title', `${label(ev.agent)} needs a ${ev.roleName}, and nobody in the team has that role · ${time(ev.at)}`));
  el.appendChild(h('div', 'hint', 'The relay is paused until you choose. The default choice can be set in Settings.'));
  const actions = h('div', 'actions');
  const add = h('button', 'primary', `Add ${ev.roleName} (${ev.suggestion.driverLabel} · ${ev.suggestion.modelLabel})`);
  add.onclick = () => api('resolveRole', { requestId: ev.requestId, action: 'add' }).catch((e) => addSys(e.message, true));
  actions.appendChild(add);
  if (ev.closest) {
    const near = h('button', null, `Continue with ${ev.closest.name} (${ev.closest.roleName}, closest)`);
    near.onclick = () => api('resolveRole', { requestId: ev.requestId, action: 'closest' }).catch((e) => addSys(e.message, true));
    actions.appendChild(near);
  }
  const dismiss = h('button', 'danger', 'Dismiss');
  dismiss.onclick = () => api('resolveRole', { requestId: ev.requestId, action: 'dismiss' }).catch((e) => addSys(e.message, true));
  actions.appendChild(dismiss);
  el.appendChild(actions);
  approvals.set(ev.requestId, el);
  $('pending').appendChild(el);
  updatePending();
}

export function renderRoleRecommendation(ev) {
  const el = h('div', 'approval');
  el.dataset.title = 'Role recommendation';
  el.append(h('div', 'title', label(ev.agent) + ' recommends adding roles'));
  const fields = h('div', 'form');
  const choices = ev.roles.map(({ id, name, reason, suggestion }) => {
    const check = h('input');
    check.type = 'checkbox';
    check.checked = true;
    const row = h('label', 'check');
    const star = suggestion.model ? ' \u2605' : '';
    row.append(check, h('span', null, name + ' (' + suggestion.driverLabel + ' \u00b7 ' + suggestion.modelLabel + star + ')'));
    fields.append(row, h('div', 'hint', reason));
    return { id, check };
  });
  el.append(fields);
  const actions = h('div', 'actions');
  const add = h('button', 'primary', 'Add selected');
  const keep = h('button', '', 'Keep current team');
  async function resolve(selected) {
    add.disabled = keep.disabled = true;
    for (const choice of choices) choice.check.disabled = true;
    try {
      await api('resolveRecommendedRoles', { requestId: ev.requestId, selected });
    } catch (error) {
      addSys(error.message, true);
      add.disabled = keep.disabled = false;
      for (const choice of choices) choice.check.disabled = false;
    }
  }
  add.onclick = () => resolve(choices.filter(({ check }) => check.checked).map(({ id }) => id));
  keep.onclick = () => resolve([]);
  actions.append(add, keep);
  el.append(actions);
  approvals.set(ev.requestId, el);
  $('pending').append(el);
  updatePending();
}

export function renderApproval(ev) {
  const el = h('div', `approval drv-${driverOf(ev.agent)}`);
  el.dataset.title = ev.title;
  el.appendChild(
    h(
      'div',
      'title',
      `${ev.title} · ${time(ev.at)}${ev.expiresAt ? ` · declined automatically at ${time(ev.expiresAt)} if unanswered` : ''}`,
    ),
  );
  if (ev.warning) el.appendChild(h('div', 'warning', `⚠ ${ev.warning}`));
  const scope = ev.decisions.includes('acceptForSession') ? 'Once or for this session' : 'Once';
  el.appendChild(h('div', 'hint', label(ev.agent) + ' · ' + scope + (ev.cwd ? ' · ' + ev.cwd : '')));
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
