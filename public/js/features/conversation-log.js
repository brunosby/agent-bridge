// The conversation: message bubbles, tool lines, system lines, and the handler for every server event.
import { agentOf, approvals, bubbles, driverOf, label, roleOf, store, tools } from '../core/store.js';
import { $, append, h, keepScrolled, log, renderMarkdown, time } from '../core/dom.js';
import { renderApproval, renderFinalReview, renderNeedRole, updatePending } from './approvals.js';
import { renderState } from './agents.js';
export function bubble(agent, key, at) {
  const id = `${agent}|${key}`;
  let b = bubbles.get(id);
  if (!b) {
    const el = h('div', `msg agent drv-${driverOf(agent)} streaming`);
    el.dataset.agent = agent;
    const head = h('div', 'head');
    const role = roleOf(agentOf(agent)?.role)?.name;
    head.append(h('span', 'who', label(agent)), h('span', null, `${role ? `${role} · ` : ''}${time(at)}`));
    const body = h('div', 'body');
    el.append(head, body);
    b = { el, body, text: '' };
    bubbles.set(id, b);
    append(el);
  }
  return b;
}

export function addSys(text, isError = false) {
  append(h('div', `sys${isError ? ' error' : ''}`, text));
}

export function handle(ev) {
  switch (ev.kind) {
    case 'reset':
      log.textContent = '';
      $('pending').textContent = '';
      bubbles.clear();
      tools.clear();
      approvals.clear();
      updatePending();
      break;
    case 'state':
      store.state = ev;
      renderState();
      break;
    case 'user': {
      const el = h('div', 'msg user');
      const head = h('div', 'head');
      head.append(h('span', 'who', 'You'), h('span', null, `→ ${(ev.to || []).map(label).join(' + ')} · ${time(ev.at)}`));
      const body = h('div', 'body');
      renderMarkdown(body, ev.text);
      el.append(head, body);
      append(el);
      break;
    }
    case 'routed':
      if (ev.relayed) append(h('div', 'route', `${label(ev.from)} → ${label(ev.to)} (hand-off ${ev.hop})`));
      break;
    case 'delta': {
      const b = bubble(ev.agent, ev.key, ev.at);
      b.text += ev.text;
      keepScrolled(() => renderMarkdown(b.body, b.text));
      break;
    }
    case 'text': {
      const b = bubble(ev.agent, ev.key, ev.at);
      b.text = ev.text;
      keepScrolled(() => renderMarkdown(b.body, b.text));
      if (ev.final) b.el.classList.remove('streaming');
      break;
    }
    case 'tool': {
      const el = h('div', `tool drv-${driverOf(ev.agent)}`);
      el.append(h('span', 'status', '…'), document.createTextNode(`${label(ev.agent)} · ${ev.title}${ev.detail ? `: ${ev.detail}` : ''}`));
      tools.set(`${ev.agent}|${ev.key}`, el);
      append(el);
      break;
    }
    case 'toolResult': {
      const el = tools.get(`${ev.agent}|${ev.key}`);
      if (!el) break;
      el.classList.add(ev.ok ? 'ok' : 'fail');
      el.querySelector('.status').textContent = ev.ok ? '✓' : '✗';
      if (!ev.ok && ev.detail) el.appendChild(h('span', 'err', ev.detail));
      break;
    }
    case 'turnEnd': {
      for (const [id, b] of bubbles) if (id.startsWith(`${ev.agent}|`)) b.el.classList.remove('streaming');
      const parts = [`${label(ev.agent)} finished its turn`];
      if (!ev.ok && ev.detail) parts.push(ev.detail);
      append(h('div', `turn-end${ev.ok ? '' : ' fail'}`, parts.join(' · ')));
      break;
    }
    case 'autoApproved':
      append(
        h(
          'div',
          `tool drv-${driverOf(ev.agent)} ok`,
          `⚡ ${label(ev.agent)} auto-approved (bypass): ${ev.detail ? ev.detail.split('\n')[0] : ev.title}`,
        ),
      );
      break;
    case 'approval':
      renderApproval(ev);
      break;
    case 'needRole':
      renderNeedRole(ev);
      break;
    case 'finalReview':
      renderFinalReview(ev);
      break;
    case 'finalReviewClosed':
    case 'needRoleClosed': {
      const el = approvals.get(ev.requestId);
      if (el) {
        approvals.delete(ev.requestId);
        el.remove();
        updatePending();
      }
      break;
    }
    case 'approvalClosed': {
      const el = approvals.get(ev.requestId);
      if (!el) break;
      approvals.delete(ev.requestId);
      el.remove();
      const names = {
        accept: 'allowed once',
        acceptForSession: 'allowed for the session',
        decline: 'declined',
        cancelled: 'cancelled',
        timeout: 'declined automatically (no answer in time)',
      };
      addSys(`${el.dataset.title} · ${names[ev.decision] || 'closed'}`);
      updatePending();
      break;
    }
    case 'system':
      addSys(ev.text);
      break;
    case 'info':
      addSys(`${label(ev.agent)}: ${ev.text}`);
      break;
    case 'error':
      addSys(`${ev.agent ? `${label(ev.agent)}: ` : ''}${ev.text}`, true);
      break;
    default:
      break;
  }
}
