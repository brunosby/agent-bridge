import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

test('markdown renders tables and keeps inline code intact inside and outside them', async () => {
  const window = new Window({ url: 'http://localhost' });
  window.document.body.innerHTML = '<div id="log"></div>';
  Object.assign(globalThis, { document: window.document });
  try {
    const { renderMarkdown } = await import('../public/js/core/dom.js');
    const box = window.document.createElement('div');
    const text = [
      'Prioridade alta para `a.css`, com `darkMode: true`.',
      '| # | Melhoria | Custo |',
      '|---|---|---|',
      '| 1 | Roda o `audit.mjs` e `npm run check` | ~0 |',
      '| 2 | Cores `#1B5772` \\| `a|b` | < 44 px |',
      'Depois da tabela.',
    ].join('\n');
    renderMarkdown(box, text);
    const [before, wrap, after] = box.children;
    assert.equal(before.tagName, 'P');
    assert.deepEqual(
      [...before.querySelectorAll('code')].map((c) => c.textContent),
      ['a.css', 'darkMode: true'],
    );
    assert.equal(wrap.className, 'md-table');
    const rows = [...wrap.querySelectorAll('tr')].map((tr) => [...tr.children].map((cell) => cell.textContent));
    assert.deepEqual(rows, [
      ['#', 'Melhoria', 'Custo'],
      ['1', 'Roda o audit.mjs e npm run check', '~0'],
      ['2', 'Cores #1B5772 | a|b', '< 44 px'],
    ]);
    assert.deepEqual(
      [...wrap.querySelectorAll('td code')].map((c) => c.textContent),
      ['audit.mjs', 'npm run check', '#1B5772', 'a|b'],
    );
    assert.equal(after.textContent, 'Depois da tabela.');
    // Pipes without a --- rule stay plain text.
    renderMarkdown(box, 'a | b | c');
    assert.equal(box.querySelector('table'), null);
  } finally {
    await window.happyDOM.close();
  }
});
