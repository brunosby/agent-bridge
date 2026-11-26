import { originPlan, register } from './request-progress.ts';
import { randomUUID } from 'node:crypto';
import { canReceiveWork } from '../core/agent-status.ts';
import type { Conversation, AgentSpec, Size, SpecAttempt, TaskDecision, TaskPlan } from '../core/types.ts';
import { relay, S } from './state.ts';
import { publish, recordWorkflow } from './events.ts';
import { deliver } from './delivery.ts';
import { relayOrHold, drainHeld, offerRecommendedRoles, orchestratorId } from './routing.ts';
import { addAgent, setRole, statusFor, validateAgentChoice } from './team.ts';
import { buildProviderHandoff } from './provider-handoff.ts';
import { captureTaskBaseline, growth, question, saveSpecification, specification } from './task-plan.ts';
import { isRecommended } from '../core/roles.ts';

export { recordWorkflow } from './events.ts';

function openDecision(owner: Conversation, decision: TaskDecision, plan = owner.plan!) {
  plan.pending = decision;
  publish({ kind: 'workflowRequest', requestId: decision.id, agent: decision.agent, decision });
}

export function closeDecision(owner: Conversation, action: string, advance = false, plan = owner.plan) {
  if (!plan?.pending) return;
  publish({ kind: 'workflowClosed', requestId: plan.pending.id, action });
  delete plan.pending;
  if (advance) {
    const next = plan.queuedDecisions?.shift();
    if (next) openDecision(owner, next, plan);
  } else delete plan.queuedDecisions;
  recordWorkflow(owner, plan);
}

export function requestSpec(owner: Conversation, lead: string, plan = owner.plan, preferredArchitect?: string) {
  if (!plan || plan.finished || plan.approved || plan.pending?.kind === 'spec' || plan.queuedDecisions?.some((d) => d.kind === 'spec'))
    return;
  if (owner.heldRelays.some((item) => item.kind === 'spec' && item.requestSeq === plan.seq)) return;
  const available = owner.team.filter((member) => member.role === 'architect' && canReceiveWork(statusFor(owner, member.id)));
  const architect = available.find((member) => member.id === preferredArchitect) ?? available[0];
  if (!relay.auto) {
    if (plan.specNeedsRetry || plan.specRequestedFrom) return;
    plan.specNeedsRetry = 'manual';
    plan.specRequestedFrom = architect?.id;
    publish({
      kind: 'system',
      text:
        'Manual mode: the specification request was not sent. ' +
        (architect ? '' : 'Add an available Architect first. ') +
        'Choose Request specification on the original task to send it.',
    });
    recordWorkflow(owner, plan);
    return;
  }
  if (architect) {
    if (plan.specRequestedFrom === architect.id && plan.specNeedsRetry !== 'manual') return;
    relayOrHold(owner, {
      kind: 'spec',
      from: lead,
      targets: [architect.id],
      requestSeq: plan.seq,
      sourceSeq: plan.seq,
      parts: [
        {
          from: lead,
          text: register(owner).get(plan.seq)?.original ?? owner.lastUserText ?? 'Draft the specification for the current task.',
        },
      ],
    });
    return true;
  } else if (!offerRecommendedRoles(owner, lead, [{ id: 'architect', reason: 'Prepare the specification for approval before coding.' }])) {
    publish({ kind: 'system', text: 'An available Architect is needed for the specification. Add one or change the task size.' });
  }
}

// If final review already collected the initial Git state, no extra process is needed.
const capturingBaseline = new WeakSet<TaskPlan>();
export function preparingSmallBaseline(owner: Conversation): boolean {
  const plan = owner.plan;
  if (plan?.size !== 'small' || !plan.baselineDeferred || plan.finished) return false;
  if (!capturingBaseline.has(plan)) {
    capturingBaseline.add(plan);
    void captureTaskBaseline(owner)
      .then((baseline) => {
        if (owner !== S.conv || owner.plan !== plan) return;
        plan.baseline = baseline;
        delete plan.baselineDeferred;
        recordWorkflow(owner, plan);
        drainHeld(owner);
      })
      .finally(() => capturingBaseline.delete(plan));
  }
  return true;
}
export function classify(owner: Conversation, size: Size, reason: string, manual: boolean, plan = owner.plan) {
  if (!plan || (!manual && plan.manual)) return;
  if (size !== 'large') {
    delete plan.specRequestedFrom;
    delete plan.specNeedsRetry;
    delete plan.awaitingSpecRevision;
    plan.queuedDecisions = plan.queuedDecisions?.filter((d) => d.kind !== 'spec');
    if (plan.pending?.kind === 'spec') closeDecision(owner, 'size changed', true, plan);
  }
  plan.size = size;
  plan.reason = reason.slice(0, 320);
  plan.classified = true;
  plan.manual = manual;
  recordWorkflow(owner, plan);
  preparingSmallBaseline(owner);
}

