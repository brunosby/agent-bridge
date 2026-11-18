// Cards pinned above the message box: approvals, missing roles and the final confirmation.
import { approvals, driverOf, label, store } from '../core/store.js';
import { $, append, h, renderMarkdown, time } from '../core/dom.js';
import { api } from '../core/api.js';
import { addSys } from './conversation-log.js';
/** Pending approvals stay pinned above the message box until answered. */
export function updatePending() {
  const n = approvals.size;
  $('pending').hidden = n === 0;
  const base = store.state ? `Agent Bridge · ${store.state.workDir}` : 'Agent Bridge';
  document.title = n ? `(${n}) Approval needed · ${base}` : base;
}

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
  append(h('div', 'sys', `⏸ ${label(ev.agent)} asked for a ${ev.roleName}: choose below.`));
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
  if (ev.detail) el.appendChild(h('pre', null, ev.detail));
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
  append(h('div', `tool drv-${driverOf(ev.agent)}`, `⏸ ${ev.title}: waiting for your approval (see below)`));
  updatePending();
}
