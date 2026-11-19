import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

test('only the background notification leader alerts; unfinished requests survive leader changes', async () => {
  const first = new Window({ url: 'http://localhost' });
  const second = new Window({ url: 'http://localhost' });
  globalThis.document = first.document;
  const notices = [];
  const opened = [];
  const focused = [];
  const storage = first.localStorage;
  let lockQueue = Promise.resolve();
  const locks = {
    request(name, { signal }, callback) {
      assert.equal(name, 'agent-bridge-notifier');
      const run = lockQueue.then(() => (signal.aborted ? undefined : callback()));
      lockQueue = run.catch(() => {});
      return run;
    },
  };
  class Notification {
    static permission = 'granted';
    constructor(title, options) {
      this.title = title;
      this.body = options.body;
      this.closed = false;
      notices.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  const browser = (win, tab) => {
    let hidden = false;
    Object.defineProperties(win, {
      Notification: { value: Notification },
      localStorage: { value: storage },
      focus: { value: () => focused.push(tab) },
    });
    Object.defineProperty(win.navigator, 'locks', { value: locks });
    Object.defineProperties(win.document, {
      hasFocus: { value: () => !hidden },
      visibilityState: { get: () => (hidden ? 'hidden' : 'visible') },
    });
    return (away) => {
      hidden = away;
      win.document.dispatchEvent(new win.Event('visibilitychange'));
    };
  };
  const awayFirst = browser(first, 'first');
  const awaySecond = browser(second, 'second');
  const setting = 'agent-bridge-request-notifications';
  storage.setItem(setting, 'on');
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const { createRequestNotifier } = await import('../public/js/features/request-notifications.js');
    const wiring = { name: (id) => id, openRequest: (id) => opened.push(id) };
    const primary = createRequestNotifier(first, wiring);
    const backup = createRequestNotifier(second, wiring);
    const publish = (event) => {
      primary.observe(event);
      backup.observe(event);
    };
    await settled();
    const approval = { seq: 2, kind: 'approval', agent: 'Coder', requestId: 'approval', detail: 'private diff body' };
    publish({ kind: 'state', conversationId: 'chat' });
    publish(approval);
    publish({ ...approval, seq: 3, requestId: 'old' });
    publish({ kind: 'approvalClosed', requestId: 'old' });
    assert.equal(notices.length, 0, 'replay alone does not notify');
    publish({ kind: 'replayComplete' });
    awaySecond(true);
    assert.equal(notices.length, 0, 'focused leader and hidden follower do not announce');

    Notification.permission = 'denied';
    awayFirst(true);
    assert.equal(notices.length, 0);
    Notification.permission = 'granted';
    storage.setItem(setting, 'off');
    primary.refresh();
    assert.equal(notices.length, 0);
    storage.setItem(setting, 'on');
    primary.refresh();
    assert.equal(notices.length, 1);
    assert.match(notices[0].title, /Coder.*tool approval/);
    assert.doesNotMatch(notices[0].body, /private diff body/);
    publish(approval);
    assert.equal(notices.length, 1, 'duplicate request events are ignored');
    notices[0].onclick();
    assert.deepEqual(focused, ['first']);
    assert.deepEqual(opened, ['approval']);
    assert.equal(notices[0].closed, true);

    awayFirst(false);
    publish({ seq: 4, kind: 'needRole', agent: 'Lead', requestId: 'role' });
    assert.equal(notices.length, 1);
    first.dispatchEvent(new first.Event('pagehide'));
    await settled();
    assert.equal(notices.length, 2, 'the next leader announces only the unseen pending role');
    assert.match(notices[1].title, /Lead.*role/);
    publish({ kind: 'needRoleClosed', requestId: 'role' });
    assert.equal(notices[1].closed, true);
    publish({ seq: 5, kind: 'finalReview', agent: 'Lead', requestId: 'review' });
    assert.equal(notices.length, 3);
    publish({ kind: 'reset' });
    assert.equal(notices[2].closed, true);
  } finally {
    first.dispatchEvent(new first.Event('pagehide'));
    second.dispatchEvent(new second.Event('pagehide'));
    await first.happyDOM.close();
    await second.happyDOM.close();
  }
});
