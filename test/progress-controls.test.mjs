import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { startBridge } from './helpers/bridge.mjs';

function page(t) {
  const win = new Window({ url: 'http://localhost', width: 1440 });
  win.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  const style = win.document.createElement('style');
  style.textContent = readFileSync(new URL('../public/css/components/progress.css', import.meta.url), 'utf8');
  win.document.head.append(style);
  for (const [key, value] of Object.entries({
    document: win.document,
    window: win,
    localStorage: win.localStorage,
    ResizeObserver: win.ResizeObserver,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  t.after(() => win.happyDOM.close());
  return win;
}

test('changing only the progress layout persists and publishes the position without a chat notice', async (t) => {
  const b = await startBridge({ team: [{ driver: 'fake', role: 'coder', name: 'Dev' }], rules: [] });
  t.after(() => b.stop());
  let seq = (await b.waitFor((e) => e.kind === 'state' && e.team[0]?.available)).seq;
  const notice = (e) => e.kind === 'system' && e.text === 'Settings saved.';
  for (const progressLayout of ['top', 'sidebar']) {
    await b.api('settings', { progressLayout });
    const state = await b.waitFor((e) => e.kind === 'state' && e.seq > seq && e.progressLayout === progressLayout);
    assert.equal((await b.api('catalog')).settings.progressLayout, progressLayout);
    assert.equal(JSON.parse(readFileSync(join(b.root, 'config.local.json'), 'utf8')).progressLayout, progressLayout);
    assert.ok(!b.events.some(notice));
    seq = state.seq;
  }
  await b.api('settings', { progressLayout: 'top', autoRelay: false });
  await b.waitFor((e) => notice(e) && e.seq > seq);
});

test('position shortcut submits just the layout, handles a failed save and preserves independent chevrons', async (t) => {
  const win = page(t);
  const { renderProgress } = await import('../public/js/features/request-progress.js');
  const state = {
    conversationId: 'controls',
    progress: [{ seq: 1, start: 1, text: 'Review', status: 'Done', tasks: [], stages: [], reasons: [] }],
  };
  const host = win.document.getElementById('requestProgress');
  const toggle = () => host.querySelector('[data-focus="toggle"]');
  const position = () => host.querySelector('[data-focus="position"]');
  const chevron = (expanded, angle) => {
    assert.equal(toggle().getAttribute('aria-expanded'), String(expanded));
    assert.equal(toggle().getAttribute('aria-label'), expanded ? 'Collapse progress' : 'Expand progress');
    assert.equal(toggle().querySelector('.progress-chevron').textContent, '»');
    assert.equal(win.getComputedStyle(toggle()).getPropertyValue('--chevron-angle').trim() || '0deg', angle);
  };
  const calls = [];
  let fail = true;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, '/api/settings');
    const changes = JSON.parse(opts.body);
    calls.push(changes);
    if (fail) return Response.json({ error: 'Unavailable' }, { status: 500 });
    Object.assign(state, changes);
    renderProgress(state);
    return Response.json({ ok: true });
  });
  renderProgress(state, true);
  chevron(true, '0deg');
  toggle().click();
  chevron(false, '180deg');
  await position().onclick();
  assert.match(host.querySelector('[role=alert]').textContent, /Unavailable/);
  assert.equal(host.parentNode.id, 'progressDock');
  fail = false;
  await position().onclick();
  assert.equal(host.parentNode.id, 'progressTop');
  assert.equal(host.querySelector('[role=alert]'), null);
  chevron(true, '-90deg');
  toggle().click();
  chevron(false, '90deg');
  await position().onclick();
  chevron(false, '180deg');
  assert.deepEqual(calls, [{ progressLayout: 'top' }, { progressLayout: 'top' }, { progressLayout: 'sidebar' }]);
});

test('the right divider restores width, handles dragging and keyboard input, and keeps space for the chat', async (t) => {
  const win = page(t);
  const divider = win.document.getElementById('progressResizer');
  const app = divider.closest('.app');
  const left = win.document.getElementById('workspaceResizer');
  let viewport = 1440;
  Object.defineProperty(app, 'clientWidth', { get: () => viewport });
  for (const separator of [left, divider]) Object.defineProperty(separator, 'offsetWidth', { value: 12 });
  let resize;
  class LayoutObserver {
    constructor(callback) {
      resize = callback;
    }
    observe() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: LayoutObserver, configurable: true });
  const storage = win.localStorage;
  storage.setItem('agent-bridge-progress-width', '416');
  await import('../public/js/features/workspace-resize.js');
  const width = () => Number(divider.getAttribute('aria-valuenow'));
  const key = (key) => divider.dispatchEvent(new win.KeyboardEvent('keydown', { key }));
  assert.equal(width(), 416);
  key('ArrowLeft');
  assert.equal(width(), 432);
  key('ArrowRight');
  assert.equal(width(), 416);
  key('Home');
  assert.equal(width(), 240);
  key('End');
  assert.equal(width(), 640);
  const pointer = (type, x) => divider.dispatchEvent(new win.PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX: x }));
  divider.setPointerCapture = () => {};
  pointer('pointerdown', 200);
  pointer('pointermove', 264);
  pointer('lostpointercapture', 264);
  assert.equal(width(), 576);
  assert.equal(storage.getItem('agent-bridge-progress-width'), '576');
  viewport = 900;
  resize();
  assert.equal(width(), 900 - 256 - 24 - 360);
  viewport = 1440;
  resize();
  assert.equal(width(), 576);
  assert.equal(left.getAttribute('aria-valuenow'), '256');
});
