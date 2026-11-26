import type { BridgeEvent, Conversation } from '../core/types.ts';
import { commandLabel, describeActivity } from '../core/activity-description.ts';

export interface TaskActivity {
  id: string;
  agent: string;
  now?: { text: string; at: number };
  workingSince?: number;
  actions?: number;
  files?: number;
}
type Stamp = NonNullable<TaskActivity['now']>;
type Batch = {
  tasks: Set<TaskActivity>;
  edits: Map<string, { files: string[]; tasks: TaskActivity[] }>;
  approvals: Map<string, Stamp>;
  last?: Stamp;
  wrote: boolean;
};
const batches = new WeakMap<Conversation, Map<string, Batch>>();
const editedFiles = new WeakMap<TaskActivity, Set<string>>();
const waitingAgents = new WeakMap<Conversation, Map<string, string>>();
export function startActivity(owner: Conversation, task: TaskActivity, at: number) {
  let agents = batches.get(owner);
  if (!agents) batches.set(owner, (agents = new Map()));
  let batch = agents.get(task.agent);
  if (!batch) agents.set(task.agent, (batch = { tasks: new Set(), edits: new Map(), approvals: new Map(), wrote: false }));
  if (batch.tasks.has(task)) return;
  task.workingSince = at;
  task.actions = 0;
  task.files = 0;
  batch.tasks.add(task);
}
export function endActivity(owner: Conversation, task: TaskActivity) {
  const agents = batches.get(owner);
  const batch = agents?.get(task.agent);
  if (!batch || !batch.tasks.delete(task)) return;
  if (batch.approvals.size) task.now = batch.last;
  if (!batch.tasks.size) {
    for (const key of batch.approvals.keys()) waitingAgents.get(owner)?.delete(key);
    agents?.delete(task.agent);
  }
}
export function recordActivity(owner: Conversation, e: BridgeEvent): string | undefined {
  const agent = e.agent || (e.kind === 'approvalClosed' && waitingAgents.get(owner)?.get(e.requestId));
  const batch = batches.get(owner)?.get(agent);
  if (!batch) return;
  const at = e.at ?? Date.now();
  if (e.kind === 'tool') {
    const folder = owner.agents[agent]?.cwd || owner.workDir || '';
    const result = describeActivity(String(e.title || 'tool'), String(e.detail || ''), folder);
    batch.last = { text: result.text, at };
    for (const t of batch.tasks) t.actions = (t.actions || 0) + 1;
    if (e.key && result.files.length) batch.edits.set(e.key, { files: result.files, tasks: [...batch.tasks] });
  } else if (e.kind === 'toolResult') {
    const edit = batch.edits.get(e.key);
    if (!edit) return;
    batch.edits.delete(e.key);
    if (e.ok !== true) return;
    for (const task of edit.tasks) {
      let files = editedFiles.get(task);
      if (!files) editedFiles.set(task, (files = new Set()));
      for (const file of edit.files) if (files.size < 50) files.add(process.platform === 'win32' ? file.toLowerCase() : file);
      task.files = files.size;
    }
  } else if (e.kind === 'delta') {
    if (batch.wrote) return;
    batch.wrote = true;
    batch.last = { text: 'Writing the reply', at };
  } else if (e.kind === 'approval') {
    const cmd = e.shellCommand?.text;
    const label = typeof cmd === 'string' ? commandLabel(cmd).replace(/^Running /, '') : '';
    batch.approvals.set(e.requestId, { text: ('Waiting for your approval' + (label ? ': ' + label : '')).slice(0, 60), at });
    let index = waitingAgents.get(owner);
    if (!index) waitingAgents.set(owner, (index = new Map()));
    index.set(e.requestId, agent);
  } else if (e.kind === 'approvalClosed') {
    if (!batch.approvals.delete(e.requestId)) return;
    waitingAgents.get(owner)?.delete(e.requestId);
  } else if (e.kind === 'info' && e.text?.startsWith('No provider activity for two minutes.'))
    batch.last = { text: 'No activity for 2 min', at };
  else return;
  const now = batch.approvals.values().next().value || batch.last;
  for (const task of batch.tasks) {
    task.now = now;
    const active = owner.tasks.get(task.id);
    if (active) active.activity = now?.text;
  }
  return agent;
}

// Coalesce changes to the visible action or counter text. Identical summaries need no broadcast.
export function activityPublisher(send: (owner: Conversation, event: BridgeEvent) => void) {
  const channels = new WeakMap<Conversation, Map<string, { sent: number; signature: string; timer?: NodeJS.Timeout }>>();
  return (owner: Conversation, agent: string) => {
    let slots = channels.get(owner);
    if (!slots) channels.set(owner, (slots = new Map()));
    let slot = slots.get(agent);
    if (!slot) slots.set(agent, (slot = { sent: -Infinity, signature: '' }));
    if (slot.timer) return;
    const channel = slot;
    const flush = () => {
      channel.timer = undefined;
      const batch = batches.get(owner)?.get(agent);
      if (!batch?.tasks.size) return;
      const updates = [...batch.tasks].map(({ id, now, actions, files }) => ({ id, now, actions, files }));
      const signature = JSON.stringify(updates.map((t) => [t.id, t.now?.text, t.actions, t.files]));
      if (signature === channel.signature) return;
      channel.signature = signature;
      channel.sent = Date.now();
      const first = updates[0];
      send(owner, {
        kind: 'activity',
        conversationId: owner.id,
        agent,
        taskIds: updates.map((t) => t.id),
        text: first.now?.text || '',
        at: first.now?.at ?? channel.sent,
        actions: first.actions,
        files: first.files,
        updates,
      });
    };
    const wait = 1000 - (Date.now() - channel.sent);
    if (wait <= 0) flush();
    else channel.timer = setTimeout(flush, wait).unref();
  };
}
