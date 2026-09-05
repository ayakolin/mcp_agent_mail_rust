import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, KimiAdapter } from '../rpc.mjs';

test('Codex refuses active turns and reconciles an already submitted batch', async () => {
  let thread = { status: { type: 'active' }, turns: [] }, calls = [];
  const rpc = { async request(method, params) { calls.push(method); return method === 'thread/read' ? { thread } : { turn: { id: 'x' } }; } };
  const adapter = new CodexAdapter(rpc, 'thread');
  assert.equal(await adapter.canDeliver(), false);
  await assert.rejects(adapter.deliver('text', { id: 'batch' }), /busy/);
  thread = { status: { type: 'idle' }, turns: [{ items: [{ text: '[Agent Mail delivery batch]' }] }] };
  await adapter.deliver('text', { id: 'batch' });
  assert.equal(calls.filter(x => x === 'turn/start').length, 0);
  thread.turns = []; await adapter.deliver('text', { id: 'new' });
  assert.equal(calls.filter(x => x === 'turn/start').length, 1);
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
