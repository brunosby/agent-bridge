// Entry point of the page. The feature modules below register their buttons when imported.
import './features/add-agent.js';
import './features/settings.js';
import './features/conversations.js';
import './features/controls.js';
import { cards, store } from './core/store.js';
import { api, connect } from './core/api.js';
import { $ } from './core/dom.js';
import { renderState } from './features/agents.js';
import { addSys } from './features/conversation-log.js';
export async function loadCatalog() {
  store.catalog = await api('catalog');
  const r = $('routing');
  const v = r.value;
  r.textContent = '';
  for (const m of store.catalog.routingModes) {
    const o = new Option(m.label, m.id);
    o.title = m.rule;
    r.appendChild(o);
  }
  r.value = store.state?.routingMode || v || 'orchestrator';
  for (const c of Object.values(cards)) c.role.dataset.sig = '';
  if (store.state) renderState();
}

loadCatalog()
  .catch((e) => addSys(`Could not load settings: ${e.message}`, true))
  .finally(connect);
