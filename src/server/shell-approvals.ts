import { inspectShell, type ShellCommand } from '../core/read-only-shell.ts';
import type { Agent, AgentEvent, Conversation, Decision } from '../core/types.ts';
import { setting } from '../config/settings.ts';

type Pending = { agent: string; sessionKey?: string; guardedText?: string };
type ShellApprovals = { pending: Map<string, Pending>; permitted: Map<string, Set<string>> };
const sessions = new WeakMap<Conversation, ShellApprovals>();

function approvals(owner: Conversation): ShellApprovals {
  let session = sessions.get(owner);
  if (!session) {
    session = { pending: new Map(), permitted: new Map() };
    sessions.set(owner, session);
  }
  return session;
}

function approveCurrentShell(agent: Agent, requestId: string, guardedText?: string): boolean {
  return guardedText ? Boolean(agent.approveShellCommand?.(requestId, guardedText)) : agent.respondApproval(requestId, 'accept');
}

export function processShellApproval(owner: Conversation, agent: Agent, event: AgentEvent, blocked: boolean): string | undefined {
  if (!event.commandApproval) return;
  const session = approvals(owner);
  const inspected =
    !blocked && event.shellCommand
      ? inspectShell(event.shellCommand as ShellCommand, agent.cwd || owner.workDir, event.cwd)
      : { readOnly: false };
  const guardedText = inspected.guardedText;
  const supported = !guardedText || Boolean(agent.approveShellCommand);
  const key = supported ? inspected.sessionKey : undefined;
  if (supported && setting('autoApproveReadOnly') && inspected.readOnly && approveCurrentShell(agent, event.requestId, guardedText))
    return 'Read-only command';
  if (key && session.permitted.get(agent.id)?.has(key) && approveCurrentShell(agent, event.requestId, guardedText))
    return 'Approved earlier in this conversation';
  session.pending.set(event.requestId, { agent: agent.id, sessionKey: key, guardedText });
  event.decisions = key ? ['accept', 'acceptForSession', 'decline'] : ['accept', 'decline'];
}

export function closeShellApproval(owner: Conversation, requestId: string): void {
  sessions.get(owner)?.pending.delete(requestId);
}

export function answerApproval(owner: Conversation, agent: Agent, requestId: string, decision: Decision): boolean {
  const session = sessions.get(owner);
  const command = session?.pending.get(requestId);
  if (!command || command.agent !== agent.id) return agent.respondApproval(requestId, decision);
  if (decision === 'acceptForSession' && !command.sessionKey) throw new Error('This command can only be approved once.');
  // Keep the permission here so the provider asks again and Bridge can revalidate it.
  const result =
    decision === 'acceptForSession'
      ? approveCurrentShell(agent, requestId, command.guardedText)
      : agent.respondApproval(requestId, decision);
  if (result && decision === 'acceptForSession' && command.sessionKey && session) {
    let permitted = session.permitted.get(agent.id);
    if (!permitted) session.permitted.set(agent.id, (permitted = new Set()));
    permitted.add(command.sessionKey);
  }
  closeShellApproval(owner, requestId);
  return result;
}
