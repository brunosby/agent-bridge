import { randomUUID } from 'node:crypto';
import type { Conversation } from '../core/types.ts';
import { DONE_MARKER, S } from './state.ts';
import { publish, publishState } from './events.ts';
import { summarizeProject } from './project.ts';

export function publishFinalReview(owner: Conversation, agent: string, text: string) {
  if (S.conv !== owner) return;
  const requestId = 'final-' + randomUUID();
  owner.pendingFinal = requestId;
  publish({
    kind: 'finalReview',
    agent,
    requestId,
    summary: text.replace(DONE_MARKER, '').trim(),
    project: summarizeProject(owner),
    tests: [...owner.testResults],
  });
  publishState();
}
