'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitForRouter() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:18082/health');
      if (response.ok) return;
    } catch { /* Router is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('router did not start');
}

async function main() {
  let requests = 0;
  let repairRequests = 0;
  let approvalPhase = false;
  let approvalTool = { name: 'read_file', arguments: { filepath: 'README.md' } };
  const modelServer = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"status":"ok"}');
    }

    if (req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        model_alias: 'coder',
        tools: [{ display_name: 'Read file', definition: { function: { name: 'read_file' } } }],
      }));
    }

    if (req.url === '/tools') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{
        display_name: 'Read file',
        tool: 'read_file',
        type: 'builtin',
        permissions: { write: false },
        definition: { type: 'function', function: { name: 'read_file' } },
      }]));
    }

    if (req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      if (body.messages?.[0]?.content?.startsWith('You are a tool-call repair engine.')) {
        assert.match(body.messages?.[1]?.content || '', /CORRECTED_TOOL_CALL=/);
        assert.equal(body.tool_choice, 'required');
        assert.deepEqual(body.tools.map(tool => tool.function.name), ['read_file']);
        repairRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
            id: 'repaired-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"example.py"}' },
          }] } }],
        }));
      }
      if (body.messages?.[0]?.content?.startsWith('Tool investigation is complete.')
          || body.messages?.[0]?.content?.startsWith('The exact same tool call was repeated')) {
        assert.equal(body.tools, undefined);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'native-final', choices: [{ index: 0, delta: { content: 'The first file is backup/router.js.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'What day is it?') {
        assert.ok(Array.isArray(body.tools));
        assert.ok(body.tool_choice === 'required' || body.tool_choice?.function?.name === 'get_datetime');
        assert.ok(!body.messages.some(message => String(message.content).startsWith('Web search results for:')));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'date-tool', choices: [{ index: 0, delta: { content: '{"name":"get_datetime","arguments":{}}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Mixed tool response') {
        const mixed = '{"name":"read_file","arguments":{"path":"example.py","append_loc":true}}\n\njson\n{"lines":["fabricated"]}\n</tool_response>';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'mixed-tool', choices: [{ index: 0, delta: { content: mixed }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Repair broken call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'broken-tool', choices: [{ index: 0, delta: { content: '{"name":"read_file","arguments":{"path":"example.py"' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Unknown repair output') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'unknown-repair', choices: [{ index: 0, delta: { content: '{"name":"nonexistent_tool","arguments":{"fabricated":true}}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Stream reasoning') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'reasoning-stream', choices: [{ index: 0, delta: { reasoning_content: 'First thought. ' }, finish_reason: null }] })}\n\n`);
        setTimeout(() => res.end(`data: ${JSON.stringify({ id: 'reasoning-stream', choices: [{ index: 0, delta: { content: 'Final answer.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`), 100);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Structured risky write') {
        const call = { index: 0, id: 'structured-write', type: 'function', function: {
          name: 'write_file', arguments: '{"path":"risk-test.txt","content":"x","summary":"fake","risk_level":"Low","risk_reason":"fake"}',
        } };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'structured-risk', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'structured-risk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Multiple native calls') {
        const calls = [
          { index: 0, id: 'multi-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing.py"}' } },
          { index: 1, id: 'multi-run', type: 'function', function: { name: 'run_file', arguments: '{"path":"missing.py"}' } },
        ];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'multi-tools', choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'multi-tools', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.some(message => message.role === 'user' && message.content === 'Read missing file accurately')) {
        const call = { index: 0, id: 'repeat-missing-read', type: 'function', function: {
          name: 'read_file', arguments: '{"path":"missing.py"}',
        } };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'repeat-missing', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'repeat-missing', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.some(message => message.role === 'user' && message.content === 'Recover failed execution')) {
        assert.equal(body.tool_choice, 'required');
        assert.deepEqual(body.tools.map(tool => tool.function?.name), ['edit_file']);
        const call = { index: 0, id: 'recovery-edit', type: 'function', function: {
          name: 'edit_file', arguments: '{"path":"broken.py","changes":[{"mode":"replace","line_start":1,"line_end":1,"content":"print(1)"}]}',
        } };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'recovery-edit-response', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'recovery-edit-response', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.some(message => message.role === 'user' && message.content === 'Create missing file')) {
        assert.equal(body.tool_choice, 'required');
        assert.deepEqual(body.tools.map(tool => tool.function?.name), ['write_file']);
        const call = { index: 0, id: 'recover-write', type: 'function', function: {
          name: 'write_file', arguments: '{"path":"missing.py","content":"print(1)"}',
        } };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'recover-missing', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'recover-missing', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'External read') {
        const call = { index: 0, id: 'external-read', type: 'function', function: {
          name: 'read_file', arguments: '{"path":"C:\\\\Users\\\\Public\\\\external-risk-test.txt"}',
        } };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'external-risk', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'external-risk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Sensitive read') {
        const call = { index: 0, id: 'sensitive-read', type: 'function', function: {
          name: 'read_file', arguments: '{"path":".env"}',
        } };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'sensitive-risk', choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'sensitive-risk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.some(message => message.role === 'user' && message.content === 'Create runnable sort.py')
          && body.messages?.some(message => message.role === 'tool')) {
        assert.ok(Array.isArray(body.tools));
        assert.notEqual(body.tool_choice?.function?.name, 'write_file');
        const call = JSON.stringify({ name: 'run_file', arguments: { path: 'sort.py' } });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'validate-tool', choices: [{ index: 0, delta: { content: call }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.messages?.at(-1)?.content === 'Create runnable sort.py') {
        const call = '{"name":"write_file","arguments":{"path":"sort.py","content":"""\ndef quicksort(items):\n    return sorted(items)\n\nprint(quicksort([3, 1, 2]))\n"""}}';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'multiline-tool', choices: [{ index: 0, delta: { content: `json\n\n${call}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.tools?.some(tool => tool.function?.name === 'file_glob_search')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'native-stream', choices: [{ index: 0, delta: { content: 'json\\n\\n{"name":"file_glob_search","arguments":{"path":".","include":"**"}}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (approvalPhase) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'approval-test', choices: [{ index: 0, delta: { content: JSON.stringify(approvalTool) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      requests++;
      if (requests === 1) {
        assert.equal(body.messages[0].role, 'system');
        assert.ok(body.messages[0].content.startsWith('Tool rules:'));
        assert.ok(!body.messages.some(message => String(message.content).startsWith('Web search results for:')));
      }
      assert.equal(body.stream, true);
      if (requests < 3) {
        assert.equal(body.tools[0].type, 'function');
        assert.equal(body.tools[0].function.name, 'web_search');
      }

      if (requests >= 2) {
        const toolMessage = body.messages.find(item => item.role === 'tool');
        assert.ok(toolMessage.content.includes('"tree"'));
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (requests <= 2) {
        res.write('data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
        const directory = requests === 1 ? '' : '.';
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', choices: [{ index: 0, delta: { content: `I will inspect it.\n\n\`\`\`json\n${JSON.stringify({ name: 'get_project_structure', arguments: { directory, maxDepth: 3, exclude: [] } })}\n\`\`\`` }, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.write('data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Tool "},"finish_reason":null}]}\n\n');
        setTimeout(() => res.end('data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"content":"worked."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 100);
      }
      return;
    }

    res.writeHead(404).end();
  });

  await listen(modelServer, 18081);
  const router = spawn(process.execPath, ['router.js'], {
    cwd: __dirname,
    stdio: 'pipe',
    env: {
      ...process.env,
      LLM_ROUTER_PORT: '18082',
      LLM_CODER_URL: 'http://127.0.0.1:18081',
      LLM_GENERAL_URL: 'http://127.0.0.1:18080',
      LLM_REPAIR_URL: 'http://127.0.0.1:18081',
      LLM_REQUIRE_APPROVALS: 'false',
    },
  });

  try {
    await waitForRouter();

    const toolsResponse = await fetch('http://127.0.0.1:18082/v1/tools');
    const tools = await toolsResponse.json();
    assert.equal(tools.data.length, 11);
    assert.equal(tools.data[0].name, 'web_search');
    assert.equal(tools.data[0].type, 'function');

    const propsResponse = await fetch('http://127.0.0.1:18082/props');
    const props = await propsResponse.json();
    assert.equal(props.tools.length, 13);
    assert.equal(props.tools[0].display_name, 'Web search');
    assert.equal(props.tools[0].definition.function.name, 'web_search');
    assert.ok(props.tools.some(tool => tool.tool === 'workspace_inspection'));
    assert.match(propsResponse.headers.get('cache-control'), /no-store/);

    const nativeToolsResponse = await fetch('http://127.0.0.1:18082/tools');
    const nativeTools = await nativeToolsResponse.json();
    assert.equal(nativeTools.length, 13);
    assert.equal(nativeTools[0].tool, 'web_search');
    assert.equal(nativeTools.find(tool => tool.tool === 'read_file').definition.function.parameters.properties.path.type, 'string');
    const nativeWriteSchema = nativeTools.find(tool => tool.tool === 'write_file').definition.function.parameters.properties;
    assert.equal(nativeWriteSchema.risk_level.type, 'string');
    assert.equal(nativeTools.find(tool => tool.tool === 'approved_external_action').permissions.write, true);
    assert.equal(nativeTools.find(tool => tool.tool === 'workspace_inspection').permissions.write, false);

    const workspaceInspection = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'workspace_inspection', params: { max_depth: 2, readme_lines: 3 } }),
    }).then(response => response.json());
    const inspection = JSON.parse(workspaceInspection.plain_text_response);
    assert.equal(inspection.maxDepth, 2);
    assert.ok(inspection.tree.some(entry => entry.name === 'router.js'));
    assert.ok(inspection.importantFiles.includes('README.md'));
    assert.equal(inspection.readmePreview.length, 3);

    const nativeRead = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'read_file', params: { path: 'README.md', start_line: 1, end_line: 1 } }),
    }).then(response => response.json());
    assert.equal(nativeRead.plain_text_response, '# LLM Optimus');

    const rootGlob = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'file_glob_search', params: { path: '.', include: '**/*.md' } }),
    }).then(response => response.json());
    assert.match(rootGlob.plain_text_response, /README\.md/);

    fs.writeFileSync('.router-python-test.py', 'print("python tool ok")\n');
    const normalizedPython = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'exec_shell_command',
        params: { command: 'powershell -ExecutionPolicy Bypass -File .router-python-test.py' },
      }),
    }).then(response => response.json());
    assert.match(normalizedPython.plain_text_response, /python tool ok/);

    const nativeRunFile = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'run_file', params: { path: '.router-python-test.py' } }),
    }).then(response => response.json());
    assert.match(nativeRunFile.plain_text_response, /python tool ok/);

    fs.writeFileSync('.router-node-test.js', 'console.log("node tool ok")\n');
    const nativeRunJavaScript = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'run_file', params: { path: '.router-node-test.js' } }),
    }).then(response => response.json());
    assert.match(nativeRunJavaScript.plain_text_response, /node tool ok/);

    const escapedRead = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'read_file', params: { path: '..\\outside.txt' } }),
    }).then(response => response.json());
    assert.match(escapedRead.error, /Access denied/);

    const nativeChatResponse = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Find files' }],
        tools: [nativeTools.find(tool => tool.tool === 'file_glob_search').definition],
      }),
    });
    const nativeChatStream = await nativeChatResponse.text();
    assert.equal(nativeChatResponse.headers.get('x-tool-executor'), 'llama-ui-via-router');
    assert.ok(nativeChatStream.includes('file_glob_search'));
    assert.ok(nativeChatStream.includes('tool_calls'));

    const forcedFinal = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'What is the first file?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'file_glob_search', arguments: '{"path":".","include":"**"}' } }] },
          { role: 'tool', tool_call_id: 'a', content: 'backup/router.js' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'file_glob_search', arguments: '{"path":".","include":"**"}' } }] },
          { role: 'tool', tool_call_id: 'b', content: 'backup/router.js' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(forcedFinal.includes('The first file is backup/router.js.'));
    assert.ok(!forcedFinal.includes('tool_calls'));

    const distinctProgress = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Continue inspecting the project' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'distinct-a', type: 'function', function: { name: 'file_glob_search', arguments: '{"path":".","include":"**"}' } }] },
          { role: 'tool', tool_call_id: 'distinct-a', content: 'backup/router.js' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'distinct-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"backup/router.js"}' } }] },
          { role: 'tool', tool_call_id: 'distinct-b', content: "'use strict';" },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(distinctProgress.includes('Reviewing the latest tool result'));
    assert.ok(distinctProgress.includes('tool_calls'));

    const freshTurnAfterOldTools = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Create a file' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'write_file', arguments: '{"path":"old.txt","content":"x"}' } }] },
          { role: 'tool', tool_call_id: 'old', content: 'Wrote old.txt' },
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'What day is it?' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(freshTurnAfterOldTools.includes('get_datetime'));
    assert.ok(freshTurnAfterOldTools.includes('tool_calls'));

    const mixedToolResponse = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Mixed tool response' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(mixedToolResponse.includes('tool_calls'));
    assert.ok(mixedToolResponse.includes('read_file'));
    assert.ok(mixedToolResponse.includes('example.py'));
    assert.ok(!mixedToolResponse.includes('fabricated'));

    const repairedToolResponse = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Repair broken call' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(repairedToolResponse.includes('tool_calls'));
    assert.ok(repairedToolResponse.includes('read_file'));
    assert.ok(repairedToolResponse.includes('example.py'));
    assert.equal(repairRequests, 1);

    const unknownRepair = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Unknown repair output' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(unknownRepair.includes('malformed tool call'));
    assert.ok(unknownRepair.includes('no action was executed'));
    assert.ok(!unknownRepair.includes('nonexistent_tool'));
    assert.equal(repairRequests, 1);

    const plannedWrite = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Edit the example file and make it contain the text you rock' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(plannedWrite.includes('write_file'));
    assert.ok(plannedWrite.includes('example.txt'));
    assert.ok(plannedWrite.includes('you rock'));
    assert.ok(!plannedWrite.includes('make it contain'));
    assert.ok(plannedWrite.includes('Medium'));
    assert.match(plannedWrite, /(?:Create|Overwrite) example\.txt/);

    const structuredRisk = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Structured risky write' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(structuredRisk.includes('write_file'));
    assert.ok(structuredRisk.includes('Medium'));
    assert.ok(structuredRisk.includes('Create risk-test.txt (1 characters)'));
    assert.ok(!structuredRisk.includes('\\"summary\\":\\"fake'));

    const serializedTools = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Multiple native calls' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(serializedTools.includes('multi-read'));
    assert.ok(serializedTools.includes('read_file'));
    assert.ok(!serializedTools.includes('multi-run'));

    const redirectedMissingRead = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Read missing file accurately' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'first-missing-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing.py"}' } }] },
          { role: 'tool', tool_call_id: 'first-missing-read', content: 'File not found: missing.py' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(redirectedMissingRead.includes('file_glob_search'));
    assert.ok(redirectedMissingRead.includes('**/missing.py'));
    assert.ok(!redirectedMissingRead.includes('repeat-missing-read'));

    const failedRunMessages = [
      { role: 'user', content: 'Recover failed execution' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'failed-run', type: 'function', function: { name: 'run_file', arguments: '{"path":"broken.py"}' } }] },
      { role: 'tool', tool_call_id: 'failed-run', content: 'Command failed with exit code 1: AssertionError' },
    ];
    const recoveryRead = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'coder', stream: true, messages: failedRunMessages, tools: nativeTools.map(tool => tool.definition) }),
    }).then(response => response.text());
    assert.ok(recoveryRead.includes('read_file'));
    assert.ok(recoveryRead.includes('broken.py'));

    const recoveryEdit = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [...failedRunMessages,
          { role: 'assistant', content: null, tool_calls: [{ id: 'recovery-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"broken.py"}' } }] },
          { role: 'tool', tool_call_id: 'recovery-read', content: 'assert False' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(recoveryEdit.includes('edit_file'));
    assert.ok(recoveryEdit.includes('recovery-edit'));

    const recoveryRerun = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [...failedRunMessages,
          { role: 'assistant', content: null, tool_calls: [{ id: 'recovery-read-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"broken.py"}' } }] },
          { role: 'tool', tool_call_id: 'recovery-read-2', content: 'assert False' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'recovery-edit-2', type: 'function', function: { name: 'edit_file', arguments: '{"path":"broken.py","changes":[{"mode":"replace","line_start":1,"line_end":1,"content":"print(1)"}]}' } }] },
          { role: 'tool', tool_call_id: 'recovery-edit-2', content: 'Edited broken.py successfully.' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(recoveryRerun.includes('run_file'));
    assert.ok(recoveryRerun.includes('broken.py'));
    const structuredRiskCall = structuredRisk.split(/\r?\n/)
      .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls?.[0])
      .find(Boolean);
    const approvedWriteArgs = JSON.parse(structuredRiskCall.function.arguments);
    const alteredApproval = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'write_file', params: { ...approvedWriteArgs, path: 'changed-after-approval.txt' } }),
    }).then(response => response.json());
    assert.match(alteredApproval.error, /changed after approval/);
    assert.equal(fs.existsSync('changed-after-approval.txt'), false);
    const reusedApproval = await fetch('http://127.0.0.1:18082/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'write_file', params: approvedWriteArgs }),
    }).then(response => response.json());
    assert.match(reusedApproval.error, /expired or was already used/);

    const externalRisk = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'External read' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(externalRisk.includes('approved_external_action'));
    assert.ok(externalRisk.includes('Critical'));
    assert.ok(externalRisk.includes('outside the OptimiLLM workspace'));

    const recoverMissing = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Create missing file' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'missing-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"missing.py"}' } }] },
          { role: 'tool', tool_call_id: 'missing-read', content: 'File not found: missing.py' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(recoverMissing.includes('write_file'));
    assert.ok(recoverMissing.includes('missing.py'));

    const sensitiveRisk = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Sensitive read' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(sensitiveRisk.includes('approved_external_action'));
    assert.ok(sensitiveRisk.includes('Critical'));
    assert.ok(sensitiveRisk.includes('credentials or other sensitive data'));

    const prohibitedDelete = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: '1. List files.\n2. Read example.py.\n3. Create tool_test.py.\nDo not delete or modify example.py.' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(!prohibitedDelete.includes('delete_file'));

    const promptAboutTools = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Generate me a prompt that tells an AI to create, edit, and delete a temporary file.' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(!promptAboutTools.includes('delete_file'));

    const multilineWrite = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Create runnable sort.py' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(multilineWrite.includes('tool_calls'));
    assert.ok(multilineWrite.includes('write_file'));
    assert.ok(multilineWrite.includes('def quicksort'));
    assert.ok(!multilineWrite.includes('\\"\\"\\"'));

    const validateAfterWrite = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Create runnable sort.py' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"sort.py","content":"print(1)"}' } }] },
          { role: 'tool', tool_call_id: 'write', content: 'Wrote sort.py' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(validateAfterWrite.includes('run_file'));
    assert.ok(validateAfterWrite.includes('sort.py'));

    const directRunFile = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Create tool_test.py' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'write-run', type: 'function', function: { name: 'write_file', arguments: '{"path":"tool_test.py","content":"print(1)"}' } }] },
          { role: 'tool', tool_call_id: 'write-run', content: 'Wrote tool_test.py' },
          { role: 'assistant', content: 'Created.' },
          { role: 'user', content: 'Now run the program' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(directRunFile.includes('run_file'));
    assert.ok(directRunFile.includes('tool_test.py'));
    assert.ok(directRunFile.includes('High'));
    assert.ok(directRunFile.includes('inherits your Windows user access'));

    const naturalLanguageRun = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Edit the tool-test file and make it funny.' },
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'Can you execute the file now?' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(naturalLanguageRun.includes('run_file'));
    assert.ok(naturalLanguageRun.includes('tool_test.py'));

    const walkthroughRead = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'How does the program within tool_test.py work? I want a walkthrough.' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(walkthroughRead.includes('read_file'));
    assert.ok(walkthroughRead.includes('tool_test.py'));

    const reasoningStream = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Stream reasoning' }],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(reasoningStream.indexOf('First thought.') < reasoningStream.indexOf('Final answer.'));

    const groundedNoOutput = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Edit tool_test.py so it prints, then run it.' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'ran-empty', type: 'function', function: { name: 'exec_shell_command', arguments: '{"command":"python tool_test.py"}' } }] },
          { role: 'tool', tool_call_id: 'ran-empty', content: 'Command completed successfully with no stdout.' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(groundedNoOutput.includes('produced no console output'));
    assert.ok(groundedNoOutput.includes('edit was not completed'));
    assert.ok(!groundedNoOutput.includes('Hello, world!'));

    const groundedOutput = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Run tool_test.py and tell me exactly what it prints.' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'ran-output', type: 'function', function: { name: 'run_file', arguments: '{"path":"tool_test.py"}' } }] },
          { role: 'tool', tool_call_id: 'ran-output', content: 'All quicksort tests passed.' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(groundedOutput.includes('Exact console output'));
    assert.ok(groundedOutput.includes('All quicksort tests passed.'));

    const contextualWrite = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Create example.txt so it says hello' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'prior', type: 'function', function: { name: 'write_file', arguments: '{"path":"example.txt","content":"hello"}' } }] },
          { role: 'tool', tool_call_id: 'prior', content: 'Wrote example.txt' },
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'Edit it so that it says something else' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(contextualWrite.includes('example.txt'));
    assert.ok(contextualWrite.includes('something else'));

    const plannedDelete = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [
          { role: 'user', content: 'Create example.txt' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'created', type: 'function', function: { name: 'write_file', arguments: '{"path":"example.txt","content":"hello"}' } }] },
          { role: 'tool', tool_call_id: 'created', content: 'Wrote example.txt' },
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'Can you delete the file?' },
        ],
        tools: nativeTools.map(tool => tool.definition),
      }),
    }).then(response => response.text());
    assert.ok(plannedDelete.includes('delete_file'));
    assert.ok(plannedDelete.includes('example.txt'));
    assert.ok(plannedDelete.includes('tool_calls'));

    const chatResponse = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder', stream: true,
        messages: [{ role: 'user', content: 'Tell me my current project file structure.' }],
      }),
    });
    const stream = await chatResponse.text();
    assert.match(chatResponse.headers.get('content-type'), /^text\/event-stream/);
    const streamedText = stream.split(/\r?\n/)
      .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '')
      .join('');
    assert.ok(streamedText.includes('Inspecting project structure'));
    assert.ok(streamedText.includes('✓ get_project_structure'));
    assert.ok(streamedText.includes('Project structure'));
    assert.ok(streamedText.includes('router.js'));
    assert.ok(stream.includes('data: [DONE]'));
    assert.equal(requests, 2);

    approvalPhase = true;
    await fetch('http://127.0.0.1:18082/v1/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalsEnabled: true }),
    });
    const approvalRequest = () => fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'coder', stream: true, messages: [{ role: 'user', content: 'Read README.md' }] }),
    }).then(response => response.text());
    const automaticRead = await approvalRequest();
    assert.ok(!automaticRead.includes('Approval required'));
    assert.ok(automaticRead.includes('Contents of README.md'));

    approvalTool = { name: 'write_file', arguments: { filepath: '.router-approval-test.txt', content: 'approved' } };
    const question = await approvalRequest();
    assert.ok(question.includes('Approval required'));
    assert.ok(question.includes('Writing .router-approval-test.txt'));
    assert.ok(question.includes('Risk: Medium'));

    const denied = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'coder', stream: true, messages: [{ role: 'user', content: 'no' }] }),
    }).then(response => response.text());
    assert.ok(denied.includes('Cancelled'));

    await approvalRequest();
    const approved = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'coder', stream: true, messages: [{ role: 'user', content: 'yes' }] }),
    }).then(response => response.text());
    assert.ok(approved.includes('write_file completed successfully'));
    assert.equal(fs.readFileSync('.router-approval-test.txt', 'utf8'), 'approved');

    fs.writeFileSync('.router-delete-test.txt', 'recoverable');
    approvalTool = { name: 'delete_file', arguments: { filepath: '.router-delete-test.txt' } };
    const deleteQuestion = await approvalRequest();
    assert.ok(deleteQuestion.includes('project trash'));
    const deleteApproved = await fetch('http://127.0.0.1:18082/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'coder', stream: true, messages: [{ role: 'user', content: 'yes' }] }),
    }).then(response => response.text());
    assert.ok(deleteApproved.includes('recovered from project trash'));
    assert.equal(fs.existsSync('.router-delete-test.txt'), false);
    const trashed = fs.readdirSync('.llmoptimus-trash').find(name => name.endsWith('-.router-delete-test.txt'));
    assert.ok(trashed);
  } finally {
    router.kill();
    await close(modelServer);
    fs.rmSync('.router-delete-test.txt', { force: true });
    fs.rmSync('.router-approval-test.txt', { force: true });
    fs.rmSync('.router-python-test.py', { force: true });
    fs.rmSync('.router-node-test.js', { force: true });
    if (fs.existsSync('.llmoptimus-trash')) {
      for (const name of fs.readdirSync('.llmoptimus-trash').filter(name => name.endsWith('-.router-delete-test.txt'))) {
        fs.rmSync(`.llmoptimus-trash/${name}`, { force: true });
      }
    }
  }
}

main().then(
  () => console.log('router tool integration test passed'),
  error => { console.error(error); process.exitCode = 1; },
);
