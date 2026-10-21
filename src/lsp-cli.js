#!/usr/bin/env node
/**
 * lsp-cli: lightweight, config-driven LSP client & diagnostics CLI for AI agents.
 *
 * Design follows omp's `lsp.json` registry model: servers are declared with
 * command / args / fileTypes / rootMarkers / initOptions / settings / isLinter / disabled,
 * so adding a language is a config edit, not a code edit.
 *
 * Commands:
 *   lsp def   <file:line[:col]>   Go to definition
 *   lsp ref   <file:line[:col]>   Find references
 *   lsp hover <file:line[:col]>   Type signature & docs
 *   lsp diag  [file|dir]          File => LSP diagnostics; dir/omitted => project compilers
 *   lsp servers                   List configured servers and availability
 *
 * Config resolution order: $DSH_LSP_CONFIG, ~/.dsh/lsp.json, ~/.local/bin/lsp.json,
 * then the embedded defaults below.
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const IS_WIN = process.platform === 'win32';
const VERSION = '2.1.0';

// ---------------------------------------------------------------------------
// Embedded default registry (mirrors ~/.dsh/lsp.json; used when no config file)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  servers: {
    'typescript-native': { disabled: true },
    biome: {
      command: 'biome',
      args: ['lsp-proxy'],
      isLinter: true,
      fileTypes: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.css'],
      rootMarkers: ['biome.json', 'biome.jsonc', 'package.json', 'tsconfig.json', 'jsconfig.json', '.'],
      readyTimeout: 8000,
      timeouts: { initialize: 20000, request: 10000 },
    },
    vtsls: {
      command: 'vtsls',
      args: ['--stdio'],
      fileTypes: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git', '.'],
      languageIds: { '.tsx': 'typescriptreact', '.jsx': 'javascriptreact' },
      initOptions: { hostInfo: 'dsh-lsp-cli' },
      settings: {
        'typescript.tsserver.maxTsServerMemory': 3072,
        'typescript.preferences.includePackageJsonAutoImports': 'on',
        'javascript.preferences.includePackageJsonAutoImports': 'on',
      },
      readyTimeout: 8000,
      timeouts: { initialize: 25000, request: 15000 },
    },
    'rust-analyzer': {
      command: 'rust-analyzer',
      fileTypes: ['.rs'],
      rootMarkers: ['Cargo.toml', '.git', '.'],
      readyTimeout: 20000,
      timeouts: { initialize: 40000, request: 30000 },
    },
    ruff: {
      command: 'ruff',
      args: ['server'],
      isLinter: true,
      fileTypes: ['.py', '.pyi'],
      rootMarkers: ['ruff.toml', '.ruff.toml', 'pyproject.toml', '.git', '.'],
      readyTimeout: 8000,
      timeouts: { initialize: 15000, request: 10000 },
    },
    ty: {
      command: 'ty',
      args: ['server'],
      fileTypes: ['.py', '.pyi'],
      rootMarkers: ['ty.toml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', '.git', '.'],
      readyTimeout: 10000,
      timeouts: { initialize: 20000, request: 15000 },
    },
  },
  diagnostics: {
    typescript: { rootMarkers: ['tsconfig.json', 'jsconfig.json'], commands: [['tsc', '--noEmit']], localBin: 'tsc' },
    biome: { rootMarkers: ['biome.json', 'biome.jsonc'], commands: [['biome', 'check', '.']] },
    rust: { rootMarkers: ['Cargo.toml'], commands: [['cargo', 'check', '--quiet']] },
    python: { rootMarkers: ['ruff.toml', '.ruff.toml', 'pyproject.toml'], commands: [['ruff', 'check', '.']] },
  },
};

// Fallback languageId table (server.languageIds wins)
const DEFAULT_LANGUAGE_IDS = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.css': 'css',
  '.rs': 'rust',
  '.py': 'python',
  '.pyi': 'python',
};

const SEVERITY_LABEL = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opt-in phase tracing: LSP_DEBUG=1 or --verbose
let DEBUG = process.env.LSP_DEBUG === '1' || process.env.LSP_DEBUG === 'true';
function debug(...parts) {
  if (!DEBUG) return;
  console.error(`[lsp:debug] ${parts.join(' ')}`);
}

function printUsage() {
  console.log(`lsp-cli v${VERSION}: config-driven LSP navigation, symbols & diagnostics

Usage:
  lsp def     <file:line[:col]> [-s <symbol>]   Find definition (auto-locates column)
  lsp ref     <file:line[:col]> [-s <symbol>]   Find all references (--no-decl to drop decl)
  lsp hover   <file:line[:col]> [-s <symbol>]   Show type signature & docs
  lsp symbols <file|query>                      Document symbol outline (file) or Workspace symbol search (query)
  lsp rename  <file:line[:col]> <newName> [--apply] [-s <symbol>]  Semantic rename (preview or apply)
  lsp action  <file:line[:col]> [-s <symbol>]   List available code actions & quick-fixes
  lsp diag    [file|dir]                        file => LSP diagnostics; dir/default => project compilers
  lsp servers                                   List configured language servers

Options:
  -s, --symbol <name>     Auto-locate column of symbol on target line
  --apply                 Apply changes to disk (for rename; default is dry-run preview)
  -e, --errors-only       (diag) Only report errors, omit warnings/hints
  --json                  Output structured JSON
  --config <path>         Use an explicit lsp.json registry
  --limit <n>             Cap emitted results (default 200)
  --no-decl               (ref) exclude the declaration itself
  --timeout <ms>          Override LSP request timeout (e.g. 30000 for slow indexers)
  --ready-timeout <ms>    Override server settle timeout (default per server config)
  --verbose               Also print server-side log messages and stderr on failure

Examples:
  lsp def     src/index.ts:35 -s getStoredProxy
  lsp symbols src/index.ts
  lsp symbols AntigravityAuthConfig
  lsp rename  src/index.ts:34 applyPlugin
  lsp rename  src/index.ts:34 applyPlugin --apply
  lsp diag    src/app.tsx -e
`);
}

// Git Bash / MSYS / WSL style paths -> native Windows paths
function normalizeUserPath(raw) {
  if (!raw) return '';
  let p = String(raw).trim().replace(/^"(.*)"$/, '$1');
  if (!p) return '';
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      // not a valid file URL: keep raw
    }
  }
  if ((p.startsWith('/') || p.startsWith('\\')) && /^[a-zA-Z]:/.test(p.slice(1))) {
    p = p.slice(1);
  }
  if (/^[a-zA-Z]:[\\/]/.test(p)) return path.resolve(p);

  let m = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) return path.resolve(`${m[1].toUpperCase()}:/${m[2]}`);
  if (p === '/mnt' || p === '/mnt/') return '';

  m = p.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (m) return path.resolve(`${m[1].toUpperCase()}:/${m[2] || ''}`);

  if (p === '/tmp' || p.startsWith('/tmp/')) return path.resolve(os.tmpdir(), p.slice(5));

  return path.resolve(p);
}

// "path/to/file.ts:12:5" | "C:\\p\\file.ts:12" | "file.ts"
function parseTarget(input) {
  if (!input) return null;
  const match = String(input).match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match) return { filePath: normalizeUserPath(input), line: 1, col: 1, colProvided: false };
  return {
    filePath: normalizeUserPath(match[1]),
    line: Math.max(1, parseInt(match[2], 10)),
    col: Math.max(1, parseInt(match[3] || '1', 10)),
    colProvided: match[3] !== undefined,
  };
}

function readRawLine(absPath, zeroBasedLine) {
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    return lines[zeroBasedLine] !== undefined ? lines[zeroBasedLine] : null;
  } catch {
    return null;
  }
}

function resolveTargetPosition(filePath, line, col, colProvided, symbol) {
  const rawLine = readRawLine(filePath, line - 1);
  if (rawLine === null) return { line, col };
  if (symbol) {
    const idx = rawLine.indexOf(symbol);
    if (idx !== -1) {
      debug(`[lsp] auto-located symbol "${symbol}" at column ${idx + 1}`);
      return { line, col: idx + 1 };
    }
    const wordRe = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`);
    const m = rawLine.match(wordRe);
    if (m && m.index !== undefined) {
      debug(`[lsp] auto-located symbol "${symbol}" at column ${m.index + 1}`);
      return { line, col: m.index + 1 };
    }
  }
  if (!colProvided || col === 1) {
    const charAt = rawLine[col - 1];
    if (!charAt || /\s/.test(charAt)) {
      const SKIP = new Set([
        'export', 'default', 'declare', 'async', 'function', 'class',
        'interface', 'type', 'enum', 'const', 'let', 'var', 'import',
        'from', 'return', 'public', 'private', 'protected', 'readonly', 'static'
      ]);
      const re = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
      let m;
      let firstIdentCol = null;
      while ((m = re.exec(rawLine)) !== null) {
        if (firstIdentCol === null) firstIdentCol = m.index + 1;
        if (!SKIP.has(m[0])) {
          debug(`[lsp] auto-snapped column from ${col} to ${m.index + 1} ("${m[0]}")`);
          return { line, col: m.index + 1 };
        }
      }
      if (firstIdentCol !== null) {
        debug(`[lsp] auto-snapped column from ${col} to ${firstIdentCol}`);
        return { line, col: firstIdentCol };
      }
    }
  }
  return { line, col };
}

function globToRegExp(pattern) {
  if (pattern === '.') return /.*/;
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

