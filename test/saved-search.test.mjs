import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBridge } from './helpers/bridge.mjs';

test('saved history search pages through old and interleaved messages within one file snapshot', async () => {
  const team = [
    { id: 'a1', driver: 'fake', role: 'orchestrator', name: 'Lead' },
    { id: 'a2', driver: 'fake', role: 'coder', name: 'Dev' },
  ];
  const bridge = await startBridge({ team, rules: [] });
  try {
    const id = 'saved-search';
    const runDir = path.join(bridge.logs, id);
    const transcript = path.join(runDir, 'transcript.jsonl');
    const query = 'find this';
    const lines = [
      { seq: 1, kind: 'state', workDir: bridge.work, at: 1, team },
      { seq: 2, kind: 'user', text: 'Find this in the early history', at: 2 },
      ...Array.from({ length: 22000 }, (_, index) => ({ seq: index + 3, kind: 'system', text: 'activity' })),
      { seq: 22003, kind: 'delta', agent: 'a1', key: 'same', text: 'prefix: find', at: 10 },
      { seq: 22004, kind: 'delta', agent: 'a2', key: 'same', text: 'wrong draft', at: 11 },
      { seq: 22005, kind: 'delta', agent: 'a1', key: 'same', text: ' this in a stream' },
      { seq: 22006, kind: 'text', agent: 'a2', key: 'same', text: 'find this in the final text', final: true },
      { seq: 22007, kind: 'turnEnd', agent: 'a1', text: 'transcript can use deltas only' },
    ];
    await mkdir(runDir);
    await writeFile(transcript, lines.map((event) => JSON.stringify(event)).join('\n') + '\nnull\n');
    await bridge.api('restore', { id });
    await bridge.waitFor((event) => event.kind === 'state' && event.conversationId === id);
    const unauthorized = await fetch('http://127.0.0.1:' + bridge.port + '/api/searchTranscript', { method: 'POST' });
    assert.equal(unauthorized.status, 403);

    const late = JSON.stringify({ kind: 'user', seq: 99999, text: 'find this after page one' });
    await appendFile(transcript, late.slice(0, -1));
    const first = await bridge.api('searchTranscript', { query, limit: 1 });
    assert.deepEqual(first.results, [{ author: 'You', at: 2, openSeq: 2, excerpt: 'Find this in the early history' }]);
    assert.ok(first.cursor);
    await appendFile(transcript, '}\n');
    await assert.rejects(
      bridge.api('searchTranscript', { query: 'other query', cursor: first.cursor }),
      /invalid saved history search cursor/,
    );

    const second = await bridge.api('searchTranscript', { query, cursor: first.cursor, limit: 1 });
    assert.deepEqual(second.results, [{ author: 'Lead', at: 10, openSeq: 22003, excerpt: 'prefix: find this in a stream' }]);
    const third = await bridge.api('searchTranscript', { query, cursor: second.cursor });
    assert.deepEqual(third.results, [{ author: 'Dev', at: 11, openSeq: 22004, excerpt: 'find this in the final text' }]);
    assert.equal(third.cursor, null);

    const after = await bridge.api('searchTranscript', { query: 'after page one' });
    assert.deepEqual(
      after.results.map((event) => event.openSeq),
      [99999],
    );
    await bridge.api('new', { workDir: bridge.work });
    await assert.rejects(bridge.api('searchTranscript', { query, cursor: first.cursor }), /invalid saved history search cursor/);
  } finally {
    await bridge.stop();
  }
});
