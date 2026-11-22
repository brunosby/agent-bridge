import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { get } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { BodyTooLargeError, readJson } from '../src/server/request-body.ts';
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

test('the local page requires its listening authority and a matching browser origin', async () => {
  const bridge = await startBridge({ team: [{ driver: 'fake', role: 'coder', name: 'Dev' }], rules: [] });
  const port = bridge.port;
  const page = (headers) =>
    new Promise((resolve, reject) => {
      get({ hostname: '127.0.0.1', port, path: '/', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).once('error', reject);
    });
  try {
    assert.equal(await page({ host: 'localhost:' + port, origin: 'http://localhost:' + port }), 200);
    assert.equal(await page({ host: 'example.invalid:' + port }), 403);
    assert.equal(await page({ host: 'localhost:' + (port + 1) }), 403);
    assert.equal(await page({ origin: 'http://example.invalid' }), 403);
  } finally {
    await bridge.stop();
  }
});

test('JSON preserves fragmented UTF-8 and enforces the byte limit while streaming', async () => {
  const data = Buffer.from(JSON.stringify('ação 🙂'));
  assert.equal(await readJson(Readable.from(Array.from(data, (byte) => Buffer.from([byte])))), 'ação 🙂');
  const exact = Buffer.from(JSON.stringify('é'.repeat(499999)));
  assert.equal(exact.length, 1_000_000);
  assert.equal((await readJson(Readable.from([exact]))).length, 499999);
  const input = new PassThrough();
  const rejected = assert.rejects(readJson(input), BodyTooLargeError);
  input.write(exact);
  input.write(Buffer.from(' '));
  await rejected;
  assert.equal(input.listenerCount('data'), 0);
  input.end();
});
