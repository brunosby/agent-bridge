// Message box and header controls, Restart and Quit.
import { $, closeDialog } from '../core/dom.js';
import { api } from '../core/api.js';
import { addSys } from './conversation-log.js';
import { store } from '../core/store.js';
import { draftForSend, refreshSelectedMentions, selectDraftMention, updateDraft } from '../core/draft-mentions.js';
import { leadingMentionTokens } from '../core/mentions.js';
const input = $('input');
const target = $('target');
const targetPreview = $('targetPreview');
const list = $('mentionSuggestions');
const drafts = new Map();
let conversationId = null;
let previewTimer;
let previewVersion = 0;
let previewKey = '';
let matches = [];
let active = -1;
let mention = null;

function draft(id) {
  if (!id) return null;
  if (drafts.has(id)) return drafts.get(id);
  try {
    const saved = sessionStorage.getItem('agent-bridge-draft:' + id) || '';
    if (saved.startsWith('v2:')) {
      const parsed = JSON.parse(saved.slice(3));
      if (typeof parsed.text === 'string' && Array.isArray(parsed.bindings)) return parsed;
    }
    return updateDraft(null, saved, store.state?.team || []);
  } catch {
    return null;
  }
}

function rememberDraft(id, next) {
  if (!id) return next;
  const key = 'agent-bridge-draft:' + id;
  if (next.text) drafts.set(id, next);
  else drafts.delete(id);
  try {
    if (next.text) sessionStorage.setItem(key, 'v2:' + JSON.stringify(next));
    else sessionStorage.removeItem(key);
  } catch {}
  return next;
}

function saveDraft(id, text) {
  const previous = draft(id);
  const next = updateDraft(previous, text, store.state?.team || []);
  return previous === next ? next : rememberDraft(id, next);
}

export function updateComposer() {
  const state = store.state;
  if (!state) return;
  if (conversationId !== state.conversationId) {
    saveDraft(conversationId, input.value);
    conversationId = state.conversationId;
    input.value = draft(conversationId)?.text || '';
    saveDraft(conversationId, input.value);
    hideMentions();
  }
  const previous = saveDraft(conversationId, input.value);
  const refreshed = refreshSelectedMentions(previous, state.team);
  if (refreshed.changes.length) {
    for (const { start, end, label } of refreshed.changes.toReversed()) input.setRangeText(label, start, end, 'preserve');
    rememberDraft(conversationId, refreshed.draft);
    hideMentions();
  }
  const current = draftForSend(refreshed.draft, state.team, target.value);
  const prefix = current.text.slice(0, leadingMentionTokens(current.text).at(-1)?.end || 0);
  const key = JSON.stringify([
    conversationId,
    state.routingMode,
    target.value,
    prefix,
    current.problem,
    current.checks,
    state.team.map((agent) => [agent.id, agent.name, agent.role, agent.available, agent.account?.state]),
  ]);
  if (key === previewKey) return;
  previewKey = key;
  const version = ++previewVersion;
  clearTimeout(previewTimer);
  targetPreview.textContent = current.problem;
  if (current.problem) return;
  previewTimer = setTimeout(async () => {
    try {
      const { targets, changedByMention } = await api('previewTarget', {
        target: target.value,
        prefix,
        conversationId,
        mentionChecks: current.checks,
      });
      if (version !== previewVersion) return;
      if (!targets.length) {
        targetPreview.textContent = 'No recipient';
      } else if (changedByMention || targets.some((agent) => !agent.available)) {
        targetPreview.textContent = 'To ' + targets.map((agent) => agent.name + (agent.available ? '' : ' (unavailable)')).join(', ');
      }
    } catch (error) {
      if (version === previewVersion) targetPreview.textContent = error.message || 'Recipient preview unavailable';
    }
  }, 120);
}

function hideMentions() {
  matches = [];
  active = -1;
  mention = null;
  list.hidden = true;
  list.replaceChildren();
  input.removeAttribute('aria-activedescendant');
}

function selectMention(index) {
  active = index;
  for (const [i, option] of [...list.children].entries()) option.setAttribute('aria-selected', String(i === index));
  if (index >= 0) input.setAttribute('aria-activedescendant', list.children[index].id);
}

function insertMention(index) {
  const agent = matches[index];
  if (!mention || !agent) return;
  const end = input.selectionStart + (input.value.slice(input.selectionStart).match(/^[\w-]+/)?.[0].length || 0);
  const start = mention.start;
  input.setRangeText('@' + agent.name + ' ', start, end, 'end');
  const next = saveDraft(conversationId, input.value);
  rememberDraft(conversationId, selectDraftMention(next, start, agent.id));
  hideMentions();
  updateComposer();
}

