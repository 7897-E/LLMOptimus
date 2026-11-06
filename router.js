'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const HOST = '127.0.0.1';
const PORT = Number(process.env.LLM_ROUTER_PORT || 8082);

const GENERAL_WEB = process.env.LLM_GENERAL_URL || 'http://127.0.0.1:8080';
const CODER_WEB = process.env.LLM_CODER_URL || 'http://127.0.0.1:8081';
const REPAIR_WEB = process.env.LLM_REPAIR_URL || process.env.LLM_AUTOCOMPLETE_URL || CODER_WEB;
const GENERAL_URL = `${GENERAL_WEB}/v1/chat/completions`;
const CODER_URL = `${CODER_WEB}/v1/chat/completions`;
const REPAIR_URL = `${REPAIR_WEB}/v1/chat/completions`;

const STATIC_DIR = __dirname;

function logRouter(level, message, details) {
  const suffix = details === undefined ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] [${level}] ${message}${suffix}`);
}
// Only serve these if they exist locally (for when llamafile isn't running)
const STATIC_FALLBACK = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/bundle.js': 'bundle.js',
  '/bundle.css': 'bundle.css',
  '/router-ui.js': 'router-ui.js',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

// Tool toggle - set via /v1/settings or query param
let toolsEnabled = true;
let approvalsEnabled = process.env.LLM_REQUIRE_APPROVALS !== 'false';
const allowRuntimeApprovalDisable = process.env.LLM_ALLOW_UNSAFE_APPROVAL_DISABLE === 'true';
let pendingApproval = null;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const nativeApprovalTokens = new Map();

function resolveInWorkspace(inputPath, label = 'path') {
  const workspace = path.resolve(STATIC_DIR);
  const resolved = path.resolve(workspace, inputPath || '.');
  const relative = path.relative(workspace, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Access denied: ${label} must stay inside ${workspace}`);
  }

  const realWorkspace = fs.realpathSync.native(workspace);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync.native(existing);
  const realRelative = path.relative(realWorkspace, realExisting);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Access denied: ${label} resolves outside ${realWorkspace}`);
  }
  return resolved;
}

// Keep one canonical OpenAI-compatible schema. UI metadata is derived from it
// at the HTTP boundary instead of being mixed into requests sent to llamafile.
function createTool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters,
    },
  };
}

function toolForUi(tool) {
  return {
    id: tool.function.name,
    name: tool.function.name,
    description: tool.function.description,
    enabled: toolsEnabled,
    type: tool.type,
    function: tool.function,
    parameters: tool.function.parameters,
  };
}

// All available tools with proper UI format (enabled + function)
const AVAILABLE_TOOLS = [
  createTool('web_search', 'Search the live web and return titles, URLs, and snippets. Use for current or time-sensitive information.', {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The web search query' },
    },
    required: ['query'],
  }),
  createTool('read_file', 'Read the contents of a file. Returns the file content as text. Use for reading code, config files, logs, or any text file.', {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Absolute or relative path to the file to read' },
    },
    required: ['filepath'],
  }),
  createTool('write_file', 'Write content to a file inside the current project. Creates or overwrites it. Use a real relative path such as "hello.txt"; never use placeholder paths such as "/path/to/file".', {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Absolute or relative path where the file should be written' },
      content: { type: 'string', description: 'The content to write to the file' },
    },
    required: ['filepath', 'content'],
  }),
  createTool('list_files', 'List files and directories in a folder. Returns the names, types (file/directory), and sizes of items in the specified directory.', {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Absolute or relative path to the directory to list' },
      recursive: { type: 'boolean', description: 'If true, list files recursively in subdirectories', default: false },
    },
    required: ['directory'],
  }),
  createTool('edit_file', 'Make targeted edits to a file. Replaces text in the file with new content. Use for modifying existing files.', {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Absolute or relative path to the file to edit' },
      oldText: { type: 'string', description: 'The exact text to find and replace in the file' },
      newText: { type: 'string', description: 'The text to replace oldText with' },
    },
    required: ['filepath', 'oldText', 'newText'],
  }),
  createTool('delete_file', 'Move a file inside the current project into the recoverable .llmoptimus-trash folder. User approval is always required.', {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Relative path of the file to move to project trash' },
    },
    required: ['filepath'],
  }),
  createTool('run_command', 'Execute a Windows shell command in the current project and return its output. Use PowerShell-compatible Windows commands, not Linux-only commands such as notify-send. Never run commands that delete files, modify system settings, or expose sensitive data.', {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)', default: 30000 },
    },
    required: ['command'],
  }),
  createTool('run_file', 'Run or compile-and-run a code file inside the current project using an installed toolchain, without constructing a shell command.', {
    type: 'object',
    properties: {
      filepath: { type: 'string', description: 'Path to the code file inside the workspace' },
      arguments: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
    },
    required: ['filepath'],
  }),
  createTool('get_project_structure', 'Get a tree view of the project directory structure. Shows files and folders organized hierarchically. Useful for understanding the layout of a project.', {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Root directory to start from (defaults to current working directory)' },
      maxDepth: { type: 'number', description: 'Maximum depth to traverse (default 3)', default: 3 },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Patterns to exclude (e.g., ["node_modules", ".git", "*.log"])' },
    },
    required: [],
  }),
  createTool('workspace_inspection', 'Inspect the workspace using a bounded file tree, project-type signals, important root files, and a short README preview.', {
    type: 'object',
    properties: {
      max_depth: { type: 'integer', description: 'Maximum tree depth from 1 to 4 (default 2)', default: 2 },
      readme_lines: { type: 'integer', description: 'README preview lines from 0 to 50 (default 10)', default: 10 },
    },
    required: [],
  }),
  createTool('search_files', 'Search for files matching a pattern or search file contents for a text pattern. Can find files by name/glob pattern or search within file contents using regex. Returns matching files and relevant context.', {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern for filenames (e.g., "*.js", "**/*.py") or text to search for in file contents' },
      path: { type: 'string', description: 'Directory to search in (defaults to current working directory)' },
      type: { type: 'string', enum: ['name', 'content'], description: 'Whether to search by filename ("name") or file contents ("content")', default: 'name' },
      regex: { type: 'string', description: 'If searching content, the regex pattern to search for' },
      caseSensitive: { type: 'boolean', description: 'Whether the search should be case-sensitive', default: false },
      maxResults: { type: 'number', description: 'Maximum number of results to return (default 50)', default: 50 },
    },
    required: ['pattern'],
  }),
];

function nativeTool(displayName, name, description, properties = {}, required = [], write = false) {
  const approvalProperties = write ? {
    summary: { type: 'string', description: 'Router-calculated short action summary' },
    risk_level: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'], description: 'Router-calculated risk level' },
    risk_reason: { type: 'string', description: 'Router-calculated risk explanation' },
    resolved_target: { type: 'string', description: 'Router-calculated resolved target, when applicable' },
    approval_id: { type: 'string', description: 'Router-issued one-time binding for this exact action' },
  } : {};
  return {
    display_name: displayName,
    tool: name,
    type: 'builtin',
    permissions: { write },
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties: { ...properties, ...approvalProperties }, ...(required.length ? { required } : {}) },
      },
    },
  };
}

const NATIVE_TOOLS = [
  nativeTool('Web search', 'web_search', 'Search the live web and return current titles, URLs, and snippets.', {
    query: { type: 'string', description: 'The web search query' },
  }, ['query']),
  nativeTool('Read file', 'read_file', 'Read a file, optionally using a 1-based line range.', {
    path: { type: 'string', description: 'Path to the file' },
    start_line: { type: 'integer', description: 'First line, 1-based' },
    end_line: { type: 'integer', description: 'Last line, inclusive' },
    append_loc: { type: 'boolean', description: 'Prefix lines with line numbers' },
  }, ['path']),
  nativeTool('File search', 'file_glob_search', 'Recursively find files matching a glob pattern.', {
    path: { type: 'string', description: 'Base directory' },
    include: { type: 'string', description: 'Glob to include, such as **/*.js' },
    exclude: { type: 'string', description: 'Glob to exclude' },
  }, ['path']),
  nativeTool('Grep search', 'grep_search', 'Search file contents using a regular expression.', {
    path: { type: 'string', description: 'File or directory to search' },
    pattern: { type: 'string', description: 'Regular expression' },
    include: { type: 'string', description: 'Optional file glob' },
    exclude: { type: 'string', description: 'Optional exclusion glob' },
    return_line_numbers: { type: 'boolean', description: 'Include line numbers' },
  }, ['path', 'pattern']),
  nativeTool('Execute command', 'exec_shell_command', 'Execute a Windows PowerShell command in the project workspace.', {
    command: { type: 'string', description: 'PowerShell command' },
    timeout: { type: 'integer', description: 'Timeout in seconds, maximum 60' },
    max_output_size: { type: 'integer', description: 'Maximum returned output bytes' },
  }, ['command'], true),
  nativeTool('Run file', 'run_file', 'Run or compile-and-run a code file using an installed toolchain. Prefer this over constructing a shell command.', {
    path: { type: 'string', description: 'Path to the code file' },
    arguments: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments' },
    timeout: { type: 'integer', description: 'Timeout in seconds, maximum 60' },
    max_output_size: { type: 'integer', description: 'Maximum returned output bytes' },
  }, ['path'], true),
  nativeTool('Write file', 'write_file', 'Write a file inside the project workspace.', {
    path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Content' },
  }, ['path', 'content'], true),
  nativeTool('Delete file', 'delete_file', 'Move a file into the recoverable project trash folder.', {
    path: { type: 'string', description: 'File path inside the project workspace' },
  }, ['path'], true),
  nativeTool('Edit file', 'edit_file', 'Apply line-based changes to a file.', {
    path: { type: 'string', description: 'File path' },
    changes: { type: 'array', items: { type: 'object', properties: {
      mode: { type: 'string', enum: ['replace', 'delete', 'append'] },
      line_start: { type: 'integer' }, line_end: { type: 'integer' }, content: { type: 'string' },
    }, required: ['mode', 'line_start', 'line_end', 'content'] } },
  }, ['path', 'changes'], true),
  nativeTool('Apply diff', 'apply_diff', 'Apply a unified diff to files in the project workspace.', {
    diff: { type: 'string', description: 'Unified git diff' },
  }, ['diff'], true),
  nativeTool('Approved external action', 'approved_external_action', 'Execute an explicitly approved file operation outside the workspace.', {
    operation: { type: 'string', enum: ['read_file', 'write_file', 'edit_file', 'delete_file', 'run_file'] },
    path: { type: 'string', description: 'Absolute resolved external target' },
    params: { type: 'object', description: 'Original validated operation parameters' },
  }, ['operation', 'path', 'params'], true),
  nativeTool('Get Date & Time', 'get_datetime', 'Return the current local date and time.'),
  nativeTool('Workspace inspection', 'workspace_inspection', 'Return a bounded workspace overview generated by the router.', {
    max_depth: { type: 'integer', description: 'Maximum tree depth from 1 to 4' },
    readme_lines: { type: 'integer', description: 'README preview lines from 0 to 50' },
  }),
];

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

function inspectPathScope(inputPath) {
  const workspace = path.resolve(STATIC_DIR);
  const resolved = path.resolve(workspace, inputPath || '.');
  const logicalRelative = path.relative(workspace, resolved);
  const logicalOutside = logicalRelative === '..' || logicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(logicalRelative);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realOutside = logicalOutside;
  try {
    const realWorkspace = fs.realpathSync.native(workspace);
    const realExisting = fs.realpathSync.native(existing);
    const realRelative = path.relative(realWorkspace, realExisting);
    realOutside = realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative);
  } catch { /* Missing ancestors remain classified from the logical path. */ }
  return { resolved, outside: logicalOutside || realOutside, symlinkEscape: !logicalOutside && realOutside };
}

function stripApprovalMetadata(args) {
  const clean = { ...(args || {}) };
  delete clean.summary;
  delete clean.risk_level;
  delete clean.risk_reason;
  delete clean.resolved_target;
  delete clean.approval_id;
  return clean;
}

function safeToolLogDetails(name, params = {}) {
  const target = params.resolved_target || params.path || params.filepath || params.directory;
  const details = { tool: name };
  if (target) details.target = String(target);
  if (params.risk_level) details.risk = String(params.risk_level);
  if (name === 'exec_shell_command') details.commandLength = String(params.command || '').length;
  if (name === 'write_file') details.contentLength = String(params.content || '').length;
  return details;
}

function isCredentialSensitivePath(filePath) {
  return /(?:^|[\\/])(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.kube|credentials?|secrets?|id_rsa|id_ed25519)(?:$|[\\/.])/i.test(String(filePath || ''))
    || /\.(?:pem|pfx|p12|key)$/i.test(String(filePath || ''));
}

function runtimeLabel(filePath) {
  return ({
    '.py': 'Python', '.js': 'Node.js', '.ts': 'TypeScript', '.ps1': 'PowerShell',
    '.bat': 'Command Prompt', '.cmd': 'Command Prompt', '.java': 'Java', '.jar': 'Java',
    '.c': 'a C compiler', '.cc': 'a C++ compiler', '.cpp': 'a C++ compiler',
    '.cxx': 'a C++ compiler', '.rs': 'Rust', '.cs': 'C#', '.go': 'Go', '.kt': 'Kotlin',
  })[path.extname(String(filePath || '')).toLowerCase()] || 'an installed toolchain';
}

function issueNativeApproval(name, args) {
  const approvalId = crypto.randomUUID();
  nativeApprovalTokens.set(approvalId, {
    name,
    arguments: JSON.stringify(stripApprovalMetadata(args)),
    createdAt: Date.now(),
  });
  for (const [id, approval] of nativeApprovalTokens) {
    if (Date.now() - approval.createdAt > APPROVAL_TTL_MS) nativeApprovalTokens.delete(id);
  }
  return approvalId;
}

function consumeNativeApproval(name, params) {
  const approvalId = params?.approval_id;
  if (!approvalId && !approvalsEnabled) return;
  if (!approvalId) throw new Error('Approval required: this action needs a router-issued one-time approval');
  const approval = nativeApprovalTokens.get(approvalId);
  nativeApprovalTokens.delete(approvalId);
  if (!approval || Date.now() - approval.createdAt > APPROVAL_TTL_MS) throw new Error('Approval expired or was already used');
  const actual = JSON.stringify(stripApprovalMetadata(params));
  if (approval.name !== name || approval.arguments !== actual) throw new Error('Tool arguments changed after approval');
}

function prepareNativeToolCalls(calls) {
  if (!Array.isArray(calls)) return null;
  const pathTools = new Set(['read_file', 'write_file', 'edit_file', 'delete_file', 'run_file']);
  const prepared = [];
  for (const call of calls) {
    let args;
    try { args = stripApprovalMetadata(JSON.parse(call.function.arguments || '{}')); }
    catch { continue; }
    let name = call.function.name;
    let targetInfo = null;
    if (pathTools.has(name) && typeof args.path === 'string') targetInfo = inspectPathScope(args.path);

    if (name === 'approved_external_action') {
      const operation = String(args.operation || 'external action');
      const target = path.resolve(String(args.path || ''));
      const actionLabel = ({ read_file: 'Read', write_file: 'Write', edit_file: 'Edit', delete_file: 'Delete', run_file: 'Run' })[operation]
        || 'Access';
      args.summary = `${actionLabel} ${target}.`;
      args.risk_level = 'Critical';
      args.risk_reason = isCredentialSensitivePath(target)
        ? 'The target may contain credentials or other sensitive data.'
        : 'The target is outside the OptimiLLM workspace.';
      args.resolved_target = target;
    }

    const sensitiveTarget = targetInfo && isCredentialSensitivePath(targetInfo.resolved);
    if (name !== 'approved_external_action' && (targetInfo?.outside || sensitiveTarget)) {
      const originalName = name;
      name = 'approved_external_action';
      args = { operation: originalName, path: targetInfo.resolved, params: args };
      const actionLabel = ({
        read_file: 'Read', write_file: 'Write', edit_file: 'Edit', delete_file: 'Delete', run_file: 'Run',
      })[originalName] || originalName.replace(/_/g, ' ');
      args.summary = `${actionLabel} ${targetInfo.resolved}.`;
      args.risk_level = 'Critical';
      args.risk_reason = sensitiveTarget
        ? 'The target may contain credentials or other sensitive data.'
        : targetInfo.symlinkEscape
        ? 'The target resolves outside the workspace through a symlink.'
        : 'The target is outside the OptimiLLM workspace.';
      args.resolved_target = targetInfo.resolved;
    } else if (name !== 'approved_external_action') {
      const target = targetInfo?.resolved;
      const relativeTarget = target ? (path.relative(STATIC_DIR, target) || '.') : '';
      const exists = target ? fs.existsSync(target) : false;
      const changeCount = Array.isArray(args.changes) ? args.changes.length : 0;
      const metadata = {
        write_file: ['Medium', `${exists ? 'Overwrite' : 'Create'} ${relativeTarget} (${String(args.content || '').length} characters).`, 'This action changes a file in the workspace.'],
        edit_file: ['Medium', `Edit ${relativeTarget} (${changeCount} change${changeCount === 1 ? '' : 's'}).`, 'This action changes a file in the workspace.'],
        apply_diff: ['Medium', 'Apply a patch to workspace files.', 'This action may change multiple workspace files.'],
        delete_file: ['High', `Move ${relativeTarget} to project trash.`, 'This action removes a file from its current location.'],
        run_file: ['High', `Run ${relativeTarget} with ${runtimeLabel(target)}.`, 'Executed code currently inherits your Windows user access and may access files outside this project.'],
        exec_shell_command: ['High', `Run PowerShell command: ${String(args.command || '').slice(0, 160)}`, 'Executed code currently inherits your Windows user access and may access files outside this project.'],
      }[name];
      if (metadata) {
        let [risk, summary, reason] = metadata;
        if (name === 'exec_shell_command' && /(?:\b(?:format|diskpart|reg\s+(?:add|delete)|remove-item|del|erase|rmdir|rd|shutdown|stop-process)\b|\.\.\\|[A-Za-z]:\\|https?:\/\/|invoke-webrequest|curl\b)/i.test(String(args.command || ''))) {
          risk = 'Critical';
          reason = 'The command may affect external files, system settings, or the network.';
        }
        args.summary = summary;
        args.risk_level = risk;
        args.risk_reason = reason;
        if (target) args.resolved_target = target;
      }
    }
    const native = NATIVE_TOOLS.find(tool => tool.tool === name);
    if (native?.permissions?.write) args.approval_id = issueNativeApproval(name, args);
    prepared.push({ ...call, function: { ...call.function, name, arguments: JSON.stringify(args) } });
  }
  return prepared.length ? prepared : null;
}

function runWorkspaceFile(inputPath, fileArguments = [], timeoutMs = 30000, maxBuffer = 16384, allowExternal = false) {
  const filePath = allowExternal ? path.resolve(inputPath) : resolveInWorkspace(inputPath, 'file');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${inputPath}`);
  if (!fs.statSync(filePath).isFile()) throw new Error('run_file only accepts files');
  const args = Array.isArray(fileArguments) ? fileArguments.map(String) : [];
  const extension = path.extname(filePath).toLowerCase();
  const childProcess = require('node:child_process');
  const timeout = Math.min(60000, Math.max(1000, Number(timeoutMs) || 30000));
  const buffer = Math.min(1024 * 1024, Math.max(1024, Number(maxBuffer) || 16384));
  const options = { cwd: STATIC_DIR, timeout, maxBuffer: buffer, encoding: 'utf8', windowsHide: true };
  const available = candidates => candidates.find(executable =>
    childProcess.spawnSync('where.exe', [executable], { windowsHide: true, stdio: 'ignore' }).status === 0
  );
  const execute = (candidates, executableArgs, label) => {
    const executable = available(candidates);
    if (!executable) throw new Error(`${label} is not installed or is not available on PATH (tried: ${candidates.join(', ')})`);
    return childProcess.execFileSync(executable, executableArgs, options) || '';
  };

  const interpreted = {
    '.py': [['python', 'py'], [filePath, ...args], 'Python'],
    '.js': [['node'], [filePath, ...args], 'Node.js'],
    '.mjs': [['node'], [filePath, ...args], 'Node.js'],
    '.cjs': [['node'], [filePath, ...args], 'Node.js'],
    '.ts': [['tsx', 'ts-node'], [filePath, ...args], 'TypeScript runner'],
    '.rb': [['ruby'], [filePath, ...args], 'Ruby'],
    '.php': [['php'], [filePath, ...args], 'PHP'],
    '.pl': [['perl'], [filePath, ...args], 'Perl'],
    '.lua': [['lua'], [filePath, ...args], 'Lua'],
    '.r': [['Rscript'], [filePath, ...args], 'R'],
    '.jl': [['julia'], [filePath, ...args], 'Julia'],
    '.dart': [['dart'], ['run', filePath, ...args], 'Dart'],
    '.exs': [['elixir'], [filePath, ...args], 'Elixir'],
    '.groovy': [['groovy'], [filePath, ...args], 'Groovy'],
    '.scala': [['scala'], [filePath, ...args], 'Scala'],
    '.swift': [['swift'], [filePath, ...args], 'Swift'],
    '.fsx': [['dotnet'], ['fsi', filePath, ...args], '.NET F# interactive'],
    '.sh': [['bash'], [filePath, ...args], 'Bash'],
    '.ps1': [['powershell.exe', 'pwsh'], ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filePath, ...args], 'PowerShell'],
    '.bat': [['cmd.exe'], ['/d', '/s', '/c', filePath, ...args], 'Command Prompt'],
    '.cmd': [['cmd.exe'], ['/d', '/s', '/c', filePath, ...args], 'Command Prompt'],
    '.go': [['go'], ['run', filePath, ...args], 'Go'],
    '.jar': [['java'], ['-jar', filePath, ...args], 'Java'],
    '.class': [['java'], ['-cp', path.dirname(filePath), path.basename(filePath, extension), ...args], 'Java'],
    '.exe': [[filePath], args, 'Windows executable'],
  };
  if (interpreted[extension]) {
    const [candidates, executableArgs, label] = interpreted[extension];
    const output = extension === '.exe'
      ? childProcess.execFileSync(filePath, args, options)
      : execute(candidates, executableArgs, label);
    return { path: inputPath, stdout: output || 'Program completed successfully with no stdout.', exitCode: 0 };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoptimus-run-'));
  const outputFile = path.join(tempRoot, `program${process.platform === 'win32' ? '.exe' : ''}`);
  let compileOutput = '';
  let runOutput = '';
  try {
    if (extension === '.c') {
      compileOutput = execute(['clang', 'gcc'], [filePath, '-o', outputFile], 'C compiler');
      runOutput = childProcess.execFileSync(outputFile, args, options);
    } else if (['.cc', '.cpp', '.cxx'].includes(extension)) {
      compileOutput = execute(['clang++', 'g++'], [filePath, '-o', outputFile], 'C++ compiler');
      runOutput = childProcess.execFileSync(outputFile, args, options);
    } else if (extension === '.rs') {
      compileOutput = execute(['rustc'], [filePath, '-o', outputFile], 'Rust compiler');
      runOutput = childProcess.execFileSync(outputFile, args, options);
    } else if (extension === '.cs') {
      compileOutput = execute(['csc'], ['/nologo', `/out:${outputFile}`, filePath], 'C# compiler');
      runOutput = childProcess.execFileSync(outputFile, args, options);
    } else if (extension === '.java') {
      compileOutput = execute(['javac'], ['-d', tempRoot, filePath], 'Java compiler');
      runOutput = execute(['java'], ['-cp', tempRoot, path.basename(filePath, extension), ...args], 'Java runtime');
    } else if (extension === '.kt') {
      const jarPath = path.join(tempRoot, 'program.jar');
      compileOutput = execute(['kotlinc'], [filePath, '-include-runtime', '-d', jarPath], 'Kotlin compiler');
      runOutput = execute(['java'], ['-jar', jarPath, ...args], 'Java runtime');
    } else {
      throw new Error(`Unsupported file type: ${extension || '(no extension)'}. Add an interpreter/compiler mapping before this file can be run safely.`);
    }
    return { path: inputPath, stdout: `${compileOutput || ''}${runOutput || ''}` || 'Program completed successfully with no stdout.', exitCode: 0 };
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const systemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${systemTemp}${path.sep}`) && path.basename(resolvedTemp).startsWith('llmoptimus-run-')) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
}

async function executeTool(toolName, args) {
  switch (toolName) {
    case 'web_search': {
      const results = await webSearch(args.query);
      return { query: args.query, results };
    }

    case 'workspace_inspection':
      return inspectWorkspace(args);

    case 'read_file': {
      const filePath = resolveInWorkspace(args.filepath, 'file');
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${args.filepath}`);
      }
      const stats = fs.statSync(filePath);
      if (stats.size > 10 * 1024 * 1024) {
        throw new Error(`File too large: ${stats.size} bytes (max 10MB)`);
      }
      return {
        content: fs.readFileSync(filePath, 'utf8'),
        path: args.filepath,
        size: stats.size,
      };
    }

    case 'write_file': {
      const filePath = resolveInWorkspace(args.filepath, 'file');
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, args.content, 'utf8');
      return {
        success: true,
        path: args.filepath,
        size: args.content.length,
      };
    }

    case 'list_files': {
      const dirPath = resolveInWorkspace(args.directory || '.', 'directory');
      const cwd = path.resolve(STATIC_DIR);
      if (!fs.existsSync(dirPath)) {
        throw new Error(`Directory not found: ${args.directory}`);
      }
      if (!fs.statSync(dirPath).isDirectory()) {
        throw new Error(`Not a directory: ${args.directory}`);
      }

      function listDir(currentPath, currentDepth) {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);
          const item = {
            name: entry.name,
            path: path.relative(cwd, fullPath),
            type: entry.isDirectory() ? 'directory' : 'file',
          };
          if (entry.isDirectory() && args.recursive && currentDepth < 5) {
            item.children = listDir(fullPath, currentDepth + 1);
          }
          result.push(item);
        }
        return result;
      }

      return {
        directory: args.directory || '.',
        items: listDir(dirPath, 0),
      };
    }

    case 'edit_file': {
      const filePath = resolveInWorkspace(args.filepath, 'file');
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${args.filepath}`);
      }
      let content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes(args.oldText)) {
        throw new Error('oldText not found in file. Please ensure the text matches exactly.');
      }
      content = content.replace(args.oldText, args.newText);
      fs.writeFileSync(filePath, content, 'utf8');
      return {
        success: true,
        path: args.filepath,
        edited: true,
      };
    }

    case 'delete_file': {
      const filePath = resolveInWorkspace(args.filepath, 'file');
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${args.filepath}`);
      if (!fs.statSync(filePath).isFile()) throw new Error('delete_file only accepts files');
      const trashDir = resolveInWorkspace('.llmoptimus-trash', 'trash directory');
      fs.mkdirSync(trashDir, { recursive: true });
      const trashName = `${Date.now()}-${path.basename(filePath)}`;
      const trashPath = path.join(trashDir, trashName);
      fs.renameSync(filePath, trashPath);
      return { success: true, path: args.filepath, trashedTo: path.relative(STATIC_DIR, trashPath), recoverable: true };
    }

    case 'run_command': {
      const timeout = args.timeout || 30000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        // Basic safety: block obviously dangerous commands
        const dangerous = ['rm -rf /', 'format', 'mkfs', 'dd if=', '> /dev/', ':(){ :|:& };:'];
        for (const pattern of dangerous) {
          if (args.command.includes(pattern)) {
            throw new Error(`Command blocked for safety: contains "${pattern}"`);
          }
        }

        const proc = require('node:child_process').execSync(args.command, {
          timeout: timeout,
          encoding: 'utf8',
          cwd: STATIC_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        clearTimeout(timeoutId);
        return {
          command: args.command,
          stdout: proc,
          stderr: '',
          exitCode: 0,
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.status !== undefined) {
          return {
            command: args.command,
            stdout: error.stdout || '',
            stderr: error.stderr || '',
            exitCode: error.status,
          };
        }
        throw error;
      }
    }

    case 'run_file':
      return runWorkspaceFile(args.filepath, args.arguments, args.timeout, 16384);

    case 'get_project_structure': {
      const rootDir = resolveInWorkspace(args.directory || STATIC_DIR, 'directory');
      if (!fs.existsSync(rootDir)) {
        throw new Error(`Directory not found: ${args.directory}`);
      }

      const excludePatterns = (args.exclude || []).map(p => new RegExp(p.replace(/\*/g, '.*').replace(/\//g, '\\/'), 'i'));

      function buildTree(currentPath, depth) {
        if (depth > (args.maxDepth || 3)) return null;
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        const children = [];
        for (const entry of entries) {
          // Check exclude patterns
          if (excludePatterns.some(p => p.test(entry.name))) continue;
          if (entry.name === '.git') continue;
          if (entry.name.startsWith('.') && entry.name !== '.vscode') continue;

          const fullPath = path.join(currentPath, entry.name);
          const child = {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
          };
          if (entry.isDirectory()) {
            const subtree = buildTree(fullPath, depth + 1);
            if (subtree) child.children = subtree;
          }
          children.push(child);
        }
        // Sort: directories first, then alphabetically
        children.sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1;
          if (a.type !== 'dir' && b.type === 'dir') return 1;
          return a.name.localeCompare(b.name);
        });
        return children;
      }

      const name = path.basename(rootDir);
      return {
        root: rootDir,
        name: name,
        tree: buildTree(rootDir, 0),
      };
    }

    case 'search_files': {
      const searchPath = resolveInWorkspace(args.path || STATIC_DIR, 'search path');
      const cwd = path.resolve(STATIC_DIR);

      const results = [];

      if (args.type === 'content') {
        // Search file contents
        const searchRegex = new RegExp(args.regex || args.pattern, args.caseSensitive ? 'g' : 'gi');
        const walk = (dir) => {
          if (results.length >= (args.maxResults || 50)) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= (args.maxResults || 50)) break;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                walk(fullPath);
              }
            } else {
              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                if (searchRegex.test(content)) {
                  searchRegex.lastIndex = 0;
                  const matches = [];
                  let match;
                  while ((match = searchRegex.exec(content)) !== null) {
                    const lineNum = content.substring(0, match.index).split('\n').length;
                    matches.push({
                      line: lineNum,
                      text: match[0].substring(0, 100),
                    });
                    if (matches.length >= 3) break;
                  }
                  results.push({
                    file: path.relative(cwd, fullPath),
                    matches: matches,
                  });
                }
              } catch { /* Skip files we can't read */ }
            }
          }
        };
        walk(searchPath);
      } else {
        // Search by filename (glob)
        const globPattern = args.pattern.replace(/\*/g, '.*').replace(/\//g, '\\/');
        const regex = new RegExp(globPattern, args.caseSensitive ? '' : 'i');
        const walk = (dir) => {
          if (results.length >= (args.maxResults || 50)) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= (args.maxResults || 50)) break;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                walk(fullPath);
              }
            } else if (regex.test(entry.name)) {
              results.push({
                file: path.relative(cwd, fullPath),
                name: entry.name,
              });
            }
          }
        };
        walk(searchPath);
      }

      return {
        pattern: args.pattern,
        path: args.path || '.',
        type: args.type || 'name',
        results: results,
        total: results.length,
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function globRegex(glob = '**') {
  const escaped = glob.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // A leading **/ also matches files directly in the searched directory.
    .replace(/\*\*\//g, '<<<DIRS>>>').replace(/\*\*/g, '<<<ALL>>>')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/<<<DIRS>>>/g, '(?:.*/)?').replace(/<<<ALL>>>/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function inspectWorkspace(options = {}) {
  const requestedDepth = Number(options.max_depth);
  const requestedReadmeLines = Number(options.readme_lines);
  const maxDepth = Math.min(4, Math.max(1, Number.isFinite(requestedDepth) ? requestedDepth : 2));
  const readmeLines = Math.min(50, Math.max(0, Number.isFinite(requestedReadmeLines) ? requestedReadmeLines : 10));
  const root = path.resolve(STATIC_DIR);
  const ignored = new Set(['.git', '.llmoptimus-trash', 'node_modules']);
  const extensions = new Map();
  const importantNames = new Set([
    'readme.md', 'package.json', 'requirements.txt', 'pyproject.toml', 'cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', 'dockerfile', 'compose.yaml', 'compose.yml',
  ]);
  const importantFiles = [];

  const build = (directory, depth) => {
    if (depth > maxDepth) return [];
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => !ignored.has(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return entries.map(entry => {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) return { name: entry.name, type: 'directory', children: depth < maxDepth ? build(fullPath, depth + 1) : undefined };
      const extension = path.extname(entry.name).toLowerCase();
      if (extension) extensions.set(extension, (extensions.get(extension) || 0) + 1);
      if (importantNames.has(entry.name.toLowerCase())) importantFiles.push(relative);
      return { name: entry.name, type: 'file', size: fs.statSync(fullPath).size };
    });
  };

  const languageByExtension = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript',
    '.py': 'Python', '.ps1': 'PowerShell', '.cs': 'C#', '.java': 'Java', '.kt': 'Kotlin',
    '.c': 'C', '.cc': 'C++', '.cpp': 'C++', '.rs': 'Rust', '.go': 'Go', '.rb': 'Ruby',
    '.php': 'PHP', '.html': 'HTML', '.css': 'CSS', '.md': 'Markdown',
  };
  const tree = build(root, 1);
  const languages = [...extensions.entries()]
    .filter(([extension]) => languageByExtension[extension])
    .map(([extension, count]) => ({ language: languageByExtension[extension], extension, files: count }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
  const readmePath = ['README.md', 'README.MD', 'readme.md'].map(name => path.join(root, name)).find(fs.existsSync);
  const readmePreview = readmePath && readmeLines
    ? fs.readFileSync(readmePath, 'utf8').split(/\r?\n/).slice(0, readmeLines)
    : [];
  return { workspace: root, maxDepth, tree, importantFiles, languages, readmePreview };
}

function walkWorkspace(root, visit) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.llmoptimus-trash' || entry.name === 'node_modules') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkWorkspace(fullPath, visit);
    else if (entry.isFile()) visit(fullPath);
  }
}

async function executeNativeTool(name, params = {}) {
  switch (name) {
    case 'web_search': {
      const results = await webSearch(String(params.query || ''));
      return results.length
        ? results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join('\n\n')
        : 'No web search results found.';
    }
    case 'workspace_inspection':
      return JSON.stringify(inspectWorkspace(params), null, 2);
    case 'approved_external_action': {
      const operation = params.operation;
      const original = stripApprovalMetadata(params.params || {});
      const target = path.resolve(params.path || original.path || '');
      if (target !== path.resolve(original.path || target)) throw new Error('External action target changed after approval');
      if (operation === 'read_file') {
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`File not found: ${target}`);
        const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
        const start = Math.max(1, Number(original.start_line) || 1);
        const end = Math.min(lines.length, Number(original.end_line) || lines.length);
        return lines.slice(start - 1, end).join('\n');
      }
      if (operation === 'write_file') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(original.content || ''), 'utf8');
        return `Wrote ${String(original.content || '').length} characters to ${target}.`;
      }
      if (operation === 'edit_file') {
        if (!fs.existsSync(target)) throw new Error(`File not found: ${target}`);
        let lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
        const changes = [...(original.changes || [])].sort((a, b) => b.line_start - a.line_start);
        for (const change of changes) {
          const start = change.line_start === -1 ? lines.length : change.line_start - 1;
          const count = change.line_start === -1 ? 0 : change.line_end - change.line_start + 1;
          const inserted = change.mode === 'delete' ? [] : String(change.content).split(/\r?\n/);
          lines.splice(change.mode === 'append' ? start + count : start, change.mode === 'append' ? 0 : count, ...inserted);
        }
        fs.writeFileSync(target, lines.join('\n'), 'utf8');
        return `Edited ${target} successfully.`;
      }
      if (operation === 'delete_file') {
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`File not found: ${target}`);
        const trashDir = resolveInWorkspace('.llmoptimus-trash', 'trash directory');
        fs.mkdirSync(trashDir, { recursive: true });
        const trashPath = path.join(trashDir, `${Date.now()}-external-${path.basename(target)}`);
        fs.copyFileSync(target, trashPath);
        fs.unlinkSync(target);
        return `Moved ${target} to ${trashPath}. The file is recoverable from project trash.`;
      }
      if (operation === 'run_file') {
        return runWorkspaceFile(target, original.arguments, Math.min(60, Math.max(1, Number(original.timeout) || 30)) * 1000, original.max_output_size, true).stdout;
      }
      throw new Error(`Unsupported external action: ${operation}`);
    }
    case 'read_file': {
      const result = await executeTool('read_file', { filepath: params.path });
      const lines = result.content.split(/\r?\n/);
      const start = Math.max(1, Number(params.start_line) || 1);
      const end = Math.min(lines.length, Number(params.end_line) || lines.length);
      const selected = lines.slice(start - 1, end);
      return params.append_loc
        ? selected.map((line, index) => `${start + index}→ ${line}`).join('\n')
        : selected.join('\n');
    }
    case 'file_glob_search': {
      const root = resolveInWorkspace(params.path || '.', 'search path');
      const include = globRegex(params.include || '**');
      const exclude = params.exclude ? globRegex(params.exclude) : null;
      const matches = [];
      walkWorkspace(root, filePath => {
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        if (include.test(relative) && !exclude?.test(relative)) matches.push(relative);
      });
      return matches.length ? matches.join('\n') : 'No matching files found.';
    }
    case 'grep_search': {
      const root = resolveInWorkspace(params.path || '.', 'search path');
      const pattern = new RegExp(params.pattern, 'i');
      const include = params.include ? globRegex(params.include) : null;
      const exclude = params.exclude ? globRegex(params.exclude) : null;
      const matches = [];
      const inspect = filePath => {
        const relative = path.relative(STATIC_DIR, filePath).replace(/\\/g, '/');
        if (include && !include.test(relative) || exclude?.test(relative)) return;
        try {
          const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
          lines.forEach((line, index) => {
            pattern.lastIndex = 0;
            if (pattern.test(line) && matches.length < 200) matches.push(`${relative}${params.return_line_numbers === false ? '' : `:${index + 1}`}: ${line}`);
          });
        } catch { /* Skip binary or unreadable files. */ }
      };
      if (fs.statSync(root).isFile()) inspect(root); else walkWorkspace(root, inspect);
      return matches.length ? matches.join('\n') : 'No matches found.';
    }
    case 'exec_shell_command': {
      const timeout = Math.min(60, Math.max(1, Number(params.timeout) || 10)) * 1000;
      const maxBuffer = Math.min(1024 * 1024, Math.max(1024, Number(params.max_output_size) || 16384));
      let command = String(params.command || '');
      // Correct the common small-model mistake of passing a Python file to
      // PowerShell's -File option. Preserve any arguments after the filename.
      const pythonViaPowerShell = command.match(/^\s*powershell(?:\.exe)?\b[\s\S]*?\s-File\s+("[^"]+\.py"|'[^']+\.py'|[^\s]+\.py)([\s\S]*)$/i);
      if (pythonViaPowerShell) {
        command = `python ${pythonViaPowerShell[1]}${pythonViaPowerShell[2] || ''}`;
        logRouter('NATIVE', 'normalized Python command', { command });
      }
      const output = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd: STATIC_DIR, timeout, maxBuffer, encoding: 'utf8', windowsHide: true,
      });
      return output || 'Command completed successfully with no stdout.';
    }
    case 'run_file': {
      const result = runWorkspaceFile(
        params.path,
        params.arguments,
        Math.min(60, Math.max(1, Number(params.timeout) || 30)) * 1000,
        params.max_output_size
      );
      return result.stdout;
    }
    case 'write_file': {
      const result = await executeTool('write_file', { filepath: params.path, content: params.content });
      return `Wrote ${result.size} characters to ${result.path}.`;
    }
    case 'delete_file': {
      const result = await executeTool('delete_file', { filepath: params.path });
      return `Moved ${result.path} to ${result.trashedTo}. The file is recoverable from project trash.`;
    }
    case 'edit_file': {
      const filePath = resolveInWorkspace(params.path, 'file');
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${params.path}`);
      let lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      const changes = [...(params.changes || [])].sort((a, b) => b.line_start - a.line_start);
      for (const change of changes) {
        const start = change.line_start === -1 ? lines.length : change.line_start - 1;
        const count = change.line_start === -1 ? 0 : change.line_end - change.line_start + 1;
        const inserted = change.mode === 'delete' ? [] : String(change.content).split(/\r?\n/);
        const index = change.mode === 'append' ? start + count : start;
        lines.splice(index, change.mode === 'append' ? 0 : count, ...inserted);
      }
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
      return `Edited ${params.path} successfully.`;
    }
    case 'apply_diff': {
      const paths = [...String(params.diff).matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/gm)]
        .map(match => match[1].trim()).filter(value => value !== '/dev/null');
      if (!paths.length) throw new Error('Diff contains no file paths');
      paths.forEach(filePath => resolveInWorkspace(filePath, 'diff path'));
      require('node:child_process').execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
        cwd: STATIC_DIR, input: params.diff, encoding: 'utf8', windowsHide: true,
      });
      return `Applied diff to ${paths.join(', ')}.`;
    }
    case 'get_datetime':
      return new Date().toString();
    default:
      throw new Error(`Unknown native tool: ${name}`);
  }
}

// ============================================================================
// TOOL EXECUTION FOR CHAT
// ============================================================================

async function executeToolCalls(toolCalls) {
  const results = [];
  for (const call of toolCalls) {
    try {
      const rawArgs = call?.function?.arguments ?? {};
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
      const started = Date.now();
      logRouter('TOOL', `starting ${call.function.name}`, safeToolLogDetails(call.function.name, args));
      const result = await executeTool(call.function.name, args);
      logRouter('TOOL', `completed ${call.function.name} in ${Date.now() - started}ms`);
      results.push({
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
          result: JSON.stringify(result),
        },
      });
    } catch (error) {
      logRouter('ERROR', `tool ${call?.function?.name || 'unknown'} failed: ${error.message}`);
      results.push({
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
          result: JSON.stringify({ error: error.message }),
        },
      });
    }
  }
  return results;
}

function extractToolCalls(response) {
  const message = response?.choices?.[0]?.message;
  if (!message?.tool_calls) return null;
  return message.tool_calls;
}

function extractTextToolCalls(content, allowedNames = AVAILABLE_TOOLS.map(tool => tool.function.name), includeOffset = false) {
  if (typeof content !== 'string' || !content.trim()) return includeOffset ? { calls: null, start: -1 } : null;
  const tagged = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)].map(match => ({
    text: match[1],
    start: match.index + match[0].indexOf(match[1]),
  }));
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match => ({
    text: match[1],
    start: match.index + match[0].indexOf(match[1]),
  }));
  let trimmed = content.trim();
  let trimmedStart = content.indexOf(trimmed);
  const jsonPrefix = trimmed.match(/^json\s*/i);
  if (jsonPrefix) {
    trimmed = trimmed.slice(jsonPrefix[0].length);
    trimmedStart += jsonPrefix[0].length;
  }
  // Pull complete JSON objects out of mixed model output. Small models may
  // append a fabricated <tool_response> after a valid call; a greedy
  // first-{...last-} slice makes the otherwise valid call unparsable.
  const embedded = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        embedded.push({ text: trimmed.slice(start, index + 1), start: trimmedStart + start });
        start = -1;
      }
    }
  }
  const candidates = tagged.length ? tagged : fenced.length ? fenced : embedded.length ? embedded : [{ text: trimmed, start: trimmedStart }];
  const allowed = new Set(allowedNames);
  const calls = [];
  let firstCallStart = -1;

  for (const candidate of candidates) {
    try {
      let parsed;
      try {
        parsed = JSON.parse(candidate.text);
      } catch {
        // Small local models sometimes use Python-style triple-quoted strings
        // for multiline file contents. That is readable, but it is not JSON,
        // so normalize those values before parsing the tool call.
        const repairedMultilineStrings = candidate.text.replace(
          /"""\r?\n?([\s\S]*?)\r?\n?"""/g,
          (_, value) => JSON.stringify(value)
        );
        const repairedPaths = repairedMultilineStrings.replace(
          /("(?:path|filepath|directory)"\s*:\s*")([^"]*)(")/g,
          (_, before, value, after) => before + value.replace(/\\/g, '\\\\') + after
        );
        parsed = JSON.parse(repairedPaths.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'));
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const fn = item?.function || item;
        if (typeof fn?.name !== 'string' || fn.name.length === 0) continue;
        if (includeOffset && firstCallStart < 0) firstCallStart = candidate.start;
        if (fn.arguments == null) continue;
        if (!allowed.has(fn.name)) continue;
        calls.push({
          id: item.id || `call_${Date.now()}_${calls.length}`,
          type: 'function',
          function: {
            name: fn.name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments),
          },
        });
      }
    } catch { /* Try the next complete JSON object. */ }
  }
  if (includeOffset) return { calls: calls.length ? calls : null, start: firstCallStart };
  return calls.length ? calls : null;
}

function validateNativeToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return null;
  const valid = [];
  for (const call of calls) {
    const native = NATIVE_TOOLS.find(tool => tool.tool === call?.function?.name);
    if (!native) continue;
    let args;
    try {
      args = typeof call.function.arguments === 'string'
        ? JSON.parse(call.function.arguments || '{}')
        : call.function.arguments;
    } catch { continue; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    const schema = native.definition.function.parameters || {};
    if ((schema.required || []).some(name => args[name] === undefined)) continue;
    const allowedProperties = new Set(Object.keys(schema.properties || {}));
    if (Object.keys(args).some(name => !allowedProperties.has(name))) continue;
    const typeMatches = Object.entries(schema.properties || {}).every(([name, property]) => {
      if (args[name] === undefined) return true;
      if (property.type === 'array') return Array.isArray(args[name]);
      if (property.type === 'integer') return Number.isInteger(args[name]);
      if (property.type === 'number') return typeof args[name] === 'number';
      if (property.type === 'boolean') return typeof args[name] === 'boolean';
      if (property.type === 'object') return args[name] && typeof args[name] === 'object' && !Array.isArray(args[name]);
      return property.type !== 'string' || typeof args[name] === 'string';
    });
    if (!typeMatches) continue;
    valid.push({ ...call, function: { ...call.function, arguments: JSON.stringify(args) } });
  }
  return valid.length ? valid : null;
}

function redirectRepeatedFailedNativeCalls(calls, messages) {
  if (!Array.isArray(calls) || !calls.length) return calls;
  const results = new Map((messages || [])
    .filter(message => message?.role === 'tool')
    .map(message => [message.tool_call_id, String(message.content || '')]));
  const failedAttempts = new Map();
  for (let messageIndex = 0; messageIndex < (messages || []).length; messageIndex++) {
    const message = messages[messageIndex];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const result = results.get(call.id);
      if (!/file not found/i.test(result || '')) continue;
      try {
        const args = stripApprovalMetadata(JSON.parse(call.function.arguments || '{}'));
        failedAttempts.set(`${call.function.name}:${JSON.stringify(args)}`, { name: call.function.name, args, messageIndex });
      } catch { /* Malformed historical calls are not safe to compare. */ }
    }
  }

  return calls.map(call => {
    let args;
    try { args = stripApprovalMetadata(JSON.parse(call.function.arguments || '{}')); }
    catch { return call; }
    const prior = failedAttempts.get(`${call.function.name}:${JSON.stringify(args)}`);
    if (!prior || !['read_file', 'run_file', 'edit_file', 'delete_file'].includes(prior.name)) return call;
    const interveningMutation = (messages || []).slice(prior.messageIndex + 1).some(message =>
      message?.role === 'assistant' && message.tool_calls?.some(candidate => {
        if (!['write_file', 'edit_file', 'apply_diff'].includes(candidate.function?.name)) return false;
        const result = results.get(candidate.id);
        return result && !/\b(error|failed|failure|exception|file not found|access denied)\b/i.test(result);
      })
    );
    if (interveningMutation) return call;
    const requestedPath = String(args.path || '');
    const basename = path.basename(requestedPath);
    const include = basename && path.extname(basename) ? `**/${basename}` : '**';
    logRouter('NATIVE', `redirecting repeated failed ${prior.name} to file discovery`, { target: requestedPath });
    return {
      ...call,
      id: `call_file_glob_search_${Date.now()}`,
      function: {
        name: 'file_glob_search',
        arguments: JSON.stringify({ path: '.', include }),
      },
    };
  });
}

function looksLikeToolAttempt(content) {
  return typeof content === 'string'
    && /(?:<tool_call>|["']name["']\s*:|["']arguments["']\s*:|\btool[_ ]?call\b)/i.test(content);
}

async function repairNativeToolCall(content) {
  if (!looksLikeToolAttempt(content)) return null;
  const intendedName = String(content).match(/["']name["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const relevantTool = NATIVE_TOOLS.find(tool => tool.tool === intendedName);
  logRouter('REPAIR', 'invalid tool-like output detected', {
    intendedTool: intendedName || '(missing)',
    contentLength: String(content).length,
  });
  if (!relevantTool) {
    logRouter('REPAIR', 'repair rejected: proposed tool name is missing or is not allowed');
    return null;
  }
  const prompt = [
    `Repair the malformed arguments for the ${intendedName} tool.`,
    'Call the supplied tool exactly once with corrected arguments.',
    'Preserve literal paths and content. Do not invent results or claim the action succeeded.',
    `MALFORMED=${String(content).slice(0, 6000)}`,
    'CORRECTED_TOOL_CALL=',
  ].join('\n');
  try {
    logRouter('REPAIR', `requesting JSON correction from instruction-tuned coder at ${REPAIR_WEB}`);
    const response = await fetch(REPAIR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder',
        messages: [
          { role: 'system', content: 'You are a tool-call repair engine. Call only the supplied tool. Never invent tool results, explain, use Markdown, or repeat tokens.' },
          { role: 'user', content: prompt },
        ],
        tools: [relevantTool.definition],
        tool_choice: 'required',
        temperature: 0,
        max_tokens: 512,
        stream: false,
      }),
      signal: AbortSignal.timeout(90 * 1000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message || {};
    const repairedText = message.content || payload?.choices?.[0]?.text || '';
    const candidates = message.tool_calls || extractTextToolCalls(repairedText, [intendedName]);
    const repaired = validateNativeToolCalls(candidates)?.filter(call => call.function.name === intendedName);
    logRouter('REPAIR', 'tool-call repair candidate received', {
      intendedTool: intendedName,
      structured: Array.isArray(message.tool_calls),
      candidateLength: String(repairedText).length,
    });
    if (repaired?.length) {
      logRouter('REPAIR', `instruction-tuned coder repaired tool call as ${repaired[0].function.name}`);
      return [repaired[0]];
    }
    logRouter('REPAIR', 'JSON repair returned no valid tool call');
  } catch (error) {
    logRouter('REPAIR', `JSON repair unavailable: ${error.message}`);
  }
  return null;
}

function toolCallsKey(calls) {
  return JSON.stringify(calls.map(call => ({
    name: call.function.name,
    arguments: normalizeToolArguments(call.function.name, call.function.arguments),
  })));
}

function normalizeToolArguments(name, rawArguments) {
  let args = rawArguments;
  try {
    if (typeof args === 'string') args = JSON.parse(args || '{}');
  } catch { return String(rawArguments); }
  args = { ...(args || {}) };

  if (name === 'get_project_structure') {
    args.directory = path.resolve(args.directory || STATIC_DIR).toLowerCase();
    args.maxDepth = args.maxDepth || 3;
    args.exclude = args.exclude || [];
  }
  if (name === 'list_files') args.directory = path.resolve(args.directory || STATIC_DIR).toLowerCase();
  if (['read_file', 'write_file', 'edit_file'].includes(name) && args.filepath) {
    args.filepath = path.resolve(args.filepath).toLowerCase();
  }
  if (name === 'search_files') args.path = path.resolve(args.path || STATIC_DIR).toLowerCase();
  return JSON.stringify(args, Object.keys(args).sort());
}

function formatTree(items, prefix = '') {
  if (!Array.isArray(items)) return '';
  const lines = [];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    lines.push(`${prefix}${last ? '└─' : '├─'} ${item.name}${item.type === 'dir' ? '/' : ''}`);
    if (item.children) lines.push(formatTree(item.children, `${prefix}${last ? '   ' : '│  '}`));
  });
  return lines.filter(Boolean).join('\n');
}

function summarizeToolResults(results) {
  return results.map(result => {
    let value;
    try { value = JSON.parse(result.function.result); } catch { value = result.function.result; }
    if (value?.error) return `${result.function.name} failed: ${value.error}`;
    if (result.function.name === 'read_file' && typeof value?.content === 'string') {
      return `Contents of ${value.path}:\n\n${value.content}`;
    }
    if (result.function.name === 'list_files' && Array.isArray(value?.items)) {
      const listing = value.items.map(item => `- ${item.name}${item.type === 'directory' ? '/' : ''}`).join('\n');
      const first = value.items[0]?.name;
      return `${first ? `The first item is ${first}.\n\n` : ''}Files in ${value.directory}:\n${listing || '(empty directory)'}`;
    }
    if (result.function.name === 'get_project_structure' && value?.tree) {
      return `Project structure (${value.root}):\n\n${value.name}/\n${formatTree(value.tree)}`;
    }
    if (result.function.name === 'delete_file' && value?.recoverable) {
      return `${value.path} was moved to ${value.trashedTo}. It can be recovered from project trash.`;
    }
    if (value?.path) return `${result.function.name} completed successfully: ${value.path}`;
    if (value?.stdout) return `${result.function.name} completed successfully:\n${value.stdout}`;
    return `${result.function.name} completed successfully.`;
  }).join('\n');
}

function describeToolCall(call) {
  let args = {};
  try {
    args = typeof call.function.arguments === 'string'
      ? JSON.parse(call.function.arguments || '{}')
      : (call.function.arguments || {});
  } catch { /* Use a generic status when arguments are malformed. */ }
  const target = args.filepath || args.path || args.directory;
  const labels = {
    read_file: target ? `Reading ${target}` : 'Reading file',
    write_file: target ? `Writing ${target}` : 'Writing file',
    edit_file: target ? `Editing ${target}` : 'Editing file',
    list_files: target ? `Listing ${target}` : 'Listing files',
    search_files: `Searching project files${args.pattern ? ` for ${args.pattern}` : ''}`,
    get_project_structure: 'Inspecting project structure',
    workspace_inspection: 'Inspecting workspace',
    run_command: args.command ? `Run command: ${args.command}` : 'Run command',
    run_file: target ? `Run ${target}` : 'Run file',
    delete_file: target ? `Move ${target} to project trash` : 'Move file to project trash',
    web_search: `Searching the web${args.query ? ` for ${args.query}` : ''}`,
  };
  return labels[call.function.name] || `Using ${call.function.name}`;
}

function toolResultSucceeded(result) {
  try { return !JSON.parse(result.function.result)?.error; } catch { return true; }
}

function assessToolCallRisk(call) {
  let args = {};
  try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function.arguments || {}); }
  catch { return { level: 'Critical', reason: 'The tool arguments are malformed.', approval: true }; }
  const name = call.function.name;
  const target = args.filepath || args.path || args.directory;
  if (typeof target === 'string' && inspectPathScope(target).outside) {
    return { level: 'Critical', reason: 'The target is outside the OptimiLLM workspace.', approval: true };
  }
  if (['read_file', 'list_files', 'search_files', 'get_project_structure', 'workspace_inspection', 'file_glob_search', 'grep_search'].includes(name)) {
    return { level: 'Low', reason: 'This action only reads or searches inside the workspace.', approval: false };
  }
  if (['write_file', 'edit_file', 'apply_diff'].includes(name)) {
    return { level: 'Medium', reason: 'This action changes files in the workspace.', approval: true };
  }
  if (['delete_file'].includes(name)) {
    return { level: 'High', reason: 'This action removes a file from its current location.', approval: true };
  }
  if (['run_file', 'run_command', 'exec_shell_command'].includes(name)) {
    const command = String(args.command || '');
    const critical = /(?:\b(?:format|diskpart|reg\s+(?:add|delete)|remove-item)\b|\.\.\\|[A-Za-z]:\\|https?:\/\/|invoke-webrequest|curl\b)/i.test(command);
    return {
      level: critical ? 'Critical' : 'High',
      reason: critical
        ? 'The command may affect external files, system settings, or the network.'
        : 'Executed code inherits your Windows user access and may access files outside this project.',
      approval: true,
    };
  }
  return { level: 'Low', reason: 'No file changes or code execution were detected.', approval: false };
}

function requiresApproval(calls) {
  return approvalsEnabled && calls.some(call => call.function.name !== 'web_search' && assessToolCallRisk(call).approval);
}

function approvalQuestion(calls) {
  const actions = calls.map(call => {
    const risk = assessToolCallRisk(call);
    return `- Action: ${describeToolCall(call)}\n  Risk: ${risk.level}\n  Reason: ${risk.reason}`;
  }).join('\n');
  return `Approval required before I access your computer:\n\n${actions}\n\nWorkspace: ${STATIC_DIR}\n\nReply **yes** to allow this exact action once, or **no** to cancel.`;
}

function directChatResponse(res, stream, model, content) {
  if (stream) {
    const chunk = {
      id: `chatcmpl-router-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-LLM-Routed-Model': model,
    });
    return res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  }
  return json(res, 200, {
    id: `chatcmpl-router-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

async function resolvePendingApproval(res, stream, model, prompt) {
  if (!pendingApproval) return false;
  if (Date.now() - pendingApproval.createdAt > APPROVAL_TTL_MS) {
    pendingApproval = null;
    return false;
  }
  const answer = prompt.trim().toLowerCase();
  if (/^(no|n|cancel|deny|stop|do not|don't)\b/.test(answer)) {
    logRouter('APPROVAL', 'pending tool action denied');
    pendingApproval = null;
    directChatResponse(res, stream, model, 'Cancelled. No file or command action was performed.');
    return true;
  }
  if (!/^(yes|y|approve|allow|go ahead|do it|ok|okay)\b/.test(answer)) return false;

  const approved = pendingApproval;
  pendingApproval = null;
  logRouter('APPROVAL', `approved: ${approved.calls.map(call => call.function.name).join(', ')}`);
  const results = await executeToolCalls(approved.calls);
  const status = approved.calls.map(call => `🔧 ${describeToolCall(call)}…`).join('\n');
  const completion = results.map(result => `${toolResultSucceeded(result) ? '✓' : '✗'} ${result.function.name}`).join('\n');
  directChatResponse(res, stream, model, `${status}\n${completion}\n\n${summarizeToolResults(results)}`);
  return true;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const codePatterns = [
  /\b(write|create|generate|implement|fix|debug|refactor|optimize|review|test|compile|convert)\b[\s\S]{0,80}\b(code|script|function|class|program|app|component|query|regex|test|bug|error)\b/i,
  /\b(code|script|function|class|program|app|component|query|regex|test|bug|error)\b[\s\S]{0,80}\b(write|create|generate|implement|fix|debug|refactor|optimize|review|test|compile|convert)\b/i,
  /\b(debug|fix|explain)\b[\s\S]{0,80}\b(stack trace|exception|compiler error|runtime error)\b/i,
  /```|\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{|\b(error|exception):/i,
];

const searchPatterns = [
  /\b(search|browse|look up|google|online|on the web|web search|find sources?)\b/i,
  /\b(latest|current|currently|today|tonight|yesterday|this week|recent|news|updated|newest)\b/i,
  /\b(weather|forecast|temperature|score|standings|schedule|price|stock|exchange rate|release date)\b/i,
  /\b(who is (?:the )?(?:president|prime minister|ceo)|what version|is .* down)\b/i,
];

function lastUserText(messages = []) {
  const message = [...messages].reverse().find(item => item && item.role === 'user');
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(item => typeof item === 'string' ? item : item?.text || '').join('\n');
  }
  return '';
}

function chooseModel(body, prompt) {
  const requested = String(body.model || 'auto').toLowerCase();
  if (requested === 'general' || requested === 'coder') return requested;
  
  const isCodeTask = codePatterns.some(pattern => pattern.test(prompt));
  const complexityPatterns = [
    /\b(explain.*why|why.* happen|reason|reasoning|analyze|analysis|factor|consider|consideration|implication|pros.*cons|advantage|disadvantage|trade-off|tradeoff)\b/i,
    /\b(plan|strategy|approach|methodology|framework|systematic|step by step|break down|detailed|comprehensive|thorough|in-depth|deep dive)\b/i,
    /\b(compare|comparison|difference|versus|vs\.|vs |alternatives?|option|evaluate|evaluation|assess|assessment)\b/i,
    /\b(philosophy|ethical|moral|argue|argument|critique|critical|perspective|viewpoint|opinion|debate|discuss|discussion)\b/i,
    /\b(design|architecture|system design|software architecture|pattern|best practice|recommend|recommendation|suggest|suggestion)\b/i,
    /\b(how.*work|how.*function|understand|understanding|concept|conceptual|theory|theor|principle|fundament|basis|underlying)\b/i,
  ];
  const needsThinking = complexityPatterns.some(pattern => pattern.test(prompt));
  const generalScore = isCodeTask ? 10 : needsThinking ? 90 : 40;
  const generalBias = typeof body.general_bias === 'number' ? body.general_bias : 50;
  return generalScore >= 100 - generalBias ? 'general' : 'coder';
}

function isDateTimeRequest(prompt) {
  return /\b(what (?:day|date|time)|current (?:day|date|time)|today'?s? (?:day|date)|day is (?:it|today)|what day is today)\b/i.test(prompt);
}

function toolsForPrompt(tools, prompt) {
  if (!Array.isArray(tools) || isDateTimeRequest(prompt)) return tools;
  return tools.filter(tool => (tool?.function || tool?.definition?.function)?.name !== 'get_datetime');
}

function filterCallsToAvailableTools(calls, tools) {
  const available = new Set((tools || []).map(tool => (tool?.function || tool?.definition?.function)?.name).filter(Boolean));
  return Array.isArray(calls) ? calls.filter(call => available.has(call?.function?.name)) : null;
}

function rejectedToolFallback(prompt) {
  if (/^\s*(?:hi|hello|hey|yo|good morning|good afternoon|good evening)[!. ]*$/i.test(prompt)) {
    return 'Hi! How can I help?';
  }
  return 'I could not use a tool for that request. Please clarify what you would like me to do.';
}

function shouldSearch(body, prompt) {
  if (body.web_search === true) return true;
  if (body.web_search === false) return false;
  if (/\b(what (?:day|date|time)|current (?:day|date|time)|today'?s? (?:day|date)|day is (?:it|today)|what day is today)\b/i.test(prompt)) return false;
  if (/\b(file|folder|directory|project|workspace|codebase|structure|read_file|write_file|list_files|get_project_structure)\b/i.test(prompt)
      && !/\b(search the web|web search|online|google|browse the web)\b/i.test(prompt)) return false;
  return searchPatterns.some(pattern => pattern.test(prompt));
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

async function webSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.slice(0, 500))}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 LLMOptimus/1.0' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`search provider returned HTTP ${response.status}`);
  const html = await response.text();
  const results = [];
  const blocks = html.split('class="result results_links').slice(1);
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    let target = link[1].replace(/&amp;/g, '&');
    try {
      const parsed = new URL(target, 'https://duckduckgo.com');
      target = parsed.searchParams.get('uddg') || parsed.href;
    } catch { /* Keep the original target. */ }
    results.push({
      title: decodeHtml(link[2]),
      url: decodeURIComponent(target),
      snippet: decodeHtml(snippet?.[1] || snippet?.[2] || ''),
    });
    if (results.length === 5) break;
  }
  if (!results.length) throw new Error('search provider returned no usable results');
  return results;
}

function searchContext(query, results) {
  const lines = results.map((result, index) =>
    `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.snippet}`
  ).join('\n\n');
  return {
    role: 'system',
    content: `Web search results for: ${query}\n\n${lines}\n\nUse these results when relevant. Cite factual web claims with [number](URL). Say when the results do not establish an answer.`,
  };
}

function json(res, status, value, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...extraHeaders,
  });
  res.end(payload);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; font-src 'self' data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function validateLocalRequest(req) {
  const hostValue = String(req.headers.host || '');
  let hostUrl;
  try { hostUrl = new URL(`http://${hostValue}`); }
  catch { throw Object.assign(new Error('Invalid Host header'), { statusCode: 400 }); }
  if (!isLoopbackHostname(hostUrl.hostname)) {
    throw Object.assign(new Error('Rejected non-loopback Host header'), { statusCode: 403 });
  }

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originUrl;
    try { originUrl = new URL(origin); }
    catch { throw Object.assign(new Error('Invalid Origin header'), { statusCode: 400 }); }
    if (originUrl.protocol !== 'http:' || !isLoopbackHostname(originUrl.hostname) || originUrl.port !== String(PORT)) {
      throw Object.assign(new Error('Cross-origin requests are not allowed'), { statusCode: 403 });
    }
  } else if (origin === 'null') {
    throw Object.assign(new Error('Opaque-origin requests are not allowed'), { statusCode: 403 });
  }
}

