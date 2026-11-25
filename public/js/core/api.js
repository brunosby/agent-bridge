// Talking to the local server: API calls and the live event stream.
import { store } from './store.js';
import { addSys, handle } from '../features/conversation-log.js';
import { observeRequestNotifications } from '../features/request-notifications.js';
import { storageKey } from './browser-session.js';
export { initializeSession } from './browser-session.js';
export async function api(action, body = {}) {
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': globalThis.sessionStorage?.getItem(storageKey) || '' },
    redirect: 'error',
    body: JSON.stringify(body),
  });
  if (res.status === 403) throw new Error('Open Agent Bridge from its shortcut to restore access.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export function connect() {
  const es = new EventSource(`/events?token=${encodeURIComponent(sessionStorage.getItem(storageKey))}`);
  es.addEventListener('session-revoked', () => {
    es.close();
    sessionStorage.removeItem(storageKey);
    addSys('This session has ended. Use the tab opened from the shortcut.', true);
  });
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === 'replayComplete') {
      handle(ev);
      observeRequestNotifications(ev);
      return;
    }
    if (ev.kind === 'reset') {
      store.lastSeq = 0;
    } else if (ev.kind === 'state' && !ev.seq) {
      // snapshot sent before the history replay
    } else {
      if (ev.seq <= store.lastSeq) return; // replayed history after a reconnect
      store.lastSeq = ev.seq;
    }
    handle(ev);
    observeRequestNotifications(ev);
  };
  es.onerror = () => addSys('Connection to the bridge lost. Retrying...', true);
}
