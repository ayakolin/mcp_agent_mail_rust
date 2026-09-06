#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MailClient, MailWatcher, STATE_ROOT, DATA_ROOT, listStates, readJson, saveJson, projectPath, identityInstructions, sleep, errorText } from './common.mjs';
import { CodexRPC, CodexAdapter, KimiAdapter, GrokACP, OpenCodeAdapter } from './rpc.mjs';

const children = new Set(); let watcher, rpc, stopping = false;
function child(command, args, options = {}) {
  const proc = spawn(command, args, options); children.add(proc); proc.on('exit', () => children.delete(proc));
  proc.on('error', error => { process.stderr.write(`${command}: ${errorText(error)}\n`); void shutdown().then(() => process.exit(1)); });
  return proc;
}
async function shutdown() {
  if (stopping) return; stopping = true;
  await watcher?.stop(); rpc?.close();
  for (const proc of children) proc.kill('SIGTERM');
  await Promise.race([Promise.all([...children].map(p => once(p, 'exit').catch(() => {}))), sleep(3000)]);
  for (const proc of children) proc.kill('SIGKILL');
}
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
function parse(args) {
  const options = { extra: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { options.extra = args.slice(i + 1); break; }
    if (['--headless', '--help'].includes(args[i])) options[args[i].slice(2)] = true;
    else if (['--project', '--session', '--server', '--token-file', '--model'].includes(args[i])) {
      if (!args[i + 1]) throw new Error(`Missing value for ${args[i]}`);
      options[args[i].slice(2)] = args[++i];
    } else throw new Error(`Unknown argument ${args[i]}; pass native CLI flags after --`);
  }
  return options;
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(test, label, proc) {
  let last;
  for (let i = 0; i < 100; i++) {
    if (proc?.exitCode != null) throw new Error(`${label} exited with ${proc.exitCode}`);
    try { return await test(); } catch (e) { last = e; await sleep(300); }
  }
  throw new Error(`${label} not ready: ${errorText(last)}`);
}
function logFile(name) {
  const dir = path.join(DATA_ROOT, 'logs'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.openSync(path.join(dir, `${name}-${Date.now()}.log`), 'a', 0o600);
}
function report(state) {
  process.stderr.write(`[Agent Mail] ${state.host} mailbox=${state.agent} id=${state.id}${state.paused ? ' PAUSED' : ''}${state.error ? ' ' + state.error : ''}\n`);
}
async function codexMain(options) {
  const project = projectPath(options.project);
  let server = options.server, proc;
  if (!server) {
    server = `ws://127.0.0.1:${await freePort()}`;
    const log = logFile('codex-server');
    proc = child('codex', ['app-server', '--listen', server], { cwd: project, stdio: ['ignore', log, log] }); fs.closeSync(log);
  }
  rpc = await waitFor(async () => { const connection = new CodexRPC(server); try { return await connection.connect(); } catch (e) { connection.close(); throw e; } }, 'Codex app server', proc);
  const result = await rpc.request(options.session ? 'thread/resume' : 'thread/start', {
    ...(options.session ? { threadId: options.session } : {}), cwd: project,
    ...(options.model ? { model: options.model } : {}),
  });
  const session = result.thread.id;
  const adapter = new CodexAdapter(rpc, session);
  watcher = new MailWatcher({ host: 'codex', session, project,
    canDeliver: () => adapter.canDeliver(), deliver: (text, batch) => adapter.deliver(text, batch), onStatus: report });
  await watcher.init({ start: false });
  // Store identity in thread history without starting an LLM turn.
  await rpc.request('thread/inject_items', { threadId: session, items: [{ type: 'message', role: 'user',
    content: [{ type: 'input_text', text: identityInstructions(watcher.state) }] }] });
  saveJson(path.join(DATA_ROOT, 'bindings', `${watcher.id}.json`), { host: 'codex', server, session, project, agent: watcher.state.agent });
  process.stderr.write(`Codex session: ${session}\n`);
  rpc.on('disconnected', () => { if (!stopping) void shutdown().then(() => process.exit(1)); });
  if (options.headless) {
    rpc.on('notification', msg => {
      if (msg.method === 'item/agentMessage/delta') process.stdout.write(msg.params.delta || '');
      if (msg.method === 'turn/completed') process.stdout.write('\n');
      if (msg.id !== undefined) process.stderr.write('Approval/input requested; attach the Codex TUI to respond.\n');
    });
    process.stderr.write(`Attach: codex resume --remote ${server} ${session}\n`);
    watcher.start();
  } else {
    const tui = child('codex', ['resume', '--remote', server, session, ...options.extra], { cwd: project, stdio: 'inherit' });
    watcher.start(); await once(tui, 'exit'); await shutdown();
  }
}
async function kimiMain(options) {
  const project = projectPath(options.project);
  let server = options.server, proc;
  if (!server) {
    const port = await freePort(); server = `http://127.0.0.1:${port}`;
    const log = logFile('kimi-server');
    proc = child('kimi', ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: project, stdio: ['ignore', log, log] }); fs.closeSync(log);
  }
  const tokenFile = options['token-file'] || path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'), 'server.token');
  const adapter = new KimiAdapter(server, () => fs.readFileSync(tokenFile, 'utf8').trim(), options.session);
  await waitFor(() => adapter.request('/api/v1/meta'), 'Kimi server', proc);
  const session = options.session ? await adapter.request(`/api/v1/sessions/${encodeURIComponent(options.session)}`)
    : await adapter.request('/api/v1/sessions', { metadata: { cwd: project }, title: 'Agent Mail' });
  if (session.metadata?.cwd && projectPath(session.metadata.cwd) !== project) throw new Error('Kimi session belongs to another project');
  adapter.session = session.id;
  // This Kimi version creates API sessions without applying the configured default model.
  // Bind that same user-selected model explicitly for new sessions only.
  if (!options.session || options.model) {
    const configured = options.model || (await adapter.request('/api/v1/config')).default_model;
    if (!configured) throw new Error('Kimi has no default model configured');
    await adapter.request(`/api/v1/sessions/${session.id}/profile`, { agent_config: { model: configured } });
  }
  watcher = new MailWatcher({ host: 'kimi-code', session: session.id, project,
    canDeliver: () => adapter.canDeliver(), deliver: (text, batch) => adapter.deliver(text, batch), onStatus: report });
  await watcher.init();
  saveJson(path.join(DATA_ROOT, 'bindings', `${watcher.id}.json`), { host: 'kimi-code', server, session: session.id, project, agent: watcher.state.agent });
  process.stderr.write(`Kimi session: ${session.id}\nWeb UI: ${server}\nKeep this launcher running. The web UI uses your existing Kimi server token.\n${identityInstructions(watcher.state)}\n`);
  if (proc) proc.on('exit', () => { if (!stopping) void shutdown().then(() => process.exit(1)); });
}
async function claudeMain(options) {
  const project = projectPath(options.project); const session = options.session || randomUUID();
  const env = { ...process.env, AGENT_MAIL_PROJECT: project, AGENT_MAIL_WAKE_SESSION: session, AGENT_MAIL_WAKE_CLAUDE_ENABLED: '1' };
  const args = ['--dangerously-load-development-channels', 'server:agent_mail_wake',
    ...(options.session ? ['--resume', options.session] : ['--session-id', session]),
    ...(options.model ? ['--model', options.model] : []), ...options.extra];
  const proc = child('claude', args, { env, cwd: project, stdio: 'inherit' });
  const [code] = await once(proc, 'exit'); process.exitCode = code || 0;
}
async function grokMain(options) {
  const project = projectPath(options.project);
  const sessionKey = options.session || randomUUID();
  let acp, session, bindingFile;
  const delivered = new Set();
  watcher = new MailWatcher({ host: 'grok-build', session: sessionKey, project,
    model: options.model || 'configured-model',
    canDeliver: () => acp?.alive,
    deliver: async (text, batch) => {
      if (delivered.has(batch.id)) return;
      delivered.add(batch.id);
      saveJson(bindingFile, { ...readJson(bindingFile, {}), delivered: [...delivered].slice(-64) });
      try { await acp.deliver(text); process.stderr.write(`[Agent Mail] grok replied: ${acp.turnText.trim().slice(0, 400)}\n`); }
      catch (error) { delivered.delete(batch.id); saveJson(bindingFile, { ...readJson(bindingFile, {}), delivered: [...delivered] }); throw error; }
    }, onStatus: report });
  bindingFile = path.join(DATA_ROOT, 'bindings', `${watcher.id}.json`);
  for (const batchId of readJson(bindingFile, {}).delivered || []) delivered.add(batchId);
  await watcher.init({ start: false });
  const log = logFile('grok-agent');
  const proc = child('grok', ['agent', '--always-approve', ...(options.model ? ['-m', options.model] : []), 'stdio'],
    { cwd: project, stdio: ['pipe', 'pipe', log] }); fs.closeSync(log);
  acp = new GrokACP(proc);
  proc.on('exit', () => { if (!stopping) { void shutdown().then(() => process.exit(1)); } });
  await waitFor(() => acp.connect(), 'Grok ACP agent', proc);
  session = await acp.openSession(project, options.session, identityInstructions(watcher.state));
  acp.session = session;
  saveJson(bindingFile, { ...readJson(bindingFile, {}), host: 'grok-build', session, project, agent: watcher.state.agent });
  process.stderr.write(`Grok session: ${session}\nKeep this launcher running; the ACP agent is owned by it.\n${identityInstructions(watcher.state)}\n`);
  watcher.start();
}
async function opencodeMain(options) {
  const project = projectPath(options.project);
  const sessionKey = options.session || randomUUID();
  let adapter, proc, session;
  watcher = new MailWatcher({ host: 'opencode', session: sessionKey, project,
    model: options.model || 'configured-model',
    canDeliver: () => adapter && proc?.exitCode === null,
    deliver: (text, batch) => adapter.deliver(session, text, batch),
    onStatus: report });
  await watcher.init({ start: false });
  const server = `http://127.0.0.1:${await freePort()}`;
  const log = logFile('opencode-server');
  proc = child('opencode', ['serve', '--port', server.split(':')[2]], { cwd: project, stdio: ['ignore', 'ignore', log] }); fs.closeSync(log);
  adapter = new OpenCodeAdapter(server);
  await waitFor(() => adapter.request('/session'), 'OpenCode server', proc);
  session = options.session || await adapter.openSession(`Agent Mail ${watcher.state.agent}`);
  if (options.model) await adapter.setModel(session, options.model);
  saveJson(path.join(DATA_ROOT, 'bindings', `${watcher.id}.json`), { host: 'opencode', server, session, project, agent: watcher.state.agent });
  process.stderr.write(`OpenCode session: ${session}\nKeep this launcher running; it owns the headless server.\n${identityInstructions(watcher.state)}\n`);
  proc.on('exit', () => { if (!stopping) void shutdown().then(() => process.exit(1)); });
  watcher.start();
}
function usage() {
  console.log(`Agent Mail Wake\n\nagent-mail-wake list\nagent-mail-wake pause|resume <listener-id>\nagent-mail-wake doctor\ncodex-mail [--project DIR] [--session ID] [--headless] [-- native flags]\nclaude-mail [--project DIR] [--session ID] [-- native flags]\nkimi-mail [--project DIR] [--server URL --session ID]\ngrok-mail [--project DIR] [--session ID] [--model ID]\nopencode-mail [--project DIR] [--session ID] [--model provider/model]\n\nOMP: automatically enabled in new interactive sessions; /mail-wake status|pause|resume\nGrok Build: managed ACP session (grok agent stdio); approvals run always-approve.`);
}
export async function main(args = process.argv.slice(2)) {
  const command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command)) return usage();
  if (command === 'list') return console.log(JSON.stringify(listStates(), null, 2));
  if (command === 'pause' || command === 'resume') {
    const matches = listStates().filter(s => s.id.startsWith(args[0] || '?'));
    if (matches.length !== 1) throw new Error('Specify one exact or unique listener ID from list');
    const file = path.join(STATE_ROOT, `${matches[0].id}.json`), state = readJson(file);
    state.paused = command === 'pause';
    if (!state.paused) { state.wakeups = 0; delete state.error; }
    saveJson(file, state); console.log(`${command}: ${state.host} ${state.agent}`); return;
  }
  if (command === 'doctor') {
    const client = new MailClient(); await client.call('health_check');
    console.log('Agent Mail: healthy\nAdapters: OMP extension, Codex App Server, Claude channel, Kimi Server API, Grok ACP agent, OpenCode headless server\n');
    return console.log(JSON.stringify(listStates(), null, 2));
  }
  const options = parse(args); if (options.help) return usage();
  if (command === 'codex') return codexMain(options);
  if (command === 'claude') return claudeMain(options);
  if (command === 'kimi') return kimiMain(options);
  if (command === 'grok') return grokMain(options);
  if (command === 'opencode') return opencodeMain(options);
  throw new Error(`Unknown command: ${command}`);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => { process.stderr.write(errorText(error) + '\n'); await shutdown(); process.exitCode = 1; });
}
