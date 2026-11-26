import { renderProgress } from './request-progress.js';
import { applyAgentAccent } from '../core/agent-accent.js';
import { parseMilestoneMarkers } from '../core/milestone-markers.js';
import { milestoneCommitCard, milestonePlanCard, renderMilestoneProgress } from './milestones.js';
// Convert incoming events to transcript entries and update their views in frame-sized batches.
import { approvals, findMentionAgent, historyAgentOf, label, roleOf, store } from '../core/store.js';
import { $, appendMentions, h, log, renderMarkdown, time } from '../core/dom.js';
import { Transcript } from '../core/transcript.js';
import { mapMentions } from '../core/mentions.js';
import {
  renderApproval,
  renderFinalReview,
  renderNeedRole,
  renderRoleRecommendation,
  refreshApprovalNames,
  updatePending,
} from './approvals.js';
import { renderState } from './agents.js';
import { updateComposer } from './controls.js';
import { bindSavedSearch } from './transcript-search.js';
import { renderWorkflow, sizeBadge } from './task-workflow.js';
import { workflowMarkers } from '../core/workflow-markers.js';
import { parseSummary } from '../core/summary-markers.js';
import { parseRoleMarkers } from '../core/role-markers.js';

const transcript = new Transcript();
const views = new Map();
const dirty = new Set();
const agentOptions = new Set();
let newNodes = document.createDocumentFragment();
let frame = 0;
let unread = 0;
let replaying = true;
let hasMessages = false;
let scrollToEndOnReplay = true;
let follow = true;
let previousScroll = scrollPosition();
let results = null;
let resultIndex = -1;
let selected = null;
let identityKey = null;
const resetSavedSearch = bindSavedSearch({ isLoaded: (seq) => transcript.bySequence.has(seq), open: jumpToSequence });

function filterOptions() {
  return [$('logSearch').value.trim().toLowerCase(), $('logMode').value, $('logAgent').value, $('logCategory').value];
}

function filterEntry(entry, filters = filterOptions()) {
  const view = views.get(entry);
  if (view) view.node.hidden = !transcript.matches(entry, ...filters);
}

function filterGroup(group) {
  group.details.hidden = group.entries.every((entry) => views.get(entry).node.hidden);
}

function resetResults() {
  results = null;
  resultIndex = -1;
  if (selected) views.get(selected)?.node.classList.remove('search-match');
  selected = null;
  $('searchPosition').textContent = '';
}

function scrollPosition() {
  return { top: log.scrollTop, height: log.scrollHeight, viewport: log.clientHeight };
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
  previousScroll = scrollPosition();
}

function stopFollowing() {
  follow = false;
  showUnread();
}

function showUnread() {
  $('returnToEnd').hidden = follow;
  $('returnToEnd').textContent = unread ? 'Back to end · ' + unread + ' new' : 'Back to end';
}

function flush() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  log.appendChild(newNodes);
  newNodes = document.createDocumentFragment();
  const filters = filterOptions();
  for (const entry of dirty) {
    const body = views.get(entry).body;
    renderMarkdown(body, entry.text, findMentionAgent);
    if (entry.summary) {
      const card = h('section', 'reply-summary');
      const content = h('div');
      renderMarkdown(content, entry.summary, findMentionAgent);
      card.append(h('strong', null, 'Summary'), content);
      body.appendChild(card);
    }
    filterEntry(entry, filters);
  }
  dirty.clear();
  if (follow) scrollToEnd();
  else previousScroll = scrollPosition();
  showUnread();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(flush);
}

function mount(entry, node, body = null, refresh = null) {
  views.set(entry, { node, body, refresh, group: null });
  node.tabIndex = -1;
  newNodes.appendChild(node);
  filterEntry(entry);
  for (const id of entry.agents) {
    if (agentOptions.has(id)) continue;
    agentOptions.add(id);
    const option = h('option', null, label(id));
    option.value = id;
    $('logAgent').appendChild(option);
  }
  schedule();
}

