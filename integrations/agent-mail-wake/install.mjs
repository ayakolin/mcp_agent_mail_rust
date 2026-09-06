#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS = ['omp', 'codex', 'claude', 'kimi', 'grok', 'opencode'];
const FILES = ['common.mjs', 'rpc.mjs', 'omp.mjs', 'claude-channel.mjs', 'cli.mjs',
  'package.json', 'install.mjs', 'README.md', 'README.zh-CN.md'];
const ENDPOINT = 'http://127.0.0.1:8765/mcp/';
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function contents(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function jsonObject(text, file) {
  const data = text === null ? {} : JSON.parse(text);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(`Expected JSON object: ${file}`);
  return data;
}
function changedJson(file, modify) {
  const before = contents(file), data = jsonObject(before, file);
  const snapshot = JSON.stringify(data); modify(data);
  return { file, before, after: JSON.stringify(data) === snapshot ? before : JSON.stringify(data, null, 2) + '\n', mode: 0o600 };
}
function discoverToken(home, customHome) {
  const inline = process.env.AGENT_MAIL_BEARER_TOKEN?.trim();
  if (inline) return inline;
  if (!customHome && process.env.AGENT_MAIL_CONFIG_ENV) {
    try { return readTokenLine(process.env.AGENT_MAIL_CONFIG_ENV); } catch { return ''; }
  }
  const configHome = !customHome && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(home, '.config');
  try { return readTokenLine(path.join(configHome, 'mcp-agent-mail', 'config.env')); } catch { return ''; }
}
function readTokenLine(file) {
  const match = fs.readFileSync(file, 'utf8').match(/^\s*(?:export\s+)?HTTP_BEARER_TOKEN\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/m);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}
function mailEntry(data, entry) {
  if (data.mcpServers === undefined) data.mcpServers = {};
  if (!data.mcpServers || Array.isArray(data.mcpServers) || typeof data.mcpServers !== 'object') throw new Error('mcpServers must be an object');
  // Preserve existing credentials, server choices, and disabled-server decisions.
  data.mcpServers.mcp_agent_mail ??= entry;
}

export function installationPlan(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const customHome = !!options.home;
  const dataHome = !customHome && process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  const prefix = path.resolve(options.prefix || path.join(dataHome, 'agent-mail', 'wake'));
  const binDir = path.resolve(options.binDir || path.join(home, '.local', 'bin'));
  const clients = options.clients || CLIENTS;
  if (!clients.length || clients.some(c => !CLIENTS.includes(c))) throw new Error(`Supported clients: ${CLIENTS.join(',')}`);
  const endpoint = new URL(options.url || ENDPOINT);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error('Agent Mail URL must be a loopback HTTP URL without embedded credentials');
  }
  const url = endpoint.toString(), changes = [];
  const token = discoverToken(home, customHome);
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const add = (file, after, mode = 0o600) => changes.push({ file, before: contents(file), after, mode });
  for (const file of FILES) add(path.join(prefix, file), fs.readFileSync(path.join(SOURCE, file), 'utf8'), 0o644);

  const launcher = (name, host = '') => {
    const file = path.join(binDir, name), existing = contents(file);
    if (existing && !existing.includes('agent-mail-wake managed launcher') && !existing.includes('/agent-mail/wake/cli.mjs')) {
      throw new Error(`Refusing to replace an unrelated executable: ${file}`);
    }
    add(file, '#!/bin/sh\n# agent-mail-wake managed launcher\n' +
      `if [ -z "\${AGENT_MAIL_WAKE_HOME:-}" ]; then AGENT_MAIL_WAKE_HOME=${shellQuote(prefix)}; fi\nexport AGENT_MAIL_WAKE_HOME\n` +
      `if [ -z "\${AGENT_MAIL_URL:-}" ]; then AGENT_MAIL_URL=${shellQuote(url)}; fi\nexport AGENT_MAIL_URL\n` +
      `exec ${shellQuote(process.execPath)} ${shellQuote(path.join(prefix, 'cli.mjs'))}${host ? ' ' + host : ''} "$@"\n`, 0o755);
  };
  launcher('agent-mail-wake');
  if (clients.includes('codex')) launcher('codex-mail', 'codex');
  if (clients.includes('claude')) launcher('claude-mail', 'claude');
  if (clients.includes('kimi')) launcher('kimi-mail', 'kimi');
  if (clients.includes('grok')) launcher('grok-mail', 'grok');
  if (clients.includes('opencode')) launcher('opencode-mail', 'opencode');

  if (clients.includes('omp')) {
    const profile = !customHome ? process.env.OMP_PROFILE : undefined;
    if (profile && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('Invalid OMP_PROFILE');
    const ompDir = !customHome && process.env.PI_CODING_AGENT_DIR ? process.env.PI_CODING_AGENT_DIR
      : profile ? path.join(home, '.omp', 'profiles', profile, 'agent') : path.join(home, '.omp', 'agent');
    const entry = path.join(ompDir, 'extensions', 'agent-mail-wake', 'index.ts');
    const previous = contents(entry);
    if (previous && !previous.includes('agent-mail/wake/omp.mjs') && !previous.includes('agent-mail-wake managed extension')) {
      throw new Error(`Refusing to replace an unrelated OMP extension: ${entry}`);
    }
    add(entry, '// agent-mail-wake managed extension\n' +
      `import agentMailWake from ${JSON.stringify(path.join(prefix, 'omp.mjs'))};\n` +
      `export default function (pi) { process.env.AGENT_MAIL_WAKE_HOME ??= ${JSON.stringify(prefix)}; process.env.AGENT_MAIL_URL ??= ${JSON.stringify(url)}; agentMailWake(pi); }\n`, 0o644);
    changes.push(changedJson(path.join(ompDir, 'mcp.json'), data => mailEntry(data, { type: 'http', url, ...(Object.keys(authHeaders).length ? { headers: authHeaders } : {}) })));
  }
  if (clients.includes('codex')) {
    const dir = !customHome && process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(home, '.codex');
    const file = path.join(dir, 'config.toml'), before = contents(file);
    const table = /^\s*\[\s*mcp_servers\s*\.\s*(?:mcp_agent_mail|"mcp_agent_mail"|'mcp_agent_mail')\s*(?:\.|\])/m;
    const after = before && table.test(before) ? before
      : `${before || ''}${before?.endsWith('\n') ? '' : '\n'}\n[mcp_servers.mcp_agent_mail]\nurl = ${JSON.stringify(url)}\n${token ? `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n` : ''}`;
    changes.push({ file, before, after, mode: 0o600 });
  }
  if (clients.includes('claude')) {
    const file = !customHome && process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
    changes.push(changedJson(file, data => {
      mailEntry(data, { type: 'http', url, ...(Object.keys(authHeaders).length ? { headers: authHeaders } : {}) });
      const current = data.mcpServers.agent_mail_wake;
      if (current && !current.args?.some(arg => arg === path.join(prefix, 'claude-channel.mjs'))) {
        throw new Error('agent_mail_wake is already assigned to another MCP server');
      }
      data.mcpServers.agent_mail_wake = { type: 'stdio', command: process.execPath,
        args: [path.join(prefix, 'claude-channel.mjs')], env: { AGENT_MAIL_WAKE_HOME: prefix, AGENT_MAIL_URL: url } };
    }));
  }
  if (clients.includes('kimi')) {
    const dir = !customHome && process.env.KIMI_CODE_HOME ? process.env.KIMI_CODE_HOME : path.join(home, '.kimi-code');
    changes.push(changedJson(path.join(dir, 'mcp.json'), data => mailEntry(data, { url, ...(Object.keys(authHeaders).length ? { headers: authHeaders } : {}) })));
  }
  if (clients.includes('grok')) {
    const dir = !customHome && process.env.GROK_HOME ? process.env.GROK_HOME : path.join(home, '.grok');
    const file = path.join(dir, 'config.toml'), before = contents(file);
    const table = /^\s*\[\s*mcp_servers\s*\.\s*(?:mcp_agent_mail|"mcp_agent_mail"|'mcp_agent_mail')\s*(?:\.|\])/m;
    const after = before && table.test(before) ? before
      : `${before || ''}${before?.endsWith('\n') ? '' : '\n'}\n[mcp_servers.mcp_agent_mail]\nurl = ${JSON.stringify(url)}\n${token ? `\n[mcp_servers.mcp_agent_mail.headers]\nAuthorization = ${JSON.stringify(`Bearer ${token}`)}\n` : ''}`;
    changes.push({ file, before, after, mode: 0o600 });
  }
  if (clients.includes('opencode')) {
    const dir = !customHome && process.env.OPENCODE_CONFIG_DIR ? process.env.OPENCODE_CONFIG_DIR : path.join(home, '.opencode');
    changes.push(changedJson(path.join(dir, 'opencode.json'), data => {
      if (data.mcp === undefined) data.mcp = {};
      if (!data.mcp || Array.isArray(data.mcp) || typeof data.mcp !== 'object') throw new Error('mcp must be an object');
      data.mcp.mcp_agent_mail ??= { type: 'remote', url, enabled: true, ...(Object.keys(authHeaders).length ? { headers: authHeaders } : {}) };
    }));
  }
  return { prefix, binDir, clients, changes: changes.filter(c => c.before !== c.after) };
}

export function applyInstallation(plan, { dryRun = false } = {}) {
  if (dryRun || plan.changes.length === 0) return { changed: plan.changes.map(c => c.file), backup: null, dryRun };
  const backup = path.join(plan.prefix, 'backups', `install-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const manifest = [];
  for (const [i, change] of plan.changes.entries()) {
    if (contents(change.file) !== change.before) throw new Error(`Concurrent modification: ${change.file}`);
    const saved = change.before === null ? null : path.join(backup, `${i}.original`);
    if (saved) fs.writeFileSync(saved, change.before, { flag: 'wx', mode: 0o600 });
    manifest.push({ file: change.file, existed: saved !== null, backup: saved });
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  for (const change of plan.changes) {
    if (contents(change.file) !== change.before) throw new Error(`Concurrent modification: ${change.file}; originals are in ${backup}`);
    fs.mkdirSync(path.dirname(change.file), { recursive: true, mode: 0o700 });
    const temporary = `${change.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, change.after, { flag: 'wx', mode: change.mode });
    fs.renameSync(temporary, change.file);
  }
  return { changed: plan.changes.map(c => c.file), backup, dryRun: false };
}

function optionsFrom(args) {
  const options = {};
  const values = { '--home': 'home', '--prefix': 'prefix', '--bin-dir': 'binDir', '--clients': 'clients', '--url': 'url' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--help') options.help = true;
    else if (values[args[i]] && args[i + 1]) options[values[args[i]]] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (options.clients) options.clients = options.clients.split(',');
  return options;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
    const options = optionsFrom(process.argv.slice(2));
    if (options.help) console.log('node install.mjs [--dry-run] [--clients omp,codex,claude,kimi] [--home DIR] [--prefix DIR] [--bin-dir DIR] [--url LOOPBACK_URL]');
    else {
      const plan = installationPlan(options), result = applyInstallation(plan, options);
      console.log(JSON.stringify({ ...result, prefix: plan.prefix, binDir: plan.binDir, clients: plan.clients }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