export async function checkGrowth(owner: Conversation) {
  const p = owner.plan;
  if (!p || p.size !== 'small' || p.warned || p.baselineDeferred || p.finished) return;
  const reason = await growth(p);
  if (!reason || S.conv !== owner || owner.plan !== p || p.size !== 'small' || p.warned || p.finished) return;
  p.warned = true;
  const lead = orchestratorId();
  const text = 'The small task now spans ' + reason + '. Reassess its size.';
  publish({ kind: 'system', text });
  if (lead) owner.pendingRoleNote[lead] = [owner.pendingRoleNote[lead], text].filter(Boolean).join('\n');
  recordWorkflow(owner, p);
}

export function readTaskBlocks(
  owner: Conversation,
  agent: string,
  blocks: { kind: string; size?: string; value: string }[],
  hasAction: boolean,
  specAttempt?: SpecAttempt,
  p = owner.plan,
) {
  if (!p || owner.routingMode !== 'orchestrator') return false;
  const role = owner.team.find((a) => a.id === agent)?.role;
  let handled = false;
  let invalidSpec = false;
  let receivedSpec = false;
  for (const block of blocks) {
    if (block.kind === 'SIZE' && agent === orchestratorId()) {
      classify(owner, block.size as Size, block.value, false, p);
    } else if (
      (block.kind === 'QUESTION' && agent === orchestratorId()) ||
      (block.kind === 'SPEC' && role === 'architect' && p.size === 'large')
    ) {
      handled = true;
      try {
        const decision = block.kind === 'SPEC' ? specification(agent, block.value) : question(agent, block.value);
        if (decision.kind === 'spec') {
          receivedSpec = true;
          delete p.specNeedsRetry;
        }
        if (p.pending) {
          (p.queuedDecisions ??= []).push(decision);
          publish({
            kind: 'system',
            agent,
            text:
              'A ' + (decision.kind === 'spec' ? 'specification' : 'question') + ' was queued. It will open after the current decision.',
          });
        } else openDecision(owner, decision, p);
        recordWorkflow(owner, p);
      } catch (error) {
        publish({ kind: 'error', agent, text: 'Invalid decision block: ' + String(error) });
        if (block.kind === 'SPEC') {
          invalidSpec = true;
          continue;
        }
        if (p.correctionRequested) continue;
        p.correctionRequested = true;
        recordWorkflow(owner, p);
        deliver(agent, 'Correct your ' + block.kind + ' block: ' + String(error), { from: 'user', sourceSeq: p.seq });
      }
    }
  }
  if (
    role === 'architect' &&
    p.size === 'large' &&
    (specAttempt || invalidSpec) &&
    !receivedSpec &&
    (!p.approved || p.awaitingSpecRevision) &&
    p.pending?.kind !== 'spec' &&
    !p.queuedDecisions?.some((d) => d.kind === 'spec')
  ) {
    if (specAttempt === 'correction') {
      p.specRequestedFrom = agent;
      p.specNeedsRetry = true;
      recordWorkflow(owner, p);
      publish({
        kind: 'error',
        agent,
        text: 'The Architect returned no valid specification after one correction. Use Retry specification on the original task to continue.',
      });
    } else if (!p.specNeedsRetry) {
      publish({ kind: 'system', agent, text: 'No valid specification received. Asked the Architect to correct the format.' });
      deliver(
        agent,
        'Resubmit the specification as a JSON array of documents with path and text. Include a docs/spec/<name>.md document. Put [[SPEC]] and [[/SPEC]] on separate lines around the array.',
        { from: 'user', sourceSeq: p.seq, specAttempt: 'correction' },
      );
    }
    return true;
  }
  if (handled) return true;
  if (blocks.some((b) => b.kind === 'SIZE') && !hasAction && agent === orchestratorId()) {
    if (!p.nudged) {
      p.nudged = true;
      recordWorkflow(owner, p);
      deliver(agent, 'Size recorded. Take the first action for this task now.', { from: 'user', sourceSeq: p.seq });
    } else
      publish({
        kind: 'system',
        agent,
        text: 'The coordinator reported the task size again without taking action. Send it the next instruction or change the task size.',
      });
    return true;
  }
  return false;
}