// Walk up from startDir until some marker exists; returns the matching dir.
function findRootByMarkers(startDir, markers) {
  const regexes = (markers || []).map(globToRegExp);
  let cur = startDir;
  while (cur) {
    for (let i = 0; i < regexes.length; i++) {
      const marker = markers[i];
      if (marker === '.') return cur;
      if (!marker.includes('*') && !marker.includes('?')) {
        if (fs.existsSync(path.join(cur, marker))) return cur;
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(cur);
      } catch {
        continue;
      }
      if (entries.some((name) => regexes[i].test(name))) return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return startDir;
}

// Resolve a bare command name to a concrete executable, Windows-aware.
function resolveExecutable(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    try {
      return fs.existsSync(cmd) ? cmd : null;
    } catch {
      return null;
    }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = IS_WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, cmd + suffix);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable PATH entry: ignore
      }
    }
  }
  return null;
}

function winQuote(arg) {
  return /[\s"]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : arg;
}

// Spawn descriptor that works for .exe (direct) and .cmd/.bat (via cmd /c).
function spawnPlan(exe, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    const line = [exe, ...args].map(winQuote).join(' ');
    return {
      cmd: process.env.ComSpec || 'cmd.exe',
      argv: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    };
  }
  return { cmd: exe, argv: args, verbatim: false };
}

// Display path: relative when inside cwd, relative to rootDir if outside, absolute otherwise.
function displayPath(absPath, rootDir) {
  const relCwd = path.relative(process.cwd(), absPath);
  if (relCwd && !relCwd.startsWith('..') && !path.isAbsolute(relCwd)) return relCwd;
  if (rootDir) {
    const relRoot = path.relative(rootDir, absPath);
    if (relRoot && !relRoot.startsWith('..') && !path.isAbsolute(relRoot)) return relRoot;
  }
  return absPath;
}

// Servers may echo a differently-encoded file URI (drive-letter case, %3A vs :).
// Key diagnostics by normalized path instead of raw URI.
function uriKey(uri) {
  try {
    const localPath = fileURLToPath(uri);
    const slashed = localPath.split(path.sep).join('/');
    return IS_WIN ? slashed.toLowerCase() : slashed;
  } catch {
    return String(uri);
  }
}