function requireJsonRequest(req) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveLocalStaticFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return json(res, 404, { error: { message: 'not found' } });
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function proxyToCoderWeb(req, res, targetPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const upstream = await fetch(`${CODER_WEB}${targetPath}`, {
      method: req.method,
      signal: controller.signal,
      headers: {
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
        'Cache-Control': req.headers['cache-control'] || '',
        'Pragma': req.headers['pragma'] || '',
        'Sec-Fetch-Dest': req.headers['sec-fetch-dest'] || '',
        'Sec-Fetch-Mode': req.headers['sec-fetch-mode'] || '',
        'Sec-Fetch-Site': req.headers['sec-fetch-site'] || 'cross-site',
        'Sec-Fetch-User': req.headers['sec-fetch-user'] || '',
        'User-Agent': req.headers['user-agent'] || '',
      },
    });
    clearTimeout(timeout);
    if (!upstream.ok) {
      return json(res, upstream.status, { error: { message: `upstream ui returned HTTP ${upstream.status}` } });
    }
    const headers = new Headers(upstream.headers);
    headers.delete('transfer-encoding');
    headers.delete('content-encoding');
    headers.set('cache-control', 'no-cache');
    if (req.method === 'GET' && /text\/html/i.test(headers.get('content-type') || '')) {
      let html = await upstream.text();
      if (!html.includes('/router-ui.js')) {
        const script = '<script defer src="/router-ui.js"></script>';
        html = /<\/body\s*>/i.test(html)
          ? html.replace(/<\/body\s*>/i, `${script}</body>`)
          : `${html}${script}`;
      }
      headers.delete('content-length');
      res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
      return res.end(html);
    }
    res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (error) {
    if (error.name === 'AbortError') {
      return json(res, 504, { error: { message: 'upstream UI server timed out' } });
    }
    json(res, 502, { error: { message: error.message } });
  }
}

