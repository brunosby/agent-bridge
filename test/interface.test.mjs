import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('transcript filters hide successful tools and preserve failures and pending decisions', async () => {
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  Object.assign(globalThis, {
    document: window.document,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  try {
    const { handle } = await import('../public/js/features/conversation-log.js');
    const $ = (id) => window.document.getElementById(id);
    handle({ kind: 'user', seq: 1, to: ['dev'], text: 'Investigate issue', at: 1 });
    handle({ kind: 'tool', seq: 2, agent: 'dev', key: 'ok', title: 'Check', at: 2 });
    handle({ kind: 'tool', seq: 3, agent: 'dev', key: 'fail', title: 'Build', at: 3 });
    handle({ kind: 'toolResult', seq: 4, agent: 'dev', key: 'ok', ok: true });
    handle({ kind: 'toolResult', seq: 5, agent: 'dev', key: 'fail', ok: false, detail: 'Build failed' });
    handle({ kind: 'turnEnd', seq: 6, agent: 'dev', ok: true });
    handle({
      kind: 'approval',
      seq: 7,
      agent: 'dev',
      title: 'Approval',
      requestId: 'one',
      decisions: ['accept'],
      appliedExceptions: [{ file: 'sample.txt', line: 2, commit: 'abcd1234', rule: 'Credential', reason: 'test fixture' }],
      at: 7,
    });
    handle({ kind: 'replayComplete' });
    assert.match($('pending').textContent, /Applied exceptions.*Credential.*abcd1234.*sample\.txt line 2.*test fixture/s);
    assert.equal($('pendingCount').textContent, '1 pending request');
    assert.ok($('log').querySelector('details.tool-group'));
    $('logMode').value = 'messages';
    $('logMode').dispatchEvent(new window.Event('change'));
    assert.equal($('log').querySelector('details.tool-group').hidden, true);
    assert.equal($('log').querySelector('.tool.fail').hidden, false);
    handle({ kind: 'approvalClosed', seq: 8, requestId: 'one', decision: 'accept' });
    assert.equal($('pendingCount').hidden, true);
  } finally {
    await window.happyDOM.close();
  }
});
