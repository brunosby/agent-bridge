import type { Conversation, DeliveryBatch } from '../core/types.ts';
import { randomUUID } from 'node:crypto';

export function addBatchPart(owner: Conversation, agent: string): string | undefined {
  const batch = (owner.batch ??= { pending: new Map(), results: [] });
  if (batch.pending.has(agent)) return;
  const taskId = randomUUID();
  batch.pending.set(agent, taskId);
  return taskId;
}

export function finishBatchPart(
  owner: Conversation,
  agent: string,
  taskId: string,
  text?: string,
  sourceSeq?: number,
  shortText?: string,
): DeliveryBatch | undefined {
  const batch = owner.batch;
  if (!batch || batch.pending.get(agent) !== taskId) return;
  batch.pending.delete(agent);
  if (text !== undefined) batch.results.push({ from: agent, text, sourceSeq, shortText });
  if (!batch.pending.size) owner.batch = null;
  return batch;
}
