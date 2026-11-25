import { gitAction } from '../core/safety.ts';
import type { Agent, AgentEvent } from '../core/types.ts';
import type { ShellCommand } from '../core/read-only-shell.ts';
import { scanPublication } from '../workspace/publication-scope.ts';
import { type Scan } from '../workspace/publication-scan.ts';
import { allowFinding, exceptionReason, signingKey } from '../workspace/publication-store.ts';

type Review = { cwd: string; shell: ShellCommand | null; scan?: Scan; event: AgentEvent };
const requests = new WeakMap<Agent, Map<string, Review>>();
function removeInactive(agent: Agent) {
  const map = requests.get(agent);
  if (map) for (const id of map.keys()) if (!agent.approvals.has(id)) map.delete(id);
}
export async function reviewPublication(agent: Agent, event: AgentEvent, directory: string, reason: unknown) {
  removeInactive(agent);
  if (!event.commandApproval) return false;
  const text = String(event.shellCommand?.text || event.matchText || '');
  if (!/\b(?:git|push|pr)\b/i.test(text)) return false;
  const cwd = event.cwd || agent.cwd || directory;
  const risk = reason === 'destructive push' ? reason : await gitAction(text, cwd, true).catch(() => 'publication alias');
  if (!(
    risk === 'publication alias' ||
    /\bgh(?:\.exe)?\s+(?:[^;&|\n]*?\s+)?pr\s+create\b/i.test(text) ||
    (/\bpush\b/i.test(text) && (risk === 'external action' || risk === 'destructive push'))
  ))
    return false;
  let map = requests.get(agent);
  if (!map) requests.set(agent, (map = new Map()));
  const review: Review = {
    cwd,
    shell:
      event.shellCommand || (event.commandProvided === true ? { text, shell: process.platform === 'win32' ? 'powershell' : 'bash' } : null),
    event,
  };
  map.set(event.requestId, review);
  await refresh(review);
  return true;
}
async function refresh(review: Review) {
  try {
    if (!review.shell) throw new Error('Submit the full publication command for review.');
    review.scan = await scanPublication(review.cwd, review.shell, signingKey());
    const applied = [];
    const findings = [];
    for (const finding of review.scan.findings) {
      const reason = exceptionReason(finding.id);
      if (reason) applied.push({ ...finding, reason });
      else findings.push(finding);
    }
    review.event.appliedExceptions = applied;
    review.event.findings = findings;
    review.event.decisions = findings.length ? ['decline'] : ['accept', 'decline'];
    review.event.warning =
      'Publication check: ' +
      review.scan.commits +
      ' commit(s) examined.' +
      (review.scan.remoteRefLimit ? ' The remote has too many refs to compare. The full outgoing history was examined.' : '') +
      (findings.length
        ? ' Resolve the findings or confirm individual exceptions. Removing a secret in a later commit keeps it in history. Rotate exposed credentials and clean the affected commits. A provider that supplied a credential in the command already saw it.'
        : '') +
      (review.scan.unexamined.length ? ' Binary/LFS files not examined: ' + review.scan.unexamined.join(', ') : '');
    review.event.publicationScope = review.scan.scope;
    if (review.shell.text.includes('pr create') && !review.scan.commits) review.event.warning += ' The branch may already be public.';
  } catch (error) {
    review.scan = undefined;
    review.event.decisions = ['decline'];
    review.event.findings = [];
    delete review.event.appliedExceptions;
    delete review.event.publicationScope;
    review.event.warning =
      'Publication pending. ' +
      (error instanceof Error &&
      /^(Use |Provide |Submit |Unknown push|Full commit|Git could|Too many|Scan limit|Invalid project)/.test(error.message)
        ? error.message
        : 'Could not verify the entire publication. Submit the operation separately and retry.');
  }
}
export function forgetReview(agent: Agent, id: string) {
  requests.get(agent)?.delete(id);
}

export async function verifyDecision(agent: Agent, id: string, decision: string, updated: (ev: AgentEvent) => void) {
  const review = requests.get(agent)?.get(id);
  if (!review || decision === 'decline') return;
  const displayedExceptions = JSON.stringify(review.event.appliedExceptions);
  const previous = review.scan?.signature;
  await refresh(review);
  if (!agent.approvals.has(id)) throw new Error('Request closed during verification.');
  if (
    decision !== 'accept' ||
    !previous ||
    review.scan?.signature !== previous ||
    displayedExceptions !== JSON.stringify(review.event.appliedExceptions) ||
    !review.event.decisions.includes('accept')
  ) {
    updated(review.event);
    throw new Error('Publication changed or is blocked. Review the updated card.');
  }
}
export async function confirmException(agent: Agent, id: string, findingId: string, reason: string, updated: (ev: AgentEvent) => void) {
  const review = requests.get(agent)?.get(id);
  if (!review || !agent.approvals.has(id)) throw new Error('Request closed.');
  const previous = review.scan?.signature;
  await refresh(review);
  const finding = review.scan?.findings.find((f) => f.id === findingId);
  if (!previous || previous !== review.scan?.signature || !finding || !agent.approvals.has(id))
    throw new Error('Finding changed. Review the publication again.');
  allowFinding(findingId, reason);
  await refresh(review);
  if (agent.approvals.has(id)) updated(review.event);
  return finding;
}
