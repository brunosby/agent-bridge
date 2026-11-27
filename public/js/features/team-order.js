import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { store, cards } from '../core/store.js';
import { addSys } from './conversation-log.js';

let saving = false;

function place(ids) {
  const box = $('agents');
  ids.forEach((id, index) => {
    const el = cards[id]?.el;
    if (el && el !== box.children[index]) box.insertBefore(el, box.children[index] || null);
  });
}

export async function moveAgent(id, index, conversationId) {
  if (saving || conversationId !== store.state.conversationId) return;
  const ids = store.state.team.map((a) => a.id);
  const from = ids.indexOf(id);
  if (from < 0 || index < 0 || index >= ids.length || from === index) return;
  ids.splice(from, 1);
  ids.splice(index, 0, id);
  saving = true;
  place(ids);
  try {
    await api('reorder', { conversationId, order: ids });
    if (store.state.conversationId === conversationId)
      $('reorderNotice').textContent =
        store.state.team.find((a) => a.id === id)?.name + ' moved from position ' + (from + 1) + ' to ' + (index + 1) + ' of ' + ids.length;
  } catch (error) {
    if (store.state.conversationId === conversationId) {
      place(store.state.team.map((member) => member.id));
      addSys(error.message, true);
    }
  } finally {
    saving = false;
    if (store.state.conversationId === conversationId) cards[id]?.el.focus();
  }
}

export function installAgentDrag(el, handle) {
  let drag;
  let suppressClick = false;
  function track() {
    if (!drag?.active) return;
    const panel = el.closest('.workspace-panel');
    if (panel) {
      const rect = panel.getBoundingClientRect();
      if (drag.y < rect.top + 32) panel.scrollTop -= 8;
      else if (drag.y > rect.bottom - 32) panel.scrollTop += 8;
    }
    const rest = [...el.parentElement.children].filter((node) => node !== el);
    const index = rest.findIndex((node) => {
      const rect = node.getBoundingClientRect();
      return drag.y < rect.top + rect.height / 2;
    });
    drag.index = index < 0 ? rest.length : index;
    const anchor = rest[index] || rest.at(-1);
    if (drag.anchor) delete drag.anchor.dataset.dropEdge;
    if (anchor) anchor.dataset.dropEdge = index < 0 ? 'after' : 'before';
    drag.anchor = anchor;
    el.style.setProperty('--drag-offset', drag.y - drag.startY + (panel?.scrollTop || 0) - drag.scrollTop + 'px');
  }
  function frame() {
    if (!drag?.active) return;
    if (!el.isConnected || store.state.conversationId !== drag.conversationId) return finish(false);
    track();
    drag.frame = requestAnimationFrame(frame);
  }
  function cancel(event) {
    if (event.key === 'Escape') finish(false);
  }
  function finish(drop) {
    if (!drag) return;
    const current = drag;
    if (current.active && drop) track();
    drag = null;
    document.removeEventListener('keydown', cancel);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', abort);
    document.defaultView?.removeEventListener('blur', blur);
    if (current.frame) cancelAnimationFrame(current.frame);
    if (current.anchor) delete current.anchor.dataset.dropEdge;
    delete el.dataset.dragging;
    el.style.removeProperty('--drag-offset');
    if (el.hasPointerCapture?.(current.pointer)) el.releasePointerCapture(current.pointer);
    if (current.active) {
      suppressClick = true;
      if (drop) void moveAgent(el.dataset.agentId, current.index, current.conversationId);
    }
  }
  el.addEventListener('pointerdown', (event) => {
    suppressClick = false;
    if (drag || saving || event.button !== 0 || (event.pointerType === 'touch' && !handle.contains(event.target))) return;
    drag = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      y: event.clientY,
      conversationId: store.state.conversationId,
      scrollTop: el.closest('.workspace-panel')?.scrollTop || 0,
    };
    if (event.pointerType === 'mouse') {
      event.preventDefault();
      el.focus({ preventScroll: true });
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', abort);
    document.defaultView?.addEventListener('blur', blur);
    document.addEventListener('keydown', cancel);
  });
  function move(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, drag.y - drag.startY) >= 4) {
      drag.active = true;
      el.setPointerCapture?.(event.pointerId);
      el.dataset.dragging = '';
      frame();
    }
  }
  function up(event) {
    if (event.pointerId === drag?.pointer) finish(true);
  }
  function abort(event) {
    if (event.pointerId === drag?.pointer) finish(false);
  }
  function blur() {
    finish(false);
  }
  el.addEventListener(
    'click',
    (event) => {
      if (suppressClick && event.detail !== 0) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
      suppressClick = false;
    },
    true,
  );
}
