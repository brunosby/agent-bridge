import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from './helpers/bridge.mjs';
import { parseSummary } from '../public/js/core/summary-markers.js';
import { buildInstructions } from '../src/core/prompts.ts';

const team = [
  { driver: 'fake', role: 'orchestrator', name: 'Lead' },
  { driver: 'fake', role: 'coder', name: 'Dev' },
  { driver: 'fake', role: 'reviewer', name: 'Rev' },
];
const report = (details, summary) => details + '\n[[SUMMARY]]\n' + summary + '\n[[/SUMMARY]]';

test('only a complete trailing summary outside code can replace a report', () => {
  const example = ['```text', '[[SUMMARY]]', 'literal', '[[/SUMMARY]]', '```'].join('\n');
  assert.deepEqual(parseSummary(report(example, 'ready') + '\n[[DONE]]'), { body: example + '\n[[DONE]]', summary: 'ready' });
  for (const input of [
    example,
    'plain',
    'details\n[[SUMMARY]]\nunfinished',
    report('details', ' '),
    report('details', 'ok') + '\nmore details',
  ]) {
    assert.equal(parseSummary(input).summary, '');
  }
  for (const id of ['coder', 'reviewer', 'tester', 'researcher', 'architect', 'orchestrator']) {
    const instructions = buildInstructions({ role: { id } });
    assert.equal(instructions.includes('[[SUMMARY]]'), id !== 'orchestrator');
  }
});

test('a two-agent handoff shortens each report separately and preserves the verdict and stop instruction', async () => {
  const bridge = await startBridge({
    team,
    settings: { maxReviewRounds: 0 },
    rules: [
      { agent: 'Lead', match: 'FULL_DEV|FULL_REV|\\[\\[SUMMARY', reply: 'Unexpected full report' },
      {
        agent: 'Lead',
        match:
          '^(?=[\\s\\S]*from @a2\\]\\nBuilt it)(?=[\\s\\S]*Ask @a2)(?=[\\s\\S]*from @a3\\]\\nCHANGES REQUESTED)(?=[\\s\\S]*limit \\(0\\) reached)(?=[\\s\\S]*Fix the check)(?=[\\s\\S]*Ask @a3)',
        reply: 'Received both summaries.\n[[DONE]]',
      },
      { agent: 'Lead', match: 'delegate work', reply: '@a2 implement\n@a3 review' },
      { agent: 'Dev', reply: report('FULL_DEV', 'Built it') },
      { agent: 'Rev', reply: report('CHANGES REQUESTED\nFULL_REV', 'Fix the check') },
    ],
  });
  try {
    await bridge.api('send', { text: 'delegate work' });
    await bridge.waitFor((e) => e.kind === 'text' && e.text.startsWith('Received both summaries.'));
    assert.ok(bridge.events.some((e) => e.kind === 'text' && e.text.includes('FULL_DEV')));
    const result = await bridge.api('searchTranscript', { query: 'Built it' });
    assert.ok(result.results.some((hit) => hit.excerpt.includes('FULL_DEV') && !hit.excerpt.includes('[[SUMMARY]]')));
  } finally {
    await bridge.stop();
  }
});

test('direct delivery selects content per recipient and honors a settings change and invalid summaries', async () => {
  const bridge = await startBridge({
    team,
    settings: { routingMode: 'mentions' },
    rules: [
      { agent: 'Rev', match: 'broken', reply: '@Lead FULL_BROKEN\n[[SUMMARY]]\nstill typing' },
      { agent: 'Rev', match: 'empty', reply: report('@Lead FULL_EMPTY', '') },
      { agent: 'Rev', match: 'plain', reply: '@Lead FULL_PLAIN' },
      { agent: 'Rev', reply: report('APPROVED\n@Lead @Dev FULL_DETAIL', 'Tests passed.') },
      { agent: 'Lead', match: 'FULL_BROKEN[\\s\\S]*still typing', reply: 'Incomplete received\n[[DONE]]' },
      { agent: 'Lead', match: 'FULL_EMPTY', reply: 'Empty received\n[[DONE]]' },
      { agent: 'Lead', match: 'FULL_PLAIN', reply: 'Plain received\n[[DONE]]' },
      { agent: 'Lead', match: 'FULL_DETAIL', reply: 'Full received\n[[DONE]]' },
      { agent: 'Lead', match: 'from @a3\\]\\nAPPROVED[\\s\\S]*Tests passed[\\s\\S]*Ask @a3', reply: 'Summary received\n[[DONE]]' },
      { agent: 'Dev', match: 'FULL_DETAIL', reply: 'Coder received full findings\n[[DONE]]' },
    ],
  });
  const wait = (prefix) => bridge.waitFor((e) => e.kind === 'text' && e.text.startsWith(prefix));
  try {
    await bridge.api('send', { text: 'review', target: 'a3' });
    await Promise.all([wait('Summary received'), wait('Coder received full findings')]);
    for (const [message, expected] of [
      ['broken', 'Incomplete received'],
      ['empty', 'Empty received'],
      ['plain', 'Plain received'],
    ]) {
      await bridge.api('send', { text: message, target: 'a3' });
      await wait(expected);
    }
    await bridge.api('settings', { summarizeAgentReplies: false });
    await bridge.api('send', { text: 'review', target: 'a3' });
    await wait('Full received');
  } finally {
    await bridge.stop();
  }
});