function addLine(event, category, classes, text, agents = []) {
  const entry = transcript.add(event, text, category, agents);
  const node = h('div', classes);
  const refresh = () => {
    node.replaceChildren();
    appendMentions(node, entry.text, findMentionAgent);
    updateSearchText(entry);
  };
  refresh();
  mount(entry, node, null, refresh);
  return entry;
}

export function addSys(text, isError = false) {
  addLine({}, isError ? 'error' : 'system', isError ? 'sys error' : 'sys', text);
}

function reference(id) {
  return /^a\d+$/.test(id) ? '@' + id : label(id);
}

function updateSearchText(entry) {
  transcript.update(
    entry,
    entry.text,
    mapMentions(entry.summary ? entry.text + '\n' + entry.summary : entry.text, (name) => {
      const member = findMentionAgent(name);
      return member ? '@' + member.name : undefined;
    }),
  );
}

function refreshNames(state) {
  const key = JSON.stringify(
    [state.team, state.knownAgents].map((members) => (members || []).map(({ id, name, driver }) => [id, name, driver])),
  );
  if (key === identityKey) return;
  if (identityKey !== null) resetSavedSearch();
  identityKey = key;
  resetResults();
  const groups = new Set();
  const filters = filterOptions();
  for (const entry of transcript.entries) {
    const view = views.get(entry);
    view.refresh?.();
    if (view.body) {
      updateSearchText(entry);
      dirty.add(entry);
    }
    filterEntry(entry, filters);
    if (view.group) groups.add(view.group);
  }
  for (const group of groups) refreshToolGroup(group);
  for (const option of $('logAgent').options) {
    if (option.value) option.textContent = label(option.value);
  }
  refreshApprovalNames();
  schedule();
}

function message(ev) {
  const user = ev.kind === 'user';
  const key = user ? null : ev.agent + '|message|' + ev.key;
  let entry = key && transcript.byKey.get(key);
  const isNew = !entry;
  if (!entry) {
    entry = transcript.add(ev, '', 'message', user ? ev.to || [] : [ev.agent], key);
    const node = h('div', user ? 'msg user' : 'msg agent');
    if (!user) applyAgentAccent(node, ev.agent);
    if (!user) node.classList.add('streaming');
    const head = h('div', 'head');

    const role = roleOf(historyAgentOf(ev.agent)?.role)?.name;
    const who = h('span', 'who');
    const meta = h('span');
    const refresh = () => {
      who.textContent = user ? 'You' : label(ev.agent);
      const detail = user ? '\u2192 ' + (ev.to || []).map(label).join(' + ') + ' \u00b7 ' : role ? role + ' \u00b7 ' : '';
      meta.textContent = detail + time(ev.at);
    };
    refresh();
    head.append(who, meta);
    const body = h('div', 'body');
    node.append(head, body);
    if (!user) transcript.track(ev.agent, entry);
    mount(entry, node, body, refresh);
  }
  if (entry.finalized && !(ev.kind === 'text' && ev.final)) return;
  if (user) transcript.update(entry, ev.text);
  else {
    entry.rawMessage = ev.kind === 'delta' ? (entry.rawMessage || '') + ev.text : ev.text;
    const visible = parseRoleMarkers(parseMilestoneMarkers(entry.rawMessage).text).text;
    const { body, summary } = parseSummary(workflowMarkers(visible).text, !ev.final);
    entry.summary = summary;
    transcript.update(entry, body);
  }
  updateSearchText(entry);
  dirty.add(entry);
  if (isNew && !replaying && !follow && transcript.matches(entry, ...filterOptions())) unread += 1;
  if (ev.final) {
    entry.finalized = true;
    if (Number.isInteger(ev.seq)) transcript.bySequence.set(ev.seq, entry);
    views.get(entry).node.classList.remove('streaming');
  }
  schedule();
}

