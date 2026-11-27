import type { Conversation, TaskPlan, QuestionDelegation, QuestionTarget } from '../core/types.ts';
import { publish, recordWorkflow } from './events.ts';
import { originPlan, register } from './request-progress.ts';
import { S } from './state.ts';

export function targetReport(target: QuestionTarget) {
  const status = {
    pending: 'not sent',
    preparing: 'preparing delivery',
    submitted: 'sent; awaiting provider confirmation',
    received: 'received',
    unconfirmed: 'delivery unconfirmed; check before resending',
  };
  return '@' + target.agent + ' — ' + status[target.state] + (target.reason ? ' (' + target.reason + ')' : '');
}

export function setTarget(
  owner: Conversation,
  plan: TaskPlan,
  record: QuestionDelegation,
  target: QuestionTarget,
  state: QuestionTarget['state'],
  reason?: string,
) {
  if (owner !== S.conv || plan.pending?.kind !== 'question' || plan.pending.delegation !== record) return false;
  if (target.state !== state || target.reason !== reason) {
    target.state = state;
    target.reason = reason;
    publish({ kind: 'system', requestSeq: plan.seq, text: targetReport(target) });
    recordWorkflow(owner, plan);
  }
  return true;
}

export function questionReceipt(owner: Conversation, taskId: string, state: 'received' | 'unconfirmed') {
  const task = owner.tasks.get(taskId);
  if (!task?.requestSeq) return;
  const plan = originPlan(owner, task.requestSeq);
  const record = plan?.pending?.kind === 'question' && plan.pending.delegation;
  if (!record || !plan) return;
  const target = record.targets.find((t) => t.taskId === taskId && t.state === 'submitted');
  if (target) setTarget(owner, plan, record, target, state);
}

export function discardQuestionDelegations(owner: Conversation, reason: string) {
  const plans = new Set([owner.plan, ...[...register(owner).values()].map((row) => row.plan)]);
  for (const plan of plans) {
    if (!plan) continue;
    let changed = false;
    for (const decision of [plan.pending, ...(plan.queuedDecisions || [])]) {
      if (decision?.kind !== 'question' || !decision.delegation) continue;
      const pending = decision.delegation.targets.filter((t) => t.state === 'pending' || t.state === 'preparing');
      if (pending.length)
        publish({
          kind: 'system',
          text: 'Discarded pending question delegations to ' + pending.map((t) => '@' + t.agent).join(', ') + '. ' + reason,
        });
      delete decision.delegation;
      changed = true;
    }
    if (changed) recordWorkflow(owner, plan);
  }
}

export function restoreQuestionDelegations(plan?: TaskPlan) {
  if (!plan) return;
  for (const decision of [plan.pending, ...(plan.queuedDecisions || [])]) {
    if (decision?.kind !== 'question') continue;
    for (const target of decision.delegation?.targets || []) {
      if (target.state === 'preparing') {
        target.state = 'pending';
        target.reason = 'preparation interrupted by restore';
      }
      if (target.state === 'submitted') target.state = 'unconfirmed';
    }
  }
}
