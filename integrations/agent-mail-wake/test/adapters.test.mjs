import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, CodexQueueAdapter, sessionHistoryHas, KimiAdapter } from '../rpc.mjs';
import { isCodexTurnBusy, codexRolloutTurnState, CODEX_STEER_WINDOW_MS, CODEX_ROLLOUT_STALE_MS } from '../common.mjs';
import { grokLaunchMode, grokTuiArgs } from '../cli.mjs';

test('Grok TUI launcher uses the native UI and forwards session, model, and Grok flags', () => {
  assert.equal(grokLaunchMode({}), 'tui');
  assert.equal(grokLaunchMode({ headless: true }), 'headless');
  assert.throws(() => grokLaunchMode({ tui: true, headless: true }), /Choose either/);
  assert.deepEqual(grokTuiArgs({ extra: [] }), ['--fullscreen']);
  assert.deepEqual(
    grokTuiArgs({ session: 'session-1', model: 'grok-4', extra: ['--no-alt-screen', '--no-plan'] }),
    ['--fullscreen', '--resume', 'session-1', '--model', 'grok-4', '--no-alt-screen', '--no-plan'],
  );
});

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

test('Codex queue adapter queues once and reconciles by marker or ledger', async () => {
  const calls = [];
  const runner = async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: 'Queued message x', stderr: '' }; };
  const seen = new Set();
  const persisted = [];
  const adapter = new CodexQueueAdapter('thread-1', '/tmp', {
    runner, seen, persist: () => persisted.push([...seen]), history: () => false,
  });
  assert.deepEqual(await adapter.deliver('[Agent Mail delivery b1]\nhello', { id: 'b1' }), { queued: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['queue', '--thread', 'thread-1', '--message', '[Agent Mail delivery b1]\nhello']);
  assert.deepEqual(await adapter.deliver('[Agent Mail delivery b1]\nhello', { id: 'b1' }), { alreadyAccepted: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(persisted, [['b1']]);
});

test('Codex queue adapter treats history hits as already accepted', async () => {
  let queued = 0;
  const adapter = new CodexQueueAdapter('thread-1', '/tmp', {
    runner: async () => { queued++; return { code: 0, stdout: '', stderr: '' }; },
    history: (_id, marker) => marker.includes('b2'),
  });
  assert.deepEqual(await adapter.deliver('[Agent Mail delivery b2]\nhello', { id: 'b2' }), { alreadyAccepted: true });
  assert.equal(queued, 0);
});

test('isCodexTurnBusy reports busy only while turn is active and lastToolAt is recent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ turnActive: true, lastToolAt: new Date(now - 1000).toISOString() }));
  assert.equal(isCodexTurnBusy(file, now), true);
  fs.writeFileSync(file, JSON.stringify({ turnActive: true, lastToolAt: new Date(now - CODEX_STEER_WINDOW_MS - 1000).toISOString() }));
  assert.equal(isCodexTurnBusy(file, now), false);
  fs.writeFileSync(file, JSON.stringify({ turnActive: false, lastToolAt: new Date(now).toISOString() }));
  assert.equal(isCodexTurnBusy(file, now), false);
  fs.writeFileSync(file, JSON.stringify({ lastToolAt: new Date(now).toISOString() }));
  assert.equal(isCodexTurnBusy(file, now), false);
  assert.equal(isCodexTurnBusy(null, now), false);
});

