import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS } from '../src/config/settings.ts';
import { Window } from 'happy-dom';

test('settings sections support search, typed edits, partial saves, manual-mode focus and project hook actions', async (t) => {
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
  const schema = { ...SETTINGS, futureSetting: { type: 'string', default: 'future' } };
  const settings = Object.fromEntries(Object.entries(schema).map(([key, def]) => [key, def.default]));
  const saved = [];
  const hookCalls = [];
  let hook = { existing: true, enabled: false, signature: 'old' };
  let hookError = false;
  let confirmation = false;
  globalThis.confirm = () => confirmation;
  globalThis.Option = function (text, value) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const body = JSON.parse(opts.body);
    let result = {};
    if (url === '/api/catalog') result = { settingsSchema: schema, settings: { ...settings }, routingModes: [], roles: [] };
    if (url === '/api/settings') {
      saved.push(body);
      Object.assign(settings, body);
      result = { settings: { ...settings } };
    }
    if (url === '/api/accounts')
      result = {
        accounts: [
          { state: 'logged_out', label: 'Fixture' },
          { state: 'ok', label: 'Ready' },
        ],
      };
    if (url === '/api/skills') result = { installed: [], roles: {} };
    if (url === '/api/publicationHook') {
      hookCalls.push(body);
      if (hookError) return { ok: false, json: async () => ({ error: 'Custom hooks directory.' }) };
      if ('enabled' in body) hook = { existing: body.enabled, enabled: body.enabled, signature: 'updated' };
      result = hook;
    }
    return { ok: true, json: async () => result };
  });
  const { SETTING_LAYOUT } = await import('../public/js/features/settings.js');
  const { store } = await import('../public/js/core/store.js');
  store.state = {
    team: [],
    relay: { auto: true },
    project: { name: 'Fixture', branch: 'main', git: true },
    conversationId: 'test',
    milestoneCommitAvailable: true,
  };
  const find = (s) => document.querySelector(s);
  const key = (k) => find('[data-key="' + k + '"]');
  const input = (el) => el.dispatchEvent(new win.Event('input', { bubbles: true }));
  const search = (q) => {
    find('#settingsSearch').value = q;
    input(find('#settingsSearch'));
  };
  const open = () => find('#openSettings').onclick();
  await open();
  assert.equal(find('#relayControls input[type=checkbox]'), null);
  for (const name of Object.keys(schema)) {
    assert.equal(document.querySelectorAll('[data-key="' + name + '"]').length, 1, name);
    assert.equal(key(name).closest('section').id, 'tab-' + (SETTING_LAYOUT[name]?.[0] ?? 'other'), name);
  }
  assert.equal(find('#accountsCount').textContent, '1');
  assert.equal(key('autoRelay').checked, false);
  assert.equal(key('routingMode').tagName, 'SELECT');
  assert.equal(key('autoRelay').getAttribute('role'), 'switch');
  assert.equal(key('progressLayout').getAttribute('role'), 'radiogroup');
  const manual = key('autoRelay');
  manual.checked = true;
  input(manual);
  const hops = key('maxHops');
  hops.value = '0';
  input(hops);
  assert.match(hops.closest('.setting-row').textContent, /Automatic hand-offs off/);
  hops.value = '4';
  input(hops);
  assert.match(hops.closest('.setting-row').textContent, /Small task 4 · medium 8 · large 16/);
  assert.match(key('tokenLimit').closest('.setting-row').textContent, /no limit/);
  key('bypassNewAgents').checked = true;
  input(key('bypassNewAgents'));
  assert.equal(key('bypassNewAgents').closest('.setting-row').querySelector('.setting-warning').hidden, false);
  assert.equal(find('#settingsMsg').textContent, '3 unsaved changes');
  assert.ok(find('#settingsNav [data-section=flow]').classList.contains('is-changed'));
  find('#closeSettings').click();
  assert.ok(find('#settingsDialog').open);
  const cancel = new win.Event('cancel', { cancelable: true });
  find('#settingsDialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  find('#discardSettings').click();
  assert.equal(manual.checked, false);
  assert.equal(hops.value, '8');
  assert.equal(find('#saveSettings').disabled, true);
  const details = key('destructivePatterns').closest('details');
  assert.equal(details.open, false);
  search('destructivePatterns');
  assert.equal(find('#tab-safety').hidden, false);
  assert.equal(details.open, true);
  assert.equal(find('#tab-general').hidden, true);
  search('nothing-matches-here');
  assert.equal(find('#settingsEmpty').hidden, false);
  search('');
  assert.equal(details.open, false);
  key('autoRelay').checked = true;
  key('maxHops').value = '12';
  key('destructivePatterns').value = 'first\nsecond';
  key('progressLayout').querySelector('input[value=top]').click();
  key('routingMode').value = 'pipeline';
  input(key('autoRelay'));
  await find('#saveSettings').onclick();
  assert.deepEqual(saved, [
    { autoRelay: false, maxHops: 12, destructivePatterns: ['first', 'second'], progressLayout: 'top', routingMode: 'pipeline' },
  ]);
  assert.ok(find('#saveSettings').disabled);
  const hookBtn = find('#changeHook');
  assert.equal(find('#hookStatus').textContent, 'Another hook exists');
  await hookBtn.onclick();
  assert.equal(hookCalls.length, 1);
  confirmation = true;
  await hookBtn.onclick();
  assert.deepEqual(hookCalls.at(-1), { enabled: true, signature: 'old', conversationId: 'test' });
  assert.equal(find('#hookStatus').textContent, 'Installed');
  await hookBtn.onclick();
  assert.equal(find('#hookStatus').textContent, 'Not installed');
  find('#settingsDialog').close();
  store.state.relay.auto = false;
  store.state.milestoneCommitAvailable = false;
  hookError = true;
  await find('#manualModeSettings').onclick();
  assert.equal(find('#tab-flow').hidden, false);
  assert.equal(document.activeElement, key('autoRelay'));
  assert.equal(key('autoRelay').checked, true);
  assert.equal(key('milestoneCommitMode'), null);
  assert.match(find('#tab-project').textContent, /orchestrator mode/);
  assert.match(find('#hookStatus').textContent, /unavailable/);
  find('#settingsDialog').close();
  store.state.project.git = false;
  const calls = hookCalls.length;
  await open();
  assert.equal(hookCalls.length, calls);
  assert.match(find('#hookStatus').textContent, /not a Git repository/);
  key('userName').value = 'Draft';
  input(key('userName'));
  find('#closeSettings').click();
  assert.equal(find('#settingsDialog').open, false);
});
