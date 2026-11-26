// Entry point of the page. The feature modules below register their buttons when imported.
import { openSetup } from './features/setup.js';
import { bindProgress } from './features/request-progress.js';
import './features/add-agent.js';
import './features/settings.js';
import './features/conversations.js';
import './features/controls.js';
import './features/workspace-resize.js';
import { cards, store } from './core/store.js';
import { api, connect, initializeSession } from './core/api.js';
import { $ } from './core/dom.js';
import { renderState } from './features/agents.js';
import { addSys } from './features/conversation-log.js';
import { setupRequestNotifications } from './features/request-notifications.js';
bindProgress(() => store.state);
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

setupRequestNotifications();
initializeSession()
  .then(loadCatalog)
  .then(() => {
    connect();
    if (store.catalog.setupCompleted === false) openSetup();
  })
  .catch((e) => addSys(e.message, true));