// A plain `codex` turn routinely goes >12 s between tool calls (model thinking,
// subagent waits, long builds). Judging "busy" from tool recency alone made the
// idle queue listener hand mid-turn mail to `codex queue`, which Codex holds
// until the turn ends (observed: queued 07:53:48Z, delivered 08:23:21Z).
// The rollout's own turn markers are the authority.
const SESSION = '01a1395e-c866-7070-bdfb-ff28eeb23fdd';
function rolloutFixture(t, events, { mtimeMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dayDir = path.join(root, '2026', '10', '14');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-2026-10-14T15-44-35-${SESSION}.jsonl`);
  const lines = events.map(e => JSON.stringify(typeof e === 'string' ? { type: 'event_msg', payload: { type: e } } : e));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return { root, file };
}
function stateFile(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ session: SESSION, ...extra }));
  return file;
}

test('codexRolloutTurnState reads the last turn marker from the session rollout', t => {
  const now = Date.now();
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: rolloutFixture(t, ['task_started']).root, now }), 'active');
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: rolloutFixture(t, ['task_started', 'task_complete']).root, now }), 'idle');
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: rolloutFixture(t, ['task_started', 'turn_aborted']).root, now }), 'idle');
  // A queued/steered follow-up opens a new turn after the previous one completed.
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: rolloutFixture(t, ['task_started', 'task_complete', 'task_started']).root, now }), 'active');
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: rolloutFixture(t, ['token_count']).root, now }), null);
  assert.equal(codexRolloutTurnState('no-such-session', { sessionsRoot: rolloutFixture(t, ['task_started']).root, now }), null);
  assert.equal(codexRolloutTurnState('', { sessionsRoot: rolloutFixture(t, ['task_started']).root, now }), null);
});

test('codexRolloutTurnState finds the marker behind a huge trailing event and ignores marker text inside tool output', t => {
  const now = Date.now();
  const huge = { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(300_000) } };
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: rolloutFixture(t, ['task_started', huge]).root, now }), 'active');
  const quoted = { type: 'response_item', payload: { type: 'custom_tool_call_output',
    output: '{"type":"event_msg","payload":{"type":"task_started"}}' } };
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: rolloutFixture(t, ['task_started', 'task_complete', quoted]).root, now }), 'idle');
});

test('codexRolloutTurnState distrusts an open turn whose rollout went silent (crashed session)', t => {
  const now = Date.now();
  const { root } = rolloutFixture(t, ['task_started'], { mtimeMs: now - CODEX_ROLLOUT_STALE_MS - 1000 });
  assert.equal(codexRolloutTurnState(SESSION, { sessionsRoot: root, now }), 'idle');
});

test('isCodexTurnBusy stays busy across a >12 s tool gap while the rollout turn is open', t => {
  const now = Date.now();
  const { root } = rolloutFixture(t, ['task_started']);
  const file = stateFile(t, { turnActive: true, lastToolAt: new Date(now - CODEX_STEER_WINDOW_MS - 3000).toISOString() });
  assert.equal(isCodexTurnBusy(file, now, { sessionsRoot: root }), true);
  // Turn opened but no tool has run yet: hook state is empty, rollout still says active.
  assert.equal(isCodexTurnBusy(stateFile(t), now, { sessionsRoot: root }), true);
});

test('isCodexTurnBusy lets the queue deliver once the rollout turn is closed, whatever the hook stamps say', t => {
  const now = Date.now();
  const fresh = { turnActive: true, lastToolAt: new Date(now - 1000).toISOString() };
  assert.equal(isCodexTurnBusy(stateFile(t, fresh), now, { sessionsRoot: rolloutFixture(t, ['task_started', 'task_complete']).root }), false);
  assert.equal(isCodexTurnBusy(stateFile(t, fresh), now, { sessionsRoot: rolloutFixture(t, ['task_started', 'turn_aborted']).root }), false);
});

test('isCodexTurnBusy falls back to the tool-recency heuristic when no rollout is readable', t => {
  const now = Date.now();
  const { root } = rolloutFixture(t, ['task_started']);
  const recent = stateFile(t, { session: 'unknown-session', turnActive: true, lastToolAt: new Date(now - 1000).toISOString() });
  const gap = stateFile(t, { session: 'unknown-session', turnActive: true, lastToolAt: new Date(now - CODEX_STEER_WINDOW_MS - 1000).toISOString() });
  assert.equal(isCodexTurnBusy(recent, now, { sessionsRoot: root }), true);
  assert.equal(isCodexTurnBusy(gap, now, { sessionsRoot: root }), false);
});

test('sessionHistoryHas scans rollout files for the delivery marker', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, '2026', '09', '12');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'rollout-01abc.jsonl'), 'noise\n[Agent Mail delivery batch-9]\n');
  assert.equal(sessionHistoryHas('01abc', '[Agent Mail delivery batch-9]', dir), true);
  assert.equal(sessionHistoryHas('01abc', '[Agent Mail delivery missing]', dir), false);
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