function hasNativeToolSchemas(body) {
  if (!Array.isArray(body.tools)) return false;
  const nativeOnlyNames = new Set(['file_glob_search', 'grep_search', 'exec_shell_command', 'run_file', 'apply_diff', 'get_datetime', 'workspace_inspection']);
  return body.tools.some(tool => {
    const fn = tool?.function || tool?.definition?.function;
    return nativeOnlyNames.has(fn?.name)
      || (fn?.name === 'read_file' && fn?.parameters?.properties?.path)
      || (fn?.name === 'edit_file' && fn?.parameters?.properties?.changes);
  });
}

function chooseRequiredNativeTool(prompt, tools) {
  const available = new Set((tools || []).map(tool => (tool.function || tool.definition?.function)?.name).filter(Boolean));
  const choose = name => available.has(name) ? { type: 'function', function: { name } } : undefined;
  // Requests to compose instructions should not execute the actions mentioned
  // inside those instructions. Multi-step workflows should likewise be left to
  // the agent so it can choose each tool in order.
  if (/\b(?:give|generate|write|create|make) me (?:a |an )?(?:prompt|instructions?|request)\b/i.test(prompt)) return undefined;
  if ((prompt.match(/(?:^|\n)\s*\d+[.)]\s/g) || []).length > 1) return undefined;
  // Ignore explicitly prohibited actions when detecting intent.
  const actionable = prompt.replace(/\b(?:do not|don't|never)\b[^\n.!?]*/gi, '');
  if (isDateTimeRequest(actionable)) return choose('get_datetime');
  if (/\b(workspace inspection|inspect (?:the )?(?:workspace|project)|workspace overview|project overview)\b/i.test(actionable)) return choose('workspace_inspection');
  if (/\b(run|execute|launch|test)\b(?:\s+(?:the\s+)?(?:program|script|file|code|it))?/i.test(actionable)) return choose('run_file');
  if (/\b(delete|remove|trash)\b/i.test(actionable)) return choose('delete_file');
  if (/\b(create|write|overwrite|edit|update|make it (?:say|contain)|change it to)\b/i.test(actionable)) return choose('write_file');
  if (/\b(find|locate|first file|file structure|project structure|list files?)\b/i.test(actionable)) return choose('file_glob_search');
  if (/\b(read|contents?|what does .*file say|open .*file|walkthrough|walk through|explain how .*\b(?:file|program|script)\b|how does .*\b(?:file|program|script)\b.*work)\b/i.test(actionable)) return choose('read_file');
  return undefined;
}

function requestedText(prompt) {
  const match = prompt.match(/(?:contain|say|says|change it to)\s+(?:that it\s+)?(?:the text\s+)?(.+?)(?:\s+use (?:the )?tools?)?$/i);
  if (!match) return null;
  const value = match[1].trim().replace(/^['"]|['"]$/g, '');
  if (/^something in latin$/i.test(value)) return 'Salve, mundi!';
  return value;
}

function lastMentionedFile(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (Array.isArray(message?.tool_calls)) {
      for (const call of [...message.tool_calls].reverse()) {
        try {
          const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function?.arguments;
          if (['read_file', 'write_file', 'edit_file', 'delete_file', 'run_file'].includes(call.function?.name)
              && typeof args?.path === 'string' && args.path !== '.' && args.path !== './') return args.path;
        } catch { /* Continue searching history. */ }
      }
    }
    if (typeof message?.content === 'string') {
      const explicit = message.content.match(/(?:^|[\s"'])([\w.-]+\.(?:txt|py|js|ps1|bat|cmd))\b/i);
      if (explicit) return explicit[1];
      if (/\btool[-_ ]test(?:\s+file)?\b/i.test(message.content)) return 'tool_test.py';
      if (/\bexample file\b/i.test(message.content)) return 'example.txt';
    }
  }
  return null;
}

function planTextWrite(prompt, messages) {
  let filePath = prompt.match(/(?:^|[\s"'])([\w.-]+\.txt)\b/i)?.[1];
  if (!filePath && /\bexample file\b/i.test(prompt)) filePath = 'example.txt';
  filePath ||= lastMentionedFile(messages);
  let content = requestedText(prompt);
  if (!content) {
    for (let index = messages.length - 1; index >= 0 && !content; index--) {
      if (messages[index]?.role === 'user') content = requestedText(String(messages[index].content || ''));
    }
  }
  return filePath && content ? { path: filePath, content } : null;
}

function nativeActivity(name, args = {}) {
  const target = args.path || args.filepath || args.directory;
  const labels = {
    workspace_inspection: 'Inspecting the workspace structure and project signals...',
    file_glob_search: `Searching the workspace${target ? ` from ${target}` : ''}...`,
    grep_search: `Searching file contents${args.pattern ? ` for ${args.pattern}` : ''}...`,
    read_file: `Reading ${target || 'the requested file'}...`,
    write_file: `Preparing to write ${target || 'a file'}...`,
    edit_file: `Preparing edits for ${target || 'the requested file'}...`,
    apply_diff: 'Preparing to apply the requested patch...',
    run_file: `Preparing to run ${target || 'the requested file'}...`,
    exec_shell_command: 'Preparing the approved shell command...',
    delete_file: `Preparing to move ${target || 'the requested file'} to project trash...`,
    web_search: `Searching the web${args.query ? ` for ${args.query}` : ''}...`,
    get_datetime: 'Checking the current local date and time...',
  };
  return labels[name] || `Preparing ${name.replace(/_/g, ' ')}...`;
}

function sendNativeToolCall(res, stream, model, name, args) {
  const id = `chatcmpl-native-${Date.now()}`;
  const rawCall = { id: `call_${name}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  const call = prepareNativeToolCalls(validateNativeToolCalls([rawCall]))?.[0];
  if (!call) return json(res, 400, { error: { message: `Invalid native tool call: ${name}` } });
  if (!stream) {
    return json(res, 200, {
      id, object: 'chat.completion', model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: nativeActivity(name, args), tool_calls: [call] }, finish_reason: 'tool_calls' }],
    }, { 'X-LLM-Routed-Model': model, 'X-Tool-Executor': 'llama-ui-via-router' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-LLM-Routed-Model': model,
    'X-Tool-Executor': 'llama-ui-via-router',
  });
  const activityChunk = { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: nativeActivity(name, args) }, finish_reason: null }] };
  const toolChunk = { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: null }] };
  const finishChunk = { id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
  res.end(`data: ${JSON.stringify(activityChunk)}\n\ndata: ${JSON.stringify(toolChunk)}\n\ndata: ${JSON.stringify(finishChunk)}\n\ndata: [DONE]\n\n`);
}

async function proxyNativeToolChat(res, body, routedModel) {
  const targetUrl = routedModel === 'coder' ? CODER_URL : GENERAL_URL;
  const userPrompt = lastUserText(body.messages);
  const availableTools = toolsForPrompt(body.tools, userPrompt);
  const nativeNames = (availableTools || []).map(tool => (tool.function || tool.definition?.function)?.name).filter(Boolean);
  const lastUserIndex = body.messages.reduce((last, message, index) => message?.role === 'user' ? index : last, -1);
  const currentTurnMessages = body.messages.slice(lastUserIndex + 1);
  const toolMessages = currentTurnMessages.filter(message => message?.role === 'tool');
  const calledNames = currentTurnMessages.flatMap(message =>
    message?.role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls.map(call => call?.function?.name).filter(Boolean)
      : []
  );
  const failedResult = message => /\b(error|failed|failure|exception|non-zero|exit code|file not found|access denied|no output)\b/i.test(String(message?.content || ''));
  const resultsByCallId = new Map(toolMessages.map(message => [message.tool_call_id, message]));
  const attemptedCalls = currentTurnMessages.flatMap(message =>
    message?.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : []
  );
  const callSignature = call => `${call.function?.name}:${call.function?.arguments || '{}'}`;
  const consecutiveRepeatedCall = attemptedCalls.length >= 2
    && callSignature(attemptedCalls.at(-1)) === callSignature(attemptedCalls.at(-2));
  let failedExecution = null;
  for (let messageIndex = currentTurnMessages.length - 1; messageIndex >= 0 && !failedExecution; messageIndex--) {
    const message = currentTurnMessages[messageIndex];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of [...message.tool_calls].reverse()) {
      const result = resultsByCallId.get(call.id);
      if (call.function?.name === 'run_file' && result && failedResult(result)) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* Leave path unknown. */ }
        failedExecution = { call, path: args.path, messageIndex };
        break;
      }
    }
  }
  let recoveryTool;
  if (failedExecution?.path) {
    const afterFailure = currentTurnMessages.slice(failedExecution.messageIndex + 1);
    const successfulAfter = name => afterFailure.some(message =>
      message?.role === 'assistant' && message.tool_calls?.some(call => {
        if (call.function?.name !== name) return false;
        const result = resultsByCallId.get(call.id);
        return result && !failedResult(result);
      })
    );
    if (successfulAfter('edit_file') || successfulAfter('write_file') || successfulAfter('apply_diff')) {
      recoveryTool = 'run_file';
    } else if (successfulAfter('read_file')) {
      recoveryTool = 'edit_file';
    } else {
      recoveryTool = 'read_file';
    }
  }
  const completedExecution = [...currentTurnMessages].reverse().flatMap(message =>
    message?.role === 'assistant' && Array.isArray(message.tool_calls) ? [...message.tool_calls].reverse() : []
  ).find(call =>
    ['exec_shell_command', 'run_file'].includes(call?.function?.name)
    && resultsByCallId.has(call.id) && !failedResult(resultsByCallId.get(call.id))
  );
  const multiStepRequest = (userPrompt.match(/(?:^|\n)\s*\d+[.)]\s/g) || []).length > 1;
  if (completedExecution && !multiStepRequest) {
    const rawOutput = String(resultsByCallId.get(completedExecution.id)?.content || '');
    const noStdout = /completed successfully with no stdout\.?/i.test(rawOutput);
    const requestedMutation = /\b(edit|change|modify|update|write|create)\b/i.test(userPrompt);
    const mutationCompleted = calledNames.some(name => ['write_file', 'edit_file', 'apply_diff'].includes(name));
    const missingEdit = requestedMutation && !mutationCompleted
      ? '\n\nThe requested file edit was not completed because no write or edit tool succeeded in this turn.'
      : '';
    const summary = noStdout
      ? `Execution completed successfully, but the program produced no console output.${missingEdit}`
      : `Execution completed successfully. Exact console output:\n\n\`\`\`text\n${rawOutput.trimEnd()}\n\`\`\`${missingEdit}`;
    logRouter('NATIVE', `returning grounded ${completedExecution.function.name} output`);
    return directChatResponse(res, body.stream, routedModel, summary);
  }
  // Distinct tool calls are progress, regardless of their count. Stop only an
  // actual identical back-to-back loop. Failed execution recovery is exempt.
  const forceFinal = consecutiveRepeatedCall && !recoveryTool;
  const missingReadNeedsCreate = !forceFinal
    && /\b(?:create|write|make)\b/i.test(userPrompt)
    && !calledNames.some(name => ['write_file', 'edit_file', 'apply_diff'].includes(name))
    && attemptedCalls.some(call => call.function?.name === 'read_file'
      && /file not found/i.test(String(resultsByCallId.get(call.id)?.content || '')));
  const candidateTool = forceFinal
    ? undefined
    : recoveryTool
      ? { type: 'function', function: { name: recoveryTool } }
    : missingReadNeedsCreate
      ? { type: 'function', function: { name: 'write_file' } }
      : chooseRequiredNativeTool(userPrompt, availableTools);
  // Do not force the original operation a second time on the continuation turn.
  const requiredTool = candidateTool && (recoveryTool || !calledNames.includes(candidateTool.function.name))
    ? candidateTool
    : undefined;
  body = {
    ...body,
    tools: forceFinal
      ? undefined
      : requiredTool
        ? availableTools.filter(tool => (tool.function || tool.definition?.function)?.name === requiredTool.function.name)
        : availableTools,
    // Llamafile expects tool_choice to be a string. Restricting the schema list
    // to one entry plus "required" reliably forces that exact native tool.
    tool_choice: forceFinal ? undefined : (requiredTool ? 'required' : body.tool_choice),
    messages: [{
      role: 'system',
      content: forceFinal
        ? 'The exact same tool call was repeated back-to-back. Stop the loop. Explain what repeated, summarize the available results, and state the next useful alternative instead of claiming success.'
        : `Native tool workspace: ${STATIC_DIR}. Use "." as the base path. Never invent placeholder paths such as C:\\path\\to\\your\\project or a workspace subfolder. If a filename is uncertain, use file_glob_search before read_file. Use file_glob_search with path "." and include "**" to inspect the project. A file search result already identifies filenames; use the returned relative path exactly. Prefer run_file to run or compile-and-run a known code file with an installed toolchain; do not construct a shell command for it. You must use get_datetime for current date, time, or weekday questions. Never claim a file action or execution succeeded unless the corresponding tool returned success. Emit only the tool call, never describe how tools could be used and never invent or append <tool_response> content. Never repeat an identical failed tool call without changing the tool or its arguments. Do not repeat a successful tool operation already present in this turn. If a requested file does not exist and the user asked to create it, call write_file before trying to read it again. If the user requested validation or testing after a change, perform that next; otherwise give the final answer.`,
    }, ...body.messages],
  };
  if (forceFinal) logRouter('NATIVE', `forcing final answer after ${toolMessages.length} tool results`);
  else if (requiredTool) logRouter('NATIVE', `requiring tool ${requiredTool.function.name}`);

  if (requiredTool?.function.name === 'get_datetime') {
    return sendNativeToolCall(res, body.stream, routedModel, 'get_datetime', {});
  }
  if (requiredTool?.function.name === 'read_file') {
    const filePath = recoveryTool === 'read_file' ? failedExecution?.path : lastMentionedFile(body.messages);
    if (filePath) {
      logRouter('NATIVE', 'planned read_file', { path: filePath });
      return sendNativeToolCall(res, body.stream, routedModel, 'read_file', { path: filePath });
    }
  }
  if (requiredTool?.function.name === 'write_file') {
    const plan = planTextWrite(userPrompt, body.messages);
    if (plan) {
      logRouter('NATIVE', `planned write_file`, { path: plan.path, content: plan.content });
      return sendNativeToolCall(res, body.stream, routedModel, 'write_file', plan);
    }
  }
  if (requiredTool?.function.name === 'run_file') {
    const filePath = recoveryTool === 'run_file' ? failedExecution?.path : lastMentionedFile(body.messages);
    if (filePath) {
      logRouter('NATIVE', 'planned run_file', { path: filePath });
      return sendNativeToolCall(res, body.stream, routedModel, 'run_file', { path: filePath });
    }
    logRouter('NATIVE', 'run target unknown; searching runnable files first');
    return sendNativeToolCall(res, body.stream, routedModel, 'file_glob_search', { path: '.', include: '**' });
  }
  if (requiredTool?.function.name === 'delete_file') {
    const filePath = lastMentionedFile(body.messages);
    if (filePath) {
      logRouter('NATIVE', 'planned delete_file', { path: filePath });
      return sendNativeToolCall(res, body.stream, routedModel, 'delete_file', { path: filePath });
    }
  }
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (error) {
    return json(res, 502, { error: { message: `Native tool chat failed: ${error.message}` } });
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    return json(res, upstream.status, { error: { message: detail || `upstream returned HTTP ${upstream.status}` } });
  }

  const headers = {
    'Content-Type': body.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-LLM-Routed-Model': routedModel,
    'X-Tool-Executor': 'llama-ui-via-router',
  };

  if (!body.stream) {
    const payload = await upstream.json();
    const message = payload?.choices?.[0]?.message;
    let calls = forceFinal ? null : validateNativeToolCalls(message?.tool_calls || extractTextToolCalls(message?.content, nativeNames));
    if (!calls && !forceFinal) calls = await repairNativeToolCall(message?.content);
    const validatedCalls = calls;
    calls = filterCallsToAvailableTools(calls, availableTools);
    // Native calls may depend on earlier results. Release exactly one action per
    // response so llama-ui returns its result before the model plans the next.
    calls = redirectRepeatedFailedNativeCalls(calls, currentTurnMessages);
    calls = prepareNativeToolCalls(calls?.slice(0, 1));
    if (calls?.length) {
      message.content = null;
      message.tool_calls = calls;
      payload.choices[0].finish_reason = 'tool_calls';
    } else if (validatedCalls?.length) {
      message.content = rejectedToolFallback(userPrompt);
      message.tool_calls = undefined;
      payload.choices[0].finish_reason = 'stop';
    } else if (looksLikeToolAttempt(message?.content)) {
      message.content = 'The model produced a malformed tool call, so no action was executed. Please retry the operation.';
      message.tool_calls = undefined;
      payload.choices[0].finish_reason = 'stop';
    }
    return json(res, 200, payload, { 'X-LLM-Routed-Model': routedModel, 'X-Tool-Executor': 'llama-ui-via-router' });
  }

  let headersSent = false;
  const start = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, headers);
    res.flushHeaders?.();
  };
  const contentParts = [];
  const structuredCalls = [];
  let mode = null;
  let earlyCalls = null;
  let lastChunk = null;

  start();
  await readSseResponse(upstream, async chunk => {
    lastChunk = chunk;
    const delta = chunk?.choices?.[0]?.delta || {};
    const priorContentLength = contentParts.join('').length;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      mode = 'structured';
      for (const fragment of delta.tool_calls) {
        const index = fragment.index || 0;
        structuredCalls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (fragment.id) structuredCalls[index].id += fragment.id;
        if (fragment.type) structuredCalls[index].type = fragment.type;
        if (fragment.function?.name) structuredCalls[index].function.name += fragment.function.name;
        if (fragment.function?.arguments) structuredCalls[index].function.arguments += fragment.function.arguments;
      }
    }
    if (typeof delta.content === 'string') contentParts.push(delta.content);

    let toolCallStart = -1;
    if (mode === 'structured') {
      if (!forceFinal) earlyCalls = validateNativeToolCalls(structuredCalls)?.slice(0, 1) || null;
    } else {
      const parsedText = extractTextToolCalls(contentParts.join(''), nativeNames, true);
      toolCallStart = parsedText.start;
      if (!forceFinal) earlyCalls = parsedText.calls;
    }
    if (earlyCalls?.length) {
      writeVisibleStreamChunk(res, start, hideParsedToolCallText(chunk, priorContentLength, toolCallStart));
      return true;
    }
    if (mode !== 'structured' && toolCallStart >= 0) {
      writeVisibleStreamChunk(res, start, hideParsedToolCallText(chunk, priorContentLength, toolCallStart));
      return true;
    }
    writeVisibleStreamChunk(res, start, chunk);
  });

  const generatedContent = contentParts.join('');
  let calls = forceFinal ? null : earlyCalls || validateNativeToolCalls(
    mode === 'structured' ? structuredCalls : extractTextToolCalls(generatedContent, nativeNames)
  );
  if (!calls && !forceFinal && mode !== 'structured') calls = await repairNativeToolCall(generatedContent);
  const validatedCalls = calls;
  // Do not let a small model queue dependent calls (for example read, then run)
  // before it has observed whether the first action succeeded.
  calls = redirectRepeatedFailedNativeCalls(calls, currentTurnMessages);
  calls = filterCallsToAvailableTools(calls, availableTools);
  const rejectedToolCalls = !calls?.length && Boolean(validatedCalls?.length);
  calls = prepareNativeToolCalls(calls?.slice(0, 1));
  const unrepairedToolAttempt = !calls?.length && looksLikeToolAttempt(generatedContent);
  start();
  if (calls?.length) {
    const id = lastChunk?.id || `chatcmpl-native-${Date.now()}`;
    let activityArgs = {};
    try { activityArgs = JSON.parse(calls[0].function.arguments || '{}'); } catch { /* Use generic activity. */ }
    const activityChunk = {
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: routedModel,
      choices: [{ index: 0, delta: { reasoning_content: nativeActivity(calls[0].function.name, activityArgs) }, finish_reason: null }],
    };
    const toolChunk = {
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: routedModel,
      choices: [{ index: 0, delta: {
        role: 'assistant',
        tool_calls: calls.map((call, index) => ({ ...call, index })),
      }, finish_reason: null }],
    };
    const finishChunk = {
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: routedModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    };
    res.write(`data: ${JSON.stringify(activityChunk)}\n\ndata: ${JSON.stringify(toolChunk)}\n\ndata: ${JSON.stringify(finishChunk)}\n\n`);
  } else if (unrepairedToolAttempt) {
    const id = lastChunk?.id || `chatcmpl-native-${Date.now()}`;
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: routedModel,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'The model produced a malformed tool call, so no action was executed. Please retry the operation.' }, finish_reason: 'stop' }],
    })}\n\n`);
  } else if (rejectedToolCalls) {
    res.write(`data: ${JSON.stringify({
      id: lastChunk?.id || `chatcmpl-native-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: routedModel,
      choices: [{ index: 0, delta: { role: 'assistant', content: rejectedToolFallback(userPrompt) }, finish_reason: 'stop' }],
    })}\n\n`);
  } else {
    const finishReason = lastChunk?.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop';
    writeStreamFinish(res, lastChunk, routedModel, finishReason);
  }
  res.end('data: [DONE]\n\n');
}

function tryServeLocalFile(req, res, pathname) {
  const fileName = STATIC_FALLBACK[pathname];
  if (!fileName) return false;
  const filePath = path.join(STATIC_DIR, fileName);
  if (!fs.existsSync(filePath)) return false;
  serveLocalStaticFile(res, filePath);
  return true;
}

// ============================================================================
// CHAT HANDLER WITH TOOL SUPPORT
// ============================================================================

async function readSseResponse(upstream, onEvent) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    if (done && buffer) {
      blocks.push(buffer);
      buffer = '';
    }
    for (const block of blocks) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (data && data !== '[DONE]' && await onEvent(JSON.parse(data), data)) {
          await reader.cancel();
          return true;
        }
      }
    }
    if (done) return false;
  }
}