function readLine(absPath, zeroBasedLine) {
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    return (lines[zeroBasedLine] || '').trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function configCandidates(explicit) {
  const out = [];
  if (explicit) out.push(explicit);
  if (process.env.AGENT_LSP_CONFIG) out.push(process.env.AGENT_LSP_CONFIG);
  if (process.env.DSH_LSP_CONFIG) out.push(process.env.DSH_LSP_CONFIG);
  out.push(path.join(process.cwd(), '.lsp.json'));
  out.push(path.join(os.homedir(), '.dsh', 'lsp.json'));
  out.push(path.join(os.homedir(), '.omp', 'agent', 'lsp.json'));
  out.push(path.join(os.homedir(), '.config', 'agent-lsp', 'lsp.json'));
  out.push(path.join(os.homedir(), '.local', 'bin', 'lsp.json'));
  out.push(path.join(__dirname, '..', 'config', 'lsp.default.json'));
  return out;
}

function loadConfig(explicitPath) {
  for (const candidate of configCandidates(explicitPath)) {
    if (!candidate) continue;
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      return mergeConfig(DEFAULT_CONFIG, parsed);
    } catch (err) {
      console.error(`Warning: failed to load ${candidate}: ${err.message}`);
    }
  }
  return mergeConfig(DEFAULT_CONFIG, {});
}

function mergeConfig(base, override) {
  const merged = {
    servers: { ...(base.servers || {}) },
    diagnostics: { ...(base.diagnostics || {}) },
  };
  for (const [name, server] of Object.entries(override.servers || {})) {
    merged.servers[name] = { ...(merged.servers[name] || {}), ...server };
  }
  for (const [name, entry] of Object.entries(override.diagnostics || {})) {
    merged.diagnostics[name] = { ...(merged.diagnostics[name] || {}), ...entry };
  }
  return merged;
}

function languageIdFor(server, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const overrides = server.languageIds || {};
  if (overrides[ext]) return overrides[ext];
  return DEFAULT_LANGUAGE_IDS[ext] || 'plaintext';
}

