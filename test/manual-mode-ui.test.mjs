import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('the manual mode shortcut focuses General settings and saves the existing autoRelay key', async (t) => {
  const win = new Window({ url: 'http://localhost' });
  t.after(() => win.happyDOM.close());
  const { document } = win;
  Object.assign(globalThis, {
    window: win,
    document,
    ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  });
  document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  let autoRelay = true;
  const saved = [];
  const catalog = () => ({ settingsSchema: { autoRelay: { type: 'boolean' } }, settings: { autoRelay }, routingModes: [], roles: [] });
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url === '/api/settings') {
      const body = JSON.parse(opts.body);
      saved.push(body);
      autoRelay = body.autoRelay;
    }
    return { ok: true, json: async () => (url === '/api/catalog' ? catalog() : { settings: { autoRelay } }) };
  });
  await import('../public/js/features/settings.js');
  assert.equal(document.querySelector('#relayControls input[type=checkbox]'), null);
  const shortcut = document.querySelector('#manualModeSettings');
  const toggle = () => document.querySelector('[data-key=autoRelay]');
  await document.querySelector('#openSettings').onclick();
  assert.equal(toggle().checked, false);
  toggle().checked = true;
  await document.querySelector('#saveSettings').onclick();
  assert.deepEqual(saved, [{ autoRelay: false }]);
  document.querySelector('#settingsDialog').close();
  await shortcut.onclick();
  assert.equal(document.querySelector('#tab-general').hidden, false);
  assert.equal(document.activeElement, toggle());
  assert.equal(toggle().checked, true);
  toggle().checked = false;
  await document.querySelector('#saveSettings').onclick();
  assert.deepEqual(saved.at(-1), { autoRelay: true });
});
