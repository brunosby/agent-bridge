import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('chat follows the initial replay and respects scrolling during streaming and reconnection', async () => {
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  let nextFrame = 0;
  const frames = new Map();
  Object.assign(globalThis, {
    document: window.document,
    requestAnimationFrame: (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const paint = () => {
    const scheduled = [...frames.values()];
    frames.clear();
    for (const callback of scheduled) callback();
  };
  const $ = (id) => window.document.getElementById(id);
  const log = $('log');
  const back = $('returnToEnd');
  let top = 250;
  let height = 1000;
  Object.defineProperties(log, {
    clientHeight: { value: 200 },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => top,
      set: (value) => {
        top = Math.min(value, height - log.clientHeight);
      },
    },
  });
  const scroll = (position) => {
    log.scrollTop = position;
    log.dispatchEvent(new window.Event('scroll'));
  };
  try {
    const { handle, jumpToSequence } = await import('../public/js/features/conversation-log.js');
    handle({ kind: 'user', seq: 1, text: 'first message', at: 1 });
    handle({ kind: 'replayComplete' });
    assert.equal(log.scrollTop, 800);
    height = 1040;
    paint();
    assert.equal(log.scrollTop, 840, 'initial replay also follows the next layout frame');

    log.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -30 }));
    scroll(810);
    height = 1100;
    handle({ kind: 'delta', seq: 2, key: 'a', agent: 'dev', text: 'stream', at: 2 });
    paint();
    assert.equal(log.scrollTop, 810);
    assert.match(back.textContent, /1 new/);

    handle({ kind: 'replayComplete' });
    paint();
    assert.equal(log.scrollTop, 810, 'reconnecting does not return the reader to the end');
    assert.equal(back.hidden, false);
    back.click();
    assert.equal(log.scrollTop, 900);
    assert.equal(back.hidden, true);

    height = 1000;
    scroll(800);
    height = 1080;
    handle({ kind: 'delta', seq: 3, key: 'a', agent: 'dev', text: ' continues', at: 3 });
    paint();
    assert.equal(log.scrollTop, 880, 'layout shrink does not disable following');

    scroll(550);
    assert.equal(back.hidden, false);
    scroll(880);
    assert.equal(back.hidden, true, 'scrolling down to the end enables following');
    assert.equal(jumpToSequence(1), true);
    assert.equal(back.hidden, false, 'jumping to search results disables following');

    handle({ kind: 'delta', seq: 4, key: 'summary', agent: 'dev', text: 'Full report\n[[SUM', at: 4 });
    paint();
    assert.doesNotMatch(log.lastElementChild.textContent, /\[\[SUM/);
    handle({
      kind: 'text',
      seq: 5,
      key: 'summary',
      agent: 'dev',
      text: 'Full report\n[[SUMMARY]]\nChecked **two** files\n[[/SUMMARY]]',
      final: true,
      at: 5,
    });
    paint();
    const message = log.lastElementChild;
    assert.match(message.textContent, /Full report/);
    assert.equal(message.querySelector('.reply-summary > strong').textContent, 'Summary');
    assert.equal(message.querySelector('.reply-summary p strong').textContent, 'two');
    assert.doesNotMatch(message.textContent, /\[\[/);

    handle({ kind: 'reset' });
    scroll(0);
    handle({ kind: 'replayComplete' });
    paint();
    assert.equal(log.scrollTop, 880, 'a restored conversation starts at the end');
    assert.equal(back.hidden, true);
  } finally {
    await window.happyDOM.close();
  }
});