// Servers matching this file, in config order. Navigation servers first, linters after.
function serversForFile(config, filePath, { linterOnly = false, navigationOnly = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const matches = [];
  for (const [name, server] of Object.entries(config.servers || {})) {
    if (!server || server.disabled) continue;
    if (!server.command) continue;
    if (!(server.fileTypes || []).includes(ext)) continue;
    if (linterOnly && !server.isLinter) continue;
    if (navigationOnly && server.isLinter) continue;
    matches.push({ name, ...server });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// LSP connection
// ---------------------------------------------------------------------------

class LspConnection {
  constructor(server, rootDir, clientOpts = {}) {
    this.server = server;
    this.rootDir = rootDir;
    this.clientOpts = clientOpts;
    this.rootUri = pathToFileURL(rootDir).toString();
    this.msgId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.settings = server.settings || {};
    this.diagnostics = new Map();
    this.publishedAt = new Map();
    this.progressActive = new Set();
    // Only meaningful events (progress, diagnostics, status) count as "still working";
    // chatty window/logMessage traffic must not keep the client waiting.
    this.lastActivity = Date.now();
    this.activityAt = Date.now();
    this.quiescent = false;
    this.capabilities = {};
    this.stderrTail = '';
    this.logLines = [];
    this.exited = null;
  }

  async start() {
    const exe = resolveExecutable(this.server.command);
    if (!exe) {
      throw new Error(
        `${this.server.command} is not installed or not on PATH. ` +
          `Install it, or declare a different server for these files in ~/.dsh/lsp.json.`,
      );
    }
    const plan = spawnPlan(exe, this.server.args || []);
    this.proc = spawn(plan.cmd, plan.argv, {
      cwd: this.rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
    });

    this.proc.on('error', (err) => this.failAll(err));
    this.proc.on('exit', (code, signal) => {
      this.exited = { code, signal };
      this.failAll(new Error(`server exited (code=${code} signal=${signal}) ${this.stderrTail.trim()}`.trim()));
    });
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf-8')).slice(-4000);
    });
  }

  failAll(err) {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      let msg;
      try {
        msg = JSON.parse(body.toString('utf-8'));
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    // Server-initiated request: MUST answer, otherwise the server stalls forever.
    if (msg.method !== undefined) {
      if (msg.id !== undefined) this.answerServerRequest(msg);
      else this.onServerNotification(msg);
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      this.activityAt = Date.now();
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    }
  }

  answerServerRequest(msg) {
    const reply = (result) => this.send({ jsonrpc: '2.0', id: msg.id, result });

    switch (msg.method) {
      case 'workspace/configuration': {
        const items = (msg.params && msg.params.items) || [];
        reply(items.map((item) => this.sectionConfig(item && item.section)));
        return;
      }
      case 'workspace/workspaceFolders':
        reply([{ uri: this.rootUri, name: path.basename(this.rootDir) || 'root' }]);
        return;
      case 'workspace/applyEdit':
        reply({ applied: false, failureReason: 'lsp-cli is read-only' });
        return;
      case 'window/showMessageRequest':
        reply(null);
        return;
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'workspace/codeLens/refresh':
        reply(null);
        return;
      default:
        // Unknown requests must still get an answer to unblock the server.
        reply(null);
    }
  }

  // Flatten "a.b.c" settings into the nested object a server expects for section a.
  sectionConfig(section) {
    if (!section) return {};
    const out = {};
    for (const [key, value] of Object.entries(this.settings)) {
      if (key !== section && !key.startsWith(section + '.')) continue;
      const rest = key === section ? [] : key.slice(section.length + 1).split('.');
      if (rest.length === 0) return value && typeof value === 'object' ? value : out;
      let node = out;
      for (let i = 0; i < rest.length - 1; i++) {
        if (typeof node[rest[i]] !== 'object' || node[rest[i]] === null) node[rest[i]] = {};
        node = node[rest[i]];
      }
      node[rest[rest.length - 1]] = value;
    }
    return out;
  }

  onServerNotification(msg) {
    const params = msg.params || {};
    switch (msg.method) {
      case '$/progress': {
        const value = params.value || {};
        if (value.kind === 'begin') this.progressActive.add(String(params.token));
        else if (value.kind === 'end') this.progressActive.delete(String(params.token));
        this.activityAt = Date.now();
        return;
      }
      case 'textDocument/publishDiagnostics': {
        if (!params.uri) return;
        const key = uriKey(params.uri);
        this.diagnostics.set(key, params.diagnostics || []);
        this.publishedAt.set(key, Date.now());
        this.activityAt = Date.now();
        debug(`${this.server.command}: publishDiagnostics ${params.diagnostics ? params.diagnostics.length : 0} for ${path.basename(fileURLToPath(params.uri))}`);
        return;
      }
      case 'experimental/serverStatus': {
        if (params.quiescent) this.quiescent = true;
        this.activityAt = Date.now();
        return;
      }
      case 'window/logMessage':
      case 'window/showMessage': {
        if (params.message) this.logLines.push(params.message);
        return;
      }
      default:
    }
  }

  send(msg) {
    if (!this.proc || this.proc.killed) return;
    const json = JSON.stringify(msg);
    try {
      this.proc.stdin.write(Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n`, 'ascii'));
      this.proc.stdin.write(json);
    } catch {
      // stdin closed: pending requests will time out with a clear error
    }
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs) {
    const id = this.msgId++;
    const timeout =
      timeoutMs ||
      (this.clientOpts && this.clientOpts.timeout) ||
      (this.server.timeouts && this.server.timeouts.request) ||
      8000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const tail = this.stderrTail.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`${method} timed out after ${timeout}ms${tail ? ` (server stderr: ${tail})` : ''}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize() {
    const timeout =
      (this.clientOpts && this.clientOpts.timeout) ||
      (this.server.timeouts && this.server.timeouts.initialize) ||
      15000;
    const result = await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'lsp-cli', version: VERSION },
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.rootDir) || 'root' }],
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
            didChangeConfiguration: { dynamicRegistration: true },
            symbol: { dynamicRegistration: false },
            applyEdit: true,
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { dynamicRegistration: false, prepareSupport: true },
            codeAction: {
              dynamicRegistration: false,
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] },
              },
            },
            // vtsls gates its diagnostic publishing on this capability; without it
            // the server silently reports nothing (no error, no diagnostics).
            publishDiagnostics: { versionSupport: false, relatedInformation: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          window: { workDoneProgress: true, showMessage: {} },
        },
        initializationOptions: this.server.initOptions || {},
      },
      timeout,
    );
    this.capabilities = (result && result.capabilities) || {};
    this.notify('initialized', {});
    if (Object.keys(this.settings).length > 0) {
      this.notify('workspace/didChangeConfiguration', { settings: this.settings });
    }
    return result;
  }

  openDocument(filePath) {
    const uri = pathToFileURL(filePath).toString();
    const text = fs.readFileSync(filePath, 'utf-8');
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageIdFor(this.server, filePath),
        version: 1,
        text,
      },
    });
    return uri;
  }

  // Wait until the server stops doing background work (project load / indexing).
  async settle(maxMs, minMs = 250) {
    const budget =
      maxMs ||
      (this.clientOpts && this.clientOpts.readyTimeout) ||
      this.server.readyTimeout ||
      6000;
    const started = Date.now();
    const deadline = started + budget;
    while (Date.now() < deadline) {
      const elapsed = Date.now() - started;
      const idle = Date.now() - this.activityAt;
      if (this.quiescent && elapsed >= minMs) return true;
      if (this.progressActive.size === 0 && idle >= 350 && elapsed >= minMs) return true;
      await sleep(80);
    }
    return false;
  }

  async waitForDiagnostics(uri, maxMs = 6000) {
    const key = uriKey(uri);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const current = this.diagnostics.get(key);
      if (current && current.length > 0) return current;
      const publishedAt = this.publishedAt.get(key);
      if (publishedAt !== undefined && Date.now() - publishedAt > 1500) {
        return this.diagnostics.get(key) || [];
      }
      await sleep(100);
    }
    return this.diagnostics.get(key) || [];
  }

  async close() {
    try {
      if (this.proc && !this.proc.killed) {
        this.request('shutdown', undefined, 1500).catch(() => {});
        await sleep(60);
        this.notify('exit', undefined);
        await sleep(60);
        this.proc.kill();
      }
    } catch {
      // process already gone
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function flattenHover(contents) {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === 'string' ? c : (c && c.value) || '')).join('\n\n');
  }
  if (typeof contents === 'object') {
    if (typeof contents.value === 'string') return contents.value;
    if (contents.language !== undefined) return contents.value || '';
  }
  return '';
}

function stripLoading(text) {
  return text.replace(/\(loading\.\.\.\)\s*/g, '');
}

function emitLocation(uri, range, note, rootDir) {
  let localPath;
  try {
    localPath = fileURLToPath(uri);
  } catch {
    return;
  }
  const line = range.start.line + 1;
  const col = range.start.character + 1;
  const snippet = readLine(localPath, range.start.line);
  console.log(`${displayPath(localPath, rootDir)}:${line}:${col}${snippet ? `  ${snippet}` : ''}${note ? `  ${note}` : ''}`);
}

