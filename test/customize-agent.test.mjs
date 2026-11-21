import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('customizing a recommendation saves values to its card until Add selected is clicked', async () => {
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  const requests = [];
  Object.assign(globalThis, {
    document: window.document,
    Option: function Option(text, value) {
      const option = window.document.createElement('option');
      option.textContent = text;
      option.value = value;
      return option;
    },
    fetch: async (url, next) => {
      const action = String(url).split('/').at(-1);
      const body = JSON.parse(next.body);
      requests.push({ action, body });
      const models =
        body.driver === 'fake'
          ? [{ value: 'first', label: 'First model', efforts: ['high'] }]
          : [{ value: 'second', label: 'Second model' }];
      return { ok: true, json: async () => ({ models, results: [] }) };
    },
  });
  try {
    const { store } = await import('../public/js/core/store.js');
    const { renderRoleRecommendation } = await import('../public/js/features/approvals.js');
    store.state = { team: [{ id: 'a1', name: 'Lead', role: 'orchestrator', driver: 'fake' }], workDir: 'workspace' };
    store.catalog.drivers = [
      { id: 'fake', label: 'Fixture One', available: true },
      { id: 'another', label: 'Fixture Two', available: true },
    ];
    store.catalog.roles = [{ id: 'reviewer', name: 'Reviewer' }];
    renderRoleRecommendation({
      agent: 'a1',
      requestId: 'recommend-fixture',
      roles: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          reason: 'check changes',
          suggestion: { driver: 'fake', driverLabel: 'Fixture One', model: 'first', modelLabel: 'First model', name: 'Quality' },
        },
      ],
    });
    const get = (id) => window.document.getElementById(id);
    const button = (label) => [...get('pending').querySelectorAll('button')].find((element) => element.textContent === label);
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    button('Customize').click();
    await settle();
    assert.equal(get('addRole').value, 'reviewer');
    assert.equal(get('addRole').disabled, true);
    assert.equal(get('addModel').value, 'first');
    assert.equal(get('addName').value, 'Quality');
    get('addEffort').value = 'high';
    get('addDriver').value = 'another';
    get('addDriver').onchange();
    await settle();
    assert.equal(get('addModel').value, 'default');
    assert.equal(get('addEffort').value, 'default');
    get('addConfirm').click();
    await settle();
    assert.match(get('pending').textContent, /Fixture Two.*default model/);
    assert.equal(
      requests.some((request) => request.action === 'addAgent'),
      false,
    );
    button('Restore suggestion').click();
    assert.match(get('pending').textContent, /Fixture One.*First model.*Quality/);
    button('Add selected').click();
    await settle();
    assert.equal(requests.at(-1).action, 'resolveRecommendedRoles');
    assert.deepEqual(requests.at(-1).body.selected, [{ role: 'reviewer' }]);
  } finally {
    await window.happyDOM.close();
  }
});
