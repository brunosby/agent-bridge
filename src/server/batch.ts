import type { Conversation, DeliveryBatch } from '../core/types.ts';
import { randomUUID } from 'node:crypto';

export function addBatchPart(owner: Conversation, agent: string, updateOf?: string, requestSeq?: number): string | undefined {
  const part = owner.batch?.pending.get(agent);
  if (part?.id !== updateOf) return;
  const batch = (owner.batch ??= { pending: new Map(), results: [] });
  const taskId = randomUUID();
  if (part) part.tasks.set(taskId, part.next++);
  else batch.pending.set(agent, { id: taskId, tasks: new Map([[taskId, 0]]), next: 1, resultOrder: -1, requestSeq });

  return taskId;
}

export function finishBatchPart(
  owner: Conversation,
  agent: string,
  taskId: string,
  text?: string,
  sourceSeq?: number,
  shortText?: string,
  requestSeq?: number,
): DeliveryBatch | undefined {
  const batch = owner.batch;
  const part = batch?.pending.get(agent);
  const position = part?.tasks.get(taskId);
  if (!batch || !part || position === undefined) return;
  part.tasks.delete(taskId);
  if (text !== undefined && position >= part.resultOrder) {
    part.resultOrder = position;
    part.result = { from: agent, text, sourceSeq, shortText, requestSeq: part.requestSeq ?? requestSeq };
  }
  if (part.tasks.size) return;
  batch.pending.delete(agent);
  if (part.result) batch.results.push(part.result);
  if (!batch.pending.size) owner.batch = null;
  return batch;
}
