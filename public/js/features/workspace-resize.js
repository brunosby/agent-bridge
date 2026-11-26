import { $ } from '../core/dom.js';

const app = $('workspaceResizer').closest('.app');

function bindDivider(separator, panel, direction) {
  const variable = '--' + panel + '-width';
  const storageKey = 'agent-bridge-' + panel + '-width';
  const min = Number(separator.getAttribute('aria-valuemin'));
  const max = Number(separator.getAttribute('aria-valuemax'));
  let preferred = Number(separator.getAttribute('aria-valuenow'));
  let width = preferred;
  let limit = max;
  let drag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved > 0) preferred = Math.max(min, Math.min(max, saved));
  } catch {
    // Storage is optional.
  }
  function fit(available) {
    limit = Math.max(min, Math.min(max, Math.floor(available)));
    width = Math.min(limit, preferred);
    app.style.setProperty(variable, width + 'px');
    separator.setAttribute('aria-valuenow', String(width));
    separator.setAttribute('aria-valuemax', String(limit));
    separator.setAttribute('aria-valuetext', width + ' pixels');
    return width;
  }
  function change(value) {
    const next = Math.max(min, Math.min(limit, Math.round(value)));
    if (next === width) return;
    preferred = next;
    fitPanels();
  }
  function save() {
    try {
      localStorage.setItem(storageKey, String(preferred));
    } catch {
      // Resizing still works without storage.
    }
  }
  separator.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    separator.focus({ preventScroll: true });
    separator.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width };
  });
  separator.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) change(drag.width + direction * (event.clientX - drag.x));
  });
  separator.addEventListener('lostpointercapture', (event) => {
    if (drag?.id !== event.pointerId) return;
    if (width !== drag.width) save();
    drag = null;
  });
  separator.addEventListener('keydown', (event) => {
    const targets = { ArrowLeft: width - direction * 16, ArrowRight: width + direction * 16, Home: min, End: limit };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    change(targets[event.key]);
    save();
  });
  return { min, fit, separator };
}

const workspace = bindDivider($('workspaceResizer'), 'workspace', 1);
const progress = bindDivider($('progressResizer'), 'progress', -1);

function fitPanels() {
  const dividerWidth = progress.separator.offsetWidth;
  if (!dividerWidth) {
    workspace.fit(Infinity);
    progress.fit(Infinity);
    return;
  }
  // Keep the composer and conversation controls usable while both panels are open.
  const available = app.clientWidth - workspace.separator.offsetWidth - dividerWidth - 360;
  const leftWidth = workspace.fit(available - progress.min);
  progress.fit(available - leftWidth);
}

fitPanels();
const observer = new ResizeObserver(fitPanels);
observer.observe(app);
observer.observe(progress.separator);
