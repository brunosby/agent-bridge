export const storageKey = 'bridge-session';
export async function initializeSession(page = window) {
  const { location, history, sessionStorage } = page;
  const code = new URLSearchParams(location.hash.slice(1)).get('abrir');
  if (code) {
    history.replaceState(null, '', location.pathname + location.search);
    sessionStorage.removeItem(storageKey);
    const response = await page.fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'error',
    });
    if (response.status === 409)
      throw new Error(
        'This link has already been used by another process. If this was not you, close Agent Bridge and reopen it from its shortcut.',
      );
    if (response.ok) sessionStorage.setItem(storageKey, (await response.json()).token);
  }
  if (!sessionStorage.getItem(storageKey)) throw new Error('Open Agent Bridge from its shortcut to access this conversation.');
}
