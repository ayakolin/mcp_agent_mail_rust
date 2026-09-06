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

test('Kimi submits with a stable prompt ID and steers the queue into the active turn', async () => {
  const adapter = new KimiAdapter('http://127.0.0.1:12345', () => 'unused', 'session');
  let status = { main_turn_active: true, pending_interaction: 'approval' }, calls = [];
  adapter.request = async (route, body) => {
    calls.push({ route, body });
    if (route.endsWith(':steer')) return { steered: true, prompt_ids: body.prompt_ids };
    if (body) return {};
    return status;
  };
  // Turn state no longer gates delivery: a queued prompt is steered into the turn.
  assert.equal(await adapter.canDeliver(), true);
  const result = await adapter.deliver('text', { id: 'fixed' });
  assert.deepEqual(result, { steered: true, prompt_ids: ['mail_fixed'] });
  const submit = calls.find(call => call.route.endsWith('/prompts'));
  const steer = calls.find(call => call.route.endsWith('/prompts:steer'));
  assert.equal(submit.body.prompt_id, 'mail_fixed');
  assert.equal(submit.body.permission_mode, undefined);
  assert.deepEqual(steer.body.prompt_ids, ['mail_fixed']);
});

test('Kimi replay of a completed prompt skips the steer; in-flight prompt is steered', async () => {
  const adapter = new KimiAdapter('http://127.0.0.1:12345', () => 'unused', 'session');
  let calls = [];
  adapter.request = async (route, body) => {
    calls.push(route);
    if (body && body.prompt_id === 'mail_done') { const error = new Error('completed'); error.code = 40903; throw error; }
    if (body && body.prompt_id === 'mail_flying') { const error = new Error('in flight'); error.code = 40927; throw error; }
    if (body) return { steered: true, prompt_ids: body.prompt_ids };
    return {};
  };
  assert.deepEqual(await adapter.deliver('text', { id: 'done' }), { alreadyAccepted: true });
  assert.equal(calls.filter(route => route.endsWith(':steer')).length, 0);
  assert.deepEqual(await adapter.deliver('text', { id: 'flying' }), { steered: true, prompt_ids: ['mail_flying'] });
});

test('Kimi treats a vanished queue entry as already running', async () => {
  const adapter = new KimiAdapter('http://127.0.0.1:12345', () => 'unused', 'session');
  adapter.request = async (route, body) => {
    if (body?.prompt_ids) { const error = new Error('not queued'); error.code = 40402; throw error; }
    if (body) return {};
    return {};
  };
  assert.deepEqual(await adapter.deliver('text', { id: 'gone' }), { steered: false, alreadyRunning: true });
});

test('OpenCode delivers via the v2 steer endpoint and reconciles by marker', async () => {
  const { OpenCodeAdapter } = await import('../rpc.mjs');
  const adapter = new OpenCodeAdapter('http://127.0.0.1:12345');
  let history = [], calls = [];
  adapter.request = async (route, body) => {
    calls.push({ route, body });
    if (body) return { data: { id: 'msg_steer1', admittedSeq: 3 } };
    return { data: history };
  };
  const result = await adapter.deliver('ses_1', 'text', { id: 'b1' });
  assert.deepEqual(result, { admitted: true, messageId: 'msg_steer1' });
  const prompt = calls.find(call => call.route === '/api/session/ses_1/prompt');
  assert.equal(prompt.body.delivery, 'steer');
  assert.equal(prompt.body.prompt.text, 'text');
  assert.ok(calls.every(call => !call.route.includes('/session/ses_1/message') || call.route.startsWith('/api/')));
  // Marker already in history -> no second submission.
  history = [{ content: [{ type: 'text', text: '[Agent Mail delivery b1]' }] }];
  assert.deepEqual(await adapter.deliver('ses_1', 'text', { id: 'b1' }), { alreadyAccepted: true });
  assert.equal(calls.filter(call => call.body).length, 1);
});
