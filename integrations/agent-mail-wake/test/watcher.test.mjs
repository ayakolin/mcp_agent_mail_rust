import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailWatcher, readJson } from '../common.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-wake-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messages = new Map(), events = [];
  const client = {
    endpoint: 'http://127.0.0.1:8765/mcp/',
    async call(name, args) {
      if (name === 'ensure_project') return {};
      if (name === 'register_agent') return { name: 'BlueLake' };
      if (name === 'fetch_inbox_events') {
        const selected = events.filter(x => x.cursor > args.after).slice(0, args.limit);
        return { events: selected, next_cursor: selected.at(-1)?.cursor || args.after, has_more: false };
      }
      throw new Error(name);
    },
    async message(id) { return messages.get(id); },
  };
  function add(id, cursor, body = 'hello') {
    messages.set(id, { id, from: 'RedHill', body_md: body, subject: 'task' });
    events.push({ message_id: id, cursor, from: 'RedHill' });
  }
  const options = { host: 'test', session: 'one', project: dir, stateRoot: path.join(dir, 'state'), client };
  return { dir, client, add, options };
}

test('busy recipient preserves delivery cursor; grouped mail is delivered once', async t => {
  const f = fixture(t); let idle = false, deliveries = [];
  const watcher = new MailWatcher({ ...f.options, canDeliver: async () => idle, deliver: async (text, batch) => deliveries.push(batch) });
  await watcher.init({ start: false }); t.after(() => watcher.stop());
  f.add(91, 10); f.add(103, 30);
  await watcher.tick(); assert.equal(watcher.state.cursor, 0); assert.equal(deliveries.length, 0);
  idle = true; await watcher.tick();
  assert.equal(watcher.state.cursor, 30); assert.equal(deliveries[0].messages.length, 2);
  await watcher.tick(); assert.equal(deliveries.length, 1);
});

test('failed submission is retried with the same durable batch ID after restart', async t => {
  const f = fixture(t); f.add(800, 7);
  const watcher = new MailWatcher({ ...f.options, deliver: async () => { throw new Error('offline'); } });
  await watcher.init({ start: false }); await watcher.tick();
  const pending = readJson(watcher.file).pending;
  assert.equal(watcher.state.cursor, 0); assert.equal(watcher.state.error, 'offline');
  await watcher.stop();
  let received;
  const resumed = new MailWatcher({ ...f.options, deliver: async (_, batch) => { received = batch; } });
  await resumed.init({ start: false }); t.after(() => resumed.stop()); await resumed.tick();
  assert.equal(received.id, pending.id); assert.equal(resumed.state.cursor, 7);
  assert.equal(resumed.state.pending, undefined);
});

test('only one listener may own a mailbox and stop releases its lock', async t => {
  const f = fixture(t);
  const a = new MailWatcher({ ...f.options, deliver: async () => {} }); await a.init({ start: false });
  const b = new MailWatcher({ ...f.options, deliver: async () => {} });
  await assert.rejects(b.init({ start: false }), /already running/);
  await a.stop(); await b.init({ start: false }); await b.stop();
});

test('auto conversation limit retains pending mail until explicit resume', async t => {
  const f = fixture(t); let count = 0;
  const watcher = new MailWatcher({ ...f.options, limit: 1, deliver: async () => count++ });
  await watcher.init({ start: false }); t.after(() => watcher.stop());
  f.add(1, 8); await watcher.tick(); f.add(2, 29); await watcher.tick();
  assert.equal(watcher.state.paused, true); assert.equal(watcher.state.cursor, 8);
  watcher.control(false); await watcher.tick(); assert.equal(count, 2); assert.equal(watcher.state.cursor, 29);
});

test('a cursor gap pauses instead of dropping unread history', async t => {
  const f = fixture(t), original = f.client.call;
  f.client.call = async (name, args) => {
    if (name === 'fetch_inbox_events') throw new Error('CURSOR_EXPIRED');
    return original(name, args);
  };
  const watcher = new MailWatcher({ ...f.options, deliver: async () => assert.fail('must not deliver') });
  await watcher.init({ start: false }); t.after(() => watcher.stop()); await watcher.tick();
  assert.equal(watcher.state.paused, true); assert.equal(watcher.state.cursor, 0);
});
