import { api } from '../core/api.js';
import { $, h, time } from '../core/dom.js';

export function bindSavedSearch({ isLoaded, open }) {
  const input = $('logSearch');
  const start = $('searchSavedHistory');
  const panel = $('savedSearchResults');
  const list = $('savedSearchMatches');
  const status = $('savedSearchStatus');
  const more = $('savedSearchMore');
  let version = 0;
  let cursor = null;

  function reset() {
    version += 1;
    cursor = null;
    panel.hidden = true;
    list.replaceChildren();
    status.textContent = '';
    more.hidden = true;
    more.disabled = false;
    start.disabled = !input.value.trim();
  }

  async function find(append = false) {
    if (!append) reset();
    const query = input.value.trim();
    if (!query) return;
    const current = ++version;
    panel.hidden = false;
    start.disabled = true;
    more.disabled = true;
    status.textContent = 'Searching saved history...';
    try {
      const page = await api('searchTranscript', { query, cursor: cursor || undefined });
      if (current !== version) return;
      cursor = page.cursor;
      for (const { author, at, excerpt, openSeq } of page.results) {
        const item = h('li', 'saved-search__match');
        const meta = h('div', 'hint', at ? author + ' \u00b7 ' + time(at) : author);
        const snippet = h('div', null, excerpt);
        item.append(meta, snippet);
        if (isLoaded(openSeq)) {
          const button = h('button', 'btn', 'Open message');
          button.onclick = () => open(openSeq);
          item.append(button);
        } else item.append(h('div', 'hint', 'Outside loaded history'));
        list.appendChild(item);
      }
      more.hidden = !cursor;
      status.textContent = list.children.length ? list.children.length + ' saved result(s)' : 'No saved messages found';
    } catch (error) {
      if (current === version) status.textContent = 'Saved history search failed: ' + error.message;
    } finally {
      if (current === version) {
        start.disabled = false;
        more.disabled = false;
      }
    }
  }

  start.onclick = () => find();
  more.onclick = () => find(true);
  input.addEventListener('input', reset);
  reset();
  return reset;
}
