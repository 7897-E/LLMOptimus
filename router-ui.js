'use strict';

(() => {
  const STORAGE_KEY = 'llm-optimus-general-bias';
  const DEFAULT_BIAS = 50;
  const ASSISTANT_GROUP = '[role="group"][aria-label*="Assistant message"]';
  let pendingToolReplacement = null;

  function readBias() {
    const storedValue = localStorage.getItem(STORAGE_KEY);
    if (storedValue === null) return DEFAULT_BIAS;
    const stored = Number(storedValue);
    return Number.isInteger(stored) && stored >= 0 && stored <= 100 ? stored : DEFAULT_BIAS;
  }

  function installRequestRouting() {
    if (window.__llmOptimusRoutingInstalled) return;
    window.__llmOptimusRoutingInstalled = true;
    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      let isChatRequest = false;
      if (typeof requestUrl === 'string'
          && new URL(requestUrl, window.location.href).pathname === '/v1/chat/completions') {
        isChatRequest = true;
        if (typeof init?.body === 'string') {
          const body = JSON.parse(init.body);
          body.model = 'auto';
          body.general_bias = readBias();
          init = { ...init, body: JSON.stringify(body) };
        } else if (input instanceof Request && !init?.body && input.method === 'POST') {
          const body = await input.clone().json();
          body.model = 'auto';
          body.general_bias = readBias();
          input = new Request(input, { body: JSON.stringify(body) });
        }
      }
      const response = await originalFetch.call(this, input, init);
      if (isChatRequest && /text\/event-stream/i.test(response.headers.get('content-type') || '') && response.body) {
        observeToolCalls(response.clone());
      }
      return response;
    };
  }

  function observeToolCalls(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedText = '';
    let toolNames = [];

    function inspectEventBlock(block) {
      const data = block.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data);
      for (const choice of event.choices || []) {
        const delta = choice.delta || {};
        if (typeof delta.content === 'string') streamedText += delta.content;
        for (const call of delta.tool_calls || []) {
          const name = call.function?.name;
          if (name && !toolNames.includes(name)) toolNames.push(name);
        }
      }
      if (toolNames.length) {
        window.dispatchEvent(new CustomEvent('llm-optimus-tool-call', {
          detail: { names: toolNames, streamedText },
        }));
        return true;
      }
      return false;
    }

    async function readEvents() {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          if (inspectEventBlock(block)) {
            await reader.cancel();
            return;
          }
        }
        if (done) {
          if (buffer) inspectEventBlock(buffer);
          return;
        }
      }
    }

    readEvents().catch(error => console.error('LLM Optimus stream monitor failed:', error));
  }

  function clearPreToolText() {
    const state = pendingToolReplacement;
    if (!state?.group.isConnected) return;

    const buttons = [...state.group.querySelectorAll('button,[role="button"]')];
    const toolButton = buttons.find(button => state.names.some(name => button.textContent.includes(name)));
    const proseBlocks = [...state.group.querySelectorAll('p,pre,ul,ol,blockquote,table')];
    if (!toolButton) {
      if (state.initialClearDone) return;
      state.initialClearDone = true;
    }
    for (const block of proseBlocks) {
      if (block.closest('button,[role="button"],[class*="reason"],[class*="Reason"]')) continue;
      if (toolButton && !(block.compareDocumentPosition(toolButton) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      block.remove();
    }
  }

  function installToolCallReplacement() {
    window.addEventListener('llm-optimus-tool-call', event => {
      const group = [...document.querySelectorAll(ASSISTANT_GROUP)].at(-1);
      if (!group) return;
      pendingToolReplacement = { group, names: event.detail?.names || [], initialClearDone: false };
      clearPreToolText();
    });
    new MutationObserver(clearPreToolText).observe(document.documentElement, { childList: true, subtree: true });
  }

  function addRoutingControl() {
    const textarea = document.querySelector('textarea[placeholder="Type a message..."]');
    const form = textarea?.closest('form');
    if (!form?.parentElement || form.parentElement.querySelector('[data-llm-optimus-routing]')) return;

    const panel = document.createElement('div');
    panel.dataset.llmOptimusRouting = 'true';
    panel.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:10px;max-width:48rem;margin:0 auto;padding:4px 12px;color:inherit;font:12px system-ui,sans-serif;';

    const title = document.createElement('span');
    title.textContent = 'General preference';
    title.title = 'Higher settings route more automatic requests to the General model.';

    const coderLabel = document.createElement('span');
    coderLabel.textContent = 'Coder';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = String(readBias());
    slider.setAttribute('aria-label', 'General model routing preference');
    slider.style.cssText = 'width:140px;accent-color:#f58236;cursor:pointer;';

    const generalLabel = document.createElement('span');
    generalLabel.textContent = 'General';

    const value = document.createElement('output');
    value.textContent = `${slider.value}%`;
    value.style.cssText = 'min-width:3em;font-variant-numeric:tabular-nums;';
    slider.addEventListener('input', () => {
      value.textContent = `${slider.value}%`;
      localStorage.setItem(STORAGE_KEY, slider.value);
    });

    panel.append(title, coderLabel, slider, generalLabel, value);
    form.insertAdjacentElement('afterend', panel);
  }

  installRequestRouting();
  installToolCallReplacement();
  addRoutingControl();
  new MutationObserver(addRoutingControl).observe(document.documentElement, { childList: true, subtree: true });
})();
