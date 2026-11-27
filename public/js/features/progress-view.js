import { h } from '../core/dom.js';
import { applyAgentAccent } from '../core/agent-accent.js';
import { agentInitials } from '../core/agent-view.js';

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const shortTime = (at) => clock.format(at);
export const isRunning = (task) => task.state === 'working' || task.state === 'queued';
const join = (...parts) => parts.filter(Boolean).join(' · ');
function duration(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? seconds + ' sec' : Math.floor(seconds / 60) + ' min';
}
function tone(state) {
  if (['completed', 'committed', 'Done', 'Answered'].includes(state)) return 'done';
  if (['waiting', 'blocked', 'waiting_for_commit', 'Waiting for you'].includes(state)) return 'waiting';
  if (['failed', 'cancelled', 'interrupted', 'Interrupted'].includes(state)) return 'stopped';
  if (['working', 'checking', 'queued', 'In progress'].includes(state)) return 'active';
  return 'next';
}
function badge(row) {
  return h('span', 'progress-badge ' + tone(row.status), row.status);
}
export function requestHeading(row, top, toggle) {
  const head = h('div', top ? 'progress-top-head' : 'progress-request');
  const title = h('strong', 'progress-title', row.text);
  title.title = row.text;
  const meta = h('span', 'progress-meta');
  if (top) {
    meta.textContent = join(shortTime(row.start), duration(row.start, row.end));
    head.append(h('span', 'progress-label', 'Your request'), title, badge(row), meta, toggle);
  } else {
    meta.append(h('span', null, 'Your request · ' + shortTime(row.start)), badge(row), h('span', null, duration(row.start, row.end)));
    head.append(meta, title);
  }
  return head;
}
export function currentStep(row) {
  return (
    row.stages.find((s) => tone(s.state) === 'waiting') ||
    row.stages.find((s) => tone(s.state) === 'active') ||
    row.stages.find((s) => s.state === 'pending') ||
    row.stages.at(-1)
  );
}
export function strip(row, position, brief) {
  const el = h('div', 'progress-strip');
  if (row.waiting) {
    const alert = h('span', 'progress-alert-icon', '!');
    alert.setAttribute('aria-label', row.waiting.reason);
    el.append(alert);
  }
  if (row.total) el.append(h('strong', null, position + '/' + row.total));
  const dots = h('div', 'progress-dots');
  for (const stage of row.stages) {
    const dot = h('span', tone(stage.state));
    dot.title = join(stage.name, stage.state.replaceAll('_', ' '));
    dots.append(dot);
  }
  const text = h('span', 'progress-vertical', brief);
  text.title = brief;
  el.append(dots, text);
  return el;
}
export function updateActivityClocks(host, time = Date.now()) {
  for (const el of host.querySelectorAll('[data-activity-at]')) {
    const seconds = Math.max(0, Math.floor((time - Number(el.dataset.activityAt)) / 1000));
    const thinking = el.dataset.thinking !== undefined;
    el.hidden = thinking && seconds < 5;
    el.textContent = (thinking ? '▸ Thinking · ' : ' · ') + seconds + ' s';
  }
}
function totals(task) {
  if (task.actions === undefined) return '';
  return (
    task.actions +
    (task.actions === 1 ? ' action' : ' actions') +
    ' · ' +
    task.files +
    (task.files >= 50 ? '+' : '') +
    (task.files === 1 ? ' file changed' : ' files changed')
  );
}
export function taskList(tasks, activities, live = false, waitingAgent, names = new Map()) {
  const list = h('ul', live ? 'progress-tasks progress-live' : 'progress-tasks');
  for (const task of tasks) {
    const item = h('li');
    applyAgentAccent(item, task.agent);
    // The current name follows renames; a removed agent keeps the name recorded with its task.
    const name = names.get(task.agent) || task.name || task.agent;
    const avatar = h('span', 'agent-avatar', agentInitials(name));
    avatar.setAttribute('aria-hidden', 'true');
    const desc = h('span', 'progress-task-title');
    desc.append(h('b', null, name));
    if (task.description) desc.append(' · ' + task.description);
    desc.title = desc.textContent;
    item.append(avatar, desc);
    const activity = activities.get(task.id);
    if (isRunning(task) && (activity || task.workingSince)) {
      const line = h('span', 'progress-now', activity ? '▸ ' + activity : '');
      if (task.now?.at || (!activity && task.workingSince)) {
        const elapsed = h('span');
        elapsed.dataset.activityAt = String(task.now?.at || task.workingSince);
        if (!activity) elapsed.dataset.thinking = '';
        line.append(elapsed);
      }
      if (live && task.actions !== undefined) line.append(h('span', 'progress-meta', ' · ' + totals(task)));
      item.append(line);
    } else if (task.state === 'interrupted' && task.now) item.append(h('span', 'progress-now', 'Last: ' + task.now.text));
    if (!live || (!activity && !task.workingSince))
      item.append(
        h(
          'span',
          'progress-meta',
          join(
            isRunning(task) && task.agent === waitingAgent ? 'waiting' : task.state,
            totals(task),
            task.delivered && 'delivered',
            task.round > 1 && 'round ' + task.round,
            duration(task.start, task.end),
          ),
        ),
      );
    list.append(item);
  }
  return list;
}
export function timeline(row, side, activities, names) {
  const list = h('ol', 'progress-stages');
  list.setAttribute('aria-label', 'Request stages');
  for (const stage of row.stages) {
    const state = tone(stage.state);
    const item = h('li', 'progress-stage ' + state);
    const marker = h('span', 'progress-marker', { done: '✓', waiting: '!', stopped: '×' }[state] || '');
    marker.setAttribute('aria-hidden', 'true');
    const title = h('strong', 'progress-stage-title', stage.name);
    if (stage.round > 1) title.append(h('small', 'progress-meta', ' · round ' + stage.round));
    const info = join(stage.agents?.join(', '), stage.state.replaceAll('_', ' '), stage.start && duration(stage.start, stage.end));
    item.append(marker, title, h('span', 'progress-meta', info));
    if (side && !row.total) {
      const tasks = row.tasks.filter((t) => t.stage === stage.name || (stage.name === 'Answer' && t.stage === 'Plan'));
      if (tasks.length) item.append(taskList(tasks, activities, false, row.waiting?.agent, names));
    }
    list.append(item);
  }
  return list;
}
export function disclosure(key, title, opened) {
  const el = h('details', 'progress-' + key);
  const summary = h('summary', null, title);
  summary.dataset.focus = key;
  el.open = opened.has(key);
  el.append(summary);
  return el;
}
export function history(rows, opened, action) {
  const section = disclosure('earlier', 'Earlier requests (' + rows.length + ')', opened);
  const list = h('ol');
  for (const row of rows) {
    const line = h('li');
    line.append(badge(row), h('span', 'progress-history-title', row.text), h('small', 'progress-meta', shortTime(row.start)));
    if (row.waiting) line.append(action(row.waiting, row.seq));
    list.append(line);
  }
  section.append(list);
  return section;
}
