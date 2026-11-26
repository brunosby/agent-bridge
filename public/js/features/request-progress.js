import { $, h, time } from '../core/dom.js';
import { approvals } from '../core/store.js';
import { api } from '../core/api.js';
let previous = '';
let layout = '';
const folded = {};
function button(text, click) {
  const el = h('button', 'btn', text);
  el.type = 'button';
  el.onclick = click;
  return el;
}
function details(title, open) {
  const el = h('details');
  el.open = open;
  el.append(h('summary', null, title));
  return el;
}
function duration(start, end = Date.now()) {
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  return secs < 60 ? secs + ' sec' : Math.floor(secs / 60) + ' min';
}
export function renderProgress(state, force = false) {
  const host = $('requestProgress');
  if (!host) return;
  const rows = state.progress || [];
  const mode = state.progressLayout || 'sidebar';
  const signature = JSON.stringify([rows, state.conversationId, mode]);
  if (!force && previous === signature) return;
  previous = signature;
  layout = mode;
  const app = host.closest('.app') || document.querySelector('.app');
  const drawer = $('progressDrawer'),
    floating = $('progressFloat'),
    dock = $('progressDock'),
    top = $('progressTop');
  const row = rows.at(-1);
  if (!row) {
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
  const inlineDrawer = mobile && mode === 'sidebar';
  if (!inlineDrawer && drawer.open) drawer.close();
  const parent = inlineDrawer ? drawer : mode === 'top' ? top : dock;
  if (host.parentNode !== parent) parent.append(host);
  host.hidden = false;
  floating.hidden = !inlineDrawer;
  app.dataset.progress = mode;
  app.dataset.folded = String(folded[mode]);
  const collapsed = folded[mode] && !inlineDrawer;
  const current = row.stages.filter((s) => ['working', 'checking', 'waiting_for_commit', 'waiting', 'blocked', 'queued'].includes(s.state));
  const stage = current[0] || row.stages.find((s) => s.state === 'pending') || row.stages.at(-1);
  const phase = (row.total ? 'Step ' + (row.stages.indexOf(stage) + 1) + ' of ' + row.total + ' · ' : '') + (stage?.name || 'Request');
  const working = row.tasks.filter((t) => ['working', 'queued'].includes(t.state)).map((t) => t.name);
  const brief = [
    phase,
    ...new Set(working),
    row.status,
    stage?.round > 1 ? 'round ' + stage.round : '',
    stage?.start ? duration(stage.start, stage.end) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const wait = row.waiting;
  floating.textContent = (wait ? '! ' : '') + phase;
  floating.classList.toggle('progress-alert', Boolean(wait));
  floating.onclick = () => drawer.showModal();
  drawer.onclick = (e) => {
    if (e.target === drawer) drawer.close();
  };
  const earlierOpen = host.querySelector('.earlier')?.open || false;
  const delegatesOpen = host.querySelector('.delegations')?.open || false;
  const activeKey = host.contains(document.activeElement) ? document.activeElement?.dataset.focus : null;
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
    el.dataset.focus = w.card || 'decision';
    return el;
  }
  const toggle = button(inlineDrawer ? 'Close' : mode === 'sidebar' ? (collapsed ? '«' : '»') : collapsed ? 'Show' : 'Hide', () => {
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
  toggle.setAttribute('aria-label', inlineDrawer ? 'Close progress' : collapsed ? 'Show progress' : 'Hide progress');
  const head = h('div', 'section-heading');
  head.append(h('strong', null, collapsed && mode === 'sidebar' ? '' : 'Request progress'), toggle);
  host.append(head);
  if (wait) host.append(h('strong', 'progress-alert', '! ' + (collapsed && mode === 'sidebar' ? '' : wait.reason)));
  if (collapsed && mode === 'sidebar') {
    const dots = h('div', 'progress-dots');
    for (const s of row.stages) {
      const dot = h('span', s.state, '●');
      dot.title = s.name;
      dots.append(dot);
    }
    host.append(dots, h('span', 'progress-vertical', phase));
  } else {
    host.append(h('strong', null, brief));
    if (wait) host.append(action(wait, row.seq));
    if (!collapsed) {
      host.append(h('p', 'request-text', row.text), h('small', 'hint', time(row.start) + ' · ' + duration(row.start, row.end)));
      const timeline = h('ol', 'progress-stages');
      const delegation = (t) =>
        h(
          'li',
          null,
          [t.name, t.description, t.state, t.delivered ? 'delivered' : '', t.round > 1 ? 'round ' + t.round : '', duration(t.start, t.end)]
            .filter(Boolean)
            .join(' · '),
        );
      for (const stage of row.stages) {
        const li = h(
          'li',
          stage.state,
          [
            stage.name,
            stage.state,
            stage.agents?.length > 1 ? stage.agents.length + ' agents' : stage.agents?.[0],
            stage.round > 1 ? 'round ' + stage.round : '',
            stage.start ? duration(stage.start, stage.end) : '',
          ]
            .filter(Boolean)
            .join(' · '),
        );
        const tasks = row.tasks.filter((t) => !row.total && (t.stage === stage.name || stage.name === 'Answer'));
        if (mode === 'sidebar' && tasks.length) {
          const list = h('ul');
          list.append(...tasks.map(delegation));
          li.append(list);
        }
        timeline.append(li);
      }
      if (mode === 'top' && mobile) {
        const steps = details(phase, false);
        const bar = h('progress');
        if (row.total) {
          bar.max = row.total;
          bar.value = row.stages.filter((s) => s.state === 'committed').length;
        }
        steps.append(bar, timeline);
        host.append(steps);
      } else host.append(timeline);
      if (mode === 'top' || row.total) {
        const d = details('Delegations', delegatesOpen);
        d.className = 'delegations';
        const list = h('ul');
        list.append(...row.tasks.map(delegation));
        d.append(list);
        host.append(d);
      }
      for (const reason of row.reasons.filter((w) => !w.action))
        host.append(
          h(
            'p',
            'hint',
            reason.reason + (reason.agent ? ' · ' + (state.team?.find((a) => a.id === reason.agent)?.name || reason.agent) : ''),
          ),
        );
      const earlier = rows.slice(0, -1).reverse();
      if (earlier.length) {
        const count = earlier.flatMap((r) => r.tasks).filter((t) => ['queued', 'working'].includes(t.state)).length;
        if (count)
          host.append(
            h(
              'p',
              'hint',
              count + (count === 1 ? ' task from an earlier request is' : ' tasks from earlier requests are') + ' still running',
            ),
          );
        const section = details('Earlier requests', earlierOpen);
        section.className = 'earlier';
        for (const r of earlier) {
          const line = h('p', r.waiting ? 'progress-alert' : '', [r.text, r.status].join(' · '));
          if (r.waiting) line.append(action(r.waiting, r.seq));
          section.append(line);
        }
        host.append(section);
      }
    }
  }
  if (activeKey) [...host.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === activeKey)?.focus();
}
export function bindProgress(getState) {
  globalThis.window?.matchMedia?.('(max-width: 899px)').addEventListener?.('change', () => {
    if (layout && getState()) renderProgress(getState(), true);
  });
}
