// Message box and header controls, Restart and Quit.
import { $, closeDialog } from '../core/dom.js';
import { api } from '../core/api.js';
import { addSys } from './conversation-log.js';
import { store } from '../core/store.js';
export async function sendMessage() {
  const text = $('input').value;
  if (!text.trim()) return;
  $('send').disabled = true;
  try {
    await api('send', { text, target: $('target').value });
    $('input').value = '';
  } catch (e) {
    addSys(`Send failed: ${e.message}`, true);
  } finally {
    $('send').disabled = false;
    $('input').focus();
  }
}

$('send').onclick = sendMessage;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
});
$('auto').onchange = (e) => api('relay', { auto: e.target.checked });
$('maxHops').onchange = (e) => api('relay', { maxHops: Number(e.target.value) });
$('routing').onchange = (e) =>
  api('routing', { mode: e.target.value })
    .then(() => e.target.blur())
    .catch((err) => addSys(err.message, true));
$('resume').onclick = () => api('relay', { resume: true });
$('pause').onclick = () => api('relay', { pause: true });
$('stopAll').onclick = () => api('interrupt', {});
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => closeDialog(b.dataset.close);

const appActions = $('appActions');
document.addEventListener('click', (event) => {
  if (appActions.open && !appActions.contains(event.target)) appActions.open = false;
});
appActions.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && appActions.open) {
    event.preventDefault();
    appActions.open = false;
    appActions.querySelector('summary').focus();
  }
});

function closeAppActions() {
  appActions.open = false;
  appActions.querySelector('summary').focus();
}

// ---------- restart / quit (there is no console window to close) ----------
export function busyConfirm(what) {
  return !(store.state && store.state.team.some((a) => a.busy)) || confirm(`An agent is still working. ${what} anyway?`);
}

$('restartApp').onclick = async () => {
  closeAppActions();
  if (!busyConfirm('Restart')) return;
  try {
    await api('restart');
  } catch (e) {
    return addSys(`Restart failed: ${e.message}`, true);
  }
  addSys('Restarting... this page reloads when Agent Bridge is back.');
  // The new process uses the same address with a new access token, so the page has to reload.
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (res.ok) return location.reload();
    } catch {
      // still restarting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  addSys('Agent Bridge did not come back. Check logs\\server.log and start it again.', true);
};

$('quitApp').onclick = async () => {
  closeAppActions();
  if (!busyConfirm('Quit') || !confirm('Close Agent Bridge and all agents?')) return;
  await api('quit').catch(() => {});
  document.body.innerHTML =
    '<div class="closed-page"><h2>Agent Bridge is closed</h2><p>Start it again with <code>Agent Bridge.vbs</code>. Conversations can be restored from the Conversations button.</p></div>';
};

// Small screens: the Workspace button toggles the side panel.
$('toggleControls').onclick = () => {
  const open = document.querySelector('.app').classList.toggle('is-open');
  $('toggleControls').setAttribute('aria-expanded', String(open));
};
