import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startBridge } from './helpers/bridge.mjs';

test('an invalid role decision preserves the pending request and logs no URL query', async () => {
  const bridge = await startBridge({
    team: [{ driver: 'fake', role: 'orchestrator', name: 'Lead' }],
    rules: [{ agent: 'Lead', match: 'needs review', reply: '[[NEED_ROLE: reviewer]]' }],
  });
  try {
    await bridge.api('send', { text: 'needs review', target: 'auto' });
    const need = await bridge.waitFor((event) => event.kind === 'needRole');
    await assert.rejects(
      bridge.api('resolveRole?token=fake-query-secret', { requestId: need.requestId, action: 'invalid' }),
      /unknown role decision/,
    );
    assert.equal(
      bridge.events.some((event) => event.kind === 'needRoleClosed'),
      false,
    );
    const errors = await readFile(path.join(bridge.logs, bridge.state().conversationId, 'errors.log'), 'utf8');
    assert.match(errors, /POST \/api\/resolveRole: Error: unknown role decision/);
    assert.doesNotMatch(errors, /token=|fake-query-secret/);
    await bridge.api('resolveRole', { requestId: need.requestId, action: 'dismiss' });
    const closed = await bridge.waitFor((event) => event.kind === 'needRoleClosed');
    assert.equal(closed.requestId, need.requestId);
  } finally {
    await bridge.stop();
  }
});
