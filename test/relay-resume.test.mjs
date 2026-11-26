import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from './helpers/bridge.mjs';

const team = [
  { driver: 'fake', role: 'orchestrator', name: 'Lead' },
  { driver: 'fake', role: 'coder', name: 'Dev' },
  { driver: 'fake', role: 'researcher', name: 'Research' },
];

test('a batch returns at the limit and Resume delivers the next delegation once', async () => {
  const bridge = await startBridge({
    team,
    settings: { maxHops: 2 },
    rules: [
      { agent: 'Lead', match: 'Results from 2 agents', reply: '@a3 follow up' },
      { agent: 'Lead', match: 'follow-up complete', reply: 'All results received.\n[[DONE]]' },
      { agent: 'Research', match: 'follow up', reply: 'follow-up complete' },
      { agent: 'Lead', match: 'start', reply: '@a2 build\n@a3 inspect' },
      { agent: 'Dev', reply: 'build ready' },
      { agent: 'Research', reply: 'inspection ready' },
    ],
  });
  try {
    await bridge.api('send', { text: 'start' });
    await bridge.waitFor((ev) => ev.kind === 'state' && ev.relay.limitPause === 'hops' && ev.relay.held === 1);
    assert.equal(bridge.events.filter((ev) => ev.kind === 'routed' && ev.to === 'a1').length, 1);
    assert.equal(bridge.state().relay.hops, 2);
    await bridge.api('relay', { auto: false });
    await bridge.api('relay', { resume: true });
    await bridge.waitFor((ev) => ev.kind === 'system' && ev.text.includes('Turn off manual mode in Settings > General'));
    await bridge.api('relay', { auto: true });
    await Promise.all([bridge.api('relay', { resume: true }), bridge.api('relay', { resume: true })]);
    await bridge.waitFor((ev) => ev.kind === 'text' && ev.text.includes('All results received.'));
    assert.equal(bridge.events.filter((ev) => ev.kind === 'routed' && ev.to === 'a3').length, 2);
    assert.deepEqual(
      bridge.events.filter((ev) => ev.kind === 'routed' && ev.from === 'a1').map((ev) => ev.hop),
      [1, 2, 1],
    );
  } finally {
    await bridge.stop();
  }
});

test('token-limit pause holds every completed reply and Resume checks the new limit', async () => {
  const bridge = await startBridge({
    team,
    settings: { routingMode: 'mentions', tokenLimit: 50 },
    rules: [
      { agent: 'Dev|Research', reply: '@a1 finished' },
      { agent: 'Lead', match: 'Message from @', reply: 'Noted.\n[[DONE]]' },
      { agent: 'Lead', reply: 'Noted.' },
    ],
  });
  try {
    await bridge.api('send', { text: 'start', target: 'all' });
    await bridge.waitFor((ev) => ev.kind === 'state' && ev.relay.limitPause === 'tokens' && ev.relay.held === 2);
    await bridge.api('relay', { resume: true });
    await bridge.waitFor((ev) => ev.kind === 'system' && ev.text.includes('still reached'));
    assert.equal(bridge.events.filter((ev) => ev.kind === 'routed').length, 0);
    await bridge.api('settings', { tokenLimit: 0 });
    await bridge.api('relay', { resume: true });
    await bridge.waitFor((ev) => ev.kind === 'state' && ev.relay.held === 0 && ev.relay.hops === 2);
    const routes = bridge.events.filter((ev) => ev.kind === 'routed');
    assert.deepEqual(routes.map((ev) => ev.from).sort(), ['a2', 'a3']);
    assert.ok(routes.every((ev) => ev.to === 'a1'));
  } finally {
    await bridge.stop();
  }
});

test('stop and a new message independently clear held hand-offs', async () => {
  const bridge = await startBridge({
    team,
    settings: { maxHops: 0 },
    rules: [
      { agent: 'Lead', match: 'delegate', reply: '@a2 do it' },
      { agent: 'Lead', reply: 'Acknowledged.\n[[DONE]]' },
    ],
  });
  try {
    await bridge.api('send', { text: 'delegate first' });
    const first = await bridge.waitFor((event) => event.kind === 'state' && event.relay.held === 1);
    await bridge.api('relay', { resume: true });
    await bridge.waitFor((event) => event.kind === 'system' && event.text.includes('still held'));
    await bridge.api('interrupt');
    const stop = await bridge.waitFor(
      (event) => event.kind === 'state' && event.seq > first.seq && event.relay.userPaused && event.relay.held === 0,
    );
    await bridge.api('send', { text: 'delegate again' });
    await bridge.waitFor((event) => event.kind === 'state' && event.seq > stop.seq && event.relay.held === 1);
    await bridge.api('send', { text: 'new direction' });
    await bridge.waitFor((event) => event.kind === 'system' && event.text.includes('Your new message takes precedence.'));
    assert.ok(!bridge.events.some((event) => event.kind === 'routed'));
  } finally {
    await bridge.stop();
  }
});
