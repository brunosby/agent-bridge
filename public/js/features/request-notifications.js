import { $ } from '../core/dom.js';
import { approvals, label } from '../core/store.js';

const ENABLED_KEY = 'agent-bridge-request-notifications';
const SEEN_KEY = 'agent-bridge-notified-requests';
const NOTICES = {
  approval: ['needs tool approval', 'Review the tool request in Agent Bridge.'],
  needRole: ['needs another role', 'Choose how to continue in Agent Bridge.'],
  finalReview: ['requests final confirmation', 'Review the result in Agent Bridge.'],
};
const CLOSED = new Set(['approvalClosed', 'needRoleClosed', 'finalReviewClosed']);
let notifier;

function read(browser, key) {
  try {
    return browser.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function notified(browser) {
  try {
    const keys = JSON.parse(read(browser, SEEN_KEY) || '[]');
    return new Set(Array.isArray(keys) ? keys : []);
  } catch {
    return new Set();
  }
}

export function createRequestNotifier(browser, { name, openRequest }) {
  const pending = new Map();
  const active = new Map();
  let conversationId = null;
  let replaying = true;
  let lease = null;

  function close(requestId) {
    active.get(requestId)?.close();
    active.delete(requestId);
  }

  function reset(id) {
    conversationId = id;
    replaying = true;
    pending.clear();
    for (const requestId of active.keys()) close(requestId);
  }

  function refresh() {
    if (read(browser, ENABLED_KEY) !== 'on' || browser.Notification.permission !== 'granted') {
      for (const requestId of active.keys()) close(requestId);
      return;
    }
    if (!lease?.release || replaying || !conversationId || (browser.document.visibilityState === 'visible' && browser.document.hasFocus()))
      return;
    const seen = notified(browser);
    for (const event of pending.values()) {
      const key = JSON.stringify([conversationId, event.kind, event.requestId, event.seq]);
      if (seen.has(key) || active.has(event.requestId)) continue;
      if (event.expiresAt && event.expiresAt <= Date.now()) continue;
      const [title, body] = NOTICES[event.kind];
      try {
        const notice = new browser.Notification(name(event.agent) + ' ' + title, { body, tag: key });
        notice.onclick = () => {
          browser.focus();
          openRequest(event.requestId);
          notice.close();
        };
        notice.onclose = () => {
          if (active.get(event.requestId) === notice) active.delete(event.requestId);
        };
        active.set(event.requestId, notice);
        seen.add(key);
        browser.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000)));
      } catch {
        // The browser may block notifications or storage even after permission was granted.
      }
    }
  }

  function observe(event) {
    if (event.kind === 'reset') reset(null);
    else if (event.kind === 'state' && event.conversationId !== conversationId) reset(event.conversationId);
    else if (event.kind === 'replayComplete') {
      replaying = false;
      refresh();
    } else if (Object.hasOwn(NOTICES, event.kind) && event.requestId) {
      pending.set(event.requestId, event);
      refresh();
    } else if (CLOSED.has(event.kind)) {
      pending.delete(event.requestId);
      close(event.requestId);
    }
  }

  function acquire() {
    if (lease) return;
    const controller = new browser.AbortController();
    const claim = { controller, release: null };
    lease = claim;
    browser.navigator.locks
      .request(
        'agent-bridge-notifier',
        { signal: controller.signal },
        () =>
          new Promise((resolve) => {
            if (lease !== claim) return resolve();
            claim.release = resolve;
            refresh();
          }),
      )
      .catch(() => {
        if (lease === claim) lease = null;
      });
  }

  browser.addEventListener('pagehide', () => {
    const claim = lease;
    lease = null;
    claim?.controller.abort();
    claim?.release?.();
    for (const requestId of active.keys()) close(requestId);
  });
  browser.addEventListener('pageshow', acquire);
  browser.addEventListener('blur', refresh);
  browser.document.addEventListener('visibilitychange', refresh);
  acquire();
  return { observe, refresh };
}

export function setupRequestNotifications() {
  const toggle = $('requestNotifications');
  const button = $('enableRequestNotifications');
  const status = $('requestNotificationsStatus');
  if (!window.Notification || !window.navigator.locks) {
    button.hidden = true;
    status.textContent = 'Browser notifications are unavailable here.';
    return;
  }

  notifier = createRequestNotifier(window, {
    name: (id) => label(id) || 'An agent',
    openRequest: (id) => {
      const card = approvals.get(id);
      card?.scrollIntoView({ block: 'nearest' });
      card?.querySelector('button')?.focus({ preventScroll: true });
    },
  });
  function render() {
    const permission = window.Notification.permission;
    toggle.checked = permission === 'granted' && read(window, ENABLED_KEY) === 'on';
    toggle.disabled = permission !== 'granted';
    button.hidden = permission !== 'default';
    button.disabled = false;
    status.textContent =
      permission === 'denied' ? 'Notifications are blocked in this browser.' : 'This preference applies to this browser.';
    notifier.refresh();
  }

  function setEnabled(enabled) {
    window.localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off');
  }

  toggle.onchange = () => {
    try {
      setEnabled(toggle.checked);
      render();
    } catch {
      status.textContent = 'Could not save the browser notification preference.';
    }
  };
  button.onclick = async () => {
    button.disabled = true;
    try {
      if ((await window.Notification.requestPermission()) === 'granted') setEnabled(true);
      render();
    } catch {
      render();
      status.textContent = 'Could not enable browser notifications.';
    }
  };
  window.addEventListener('storage', (event) => {
    if (event.key === ENABLED_KEY || event.key === null) render();
  });
  window.addEventListener('focus', render);
  render();
}

export function observeRequestNotifications(event) {
  notifier?.observe(event);
}
