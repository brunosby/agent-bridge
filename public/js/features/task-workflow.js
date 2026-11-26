import { $, h } from '../core/dom.js';
import { api } from '../core/api.js';
import { approvals, cards, store } from '../core/store.js';
import { updatePending } from './approvals.js';
import { openAddDialog } from './add-agent.js';

function button(parent, title, action) {
  const el = h('button', null, title);
  el.type = 'button';
  el.onclick = action;
  parent.appendChild(el);
  return el;
}

function field(parent, title, control) {
  const label = h('label', 'workflow-field', title);
  label.appendChild(control);
  parent.appendChild(label);
  return control;
}

export function sizeBadge(node, state, editable = true) {
  const plan = state.taskPlan;
  if (!node || !plan) return;
  const head = node.querySelector('.head');
  let select = head.querySelector('.task-size');
  if (!select) {
    select = h('select', 'task-size');
    select.setAttribute('aria-label', 'Task size');
    for (const value of ['small', 'medium', 'large']) select.add(new Option(value + ' task', value));
    head.appendChild(select);
  }
  let reason = head.querySelector('.task-size-reason');
  if (!reason) {
    reason = h('span', 'task-size-reason');
    head.appendChild(reason);
  }
  reason.textContent = plan.reason;
  reason.hidden = !plan.reason;
  select.value = plan.size;
  select.title = plan.reason || 'Estimated task size';
  select.disabled = !editable || Boolean(plan.finished || state.succession);
  let retry = head.querySelector('.retry-spec');
  if (editable && plan.specNeedsRetry && !select.disabled) {
    if (!retry) {
      retry = button(head, 'Retry specification', async () => {
        retry.disabled = true;
        try {
          await api('taskDecision', { conversationId: state.conversationId, seq: plan.seq, action: 'retrySpec' });
        } catch (error) {
          head.appendChild(h('span', 'err', error.message));
          retry.disabled = false;
        }
      });
      retry.className = 'retry-spec';
    }
  } else retry?.remove();
  select.onchange = async () => {
    select.disabled = true;
    try {
      await api('taskDecision', { conversationId: state.conversationId, seq: plan.seq, action: 'size', size: select.value });
    } catch (error) {
      select.value = plan.size;
      select.title = error.message;
      head.appendChild(h('span', 'err', error.message));
    } finally {
      if (store.state?.taskPlan?.seq === plan.seq) select.disabled = Boolean(store.state.taskPlan.finished || store.state.succession);
    }
  };
}

export function renderWorkflow(state) {
  const pending = state.taskPlan?.pending;
  const successor = state.succession;
  const decisions = [...(state.earlierDecisions || []).map((p) => p.pending), pending, successor].filter(Boolean);
  for (const [id, card] of approvals) {
    if (card.dataset.workflow && !decisions.some((d) => d.id === id)) {
      card.remove();
      approvals.delete(id);
      updatePending();
    }
  }
  for (const request of decisions) {
    const succession = request === successor;
    const choicesKey = succession ? JSON.stringify([request.choices, request.waiting, request.removed]) : '';
    const existing = approvals.get(request.id);
    if (existing && existing.dataset.choices === choicesKey) continue;
    const selected = existing?.querySelector('.successor')?.value;
    const previous = existing?.querySelector('.previous-role')?.value;
    const title = succession
      ? 'Who takes over coordination?'
      : request.kind === 'spec'
        ? 'Approve specification'
        : 'Question from the coordinator';
    const card = h('section', 'approval workflow-card');
    card.dataset.workflow = 'true';
    card.dataset.choices = choicesKey;
    card.dataset.title = title;
    const body = h('div', 'body');
    const actions = h('div', 'actions');
    const error = h('div', 'err');
    error.setAttribute('role', 'alert');
    card.append(h('h3', 'title', title), body, actions, error);
    let submitting = false;
    async function send(action, values = {}) {
      if (submitting) return false;
      submitting = true;
      error.textContent = '';
      card.setAttribute('aria-busy', 'true');
      try {
        await api(succession ? 'coordinatorDecision' : 'taskDecision', {
          conversationId: state.conversationId,
          seq: state.earlierDecisions?.find((p) => p.pending.id === request.id)?.seq ?? state.taskPlan?.seq,
          requestId: request.id,
          action,
          ...values,
        });
        return true;
      } catch (e) {
        error.textContent = e.message;
        return false;
      } finally {
        submitting = false;
        card.removeAttribute('aria-busy');
      }
    }
    if (succession) {
      const candidates = field(body, 'New coordinator', h('select', 'successor'));
      for (const member of request.choices)
        candidates.add(new Option(member.name + (member.recommended ? ' (recommended)' : ''), member.id));
      const suggested = request.choices.find((m) => m.id === selected) || request.choices.find((m) => m.recommended);
      if (suggested) candidates.value = suggested.id;
      let demote;
      if (!request.removed) {
        demote = field(body, 'Former coordinator’s role', h('select', 'previous-role'));
        for (const role of store.catalog.roles.filter((r) => r.id !== 'orchestrator')) demote.add(new Option(role.name, role.id));
        demote.value = previous || 'reviewer';
      }
      button(actions, 'Transfer', () => send('transfer', { agent: candidates.value, previousRole: demote?.value })).disabled =
        !request.choices.length;
      button(actions, 'Add a coordinator', () =>
        openAddDialog({
          mode: 'customize',
          role: 'orchestrator',
          onConfirm: async (choice) => {
            if (!(await send('add', { choice, previousRole: demote?.value }))) throw Error(error.textContent);
          },
        }),
      );
      if (!request.removed) {
        button(actions, request.waiting ? 'Waiting for coordinator' : 'Wait', () => send('wait')).disabled = Boolean(request.waiting);
        button(actions, 'Change provider', async () => {
          if (await send('wait')) cards[request.agent]?.el.click();
        });
      }
    } else if (request.kind === 'spec') {
      const editors = request.docs.map((doc) => {
        const edit = field(body, doc.path, h('textarea'));
        edit.rows = 5;
        edit.value = doc.text;
        return { path: doc.path, edit };
      });
      const feedback = field(body, 'Requested changes', h('textarea'));
      feedback.rows = 2;
      button(actions, 'Approve and save', () => send('approve', { docs: editors.map(({ path, edit }) => ({ path, text: edit.value })) }));
      button(actions, 'Request changes', () => send('revise', { feedback: feedback.value }));
    } else {
      const inputs = request.questions.map((q) => {
        const group = h('fieldset');
        group.appendChild(h('legend', null, q.question));
        const input = h('textarea');
        input.rows = 2;
        for (const opt of q.options)
          button(group, opt, () => {
            input.value = opt;
            if (request.questions.length === 1) return send('answer', { answers: [opt] });
            input.focus();
          });
        if (q.recommendation) group.appendChild(h('p', null, 'Recommendation: ' + q.recommendation));
        if (q.evidence) group.appendChild(h('p', null, 'Evidence: ' + q.evidence));
        field(group, 'Your answer', input);
        body.appendChild(group);
        return input;
      });
      button(actions, 'Send answers', () => send('answer', { answers: inputs.map((el) => el.value) }));
      button(actions, 'Dismiss', () => send('dismiss'));
    }
    if (existing) existing.replaceWith(card);
    else $('pending').appendChild(card);
    approvals.set(request.id, card);
    updatePending();
  }
}
