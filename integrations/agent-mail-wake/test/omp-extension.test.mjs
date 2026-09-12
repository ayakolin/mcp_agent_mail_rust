import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// The extension reads env-derived constants at module load, so point state and
// the MCP endpoint at throwaway locations BEFORE importing it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-wake-test-'));
process.env.AGENT_MAIL_WAKE_STATE_DIR = path.join(dir, 'state');
process.env.AGENT_MAIL_WAKE_HOME = path.join(dir, 'home');
process.env.AGENT_MAIL_WAKE_INTERVAL_MS = '250';

function stubMailServer(messages) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      calls.push(rpc);
      const reply = result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (rpc.method === 'tools/call') {
        const name = rpc.params.name;
        if (name === 'ensure_project') return reply({ content: [{ type: 'text', text: '{}' }] });
        if (name === 'register_agent') return reply({ content: [{ type: 'text', text: JSON.stringify({ name: 'OchrePond' }) }] });
        if (name === 'fetch_inbox_events') {
          const events = messages.map(m => ({ message_id: m.id, cursor: m.cursor, from: 'RedHill' }));
          return reply({ content: [{ type: 'text', text: JSON.stringify({ events, next_cursor: messages.at(-1)?.cursor || 0, has_more: false }) }] });
        }
      }
      if (rpc.method === 'resources/read') {
        const id = Number(rpc.params.uri.match(/message\/(\d+)/)[1]);
        const message = messages.find(m => m.id === id);
        return reply({ contents: [{ text: JSON.stringify({ id, from: 'RedHill', subject: 'task', body_md: message.body }) }] });
      }
      res.writeHead(400).end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

test('OMP extension delivers mail mid-run via deliverAs aside without an idle gate', async t => {
  const stub = await stubMailServer([{ id: 91, cursor: 10, body: 'mid-run mail body' }]);
  t.after(() => stub.server.close());
  process.env.AGENT_MAIL_URL = `http://127.0.0.1:${stub.port}/mcp/`;

  const sent = [], handlers = new Map();
  const pi = {
    on: (event, fn) => handlers.set(event, fn),
    registerCommand: () => {},
    sendMessage: (message, options) => sent.push({ message, options }),
  };
  // Deliberately NO isIdle/hasPendingMessages on the context: the delivery gate
  // must not consult them anymore (aside injects at the next step boundary).
  const ctx = {
    hasUI: true,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: { getSessionId: () => 'omp-session-1', getEntries: () => [] },
    cwd: dir,
    model: { id: 'test-model' },
  };
  const { default: agentMailWake } = await import('../omp.mjs');
  agentMailWake(pi);
  await handlers.get('session_start')(undefined, ctx);

  const deadline = Date.now() + 10000;
  while (!sent.some(s => s.options.deliverAs === 'aside') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Same-session restart must keep the live listener, not mint a second mailbox.
  await handlers.get('session_start')(undefined, ctx);
  assert.equal(sent.filter(s => s.message.customType === 'agent-mail-identity').length, 1);
  await handlers.get('session_shutdown')();

  const identity = sent.find(s => s.message.customType === 'agent-mail-identity');
  const mail = sent.find(s => s.message.customType === 'agent-mail-incoming');
  assert.ok(identity, 'identity instructions are stored for the session');
  assert.equal(identity.options.deliverAs, 'nextTurn');
  assert.ok(mail, 'mail batch delivered');
  assert.equal(mail.options.deliverAs, 'aside');
  assert.ok(mail.message.content.includes('mid-run mail body'));
  assert.ok(mail.message.details.batchId);
});

test('OMP extension resets wakeups and unpauses on real user message_start', async t => {
  const stub = await stubMailServer([]);
  t.after(() => stub.server.close());
  process.env.AGENT_MAIL_URL = `http://127.0.0.1:${stub.port}/mcp/`;

  const sent = [], handlers = new Map(), statuses = [];
  let registeredCmd, statusText = '';
  const pi = {
    on: (event, fn) => handlers.set(event, fn),
    registerCommand: (name, cmd) => { if (name === 'mail-wake') registeredCmd = cmd; },
    sendMessage: (message, options) => sent.push({ message, options }),
  };
  const ctx = {
    hasUI: true,
    ui: { notify: txt => { statusText = txt; }, setStatus: (_, s) => statuses.push(s) },
    sessionManager: { getSessionId: () => 'omp-session-user-input', getEntries: () => [] },
    cwd: dir,
    model: { id: 'test-model' },
  };
  const { default: agentMailWake } = await import('../omp.mjs');
  agentMailWake(pi);
  await handlers.get('session_start')(undefined, ctx);

  await registeredCmd.handler('status', ctx);
  const state = JSON.parse(statusText);
  assert.equal(state.paused, false);

  // Simulate 8 wakeups and pause
  const file = path.join(process.env.AGENT_MAIL_WAKE_STATE_DIR, `${state.id}.json`);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  current.wakeups = 8;
  current.paused = true;
  current.error = 'Paused after 8 automatic deliveries; resume to continue';
  fs.writeFileSync(file, JSON.stringify(current, null, 2));

  // Synthetic or agent message must NOT unpause
  await handlers.get('message_start')({ message: { role: 'user', synthetic: true } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).paused, true);
  await handlers.get('message_start')({ message: { role: 'user', attribution: 'agent' } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).paused, true);

  // Real interactive user message MUST unpause and reset wakeups
  await handlers.get('message_start')({ message: { role: 'user', content: 'hello' } });
  const unpaused = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(unpaused.paused, false);
  assert.equal(unpaused.wakeups, 0);
  assert.equal(unpaused.error, undefined);

  await handlers.get('session_shutdown')();
});