export function resolveTask(owner: Conversation, body: Record<string, any>) {
  const plan = originPlan(owner, body.seq);
  if (!plan || owner.id !== body.conversationId || body.seq !== plan.seq) throw new Error('This task is no longer current.');
  if (plan !== owner.plan && !plan.pending && !plan.specNeedsRetry) throw new Error('This task is no longer current.');
  const lead = orchestratorId();
  if (!lead || owner.succession) throw new Error('Choose the coordinator first.');
  if (plan.finished) throw new Error('This task is finished.');
  if (body.action === 'size') {
    if (!['small', 'medium', 'large'].includes(body.size)) throw new Error('Unknown task size.');
    classify(owner, body.size, 'Selected by you', true, plan);
    deliver(lead, 'The user selected task size ' + body.size + '. Continue the current task accordingly.', {
      from: 'user',
      sourceSeq: plan.seq,
    });
    drainHeld(owner);
    return;
  }
  if (body.action === 'retrySpec') {
    if (!plan.specNeedsRetry || plan.size !== 'large') throw new Error('No specification is waiting for a retry.');
    const architect =
      owner.team.find(
        (member) => member.role === 'architect' && member.id === plan.specRequestedFrom && canReceiveWork(statusFor(owner, member.id)),
      ) ?? owner.team.find((member) => member.role === 'architect' && canReceiveWork(statusFor(owner, member.id)));
    if (!architect) throw new Error('An available Architect is needed to request a specification.');
    const firstDraft = plan.specNeedsRetry === 'manual';
    delete plan.specNeedsRetry;
    plan.specRequestedFrom = architect.id;
    recordWorkflow(owner, plan);
    deliver(
      architect.id,
      (firstDraft ? 'Draft' : 'Retry') +
        ' the specification for this task using [[SPEC]] and [[/SPEC]]:\n' +
        (register(owner).get(plan.seq)?.original ?? owner.lastUserText),
      {
        from: 'user',
        sourceSeq: plan.seq,
        specAttempt: 'draft',
      },
    );
    return;
  }
  if (!canReceiveWork(statusFor(owner, lead))) throw new Error('The coordinator is unavailable.');
  const pending = plan.pending;
  if (!pending || pending.id !== body.requestId) throw new Error('This request is no longer open.');
  let recipient = lead;
  let message = '';
  if (body.action === 'dismiss') {
    message = 'The user dismissed the question. Continue with the available evidence.';
    if (pending.kind === 'spec') throw new Error('Request changes or change the task size.');
  } else if (pending.kind === 'spec' && body.action === 'revise') {
    if (!body.feedback?.trim()) throw new Error('Describe the changes requested.');
    recipient = pending.agent;
    if (!canReceiveWork(statusFor(owner, recipient))) throw new Error('The Architect is unavailable.');
    plan.awaitingSpecRevision = true;
    message = 'Revise the proposed specification: ' + body.feedback;
  } else if (pending.kind === 'spec' && body.action === 'approve') {
    const saved = saveSpecification(owner.workDir, pending.docs, body.docs);
    delete plan.awaitingSpecRevision;
    plan.approved = [...new Set([...(plan.approved ?? []), ...saved])];
    message = 'Specification approved and saved: ' + plan.approved.join(', ') + '. Delegate implementation against this version.';
  } else if (pending.kind === 'question' && body.action === 'answer') {
    if (
      !Array.isArray(body.answers) ||
      body.answers.length !== pending.questions.length ||
      body.answers.some((s: unknown) => typeof s !== 'string' || !s.trim())
    )
      throw new Error('Answer each question.');
    message = pending.questions.map((q, i) => '[Answer to question ' + (i + 1) + '] ' + q.question + '\n' + body.answers[i]).join('\n\n');
  } else throw new Error('Invalid decision.');
  if (!owner.agents[recipient]) throw new Error('The intended recipient is unavailable.');
  closeDecision(owner, body.action, true, plan);
  publish({ kind: 'system', text: message });
  deliver(recipient, message, { from: 'user', sourceSeq: plan.seq, specAttempt: body.action === 'revise' ? 'draft' : undefined });
  drainHeld(owner);
}

const watching = new WeakMap<Conversation, NodeJS.Timeout>();
const transferring = new WeakSet<Conversation>();
export function stopWatching(owner: Conversation) {
  clearTimeout(watching.get(owner));
  watching.delete(owner);
}