function writeVisibleStreamChunk(res, start, chunk) {
  if (!Array.isArray(chunk?.choices)) return false;
  const visibleChoices = chunk.choices.map(choice => {
    const delta = { ...(choice.delta || {}) };
    delete delta.tool_calls;
    return { ...choice, delta, finish_reason: null };
  });
  if (!visibleChoices.some(choice => Object.keys(choice.delta).length)) return false;
  start();
  res.write(`data: ${JSON.stringify({ ...chunk, choices: visibleChoices })}\n\n`);
  return true;
}

function hideParsedToolCallText(chunk, priorContentLength, toolCallStart) {
  if (toolCallStart < 0 || !Array.isArray(chunk?.choices)) return chunk;
  return {
    ...chunk,
    choices: chunk.choices.map((choice, index) => {
      if (index !== 0 || typeof choice.delta?.content !== 'string') return choice;
      const visibleLength = Math.max(0, Math.min(
        choice.delta.content.length,
        toolCallStart - priorContentLength
      ));
      const delta = { ...choice.delta };
      if (visibleLength) delta.content = delta.content.slice(0, visibleLength);
      else delete delta.content;
      return { ...choice, delta };
    }),
  };
}

function writeStreamFinish(res, lastChunk, model, finishReason) {
  res.write(`data: ${JSON.stringify({
    id: lastChunk?.id || `chatcmpl-router-${Date.now()}`,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`);
}