function showMentions() {
  const before = input.value.slice(0, input.selectionStart);
  const token = /(?:^|\s)@([\w-]*)$/.exec(before);
  hideMentions();
  if (!token || input.selectionStart !== input.selectionEnd) return;
  matches = (store.state?.team || []).filter((agent) => agent.name.toLowerCase().startsWith(token[1].toLowerCase()));
  if (!matches.length) return;
  mention = { start: before.length - token[1].length - 1 };
  for (const [index, agent] of matches.entries()) {
    const option = document.createElement('div');
    option.id = 'mention-option-' + index;
    option.setAttribute('role', 'option');
    option.textContent = '@' + agent.name;
    option.onpointerdown = (event) => event.preventDefault();
    option.onclick = () => insertMention(index);
    list.appendChild(option);
  }
  list.hidden = false;
  selectMention(0);
}

export async function sendMessage() {
  const text = input.value;
  const id = conversationId;
  if (!text.trim() || $('send').disabled) return;
  const current = draftForSend(saveDraft(id, text), store.state?.team || [], target.value);
  if (current.problem) {
    targetPreview.textContent = current.problem;
    return;
  }
  $('send').disabled = true;
  try {
    await api('send', { text: current.text, target: target.value, conversationId: id, mentionChecks: current.checks });
    if (draft(id)?.text === text) saveDraft(id, '');
    if (conversationId === id && input.value === text) {
      input.value = '';
      hideMentions();
      updateComposer();
    }
  } catch (e) {
    addSys('Send failed: ' + e.message, true);
  } finally {
    $('send').disabled = false;
    if (conversationId === id) input.focus();
  }
}

$('send').onclick = sendMessage;
target.addEventListener('change', updateComposer);
input.addEventListener('blur', hideMentions);
input.addEventListener('input', () => {
  saveDraft(conversationId, input.value);
  showMentions();
  updateComposer();
});
input.addEventListener('keydown', (e) => {
  // keyCode 229: some browsers report IME composition only this way.
  if (e.isComposing || e.keyCode === 229) return;
  const enter = e.key === 'Enter';
  if (enter && (e.shiftKey || e.altKey)) return;
  if (enter && (e.ctrlKey || e.metaKey || !matches.length)) {
    e.preventDefault();
    sendMessage();
  } else if (matches.length && !e.shiftKey && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
    e.preventDefault();
    if (enter) insertMention(active);
    else if (e.key === 'Escape') hideMentions();
    else selectMention((active + matches.length + (e.key === 'ArrowDown' ? 1 : -1)) % matches.length);
  }
});
$('auto').onchange = (e) => api('relay', { auto: e.target.checked });
$('maxHops').onchange = (e) => api('relay', { maxHops: Number(e.target.value) });
$('routing').onchange = (e) =>
  api('routing', { mode: e.target.value })
    .then(() => e.target.blur())
    .catch((err) => addSys(err.message, true));
$('resume').onclick = () => api('relay', { resume: true });
$('pause').onclick = () => api('relay', { pause: true });
$('stopAll').onclick = () => api('interrupt', {}).catch((error) => addSys(error.message, true));
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => closeDialog(b.dataset.close);

const appActions = $('appActions');
document.addEventListener('click', (event) => {
  if (appActions.open && !appActions.contains(event.target)) appActions.open = false;
});
appActions.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && appActions.open) {
    event.preventDefault();
    appActions.open = false;
    appActions.querySelector('summary').focus();
  }
});

function closeAppActions() {
  appActions.open = false;
  appActions.querySelector('summary').focus();
}

// ---------- restart / quit (there is no console window to close) ----------
export function busyConfirm(what) {
  return !(store.state && store.state.team.some((a) => a.busy)) || confirm(`An agent is still working. ${what} anyway?`);
}

$('restartApp').onclick = async () => {
  closeAppActions();
  if (!busyConfirm('Restart')) return;
  try {
    await api('restart');
  } catch (e) {
    return addSys(`Restart failed: ${e.message}`, true);
  }
  addSys('Restarting... this page reloads when Agent Bridge is back.');
  // Reload when the replacement process is listening at the same address.
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (res.ok) return location.reload();
    } catch {
      // still restarting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  addSys('Agent Bridge did not come back. Check logs\\server.log and start it again.', true);
};

$('quitApp').onclick = async () => {
  closeAppActions();
  if (!busyConfirm('Quit') || !confirm('Close Agent Bridge and all agents?')) return;
  try {
    await api('quit');
  } catch (error) {
    addSys(error.message, true);
    return;
  }
  document.body.innerHTML =
    '<div class="closed-page"><h2>Agent Bridge is closed</h2><p>Start it again with <code>Agent Bridge.vbs</code>. Conversations can be restored from the Conversations button.</p></div>';
};

// Small screens: the Workspace button toggles the side panel.
$('toggleControls').onclick = () => {
  const open = document.querySelector('.app').classList.toggle('is-open');
  $('toggleControls').setAttribute('aria-expanded', String(open));
};