export function watchCoordinator(owner: Conversation) {
  if (S.conv !== owner) return;
  const lead = owner.team.find((m) => m.role === 'orchestrator');
  if (
    owner.succession?.waiting &&
    lead?.id === owner.succession.agent &&
    canReceiveWork(statusFor(owner, lead.id)) &&
    !transferring.has(owner)
  ) {
    void resolveSuccession(owner, { action: 'wait', requestId: owner.succession.id, conversationId: owner.id }).catch((error) =>
      publish({ kind: 'error', text: String(error) }),
    );
    return;
  }
  if (
    !lead ||
    !owner.plan ||
    owner.plan.finished ||
    owner.routingMode !== 'orchestrator' ||
    owner.succession ||
    canReceiveWork(statusFor(owner, lead.id))
  ) {
    stopWatching(owner);
    return;
  }
  if (!watching.has(owner)) {
    const timer = setTimeout(() => {
      stopWatching(owner);
      if (S.conv === owner && owner.plan && !owner.plan.finished && owner.team.includes(lead) && !canReceiveWork(statusFor(owner, lead.id)))
        offerSuccession(owner, lead, false);
    }, 180000);
    timer.unref();
    watching.set(owner, timer);
  }
}

export function offerSuccession(owner: Conversation, old: AgentSpec, removed: boolean, summary?: string) {
  if (owner.routingMode !== 'orchestrator' || old.role !== 'orchestrator') return;
  stopWatching(owner);
  if (owner.succession) {
    if (removed && owner.succession.agent === old.id) {
      owner.succession.removed = true;
      recordWorkflow(owner);
    }
    return;
  }
  const decision = {
    id: randomUUID(),
    agent: old.id,
    removed,
    summary: summary ?? buildProviderHandoff(owner, old, S.roles.orchestrator, S.history),
  };
  owner.succession = decision;
  publish({ kind: 'workflowRequest', agent: old.id, requestId: decision.id, decision: { kind: 'succession', ...decision } });
  recordWorkflow(owner);
}

export async function resolveSuccession(owner: Conversation, body: Record<string, any>) {
  const request = owner.succession;
  if (!request || request.id !== body.requestId || body.conversationId !== owner.id || transferring.has(owner))
    throw new Error('This transfer is no longer available.');
  const old = owner.team.find((m) => m.id === request.agent);
  if (body.action === 'wait' && !request.removed) {
    if (!old || !canReceiveWork(statusFor(owner, old.id))) {
      publish({ kind: 'info', text: 'Waiting for the current coordinator to become available.' });
      request.waiting = true;
      recordWorkflow(owner);
      return;
    }
  }
  transferring.add(owner);
  try {
    let next = old;
    if (body.action === 'transfer' || body.action === 'add') {
      const previousRole = body.previousRole || 'reviewer';
      if (!Object.hasOwn(S.roles, previousRole) || previousRole === 'orchestrator')
        throw new Error('Choose another role for the former coordinator.');
      next =
        body.action === 'add'
          ? await addAgent(await validateAgentChoice(owner, { ...body.choice, role: previousRole }), true)
          : owner.team.find((m) => m.id === body.agent);
      if (
        owner !== S.conv ||
        owner.succession !== request ||
        !next ||
        next === old ||
        !canReceiveWork(statusFor(owner, next.id)) ||
        owner.agents[next.id].busy ||
        owner.batch?.pending.has(next.id)
      )
        throw new Error('Choose a ready, idle agent.');
      const fromRole = next.role;
      try {
        if (old) await setRole(old.id, previousRole);
        if (owner !== S.conv || owner.succession !== request) throw new Error('Conversation changed.');
        await setRole(next.id, 'orchestrator');
      } catch (error) {
        if (owner === S.conv) {
          if (next.role === 'orchestrator') await setRole(next.id, fromRole);
          if (old && old.role !== 'orchestrator') await setRole(old.id, 'orchestrator');
        }
        throw error;
      }
    } else if (body.action !== 'wait' || !old || !canReceiveWork(statusFor(owner, old.id))) throw new Error('Coordinator unavailable.');
    if (owner !== S.conv || owner.succession !== request || !next) throw new Error('Conversation changed.');
    for (const item of owner.heldRelays) item.targets = item.targets.map((id) => (id === request.agent ? next!.id : id));
    delete owner.succession;
    publish({ kind: 'workflowClosed', requestId: request.id, action: 'resolved' });
    recordWorkflow(owner);
    if (next !== old) deliver(next.id, request.summary, { from: 'user', sourceSeq: owner.plan?.seq });
    drainHeld(owner);
  } finally {
    transferring.delete(owner);
  }
}

export function successorChoices(owner: Conversation) {
  return owner.team
    .filter(
      (a) =>
        a.id !== owner.succession?.agent &&
        canReceiveWork(statusFor(owner, a.id)) &&
        !owner.agents[a.id].busy &&
        !owner.batch?.pending.has(a.id),
    )
    .map((a) => ({
      id: a.id,
      name: a.name,
      recommended: isRecommended(S.roles.orchestrator, { value: owner.agents[a.id].model || owner.agents[a.id].resolvedModel || '' }),
    }));
}