// A definition that resolves back to an `import` line means module resolution failed.
function definitionLooksUnresolved(result, sourceUri) {
  if (!result) return true;
  const locations = Array.isArray(result) ? result : [result];
  if (locations.length === 0) return true;
  return locations.every((loc) => {
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetSelectionRange || loc.targetRange;
    if (!uri || !range) return true;
    if (uri !== sourceUri) return false;
    try {
      return /^\s*import\b/.test(readLine(fileURLToPath(uri), range.start.line));
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Navigation commands
// ---------------------------------------------------------------------------

async function runNavigation(action, targetStr, opts) {
  const target = parseTarget(targetStr);
  if (!target) {
    console.error('Error: missing target. Expected <file>:<line>[:<col>].');
    process.exit(2);
  }
  if (!fs.existsSync(target.filePath) || !fs.statSync(target.filePath).isFile()) {
    console.error(`Error: file not found: ${target.filePath}`);
    process.exit(2);
  }

  const config = opts.config;
  const navServers = serversForFile(config, target.filePath, { navigationOnly: true });
  if (navServers.length === 0) {
    const ext = path.extname(target.filePath);
    console.error(`Error: no navigation server configured for "${ext}" files (only linters match).`);
    process.exit(2);
  }

  const pos = resolveTargetPosition(target.filePath, target.line, target.col, target.colProvided, opts.symbol);
  target.line = pos.line;
  target.col = pos.col;

  const server = navServers[0];
  const root = findRootByMarkers(path.dirname(target.filePath), server.rootMarkers);
  const client = new LspConnection(server, root, opts);

  try {
    await client.start();
    await client.initialize();
    const uri = client.openDocument(target.filePath);
    await client.settle(opts.readyTimeout || server.readyTimeout);

    const position = { line: target.line - 1, character: target.col - 1 };

    if (action === 'def') {
      let result = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await client.request('textDocument/definition', { textDocument: { uri }, position });
        if (!definitionLooksUnresolved(result, uri)) break;
        await sleep(400);
        await client.settle(2000, 100);
      }
      const locations = !result ? [] : Array.isArray(result) ? result : [result];
      if (locations.length === 0) {
        console.log('No definition found.');
      } else {
        const unresolved = definitionLooksUnresolved(result, uri);
        for (const loc of locations) {
          const locUri = loc.uri || loc.targetUri;
          const range = loc.range || loc.targetSelectionRange || loc.targetRange;
          if (locUri && range) emitLocation(locUri, range, unresolved ? '(unresolved import)' : '', root);
        }
      }
      return;
    }

    if (action === 'ref') {
      const result = await client.request('textDocument/references', {
        textDocument: { uri },
        position,
        context: { includeDeclaration: opts.includeDecl },
      });
      const locations = Array.isArray(result) ? result : [];
      if (locations.length === 0) {
        console.log('No references found.');
        return;
      }
      const limit = opts.limit;
      for (const loc of locations.slice(0, limit)) emitLocation(loc.uri, loc.range, '', root);
      if (locations.length > limit) {
        console.log(`... ${locations.length - limit} more (raise with --limit)`);
      }
      return;
    }

    if (action === 'hover') {
      let result = null;
      let text = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        result = await client.request('textDocument/hover', { textDocument: { uri }, position });
        text = stripLoading(flattenHover(result && result.contents)).trim();
        if (text && !/^\(loading/.test(text)) break;
        await sleep(400);
      }
      if (!text) {
        console.log('No hover information available (is the cursor on an identifier?).');
        return;
      }
      console.log(text);
      return;
    }
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Symbols, Rename & Code Actions
// ---------------------------------------------------------------------------

const SYMBOL_KIND_NAMES = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method',
  7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface',
  12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
  17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null',
  22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type-parameter',
};

function formatDocumentSymbols(symbols, indent = '  ') {
  const lines = [];
  for (const sym of symbols) {
    const kind = SYMBOL_KIND_NAMES[sym.kind] || 'symbol';
    const range = sym.selectionRange || sym.range || (sym.location && sym.location.range);
    const pos = range ? ` (line ${range.start.line + 1}:${range.start.character + 1})` : '';
    lines.push(`${indent}${kind.padEnd(12)} ${sym.name}${pos}`);
    if (sym.children && sym.children.length > 0) {
      lines.push(...formatDocumentSymbols(sym.children, indent + '  '));
    }
  }
  return lines;
}

async function runSymbols(targetStr, opts) {
  const config = opts.config;
  const isFile = targetStr && fs.existsSync(normalizeUserPath(targetStr)) && fs.statSync(normalizeUserPath(targetStr)).isFile();

  if (isFile) {
    const absPath = normalizeUserPath(targetStr);
    const navServers = serversForFile(config, absPath, { navigationOnly: true });
    if (navServers.length === 0) {
      console.error(`Error: no navigation server configured for ${path.extname(absPath)} files.`);
      process.exit(2);
    }
    const server = navServers[0];
    const root = findRootByMarkers(path.dirname(absPath), server.rootMarkers);
    const client = new LspConnection(server, root, opts);
    try {
      await client.start();
      await client.initialize();
      const uri = client.openDocument(absPath);
      await client.settle(opts.readyTimeout || server.readyTimeout);
      const result = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
      const symbols = Array.isArray(result) ? result : [];
      if (symbols.length === 0) {
        console.log(`[lsp symbols] No symbols found in ${displayPath(absPath, root)}.`);
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(symbols, null, 2));
        return;
      }
      console.log(`[lsp symbols] ${displayPath(absPath, root)} (${symbols.length} top-level symbols):`);
      for (const line of formatDocumentSymbols(symbols)) {
        console.log(line);
      }
    } finally {
      await client.close();
    }
    return;
  }

  // Workspace symbol search
  const query = opts.query || targetStr || '';
  const root = process.cwd();
  const sampleExts = ['.ts', '.tsx', '.js', '.rs', '.py'];
  let chosenServer = null;
  for (const ext of sampleExts) {
    const matched = serversForFile(config, `dummy${ext}`, { navigationOnly: true });
    if (matched.length > 0 && resolveExecutable(matched[0].command)) {
      chosenServer = matched[0];
      break;
    }
  }
  if (!chosenServer) {
    console.error('Error: no available language server for workspace symbol search.');
    process.exit(2);
  }

  const client = new LspConnection(chosenServer, root, opts);
  try {
    await client.start();
    await client.initialize();
    const entryCandidate = ['src/index.ts', 'src/main.ts', 'src/lib.rs', 'index.ts', 'main.py']
      .map(f => path.join(root, f))
      .find(p => fs.existsSync(p));
    if (entryCandidate) {
      client.openDocument(entryCandidate);
    }
    await client.settle(opts.readyTimeout || chosenServer.readyTimeout);
    const result = await client.request('workspace/symbol', { query });
    const symbols = Array.isArray(result) ? result : [];
    if (symbols.length === 0) {
      console.log(`[lsp symbols] No workspace symbols found matching "${query}".`);
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(symbols, null, 2));
      return;
    }
    console.log(`[lsp symbols] Workspace query "${query}" (${symbols.length} matches):`);
    for (const sym of symbols.slice(0, opts.limit || 50)) {
      const kind = SYMBOL_KIND_NAMES[sym.kind] || 'symbol';
      let locStr = '';
      if (sym.location) {
        try {
          const locPath = fileURLToPath(sym.location.uri);
          const line = sym.location.range.start.line + 1;
          const col = sym.location.range.start.character + 1;
          locStr = `${displayPath(locPath, root)}:${line}:${col}`;
        } catch {}
      }
      const container = sym.containerName ? ` (${sym.containerName})` : '';
      console.log(`  ${locStr.padEnd(35)} ${kind.padEnd(10)} ${sym.name}${container}`);
    }
    if (symbols.length > (opts.limit || 50)) {
      console.log(`  ... and ${symbols.length - (opts.limit || 50)} more (raise with --limit)`);
    }
  } finally {
    await client.close();
  }
}

async function runRename(targetStr, newName, opts) {
  if (!newName) {
    console.error('Error: missing newName. Expected: lsp rename <file:line[:col]> <newName> [--apply]');
    process.exit(2);
  }
  const target = parseTarget(targetStr);
  if (!target || !fs.existsSync(target.filePath)) {
    console.error(`Error: valid file target required: ${targetStr}`);
    process.exit(2);
  }
  const pos = resolveTargetPosition(target.filePath, target.line, target.col, target.colProvided, opts.symbol);
  target.line = pos.line;
  target.col = pos.col;

  const config = opts.config;
  const navServers = serversForFile(config, target.filePath, { navigationOnly: true });
  if (navServers.length === 0) {
    console.error(`Error: no navigation server for ${path.extname(target.filePath)}.`);
    process.exit(2);
  }
  const server = navServers[0];
  const root = findRootByMarkers(path.dirname(target.filePath), server.rootMarkers);
  const client = new LspConnection(server, root, opts);

  try {
    await client.start();
    await client.initialize();
    const uri = client.openDocument(target.filePath);
    await client.settle(opts.readyTimeout || server.readyTimeout);

    const position = { line: target.line - 1, character: target.col - 1 };
    const editResult = await client.request('textDocument/rename', {
      textDocument: { uri },
      position,
      newName,
    });

    const edits = [];
    if (editResult && editResult.changes) {
      for (const [docUri, textEdits] of Object.entries(editResult.changes)) {
        try {
          const filePath = fileURLToPath(docUri);
          for (const e of textEdits) edits.push({ filePath, uri: docUri, range: e.range, newText: e.newText });
        } catch {}
      }
    } else if (editResult && editResult.documentChanges) {
      for (const change of editResult.documentChanges) {
        if (change.textDocument && change.edits) {
          try {
            const filePath = fileURLToPath(change.textDocument.uri);
            for (const e of change.edits) edits.push({ filePath, uri: change.textDocument.uri, range: e.range, newText: e.newText });
          } catch {}
        }
      }
    }

    if (edits.length === 0) {
      console.log('No rename edits returned by server (is the cursor on a renameable identifier?).');
      return;
    }

    const fileCount = new Set(edits.map(e => e.filePath)).size;
    if (!opts.apply) {
      console.log(`[lsp rename] Proposed changes (Dry-Run — pass --apply to execute):\n`);
      for (const e of edits) {
        const line = e.range.start.line + 1;
        const col = e.range.start.character + 1;
        const origSnippet = readLine(e.filePath, e.range.start.line);
        console.log(`  ${displayPath(e.filePath, root)}:${line}:${col} -> replace with "${e.newText}"`);
        if (origSnippet) console.log(`    current: ${origSnippet}`);
      }
      console.log(`\nTotal: ${edits.length} edit(s) across ${fileCount} file(s). Use --apply to write to disk.`);
      return;
    }

    // Apply edits safely in reverse order per file
    const byFile = new Map();
    for (const e of edits) {
      if (!byFile.has(e.filePath)) byFile.set(e.filePath, []);
      byFile.get(e.filePath).push(e);
    }

    for (const [fPath, fileEdits] of byFile) {
      fileEdits.sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line;
        return b.range.start.character - a.range.start.character;
      });
      const lines = fs.readFileSync(fPath, 'utf-8').split(/\r?\n/);
      for (const e of fileEdits) {
        const { start, end } = e.range;
        if (start.line === end.line) {
          const l = lines[start.line] || '';
          lines[start.line] = l.slice(0, start.character) + e.newText + l.slice(end.character);
        } else {
          const startL = lines[start.line] || '';
          const endL = lines[end.line] || '';
          const combined = startL.slice(0, start.character) + e.newText + endL.slice(end.character);
          lines.splice(start.line, end.line - start.line + 1, combined);
        }
      }
      fs.writeFileSync(fPath, lines.join('\n'), 'utf-8');
    }
    console.log(`[lsp rename] Successfully applied ${edits.length} edit(s) across ${fileCount} file(s).`);
  } finally {
    await client.close();
  }
}

