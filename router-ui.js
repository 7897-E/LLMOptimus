'use strict';

(() => {
  const STORAGE_KEY = 'llm-optimus-general-bias';
  const DEFAULT_BIAS = 50;
  const ASSISTANT_GROUP = '[role="group"][aria-label*="Assistant message"]';
  let pendingToolReplacement = null;
  let openRoutingControl = null;

  function closeRoutingControl() {
    if (!openRoutingControl) return;
    const { dropdown, toggle, chevron } = openRoutingControl;
    dropdown.hidden = true;
    dropdown.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open General model routing preference');
    chevron.textContent = '▾';
    openRoutingControl = null;
  }

  document.addEventListener('click', event => {
    if (openRoutingControl && !openRoutingControl.control.contains(event.target)) closeRoutingControl();
  });

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
    if (openRoutingControl && !openRoutingControl.control.isConnected) closeRoutingControl();
    const textarea = document.querySelector('textarea[placeholder="Type a message..."]');
    const form = textarea?.closest('form');
    if (!form?.parentElement || form.parentElement.querySelector('[data-llm-optimus-routing]')) return;

    const control = document.createElement('div');
    control.dataset.llmOptimusRouting = 'true';
    control.style.cssText = 'position:relative;display:flex;justify-content:flex-end;max-width:48rem;margin:0 auto;padding:4px 12px;font:12px system-ui,sans-serif;';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open General model routing preference');
    toggle.style.cssText = 'display:inline-flex;align-items:center;gap:8px;border:1px solid #d1d5db;border-radius:999px;background:#fff;color:#1f2937;padding:7px 12px;font:600 12px system-ui,sans-serif;box-shadow:0 1px 3px #00000014;cursor:pointer;';

    const toggleLabel = document.createElement('span');
    toggleLabel.textContent = `General ${readBias()}%`;
    const chevron = document.createElement('span');
    chevron.textContent = '▾';
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(toggleLabel, chevron);

    const dropdown = document.createElement('div');
    dropdown.hidden = true;
    dropdown.setAttribute('role', 'group');
    dropdown.setAttribute('aria-label', 'General model routing preference');
    dropdown.style.cssText = 'position:absolute;right:12px;bottom:calc(100% + 8px);z-index:20;display:none;align-items:center;gap:10px;width:min(360px,calc(100vw - 48px));box-sizing:border-box;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;color:#1f2937;box-shadow:0 8px 24px #0000001f;color-scheme:light;';

    const coderLabel = document.createElement('span');
    coderLabel.textContent = 'Coder';
    coderLabel.style.cssText = 'color:#4b5563;font-weight:500;';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = String(readBias());
    slider.setAttribute('aria-label', 'General model routing preference');
    slider.style.cssText = 'width:150px;accent-color:#fff;cursor:pointer;';

    const generalLabel = document.createElement('span');
    generalLabel.textContent = 'General';
    generalLabel.style.cssText = 'color:#4b5563;font-weight:500;';

    const value = document.createElement('output');
    value.textContent = `${slider.value}%`;
    value.style.cssText = 'min-width:3em;color:#1f2937;font-variant-numeric:tabular-nums;text-align:right;';
    slider.addEventListener('input', () => {
      value.textContent = `${slider.value}%`;
      toggleLabel.textContent = `General ${slider.value}%`;
      localStorage.setItem(STORAGE_KEY, slider.value);
    });

    toggle.addEventListener('click', () => {
      if (!dropdown.hidden) {
        closeRoutingControl();
        return;
      }
      closeRoutingControl();
      dropdown.hidden = false;
      dropdown.style.display = 'flex';
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close General model routing preference');
      chevron.textContent = '▴';
      openRoutingControl = { control, dropdown, toggle, chevron };
    });
    control.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !dropdown.hidden) {
        closeRoutingControl();
        toggle.focus();
      }
    });

    dropdown.append(coderLabel, slider, generalLabel, value);
    control.append(toggle, dropdown);
    form.insertAdjacentElement('afterend', control);
  }

  installRequestRouting();
  installToolCallReplacement();
  addRoutingControl();
  new MutationObserver(addRoutingControl).observe(document.documentElement, { childList: true, subtree: true });
})();
