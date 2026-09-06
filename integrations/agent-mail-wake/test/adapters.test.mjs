import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, KimiAdapter } from '../rpc.mjs';

test('Codex steers mail into an active turn instead of waiting for idle', async () => {
  const turn = { id: 'turn-1', status: 'inProgress', items: [] };
  let thread = { status: { type: 'active', activeFlags: [] }, turns: [turn] }, calls = [];
  const rpc = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread };
      if (method === 'turn/steer') return { turnId: params.expectedTurnId };
      return { turn: { id: 'turn-2' } };
    },
  };
  const adapter = new CodexAdapter(rpc, 'thread');
  assert.equal(await adapter.canDeliver(), true);
  await adapter.deliver('text', { id: 'batch-7' });
  const steer = calls.find(call => call.method === 'turn/steer');
  assert.equal(steer.params.expectedTurnId, 'turn-1');
  assert.equal(steer.params.clientUserMessageId, 'batch-7');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 0);
});

test('Codex starts a new turn when idle and reconciles an already submitted batch', async () => {
  let thread = { status: { type: 'idle' }, turns: [{ items: [{ text: '[Agent Mail delivery batch]' }] }] }, calls = [];
  const rpc = { async request(method) { calls.push(method); return method === 'thread/read' ? { thread } : { turn: { id: 'x' } }; } };
  const adapter = new CodexAdapter(rpc, 'thread');
  await adapter.deliver('text', { id: 'batch' });
  assert.equal(calls.filter(x => x === 'turn/start').length, 0);
  thread.turns = []; await adapter.deliver('text', { id: 'new' });
  assert.equal(calls.filter(x => x === 'turn/start').length, 1);
});

test('Codex falls back to turn/start when the active turn completes mid-delivery', async () => {
  const turn = { id: 'turn-1', status: 'inProgress', items: [] };
  const states = [
    { status: { type: 'active', activeFlags: [] }, turns: [turn] },
    { status: { type: 'idle' }, turns: [{ ...turn, status: 'completed' }] },
  ];
  let reads = 0, calls = [];
  const rpc = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: states[Math.min(reads++, states.length - 1)] };
      if (method === 'turn/steer') throw new Error('no active turn to steer');
      return { turn: { id: 'turn-2' } };
    },
  };
  const adapter = new CodexAdapter(rpc, 'thread');
  await adapter.deliver('text', { id: 'batch-9' });
  assert.equal(calls.filter(call => call.method === 'turn/steer').length, 1);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
});

test('Codex keeps the batch pending when the active turn stays unsteerable', async () => {
  const turn = { id: 'turn-1', status: 'inProgress', items: [] };
  const thread = { status: { type: 'active', activeFlags: [] }, turns: [turn] };
  const rpc = {
    async request(method) {
      if (method === 'thread/read') return { thread };
      throw new Error('active turn is not steerable: review');
    },
  };
  const adapter = new CodexAdapter(rpc, 'thread');
  await assert.rejects(adapter.deliver('text', { id: 'batch' }), /kept changing|not steerable/);
});

test('Codex refuses delivery while the thread is in an error state', async () => {
  const thread = { status: { type: 'systemError' }, turns: [] };
  const rpc = { async request() { return { thread }; } };
  const adapter = new CodexAdapter(rpc, 'thread');
  assert.equal(await adapter.canDeliver(), false);
  await assert.rejects(adapter.deliver('text', { id: 'batch' }), /systemError/);
});

test('Kimi retries use a stable prompt ID and respect outstanding approvals', async () => {
  const adapter = new KimiAdapter('http://127.0.0.1:12345', () => 'unused', 'session');
  let status = { main_turn_active: false, pending_interaction: 'approval' }, submitted;
  adapter.request = async (route, body) => {
    if (body) { submitted = body; const error = new Error('already received'); error.code = 40927; throw error; }
    return status;
  };
  assert.equal(await adapter.canDeliver(), false);
  status.pending_interaction = 'none'; assert.equal(await adapter.canDeliver(), true);
  assert.deepEqual(await adapter.deliver('text', { id: 'fixed' }), { alreadyAccepted: true });
  assert.equal(submitted.prompt_id, 'mail_fixed');
  assert.equal(submitted.permission_mode, undefined);
});