async function runCodeAction(targetStr, opts) {
  const target = parseTarget(targetStr);
  if (!target || !fs.existsSync(target.filePath)) {
    console.error(`Error: valid file target required: ${targetStr}`);
    process.exit(2);
  }
  const pos = resolveTargetPosition(target.filePath, target.line, target.col, target.colProvided, opts.symbol);
  target.line = pos.line;
  target.col = pos.col;

  const config = opts.config;
  const navServers = serversForFile(config, target.filePath, { navigationOnly: true });
  if (navServers.length === 0) {
    console.error(`Error: no navigation server for ${path.extname(target.filePath)}.`);
    process.exit(2);
  }
  const server = navServers[0];
  const root = findRootByMarkers(path.dirname(target.filePath), server.rootMarkers);
  const client = new LspConnection(server, root, opts);

  try {
    await client.start();
    await client.initialize();
    const uri = client.openDocument(target.filePath);
    await client.settle(opts.readyTimeout || server.readyTimeout);

    const position = { line: target.line - 1, character: target.col - 1 };
    const result = await client.request('textDocument/codeAction', {
      textDocument: { uri },
      range: { start: position, end: position },
      context: { diagnostics: [] },
    });
    const actions = Array.isArray(result) ? result : [];
    if (actions.length === 0) {
      console.log('No code actions available at this position.');
      return;
    }
    console.log(`[lsp action] Available code actions for ${displayPath(target.filePath, root)}:${target.line}:${target.col}:`);
    actions.forEach((act, idx) => {
      const kind = act.kind ? ` [${act.kind}]` : '';
      console.log(`  ${idx + 1}.${kind} ${act.title}`);
    });
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function diagnosticsFromServer(server, filePath, root, maxMs, opts = {}) {
  const client = new LspConnection(server, root, opts);
  const t0 = Date.now();
  try {
    await client.start();
    await client.initialize();
    const uri = client.openDocument(filePath);
    const settled = await client.settle(server.readyTimeout);
    debug(`${server.name}: init+open ${Date.now() - t0}ms, settled=${settled}`);

    const supportsPull = Boolean(client.capabilities && client.capabilities.diagnosticProvider);
    debug(`${server.name}: pullDiagnostics=${supportsPull}`);
    if (supportsPull && !server.forcePushDiagnostics) {
      const pullStart = Date.now();
      try {
        const report = await client.request('textDocument/diagnostic', { textDocument: { uri } }, maxMs);
        debug(`${server.name}: pull answered in ${Date.now() - pullStart}ms, items=${report && report.items ? report.items.length : 'n/a'}`);
        if (report && Array.isArray(report.items)) return report.items;
      } catch (err) {
        debug(`${server.name}: pull failed after ${Date.now() - pullStart}ms: ${err.message}`);
      }
    }
    const pushStart = Date.now();
    const items = await client.waitForDiagnostics(uri, maxMs);
    debug(`${server.name}: push collected ${items.length} in ${Date.now() - pushStart}ms`);
    return items;
  } finally {
    await client.close();
  }
}

async function runFileDiagnostics(filePath, opts) {
  const config = opts.config;
  const abs = normalizeUserPath(filePath);
  if (!fs.existsSync(abs)) {
    console.error(`Error: file not found: ${abs}`);
    process.exit(2);
  }
  const servers = serversForFile(config, abs, {});
  if (servers.length === 0) {
    console.error(`Error: no language server configured for ${path.extname(abs)} files.`);
    process.exit(2);
  }

  console.log(`[lsp diag] ${displayPath(abs)}`);
  let total = 0;
  let errors = 0;

  for (const server of servers) {
    const root = findRootByMarkers(path.dirname(abs), server.rootMarkers);
    let items = [];
    try {
      items = await diagnosticsFromServer(server, abs, root, opts.diagTimeout, opts);
    } catch (err) {
      console.log(`  ${server.name}: unavailable (${err.message.split('\n')[0]})`);
      continue;
    }
    if (items.length === 0) {
      console.log(`  ${server.name}: clean`);
      continue;
    }
    items.sort((a, b) => (a.range.start.line - b.range.start.line) || (a.range.start.character - b.range.start.character));
    for (const item of items) {
      const line = item.range.start.line + 1;
      const col = item.range.start.character + 1;
      const severity = SEVERITY_LABEL[item.severity] || 'info';
      if (item.severity === 1) errors++;
      total++;
      console.log(`  ${displayPath(abs)}:${line}:${col}  ${severity}  [${server.name}] ${item.message.split('\n')[0]}`);
    }
  }

  console.log(`[lsp diag] ${total} problem${total === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'})`);
  if (errors > 0) process.exitCode = 1;
}

function hasAnyMarker(dir, markers) {
  return (markers || []).some((marker) => {
    if (marker === '.') return false;
    if (!marker.includes('*')) return fs.existsSync(path.join(dir, marker));
    try {
      const re = globToRegExp(marker);
      return fs.readdirSync(dir).some((name) => re.test(name));
    } catch {
      return false;
    }
  });
}

function resolveLocalBin(root, name) {
  const candidates = IS_WIN
    ? [path.join(root, 'node_modules', '.bin', `${name}.cmd`), path.join(root, 'node_modules', '.bin', name)]
    : [path.join(root, 'node_modules', '.bin', name)];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Next best: project-pinned TypeScript entry point
  if (name === 'tsc') {
    const jsEntry = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (fs.existsSync(jsEntry)) return jsEntry;
  }
  return null;
}

function runSync(plan, cwd) {
  return spawnSync(plan.cmd, plan.argv, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    windowsVerbatimArguments: plan.verbatim,
  });
}

function runProjectDiagnostics(dirArg, opts) {
  const config = opts.config;
  const root = dirArg ? normalizeUserPath(dirArg) : process.cwd();
  if (!fs.existsSync(root)) {
    console.error(`Error: path not found: ${root}`);
    process.exit(2);
  }
  console.log(`[lsp diag] project: ${root}`);

  let ran = 0;
  let failed = 0;

  for (const [id, entry] of Object.entries(config.diagnostics || {})) {
    if (!hasAnyMarker(root, entry.rootMarkers)) continue;
    for (const command of entry.commands || []) {
      if (!command || command.length === 0) continue;
      const [bin, ...args] = command;
      let plan;

      // Prefer the project-pinned binary to avoid version skew (e.g. global tsc 7 vs local tsc 6).
      let exe = entry.localBin === bin ? resolveLocalBin(root, bin) : null;
      let label = exe ? `${bin} (local)` : bin;
      if (exe && exe.endsWith('.js')) {
        const node = resolveExecutable('node');
        if (!node) {
          console.log(`--- ${id}: skipped (node not found) ---`);
          continue;
        }
        plan = spawnPlan(node, [exe, ...args]);
      } else if (exe) {
        plan = spawnPlan(exe, args);
      } else {
        exe = resolveExecutable(bin);
        if (!exe) {
          console.log(`--- ${id}: skipped (${bin} not installed) ---`);
          continue;
        }
        plan = spawnPlan(exe, args);
      }

      console.log(`--- ${id}: ${label} ${args.join(' ')} ---`);
      ran++;
      const result = runSync(plan, root);
      if (result.status !== 0) failed++;
    }
  }

  if (ran === 0) {
    const tsEntry = config.diagnostics && config.diagnostics.typescript;
    if (tsEntry) {
      const exe = resolveLocalBin(root, 'tsc') || resolveExecutable('tsc');
      if (exe) {
        console.log('--- typescript: tsc --noEmit (fallback) ---');
        const plan = exe.endsWith('.js')
          ? spawnPlan(resolveExecutable('node'), [exe, '--noEmit'])
          : spawnPlan(exe, ['--noEmit']);
        const result = runSync(plan, root);
        if (result.status !== 0) failed++;
        ran++;
      }
    }
  }

  if (ran === 0) {
    console.log('No configured diagnostics apply to this directory. See ~/.dsh/lsp.json > diagnostics.');
    return;
  }
  console.log(failed === 0 ? '[lsp diag] all checks passed' : `[lsp diag] ${failed} check(s) failed`);
  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// servers
// ---------------------------------------------------------------------------

function listServers(opts) {
  const config = opts.config;
  let rows = 0;
  for (const [name, server] of Object.entries(config.servers || {})) {
    if (!server || !server.command) {
      if (server && server.disabled) console.log(`${name.padEnd(18)} disabled`);
      continue;
    }
    const exe = resolveExecutable(server.command);
    const kind = server.isLinter ? 'linter' : 'nav';
    const exts = (server.fileTypes || []).join(',');
    console.log(`${name.padEnd(18)} ${kind.padEnd(6)} ${exe ? 'ok   ' : 'MISSING'} ${exts}`);
    if (exe) console.log(`${''.padEnd(18)}        ${exe}`);
    rows++;
  }
  if (rows === 0) console.log('No servers configured.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    limit: 200,
    includeDecl: true,
    config: null,
    verbose: false,
    diagTimeout: 6000,
    timeout: 0,
    readyTimeout: 0,
    symbol: null,
    apply: false,
    errorsOnly: false,
    json: false,
    query: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-decl') opts.includeDecl = false;
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--limit') opts.limit = Math.max(0, parseInt(argv[++i] || '200', 10));
    else if (arg === '--config') opts.config = argv[++i];
    else if (arg === '--timeout') opts.timeout = parseInt(argv[++i] || '0', 10);
    else if (arg === '--ready-timeout') opts.readyTimeout = parseInt(argv[++i] || '0', 10);
    else if (arg === '--diag-timeout') opts.diagTimeout = parseInt(argv[++i] || '6000', 10);
    else if (arg === '-s' || arg === '--symbol') opts.symbol = argv[++i];
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '-e' || arg === '--errors-only') opts.errorsOnly = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-q' || arg === '--query') opts.query = argv[++i];
    else if (arg === '-h' || arg === '--help' || arg === 'help') opts.help = true;
    else positional.push(arg);
  }
  return { opts, positional };
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help || positional.length === 0) {
    printUsage();
    return;
  }

  opts.config = loadConfig(opts.config);
  const [cmd, ...args] = positional;

  switch (cmd) {
    case 'def':
    case 'definition':
      await runNavigation('def', args[0], opts);
      return;
    case 'ref':
    case 'references':
      await runNavigation('ref', args[0], opts);
      return;
    case 'hover':
    case 'type':
      await runNavigation('hover', args[0], opts);
      return;
    case 'sym':
    case 'symbol':
    case 'symbols':
      await runSymbols(args[0], opts);
      return;
    case 'rename':
      await runRename(args[0], args[1], opts);
      return;
    case 'action':
    case 'actions':
    case 'code-action':
      await runCodeAction(args[0], opts);
      return;
    case 'diag':
    case 'diagnostics':
    case 'check': {
      const targetArg = args[0];
      if (targetArg) {
        const abs = normalizeUserPath(targetArg);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          await runFileDiagnostics(targetArg, opts);
          return;
        }
      }
      runProjectDiagnostics(targetArg, opts);
      return;
    }
    case 'servers':
      listServers(opts);
      return;
    case '-v':
    case '--version':
    case 'version':
      console.log(`agent-lsp v${VERSION}`);
      return;
    case '-h':
    case '--help':
    case 'help':
      printUsage();
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`lsp-cli failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