function groupTools(entries) {
  // Group adjacent successful calls so the display order is preserved across parallel agents.
  let group = null;
  let previous = null;
  const groups = new Set();
  for (const entry of entries) {
    const view = views.get(entry);
    if (entry.category !== 'tool' || entry.ok !== true) continue;
    if (entry.previous !== previous || !group) {
      const details = h('details', 'tool-group');
      const summary = h('summary');
      details.appendChild(summary);
      view.node.before(details);
      group = { details, summary, entries: [] };
      groups.add(group);
    }
    group.entries.push(entry);
    group.details.appendChild(view.node);
    view.group = group;
    previous = entry;
  }
  for (const grouped of groups) refreshToolGroup(grouped);
}

function refreshToolGroup(group) {
  const count = group.entries.length;
  group.summary.textContent =
    label(group.entries[0].agents[0]) + ' \u00b7 ' + count + ' successful tool ' + (count === 1 ? 'call' : 'calls');
  filterGroup(group);
}

export function jumpToSequence(seq) {
  const entry = transcript.bySequence.get(seq);
  if (!entry) return false;
  const view = views.get(entry);
  stopFollowing();
  flush();
  if (view.group) {
    view.group.details.hidden = false;
    view.group.details.open = true;
  }
  view.node.hidden = false;
  view.node.scrollIntoView({ block: 'center' });
  view.node.focus({ preventScroll: true });
  previousScroll = scrollPosition();
  return true;
}

function seek(step) {
  results ??= transcript.search(...filterOptions());
  if (!results.length) {
    $('searchPosition').textContent = 'No matches';
    return;
  }
  if (selected) views.get(selected).node.classList.remove('search-match');
  resultIndex = resultIndex < 0 ? (step > 0 ? 0 : results.length - 1) : (resultIndex + step + results.length) % results.length;
  selected = results[resultIndex];
  if (!jumpToSequence(selected.seq)) {
    stopFollowing();
    flush();
    views.get(selected).node.scrollIntoView({ block: 'center' });
    previousScroll = scrollPosition();
  }
  views.get(selected).node.classList.add('search-match');
  $('searchPosition').textContent = resultIndex + 1 + ' / ' + results.length;
}

for (const id of ['logSearch', 'logMode', 'logAgent', 'logCategory']) {
  $(id).addEventListener(id === 'logSearch' ? 'input' : 'change', () => {
    resetResults();
    const filters = filterOptions();
    const groups = new Set();
    for (const entry of transcript.entries) {
      filterEntry(entry, filters);
      const group = views.get(entry)?.group;
      if (group) groups.add(group);
    }
    for (const group of groups) filterGroup(group);
  });
}
$('searchPrev').onclick = () => seek(-1);
$('searchNext').onclick = () => seek(1);
function returnToEnd() {
  follow = true;
  unread = 0;
  flush();
}

$('returnToEnd').onclick = returnToEnd;
log.addEventListener(
  'wheel',
  (event) => {
    if (event.deltaY < 0 && !event.ctrlKey && log.scrollHeight > log.clientHeight) stopFollowing();
  },
  { passive: true },
);
log.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.altKey || event.target.closest('button, input, textarea, select, [contenteditable]')) return;
  if (event.key === 'End') {
    event.preventDefault();
    returnToEnd();
  } else if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && log.scrollHeight > log.clientHeight) {
    stopFollowing();
  }
});
log.addEventListener('scroll', () => {
  const position = scrollPosition();
  const { top, height, viewport } = previousScroll;
  previousScroll = position;
  // A layout change can move the scroll position without a user gesture.
  if (position.height !== height || position.viewport !== viewport || position.top === top) return;
  follow = position.top > top && position.height - position.top - position.viewport <= 40;
  if (follow) unread = 0;
  showUnread();
});

