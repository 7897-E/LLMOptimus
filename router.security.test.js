'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BASE_URL = 'http://127.0.0.1:18182';

function rawRequest(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: 18182, path: pathname, headers }, response => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    request.on('error', reject);
    request.end();
  });
}

async function waitForRouter() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch { /* Router is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('security-test router did not start');
}

async function main() {
  const router = spawn(process.execPath, ['router.js'], {
    cwd: __dirname,
    stdio: 'pipe',
    env: {
      ...process.env,
      LLM_ROUTER_PORT: '18182',
      LLM_GENERAL_URL: 'http://127.0.0.1:18180',
      LLM_CODER_URL: 'http://127.0.0.1:18181',
      LLM_AUTOCOMPLETE_URL: 'http://127.0.0.1:18183',
      LLM_REQUIRE_APPROVALS: 'true',
      LLM_ALLOW_UNSAFE_APPROVAL_DISABLE: 'false',
    },
  });

  try {
    await waitForRouter();

    const health = await fetch(`${BASE_URL}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);

    const forgedHost = await rawRequest('/health', { Host: 'attacker.example' });
    assert.equal(forgedHost.statusCode, 403);

    const forgedOrigin = await fetch(`${BASE_URL}/v1/settings`, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(forgedOrigin.status, 403);

    const wrongContentType = await fetch(`${BASE_URL}/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ tool: 'run_file', params: { path: 'tool_test.py' } }),
    });
    assert.equal(wrongContentType.status, 415);

    const tokenlessExecution = await fetch(`${BASE_URL}/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'run_file', params: { path: 'tool_test.py' } }),
    }).then(response => response.json());
    assert.match(tokenlessExecution.error, /Approval required/);

    const disableApprovals = await fetch(`${BASE_URL}/v1/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalsEnabled: false }),
    });
    assert.equal(disableApprovals.status, 403);
    const settings = await fetch(`${BASE_URL}/v1/settings`).then(response => response.json());
    assert.equal(settings.approvalsEnabled, true);
  } finally {
    router.kill();
  }
}

main().then(
  () => console.log('router security test passed'),
  error => { console.error(error); process.exitCode = 1; },
);
