// Talking to the local server: API calls and the live event stream.
import { store } from './store.js';
import { addSys, handle } from '../features/conversation-log.js';
export const TOKEN = document.querySelector('meta[name="bridge-token"]').content;

export async function api(action, body = {}) {
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export function connect() {
  const es = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === 'reset') {
      store.lastSeq = 0;
    } else if (ev.kind === 'state' && !ev.seq) {
      // snapshot sent before the history replay
    } else {
      if (ev.seq <= store.lastSeq) return; // replayed history after a reconnect
      store.lastSeq = ev.seq;
    }
    handle(ev);
  };
  es.onerror = () => addSys('Connection to the bridge lost. Retrying...', true);
}