export function handle(ev) {
  if (!['state', 'delta'].includes(ev.kind)) results = null;
  switch (ev.kind) {
    case 'reset': {
      if ($('agentDetails').open) $('agentDetails').close();
      hasMessages = false;
      $('conversationStart').hidden = true;
      log.textContent = '';
      $('pending').textContent = '';
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      newNodes = document.createDocumentFragment();
      transcript.clear();
      views.clear();
      dirty.clear();
      agentOptions.clear();
      identityKey = null;
      const allAgents = h('option', null, 'All agents');
      allAgents.value = '';
      $('logAgent').replaceChildren(allAgents);
      $('logSearch').value = '';
      resetSavedSearch();
      $('logCategory').value = '';
      unread = 0;
      replaying = true;
      scrollToEndOnReplay = true;
      follow = true;
      previousScroll = scrollPosition();
      resetResults();
      approvals.clear();
      renderMilestoneProgress();
      updatePending();
      showUnread();
      break;
    }
    case 'replayComplete':
      $('conversationStart').hidden = hasMessages;
      replaying = false;
      if (scrollToEndOnReplay) {
        scrollToEndOnReplay = false;
        follow = true;
        unread = 0;
        requestAnimationFrame(() => {
          if (follow) scrollToEnd();
        });
      }
      flush();
      if (store.state?.taskPlan) sizeBadge(views.get(transcript.bySequence.get(store.state.taskPlan.seq))?.node, store.state);
      break;
    case 'state':
      if (JSON.stringify(store.state?.signIn) !== JSON.stringify(ev.signIn))
        queueMicrotask(() => globalThis.window?.dispatchEvent(new globalThis.window.CustomEvent('bridge-sign-in', { detail: ev.signIn })));
      if (store.state?.taskPlan && store.state.taskPlan.seq !== ev.taskPlan?.seq)
        sizeBadge(views.get(transcript.bySequence.get(store.state.taskPlan.seq))?.node, store.state, false);
      store.state = ev;
      renderWorkflow(ev);
      renderProgress(ev);
      if (ev.taskPlan) sizeBadge(views.get(transcript.bySequence.get(ev.taskPlan.seq))?.node, ev);
      refreshNames(ev);
      renderMilestoneProgress(ev.milestones);
      renderState();
      updateComposer();
      break;
    case 'workflowChanged':
      if (ev.plan) sizeBadge(views.get(transcript.bySequence.get(ev.plan.seq))?.node, { ...store.state, taskPlan: ev.plan }, false);
      break;
    case 'user':
    case 'delta':
    case 'text':
      if (!hasMessages) {
        hasMessages = true;
        $('conversationStart').hidden = true;
      }
      message(ev);
      if (ev.kind === 'user' && ev.seq === store.state?.taskPlan?.seq)
        sizeBadge(views.get(transcript.bySequence.get(ev.seq))?.node, store.state);
      if (ev.kind === 'delta' && $('logSearch').value) results = null;
      break;
    case 'routed':
      if (ev.relayed)
        addLine(ev, 'route', 'route', reference(ev.from) + ' → ' + reference(ev.to) + ' (hand-off ' + ev.hop + ')', [ev.from, ev.to]);
      break;
    case 'tool': {
      const entry = transcript.add(
        ev,
        reference(ev.agent) + ' · ' + ev.title + (ev.detail ? ': ' + ev.detail : ''),
        'tool',
        [ev.agent],
        ev.agent + '|tool|' + ev.key,
      );
      transcript.track(ev.agent, entry);
      const node = h('div', 'tool');
      applyAgentAccent(node, ev.agent);
      const actor = document.createTextNode('');
      const refresh = () => {
        actor.textContent = label(ev.agent) + ' \u00b7 ';
        updateSearchText(entry);
      };
      refresh();
      node.append(h('span', 'status', '\u2026'), actor, document.createTextNode(ev.title + (ev.detail ? ': ' + ev.detail : '')));
      mount(entry, node, null, refresh);
      break;
    }
    case 'toolResult': {
      const entry = transcript.byKey.get(ev.agent + '|tool|' + ev.key);
      if (!entry) break;
      entry.ok = ev.ok;
      const node = views.get(entry).node;
      node.classList.add(ev.ok ? 'ok' : 'fail');
      node.querySelector('.status').textContent = ev.ok ? '✓' : '✗';
      if (!ev.ok && ev.detail) {
        node.appendChild(h('span', 'err', ev.detail));
        transcript.update(entry, entry.text + ' ' + ev.detail);
        updateSearchText(entry);
      }
      filterEntry(entry);
      break;
    }
    case 'turnEnd': {
      const entries = transcript.endTurn(ev.agent);
      for (const entry of entries) views.get(entry).node.classList.remove('streaming');
      groupTools(entries);
      const detail = !ev.ok && ev.detail ? ' · ' + ev.detail : '';
      addLine(ev, 'turn', 'turn-end' + (ev.ok ? '' : ' fail'), reference(ev.agent) + ' finished its turn' + detail, [ev.agent]);
      break;
    }
    case 'autoApproved':
      addLine(ev, 'approval', 'tool ok', reference(ev.agent) + ' auto-approved: ' + (ev.detail?.split('\n')[0] || ev.title), [ev.agent]);
      break;
    case 'approval':
      renderApproval(ev);
      addLine(ev, 'approval', 'sys', reference(ev.agent) + ' · ' + ev.title + ' · waiting for approval', [ev.agent]);
      break;
    case 'needRole':
      renderNeedRole(ev);
      addLine(ev, 'approval', 'sys', reference(ev.agent) + ' asked for ' + ev.roleName, [ev.agent]);
      break;
    case 'milestonePlanProposed':
    case 'milestoneCommitProposed': {
      const card = ev.kind === 'milestonePlanProposed' ? milestonePlanCard(ev) : milestoneCommitCard(ev);
      approvals.set(ev.requestId, card);
      $('pending').append(card);
      updatePending();
      break;
    }
    case 'recommendRoles':
      renderRoleRecommendation(ev);
      addLine(ev, 'approval', 'sys', reference(ev.agent) + ' suggested additional roles', [ev.agent]);
      break;
    case 'finalReview':
      renderFinalReview(ev);
      addLine(ev, 'approval', 'sys', reference(ev.agent) + ' requested final confirmation', [ev.agent]);
      break;
    case 'finalReviewClosed':
    case 'needRoleClosed':
    case 'recommendRolesClosed':
    case 'milestoneDecisionClosed':
    case 'approvalClosed': {
      const el = approvals.get(ev.requestId);
      if (!el) break;
      approvals.delete(ev.requestId);
      el.remove();
      const names = {
        accept: 'allowed once',
        acceptForSession: 'allowed for the session',
        decline: 'declined',
        cancelled: 'cancelled',
        timeout: 'declined automatically (no answer in time)',
      };
      addLine(ev, 'approval', 'sys', el.dataset.title + ' · ' + (names[ev.decision] || ev.action || 'closed'));
      updatePending();
      break;
    }
    case 'tasksCancelled':
      if (!ev.taskIds?.length) break;
      addLine(ev, 'system', 'sys', reference(ev.agent) + ' · ' + ev.taskIds.length + ' task(s) interrupted', [ev.agent]);
      break;
    case 'batchProgress':
      addLine(ev, 'system', 'sys', ev.text, [ev.agent, ...ev.pending]);
      break;
    case 'system':
    case 'info':
    case 'error':
      addLine(
        ev,
        ev.kind === 'error' ? 'error' : 'system',
        ev.kind === 'error' ? 'sys error' : 'sys',
        (ev.agent ? reference(ev.agent) + ': ' : '') + ev.text,
        ev.agent ? [ev.agent] : [],
      );
      break;
  }
}