async function handleStreamingChat(res, body, routedModel, searched, searchError, searchResults) {
  const targetUrl = routedModel === 'coder' ? CODER_URL : GENERAL_URL;
  const conversation = [...body.messages];
  let activeTools = toolsEnabled && body.tools !== false ? AVAILABLE_TOOLS : undefined;
  let toolIterations = 0;
  let headersSent = false;
  const completedCalls = new Map();
  let lastToolResults = null;

  const startResponse = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-LLM-Routed-Model': routedModel,
      'X-Web-Search': searched ? 'used' : searchError ? 'failed' : 'not-needed',
    });
    res.flushHeaders?.();
  };

  const streamStatus = (content) => {
    startResponse();
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-status-${Date.now()}`,
      object: 'chat.completion.chunk',
      model: routedModel,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`);
  };

  while (toolIterations <= 5) {
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          messages: conversation,
          stream: true,
          tools: activeTools,
          tool_choice: activeTools ? (body.tool_choice || 'auto') : undefined,
        }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
    } catch (error) {
      if (!headersSent) return json(res, 502, { error: { message: `Failed to connect to ${routedModel} model server: ${error.message}` } });
      res.end();
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text();
      if (!headersSent) return json(res, upstream.status, { error: { message: detail || `upstream returned HTTP ${upstream.status}` } });
      res.end();
      return;
    }

    const calls = [];
    const contentParts = [];
    let mode = null;
    let malformedToolAttempt = false;
    let lastChunk = null;

    const processStreamEvent = async chunk => {
      lastChunk = chunk;
      const delta = chunk?.choices?.[0]?.delta || {};
      const priorContentLength = contentParts.join('').length;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        mode = 'tools';
        for (const fragment of delta.tool_calls) {
          const index = fragment.index || 0;
          calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (fragment.id) calls[index].id += fragment.id;
          if (fragment.type) calls[index].type = fragment.type;
          if (fragment.function?.name) calls[index].function.name += fragment.function.name;
          if (fragment.function?.arguments) calls[index].function.arguments += fragment.function.arguments;
        }
        if (typeof delta.content === 'string') contentParts.push(delta.content);
        writeVisibleStreamChunk(res, startResponse, chunk);
        return;
      }

      if (typeof delta.content === 'string') contentParts.push(delta.content);
      const hasText = (typeof delta.content === 'string' && delta.content.length > 0)
        || typeof delta.reasoning_content === 'string';
      if (mode === null && hasText) mode = 'text';
      const parsedText = extractTextToolCalls(contentParts.join(), undefined, true);
      const textCalls = parsedText.calls;
      if (textCalls?.length) {
        calls.push(...textCalls);
        mode = 'tools';
        writeVisibleStreamChunk(res, startResponse, hideParsedToolCallText(chunk, priorContentLength, parsedText.start));
        return true;
      }
      if (parsedText.start >= 0) {
        malformedToolAttempt = true;
        writeVisibleStreamChunk(res, startResponse, hideParsedToolCallText(chunk, priorContentLength, parsedText.start));
        return true;
      }
      writeVisibleStreamChunk(res, startResponse, chunk);
    };

    if (/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') || '')) {
      await readSseResponse(upstream, processStreamEvent);
    } else {
      let payload;
      try {
        payload = await upstream.json();
      } catch (error) {
        return json(res, 502, {
          error: { message: `The ${routedModel} model server returned a non-SSE response that was not valid JSON: ${error.message}` },
        });
      }
      if (!Array.isArray(payload?.choices) || payload.choices.length === 0) {
        return json(res, 502, {
          error: { message: `The ${routedModel} model server returned a non-SSE response without completion choices.` },
        });
      }
      const chunk = {
        ...payload,
        object: 'chat.completion.chunk',
        choices: payload.choices.map(choice => ({
          ...choice,
          delta: choice.delta || choice.message || {},
          message: undefined,
        })),
      };
      await processStreamEvent(chunk, JSON.stringify(chunk));
    }

    if (!calls.length) {
      const textCalls = extractTextToolCalls(contentParts.join(''));
      if (textCalls) calls.push(...textCalls);
    }

    if (malformedToolAttempt && !calls.length) {
      startResponse();
      res.write(`data: ${JSON.stringify({
        id: lastChunk?.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        model: routedModel,
        choices: [{ index: 0, delta: { content: 'The model produced a malformed tool call, so no action was executed. Please retry the operation.' }, finish_reason: 'stop' }],
      })}\n\n`);
      break;
    }

    if (calls.length) {
      if (requiresApproval(calls)) {
        pendingApproval = { calls, createdAt: Date.now() };
        logRouter('APPROVAL', `requested: ${calls.map(call => call.function.name).join(', ')}`);
        startResponse();
        res.write(`data: ${JSON.stringify({
          id: lastChunk?.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          model: routedModel,
          choices: [{ index: 0, delta: { content: approvalQuestion(calls) }, finish_reason: 'stop' }],
        })}\n\n`);
        break;
      }
      const callKey = toolCallsKey(calls);
      const previousResults = completedCalls.get(callKey);
      if (previousResults) {
        logRouter('TOOL', `duplicate ${calls.map(call => call.function.name).join(', ')} call suppressed`);
        startResponse();
        res.write(`data: ${JSON.stringify({
          id: lastChunk?.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          model: routedModel,
          choices: [{ index: 0, delta: { content: summarizeToolResults(previousResults) }, finish_reason: 'stop' }],
        })}\n\n`);
        break;
      }
      if (toolIterations === 5) {
        startResponse();
        res.write(`data: ${JSON.stringify({
          id: lastChunk?.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          model: routedModel,
          choices: [{ index: 0, delta: { content: '\nThe tool could not complete after several attempts.' }, finish_reason: 'stop' }],
        })}\n\n`);
        break;
      }
      toolIterations++;
      streamStatus(`${calls.map(call => `🔧 ${describeToolCall(call)}…`).join('\n')}\n`);
      const toolResults = await executeToolCalls(calls);
      streamStatus(`${toolResults.map(result => `${toolResultSucceeded(result) ? '✓' : '✗'} ${result.function.name}`).join('\n')}\n\n`);
      completedCalls.set(callKey, toolResults);
      lastToolResults = toolResults;
      conversation.push({
        role: 'assistant',
        content: contentParts.join('') || null,
        tool_calls: calls,
      });
      conversation.push(...toolResults.map(result => ({
        role: 'tool',
        tool_call_id: result.id,
        content: result.function.result,
      })));
      continue;
    }

    if (mode === null && contentParts.join('').trim() === '' && lastToolResults) {
      startResponse();
      res.write(`data: ${JSON.stringify({
        id: lastChunk?.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        model: routedModel,
        choices: [{ index: 0, delta: { content: summarizeToolResults(lastToolResults) }, finish_reason: 'stop' }],
      })}\n\n`);
    } else {
      startResponse();
      const finishReason = lastChunk?.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop';
      writeStreamFinish(res, lastChunk, routedModel, finishReason);
    }
    break;
  }

  startResponse();
  if (searched && searchResults.length) {
    const sources = searchResults.map((result, index) => `${index + 1}. [${result.title}](${result.url})`).join('\n');
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-sources-${Date.now()}`,
      object: 'chat.completion.chunk',
      model: routedModel,
      choices: [{ index: 0, delta: { content: `\n\nSources:\n${sources}` }, finish_reason: null }],
    })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

async function handleChat(req, res) {
  const body = await readJson(req);
  if (!Array.isArray(body.messages)) return json(res, 400, { error: { message: 'messages must be an array' } });
  if (body.general_bias !== undefined
      && (typeof body.general_bias !== 'number' || !Number.isFinite(body.general_bias)
        || body.general_bias < 0 || body.general_bias > 100)) {
    return json(res, 400, { error: { message: 'general_bias must be a number from 0 to 100' } });
  }

  const prompt = lastUserText(body.messages);
  const routedModel = chooseModel(body, prompt);
  logRouter('ROUTE', `${body.model || 'auto'} -> ${routedModel}`, { stream: body.stream === true, promptLength: prompt.length });
  if (await resolvePendingApproval(res, body.stream === true, routedModel, prompt)) return;
  let searched = false;
  let searchError = '';
  let searchResults = [];
  // Native llama-ui conversations can call web_search at the appropriate step.
  // Do not front-load search results into a multi-step agent prompt.
  if (shouldSearch(body, prompt) && !hasNativeToolSchemas(body)) {
    try {
      searchResults = await webSearch(prompt);
      body.messages = [searchContext(prompt, searchResults), ...body.messages];
      searched = true;
      logRouter('SEARCH', `completed with ${searchResults.length} results`);
    } catch (error) {
      searchError = error.message;
      logRouter('ERROR', `web search failed: ${error.message}`);
      body.messages = [{
        role: 'system',
        content: `A web search was attempted but failed: ${error.message}. Be transparent that live results were unavailable.`,
      }, ...body.messages];
    }
  }

  delete body.web_search;
  delete body.general_bias;
  body.model = routedModel;
  const clientWantsStream = body.stream === true;
  if (toolsEnabled && body.tools !== false && !hasNativeToolSchemas(body)) {
    body.messages = [{
      role: 'system',
      content: 'Tool rules: use read_file to read a known file, list_files to inspect a directory, search_files to locate files, and run_file to execute a supported code file. Do not use run_command for operations covered by a dedicated tool. After receiving a tool result, answer the user from that result instead of repeating the call.',
    }, ...body.messages];
  }

  // Check if the target upstream is available before sending the request
  const targetAvailable = routedModel === 'coder' ? coderAvailable : generalAvailable;
  if (!targetAvailable) {
    // Quick re-check in case status changed
    const recheck = routedModel === 'coder' ? await checkCoderAvailable() : await checkGeneralAvailable();
    if (!recheck) {
      return json(res, 503, {
        error: { message: `Model server '${routedModel}' is not available on port ${routedModel === 'coder' ? 8081 : 8080}. Ensure the llamafile server is running.` }
      });
    }
  }

  // llama-ui manages its native agent loop and permission prompts. Preserve
  // its schemas and tool-call SSE verbatim; POST /tools executes safely.
  if (hasNativeToolSchemas(body)) {
    logRouter('NATIVE', `passing ${routedModel} tool-call stream to llama-ui`);
    return proxyNativeToolChat(res, body, routedModel);
  }

  if (clientWantsStream) {
    return handleStreamingChat(res, body, routedModel, searched, searchError, searchResults);
  }

  // Add tools to the request only if enabled
  const requestBody = {
    ...body,
    // Tool calls must be observed and executed here. The final response is
    // converted back to SSE below when the client requested streaming.
    stream: false,
  };
  
  // Only include tools if they're enabled
  if (toolsEnabled && body.tools !== false) {
    // Filter to only enabled tools with proper format for the model
    const toolsForModel = AVAILABLE_TOOLS;
    
    if (toolsForModel.length > 0) {
      requestBody.tools = toolsForModel;
      requestBody.tool_choice = body.tool_choice || 'auto';
    }
  }

  let upstream;
  try {
    upstream = await fetch(routedModel === 'coder' ? CODER_URL : GENERAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (fetchError) {
    return json(res, 502, { error: { message: `Failed to connect to ${routedModel} model server: ${fetchError.message}` } });
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    // Stream response or non-JSON
    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'X-LLM-Routed-Model': routedModel,
      'X-Web-Search': searched ? 'used' : searchError ? 'failed' : 'not-needed',
    };
    res.writeHead(upstream.status, headers);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
    return;
  }

  // Handle tool calls if present
  if (!upstream.ok) {
    return json(res, upstream.status, payload, {
      'X-LLM-Routed-Model': routedModel,
      'X-Web-Search': searched ? 'used' : searchError ? 'failed' : 'not-needed',
    });
  }

  let response = payload;
  let conversation = [...body.messages];
  let toolCallCount = 0;
  const maxToolIterations = 5;
  const completedCalls = new Map();
  let activeTools = AVAILABLE_TOOLS;

  while (toolCallCount < maxToolIterations) {
    const responseMessage = response?.choices?.[0]?.message;
    const detectedToolCalls = responseMessage?.tool_calls || extractTextToolCalls(responseMessage?.content);
    if (!detectedToolCalls?.length) break;
    if (requiresApproval(detectedToolCalls)) {
      pendingApproval = { calls: detectedToolCalls, createdAt: Date.now() };
      logRouter('APPROVAL', `requested: ${detectedToolCalls.map(call => call.function.name).join(', ')}`);
      response = {
        ...response,
        choices: [{ index: 0, message: { role: 'assistant', content: approvalQuestion(detectedToolCalls) }, finish_reason: 'stop' }],
      };
      break;
    }
    toolCallCount++;
    const toolCalls = detectedToolCalls;
    const callKey = toolCallsKey(toolCalls);
    const previousResults = completedCalls.get(callKey);
    if (previousResults) {
      logRouter('TOOL', `duplicate ${toolCalls.map(call => call.function.name).join(', ')} call suppressed`);
      response = {
        ...response,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: summarizeToolResults(previousResults) },
          finish_reason: 'stop',
        }],
      };
      break;
    }
    const toolResults = previousResults
      ? toolCalls.map((call, index) => ({
          id: call.id,
          type: 'function',
          function: { ...call.function, result: previousResults[index]?.function.result || JSON.stringify({ error: 'duplicate tool call' }) },
        }))
      : await executeToolCalls(toolCalls);
    if (!previousResults) completedCalls.set(callKey, toolResults);
    else activeTools = undefined;

    // Add assistant message with tool calls and tool results to messages
    const assistantMessage = {
      role: 'assistant',
      content: responseMessage.tool_calls ? (responseMessage.content || null) : null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };

    const toolMessages = toolResults.map(tr => ({
      role: 'tool',
      tool_call_id: tr.id,
      content: tr.function.result,
    }));
    conversation.push(assistantMessage, ...toolMessages);
    if (previousResults) conversation.push({
      role: 'system',
      content: 'The requested tool action has already completed. Do not call another tool. Give the user a concise final answer using the tool result.',
    });

    // Send follow-up request with tool results
    const followUpBody = {
      ...body,
      messages: conversation,
      tools: activeTools,
      tool_choice: activeTools ? (body.tool_choice || 'auto') : undefined,
      model: routedModel,
      stream: false,
    };

    try {
      const followUp = await fetch(routedModel === 'coder' ? CODER_URL : GENERAL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(followUpBody),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      const followUpData = await followUp.json();
      if (!followUp.ok) {
        return json(res, followUp.status, followUpData, {
          'X-LLM-Routed-Model': routedModel,
          'X-Tool-Calls': String(toolCallCount),
        });
      }
      response = followUpData;
      // Update usage stats
      if (followUpData.usage) {
        payload.usage = followUpData.usage;
      }
    } catch (error) {
      return json(res, 502, { error: { message: `Tool execution failed: ${error.message}` } });
    }
  }

  const responseHeaders = {
    'X-LLM-Routed-Model': routedModel,
    'X-Web-Search': searched ? 'used' : searchError ? 'failed' : 'not-needed',
  };
  if (toolCallCount > 0) responseHeaders['X-Tool-Calls'] = String(toolCallCount);

  if (searched && response.ok !== false) {
    const answer = response?.choices?.[0]?.message;
    if (answer && typeof answer.content === 'string') {
      const sources = searchResults.map((result, index) =>
        `${index + 1}. [${result.title}](${result.url})`
      ).join('\n');
      answer.content = `${answer.content.trim()}\n\nSources:\n${sources}`;
    }
  }

  return json(res, 200, response, responseHeaders);
}

// ============================================================================
// UPSTREAM AVAILABILITY TRACKING
// ============================================================================

let generalAvailable = false;
let coderAvailable = false;

async function checkGeneralAvailable() {
  try {
    const r = await fetch(`${GENERAL_WEB}/health`, { signal: AbortSignal.timeout(3000) });
    generalAvailable = r.ok;
    return generalAvailable;
  } catch {
    generalAvailable = false;
    return false;
  }
}

async function checkCoderAvailable() {
  try {
    const r = await fetch(`${CODER_WEB}/health`, { signal: AbortSignal.timeout(3000) });
    coderAvailable = r.ok;
    return coderAvailable;
  } catch {
    coderAvailable = false;
    return false;
  }
}

function checkUpstreamAvailable() {
  return checkGeneralAvailable().then(() => checkCoderAvailable())
    .then(() => generalAvailable || coderAvailable);
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    validateLocalRequest(req);
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = url.pathname;

    // Health endpoint always works
    if (pathname === '/health') {
      return json(res, 200, { status: 'ok', router: 'auto', webSearch: true, general: generalAvailable, coder: coderAvailable });
    }

    // Tools endpoint - returns list of available tools for UI discovery
    if (pathname === '/v1/tools' && req.method === 'GET') {
      return json(res, 200, {
        object: 'list',
        data: AVAILABLE_TOOLS.map(toolForUi),
        total: AVAILABLE_TOOLS.length,
      });
    }

    // Expose llama-ui's native schema contract, backed by our workspace-scoped
    // POST adapter instead of llamafile's unrestricted executor.
    if (pathname === '/tools' && req.method === 'GET') {
      return json(res, 200, NATIVE_TOOLS, { 'Cache-Control': 'no-store' });
    }

    if (pathname === '/tools' && req.method === 'POST') {
      requireJsonRequest(req);
      const request = await readJson(req);
      if (!request || typeof request !== 'object' || Array.isArray(request)
          || typeof request.tool !== 'string'
          || (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)))) {
        return json(res, 400, { error: 'Malformed native tool request' });
      }
      const native = NATIVE_TOOLS.find(tool => tool.tool === request.tool);
      if (!native) return json(res, 404, { error: `Unknown native tool: ${request.tool}` });
      try {
        if (native.permissions?.write) consumeNativeApproval(request.tool, request.params || {});
        logRouter('NATIVE', `starting ${request.tool}`, safeToolLogDetails(request.tool, request.params || {}));
        const result = await executeNativeTool(request.tool, request.params || {});
        logRouter('NATIVE', `completed ${request.tool}`);
        return json(res, 200, { plain_text_response: String(result) });
      } catch (error) {
        logRouter('ERROR', `native tool ${request.tool} failed: ${error.message}`);
        return json(res, 200, { error: error.message });
      }
    }

    // Settings endpoint - get/set tool enabled state
    if (pathname === '/v1/settings' && req.method === 'GET') {
      return json(res, 200, { toolsEnabled, approvalsEnabled, workspace: STATIC_DIR });
    }

    // Update settings (toggle tools on/off)
    if (pathname === '/v1/settings' && req.method === 'POST') {
      requireJsonRequest(req);
      const settings = await readJson(req);
      if (typeof settings.toolsEnabled === 'boolean') {
        toolsEnabled = settings.toolsEnabled;
      }
      if (typeof settings.approvalsEnabled === 'boolean') {
        if (!settings.approvalsEnabled && !allowRuntimeApprovalDisable) {
          return json(res, 403, { error: { message: 'Disabling approvals at runtime is locked. Set LLM_ALLOW_UNSAFE_APPROVAL_DISABLE=true before startup only for isolated testing.' } });
        }
        approvalsEnabled = settings.approvalsEnabled;
      }
      return json(res, 200, { toolsEnabled, approvalsEnabled, workspace: STATIC_DIR });
    }

    if (pathname === '/router-ui.js' && req.method === 'GET') {
      return serveLocalStaticFile(res, path.join(STATIC_DIR, 'router-ui.js'));
    }

    // For UI requests, try upstream first, fall back to local files
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/bundle.js' || pathname === '/bundle.css')) {
      // Try upstream first (the exe's web server on 8081)
      if (coderAvailable || await checkCoderAvailable()) {
        return proxyToCoderWeb(req, res, pathname);
      }

      // Fall back to local files if they exist
      if (tryServeLocalFile(req, res, pathname)) {
        return;
      }

      // Nothing available
      return json(res, 503, { error: { message: 'No UI available - start the llamafile servers or place UI files in this folder' } });
    }

    // Proxy UI API endpoints to upstream server (e.g., /api/*, /models)
    // Note: /props is handled separately below to inject our tools
    if (req.method === 'GET' && (pathname.startsWith('/api/') || pathname.startsWith('/models'))) {
      if (coderAvailable || await checkCoderAvailable()) {
        return proxyToCoderWeb(req, res, req.url);
      }
      return json(res, 503, { error: { message: 'UI API server not available' } });
    }

    // The Web UI relies on llamafile's richer native tool records here. Do not
    // replace them with OpenAI request schemas; doing so crashes its Tools view.
    if (pathname === '/props' && req.method === 'GET') {
      if (coderAvailable || await checkCoderAvailable()) {
        // First try to get props from upstream
        try {
          const upstream = await fetch(`${CODER_WEB}/props${url.search}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (upstream.ok) {
            const upstreamProps = await upstream.json();
            // Llama-ui initializes its agent registry from /props. Always inject
            // the router's authoritative schemas instead of the upstream
            // llamafile list, which does not know about router-only tools.
            return json(res, 200, { ...upstreamProps, model_alias: 'auto', tools: NATIVE_TOOLS }, { 'Cache-Control': 'no-store' });
          }
        } catch { /* Fall through to our own props */ }
      }
      // Return our own props with tools in UI-expected format
      return json(res, 200, {
        default_generation_settings: {
          params: {
            seed: 4294967295,
            temperature: 0.8,
            top_k: 40,
            top_p: 0.95,
            n_predict: -1,
            stream: true,
          },
          n_ctx: 8192,
        },
        total_slots: 1,
        model_alias: 'auto',
        ui: true,
        webui: true,
        tools: NATIVE_TOOLS,
      }, { 'Cache-Control': 'no-store' });
    }

    if (pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: [
        { id: 'auto', object: 'model', owned_by: 'local' },
        { id: 'general', object: 'model', owned_by: 'local' },
        { id: 'coder', object: 'model', owned_by: 'local' },
      ] });
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      requireJsonRequest(req);
      return await handleChat(req, res);
    }

    json(res, 404, { error: { message: 'Not found' } });
  } catch (error) {
    logRouter('ERROR', `${req.method} ${req.url}: ${error.stack || error.message}`);
    json(res, error.statusCode || 500, { error: { message: error.message } });
  }
});

server.listen(PORT, HOST, () => {
  logRouter('READY', `LLM Optimus router listening on http://${HOST}:${PORT}/`);
  logRouter('READY', `available tools: ${AVAILABLE_TOOLS.map(t => t.function.name).join(', ')}`);
  // Check if upstream servers are available at startup
  checkUpstreamAvailable().then(available => {
    if (available) {
      logRouter('READY', `upstream servers available - general: ${generalAvailable}, coder: ${coderAvailable}`);
    } else {
      logRouter('ERROR', 'no upstream servers detected - model routing will return 503 until servers start');
    }
  });
});
