import { $, h } from '../core/dom.js';
import { approvals } from '../core/store.js';
import { api } from '../core/api.js';
import {
  currentStep,
  disclosure,
  history,
  isRunning,
  requestHeading,
  strip,
  taskList,
  timeline,
  updateActivityClocks,
} from './progress-view.js';

let tick = () => {};
let previous = '';
let previousRequest;
let layout = '';
let savingLayout = false;
const folded = {};
function button(text, click) {
  const el = h('button', 'btn', text);
  el.type = 'button';
  el.onclick = click;
  return el;
}
function positionButton(side, host) {
  const destination = side ? 'top' : 'sidebar';
  const label = side ? 'Move progress above the chat' : 'Move progress to the right sidebar';
  const el = button('', async () => {
    if (savingLayout) return;
    savingLayout = true;
    el.setAttribute('aria-disabled', 'true');
    host.querySelector('.progress-layout-error')?.remove();
    try {
      await api('settings', { progressLayout: destination });
    } catch (err) {
      const message = h('p', 'err progress-layout-error', 'Could not move progress: ' + err.message);
      message.setAttribute('role', 'alert');
      host.append(message);
    } finally {
      savingLayout = false;
      host.querySelector('[data-focus="position"]')?.removeAttribute('aria-disabled');
    }
  });
  el.classList.add('progress-position');
  el.dataset.focus = 'position';
  el.dataset.destination = destination;
  el.title = label;
  el.setAttribute('aria-label', label);
  if (savingLayout) el.setAttribute('aria-disabled', 'true');
  const icon = h('span', 'progress-position-icon');
  icon.setAttribute('aria-hidden', 'true');
  el.append(icon);
  return el;
}
export function renderProgress(state, force = false) {
  const host = $('requestProgress');
  if (!host) return;
  const rows = state.progress || [];
  const mode = state.progressLayout || 'sidebar';
  const activities = new Map((state.tasks || []).filter((t) => t.activity).map((t) => [t.id, t.activity]));
  const names = new Map((state.team || []).map((a) => [a.id, a.name]));
  const signature = JSON.stringify([rows, state.conversationId, mode, [...activities], [...names]]);
  if (!force && previous === signature) return;
  previous = signature;
  const changedPosition = layout !== mode;
  layout = mode;
  const activeKey = host.contains(document.activeElement) ? document.activeElement?.dataset.focus : null;
  const app = host.closest('.app') || document.querySelector('.app');
  const drawer = $('progressDrawer'),
    floating = $('progressFloat'),
    dock = $('progressDock'),
    top = $('progressTop');
  const row = rows.at(-1);
  if (!row) {
    tick = () => {};
    host.hidden = floating.hidden = true;
    app.removeAttribute('data-progress');
    if (drawer.open) drawer.close();
    return;
  }
  if (!(mode in folded)) {
    try {
      folded[mode] = globalThis.window.localStorage.getItem('progress-folded-' + mode) === 'true';
    } catch {
      folded[mode] = false;
    }
  }
  const mobile = globalThis.window?.matchMedia?.('(max-width: 899px)').matches;
  const narrowTop = mode === 'top' && globalThis.window?.matchMedia?.('(max-width: 700px)').matches;
  const inlineDrawer = mobile && mode === 'sidebar';
  if (!inlineDrawer && drawer.open) drawer.close();
  const parent = inlineDrawer ? drawer : mode === 'top' ? top : dock;
  if (host.parentNode !== parent) parent.append(host);
  host.hidden = false;
  floating.hidden = !inlineDrawer;
  app.dataset.progress = mode;
  app.dataset.folded = String(folded[mode]);
  const collapsed = folded[mode] && !inlineDrawer;
  const side = mode === 'sidebar';
  const stage = currentStep(row);
  const position = row.stages.indexOf(stage) + 1;
  const phase = (row.total && stage ? 'Step ' + position + ' of ' + row.total + ' · ' : '') + (stage?.name || 'Request');
  const live = row.tasks.filter(isRunning);
  for (const task of live) {
    if (task.now?.text) activities.set(task.id, task.now.text);
    else if (row.waiting?.agent === task.agent) activities.set(task.id, row.waiting.reason);
  }
  function summary(short, time = Date.now()) {
    const descriptions = live.map((task) => {
      let text = activities.get(task.id) || (task.workingSince && time - task.workingSince >= 5000 ? 'Thinking' : '');
      if (short) text = text.replace(/^(Editing |Reading ).*\//, '$1');
      return task.name + (text ? ': ' + text : '');
    });
    return [phase, [...new Set(descriptions)].join(' · ') || row.status].join(' · ');
  }
  const brief = summary(true);
  let compact;
  const wait = row.waiting;
  floating.textContent = (wait ? '! ' : '') + brief;
  floating.classList.toggle('progress-alert', Boolean(wait));
  floating.setAttribute('aria-label', 'Open progress: ' + (wait?.reason || brief));
  floating.onclick = () => drawer.showModal();
  drawer.onclick = (e) => {
    if (e.target !== drawer) return;
    const bounds = drawer.getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) drawer.close();
  };
  const requestKey = JSON.stringify([state.conversationId, row.seq]);
  const opened = new Set(
    previousRequest === requestKey ? [...host.querySelectorAll('details[open] > summary')].map((el) => el.dataset.focus) : [],
  );
  const scrollTop = previousRequest === requestKey ? parent.scrollTop : 0;
  const horizontalScroll = host.querySelector('.progress-stages')?.scrollLeft || 0;
  previousRequest = requestKey;
  host.replaceChildren();
  function action(w, seq) {
    const el = button(w.action, async () => {
      if (drawer.open) drawer.close();
      if (w.card === 'retry') {
        try {
          await api('taskDecision', { action: 'retrySpec', seq, conversationId: state.conversationId });
        } catch (e) {
          host.append(h('p', 'err', e.message));
        }
        return;
      }
      const card = approvals.get(w.card) || $(w.card) || $('pending');
      card?.scrollIntoView?.({ block: 'nearest' });
      (card?.matches('button') ? card : card?.querySelector('button,input,select'))?.focus();
    });
    el.classList.add('btn--primary');
    el.dataset.focus = 'action-' + seq + '-' + (w.card || 'decision');
    return el;
  }
  const toggle = button('', () => {
    if (inlineDrawer) return drawer.close();
    folded[mode] = !folded[mode];
    try {
      globalThis.window.localStorage.setItem('progress-folded-' + mode, String(folded[mode]));
    } catch {
      /* storage is optional */
    }
    renderProgress(state, true);
  });
  toggle.dataset.focus = 'toggle';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.title = inlineDrawer ? 'Close progress' : collapsed ? 'Expand progress' : 'Collapse progress';
  toggle.setAttribute('aria-label', toggle.title);
  if (side && !collapsed) toggle.append(h('span', null, 'Progress'));
  const arrow = h('span', 'progress-chevron', '»');
  arrow.setAttribute('aria-hidden', 'true');
  toggle.append(arrow);
  host.dataset.mode = mode;
  const body = h('div', 'progress-body');
  body.id = 'progressBody';
  toggle.setAttribute('aria-controls', body.id);
  if (side) {
    toggle.classList.add('progress-rail-toggle');
    const heading = h('div', 'progress-rail-head');
    heading.append(toggle, positionButton(side, host));
    host.append(heading);
    if (!collapsed) body.append(requestHeading(row, false));
  } else {
    toggle.classList.add('progress-top-toggle');
    const heading = requestHeading(row, true, toggle);
    heading.append(positionButton(side, host));
    host.append(heading);
  }
  host.append(body);
  if (collapsed) {
    if (side) {
      body.append(strip(row, position, brief));
      compact = body.querySelector('.progress-vertical');
    } else {
      const line = h('div', 'progress-brief');
      compact = h('span', null, brief);
      line.append(compact);
      if (wait) {
        const alert = h('span', 'progress-alert-icon', '!');
        alert.title = wait.reason;
        line.prepend(alert);
        line.append(action(wait, row.seq));
      }
      body.append(line);
    }
  } else {
    const waitBox = wait && h('div', 'progress-wait');
    if (waitBox) {
      waitBox.append(h('strong', null, wait.reason));
      if (wait.agent) waitBox.append(h('span', null, names.get(wait.agent) || wait.agent));
      waitBox.append(action(wait, row.seq));
      if (side) body.append(waitBox);
    }
    let stagesHost = body;
    if (narrowTop && row.stages.length) {
      stagesHost = disclosure('steps', '', opened);
      compact = h('span', null, brief);
      stagesHost.querySelector('summary').append(compact);
      if (row.total) {
        const bar = h('progress');
        bar.max = row.total;
        bar.value = row.stages.filter((s) => s.state === 'committed').length;
        bar.setAttribute('aria-label', 'Completed steps');
        stagesHost.querySelector('summary').append(bar);
      }
      body.append(stagesHost);
    }
    if (row.stages.length) stagesHost.append(timeline(row, side, activities, names));
    if ((!side || row.total) && live.length) stagesHost.append(taskList(live, activities, true, wait?.agent, names));
    if (waitBox && !side) body.append(waitBox);
    if ((!side || row.total) && row.tasks.length) {
      const d = disclosure('delegations', 'Delegations in this request (' + row.tasks.length + ')', opened);
      d.append(taskList(row.tasks, activities, false, wait?.agent, names));
      stagesHost.append(d);
    }
    for (const reason of row.reasons.filter((w) => !w.action)) {
      body.append(h('p', 'progress-meta', [reason.reason, names.get(reason.agent) || reason.agent].filter(Boolean).join(' · ')));
    }
    const earlier = rows.slice(0, -1).reverse();
    const count = earlier.reduce((n, r) => n + r.tasks.filter(isRunning).length, 0);
    if (count)
      body.append(
        h(
          'p',
          'progress-meta',
          count + (count === 1 ? ' task from an earlier request is' : ' tasks from earlier requests are') + ' still running',
        ),
      );
    body.append(history(earlier, opened, action));
  }
  tick = live.length
    ? (time = Date.now()) => {
        updateActivityClocks(host, time);
        const label = summary(true, time);
        if (compact) {
          compact.textContent = label;
          compact.title = summary(false, time);
        }
        if (inlineDrawer) {
          floating.textContent = (wait ? '! ' : '') + label;
          floating.title = summary(false, time);
        }
      }
    : () => {};
  tick();
  parent.scrollTop = scrollTop;
  if (horizontalScroll && host.querySelector('.progress-stages')) host.querySelector('.progress-stages').scrollLeft = horizontalScroll;
  if (changedPosition && activeKey === 'position' && inlineDrawer && !drawer.open) drawer.showModal();
  if (activeKey) [...host.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === activeKey)?.focus({ preventScroll: true });
}
export function applyActivity(state, event) {
  if (!state || state.conversationId !== event.conversationId) return;
  const updates = new Map(event.updates.map((t) => [t.id, t]));
  let changed = false;
  for (const row of state.progress || [])
    for (const task of row.tasks) {
      const update = updates.get(task.id);
      if (!update || task.agent !== event.agent || task.state !== 'working') continue;
      Object.assign(task, { now: update.now, actions: update.actions, files: update.files });
      changed = true;
    }
  for (const task of state.tasks || []) if (updates.has(task.id)) task.activity = updates.get(task.id).now?.text;
  if (changed) renderProgress(state);
}
export function bindProgress(getState) {
  globalThis.window.setInterval(() => {
    if (!document.hidden) tick();
  }, 1000);
  for (const query of ['(max-width: 899px)', '(max-width: 700px)'])
    globalThis.window?.matchMedia?.(query).addEventListener?.('change', () => {
      if (layout && getState()) renderProgress(getState(), true);
    });
}
