'use strict';

(() => {
  const STORAGE_KEY = 'llm-optimus-general-bias';
  const DEFAULT_BIAS = 50;

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

    window.fetch = function (input, init) {
      const requestUrl = typeof input === 'string' ? input : input?.url;
      if (typeof requestUrl === 'string'
          && new URL(requestUrl, window.location.href).pathname === '/v1/chat/completions'
          && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        body.model = 'auto';
        body.general_bias = readBias();
        init = { ...init, body: JSON.stringify(body) };
      }
      return originalFetch.call(this, input, init);
    };
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
  addRoutingControl();
  new MutationObserver(addRoutingControl).observe(document.documentElement, { childList: true, subtree: true });
})();
