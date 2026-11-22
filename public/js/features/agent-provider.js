import { h } from '../core/dom.js';
import { api } from '../core/api.js';
import { agentOf, store } from '../core/store.js';
import { ACCOUNT_STATUS_TEXT, sortModels } from '../core/agent-view.js';

function selectField(text, select) {
  const label = h('label', null, text);
  label.append(select);
  return label;
}

export function providerForm(id, showCurrentModel) {
  const form = h('form', 'agent-provider');
  const driver = h('select');
  const model = h('select');
  const effort = h('select');
  const choices = h('div', 'agent-provider__choices');
  const notice = h('p', 'hint', 'The new provider starts a fresh session. Agent Bridge sends it a summary of the current work.');
  const account = h('output', 'hint');
  account.setAttribute('aria-live', 'polite');
  const message = h('output', 'hint');
  message.setAttribute('aria-live', 'polite');
  const apply = h('button', 'btn btn--primary', 'Change provider');
  apply.type = 'submit';
  const fields = h('div', 'agent-provider__fields');
  fields.append(selectField('New model', model), selectField('New reasoning effort', effort));
  const modelWarning = h('p', 'hint', 'The selected model may use the handoff and future messages for training.');
  modelWarning.hidden = true;
  choices.append(notice, account, fields, modelWarning, apply);
  form.append(selectField('Provider', driver), choices, message);
  choices.hidden = true;

  let current;
  let models = [];
  let loading = false;
  let submitting = false;
  let request = 0;

  function update(agent) {
    if (!agent) return;
    if (current?.driver !== agent.driver) resetChoice(agent);
    current = agent;
    const switching = agent.status?.availability === 'switching_provider';
    const mustWait = agent.status?.availability === 'starting';
    const working = agent.busy || agent.waitingApproval;
    driver.disabled = submitting || switching || mustWait;
    apply.disabled = loading || driver.disabled || Boolean(working);
    if (switching) message.textContent = 'Switching provider...';
    else if (working && !choices.hidden) message.textContent = 'Use Stop or wait for this agent to finish before changing provider.';
    else if (!submitting && (message.textContent === 'Switching provider...' || message.textContent.includes('before changing provider.')))
      message.textContent = '';
  }

  function resetChoice(agent) {
    current = agent;
    request++;
    loading = false;
    const providers = store.catalog.drivers;
    driver.replaceChildren(...providers.map((provider) => new Option(provider.label, provider.id)));
    if (!providers.some((provider) => provider.id === agent.driver))
      driver.append(new Option(agent.driverLabel || agent.driver, agent.driver));
    driver.value = agent.driver;
    choices.hidden = true;
    showCurrentModel(true);
    message.textContent = '';
  }

  function open(agent) {
    if (!agent) return;
    resetChoice(agent);
    update(agent);
  }

  function renderEffort() {
    const chosen = models.find((entry) => entry.value === model.value) || models.find((entry) => entry.isDefault);
    const levels = chosen?.efforts || [];
    effort.replaceChildren(new Option('Default', 'default'), ...levels.map((level) => new Option(level, level)));
    effort.disabled = !levels.length;
    modelWarning.hidden = !chosen?.sensitive;
  }

  model.onchange = renderEffort;
  driver.onchange = async () => {
    const selected = driver.value;
    const query = ++request;
    choices.hidden = selected === current.driver;
    showCurrentModel(choices.hidden);
    message.textContent = '';
    loading = !choices.hidden;
    update(current);
    if (!loading) return;
    models = [];
    model.disabled = true;
    model.replaceChildren(new Option('Default', 'default'));
    renderEffort();
    account.textContent = 'Checking account...';
    try {
      const { accounts } = await api('accounts', { driver: selected });
      if (query !== request) return;
      const status = accounts[0];
      account.textContent = status
        ? [(ACCOUNT_STATUS_TEXT[status.state] || [status.state])[0], status.detail].filter(Boolean).join(' - ')
        : 'Account status unavailable.';
      if (status && !['ok', 'unknown'].includes(status.state)) return;
      const { models: availableModels } = await api('driverModels', { driver: selected });
      if (query !== request) return;
      models = availableModels;
      for (const item of sortModels(models)) {
        const option = new Option((item.sensitive ? '⚠ ' : '') + (item.label || item.value), item.value);
        option.disabled = Boolean(item.disabled);
        option.title = item.sensitive ? 'This model may use its prompts for training.' : item.disabledReason || '';
        model.append(option);
      }
      model.disabled = !models.some((entry) => entry.value !== 'default' && !entry.disabled);
      renderEffort();
    } catch (error) {
      if (query === request) message.textContent = error.message;
    } finally {
      if (query === request) {
        if (account.textContent === 'Checking account...') account.textContent = 'Account status unavailable.';
        loading = false;
        update(current);
      }
    }
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (apply.disabled || choices.hidden) return;
    const conversationId = store.state.conversationId;
    submitting = true;
    update(current);
    message.textContent = 'Switching provider...';
    try {
      const result = await api('changeProvider', {
        agent: id,
        driver: driver.value,
        model: model.value,
        effort: effort.value,
        conversationId,
      });
      if (store.state?.conversationId === conversationId) {
        open(agentOf(id));
        message.textContent = result.ready ? '' : 'Provider unavailable. Use Retry or choose another provider.';
      }
    } catch (error) {
      if (store.state?.conversationId === conversationId) message.textContent = error.message;
    } finally {
      submitting = false;
      update(current);
    }
  };
  return { form, open, update };
}
