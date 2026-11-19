import { $ } from '../core/dom.js';

const separator = $('workspaceResizer');
const app = separator.closest('.app');
const storageKey = 'agent-bridge-workspace-width';
const minWidth = Number(separator.getAttribute('aria-valuemin'));
const maxWidth = Number(separator.getAttribute('aria-valuemax'));
const step = 16;
let width = Number(separator.getAttribute('aria-valuenow'));
let drag = null;

function resize(nextWidth) {
  width = Math.max(minWidth, Math.min(maxWidth, Math.round(nextWidth)));
  app.style.setProperty('--workspace-width', width + 'px');
  separator.setAttribute('aria-valuenow', String(width));
}

function saveWidth() {
  try {
    localStorage.setItem(storageKey, String(width));
  } catch {
    // The divider still works when browser storage is unavailable.
  }
}

try {
  const savedWidth = Number(localStorage.getItem(storageKey));
  if (Number.isFinite(savedWidth) && savedWidth > 0) resize(savedWidth);
} catch {
  // Use the default width.
}

separator.addEventListener('pointerdown', (event) => {
  if (drag || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  separator.focus({ preventScroll: true });
  separator.setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
});

separator.addEventListener('pointermove', (event) => {
  if (drag?.pointerId === event.pointerId) resize(drag.startWidth + event.clientX - drag.startX);
});

separator.addEventListener('lostpointercapture', (event) => {
  if (drag?.pointerId !== event.pointerId) return;
  if (width !== drag.startWidth) saveWidth();
  drag = null;
});

separator.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'ArrowLeft':
      resize(width - step);
      break;
    case 'ArrowRight':
      resize(width + step);
      break;
    case 'Home':
      resize(minWidth);
      break;
    case 'End':
      resize(maxWidth);
      break;
    default:
      return;
  }
  event.preventDefault();
  saveWidth();
});
