import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { handleHook, shouldAttach, parseHookEvent, sessionId, isFreshListener, stopQueueListeners } from '../codex-hook.mjs';
import { findCodexBinary } from '../common.mjs';

test('SessionStart startup and resume attach; compact and opt-out do not', async () => {
  assert.equal(shouldAttach({ session_id: 's1', source: 'startup' }), true);
  assert.equal(shouldAttach({ session_id: 's1', source: 'resume' }), true);
  assert.equal(shouldAttach({ session_id: 's1', source: 'clear' }), true);
  assert.equal(shouldAttach({ session_id: 's1', source: 'compact' }), false);
  assert.equal(shouldAttach({ session_id: 's1', hook_event_name: 'SessionEnd' }), false);
  assert.equal(shouldAttach({ session_id: 's1' }, { AGENT_MAIL_WAKE_ENABLED: '0' }), false);
  assert.equal(shouldAttach({}), false);
});
test('sessionId resolves session_id, thread_id, or id', () => {
  assert.equal(sessionId({ session_id: 's1' }), 's1');
  assert.equal(sessionId({ thread_id: 't1' }), 't1');
  assert.equal(sessionId({ id: 'i1' }), 'i1');
  assert.equal(sessionId({}), '');
  assert.equal(shouldAttach({ thread_id: 't1', source: 'resume' }), true);
});

test('findCodexBinary finds real binary and respects CODEX_PATH', () => {
  const binary = findCodexBinary();
  assert.ok(typeof binary === 'string' && binary.length > 0);
  const custom = findCodexBinary({ ...process.env, CODEX_PATH: '/bin/sh' });
  // When CODEX_PATH points to an existing file
  const original = process.env.CODEX_PATH;
  try {
    process.env.CODEX_PATH = '/bin/sh';
    assert.equal(findCodexBinary(), '/bin/sh');
  } finally {
    if (original === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = original;
  }
});

test('SessionStart hook detaches a queue listener process', async t => {
  const spawned = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await handleHook(JSON.stringify({
    session_id: '01abc', cwd: '/tmp/project', source: 'startup', hook_event_name: 'SessionStart',
  }), { AGENT_MAIL_WAKE_HOME: home }, (command, args, options) => {
    spawned.push({ command, args, options });
    return { pid: 4242, unref() {} };
  });
  assert.equal(result.spawned, true);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('attach'));
  assert.ok(spawned[0].args.includes('01abc'));
  assert.match(result.stdout, /Agent Mail auto-wake is enabled/);
});

test('SessionEnd and compact emit empty JSON and do not spawn', async () => {
  for (const event of [
    { session_id: 's1', hook_event_name: 'SessionEnd' },
    { session_id: 's1', source: 'compact' },
  ]) {
    const result = await handleHook(JSON.stringify(event), {}, () => { throw new Error('must not spawn'); });
    assert.equal(result.spawned, false);
    assert.equal(result.stdout, '{}\n');
  }
});

test('parseHookEvent tolerates empty and invalid stdin', () => {
  assert.deepEqual(parseHookEvent(''), {});
  assert.deepEqual(parseHookEvent('not-json'), {});
  assert.equal(parseHookEvent('{"session_id":"x"}').session_id, 'x');
});

test('cli.mjs codex forwards native subcommands and parses native flags into extra', async () => {
  const { spawnSync } = await import('node:child_process');
  const cliPath = new URL('../cli.mjs', import.meta.url).pathname;
  // Running codex queue --help through cli.mjs forwards to native codex instead of throwing
  const queueHelp = spawnSync(process.execPath, [cliPath, 'codex', 'queue', '--help'], { encoding: 'utf8' });
  assert.equal(queueHelp.status, 0, queueHelp.stderr);
  assert.match(queueHelp.stdout, /queue/i);
  // Running codex resume --help forwards to native codex instead of throwing
  const resumeHelp = spawnSync(process.execPath, [cliPath, 'codex', 'resume', '--help'], { encoding: 'utf8' });
  assert.equal(resumeHelp.status, 0, resumeHelp.stderr);
  assert.match(resumeHelp.stdout, /resume/i);
});

test('SessionStart clear attaches a queue listener', async t => {
  const spawned = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-clear-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await handleHook(JSON.stringify({
    session_id: '01clear', cwd: '/tmp/project', source: 'clear', hook_event_name: 'SessionStart',
  }), { AGENT_MAIL_WAKE_HOME: home }, (command, args) => {
    spawned.push({ command, args });
    return { pid: 4343, unref() {} };
  });
  assert.equal(result.spawned, true);
  assert.ok(spawned[0].args.includes('01clear'));
});

test('isFreshListener accepts a recent updatedAt', () => {
  const now = Date.now();
  assert.equal(isFreshListener({ updatedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isFreshListener({ updatedAt: new Date(now - 60_000).toISOString() }, now), false);
  assert.equal(isFreshListener({}, now), false);
});

test('stopQueueListeners skips a fresh listener and stops a stale one', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-stop-'));
  const stateRoot = path.join(home, 'state');
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const writeListener = (id, updatedAt) => {
    fs.mkdirSync(path.join(home, 'bindings'), { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, `${id}.json`), JSON.stringify({
      id, host: 'codex', session: 's-restart', pid: child.pid, updatedAt,
    }));
    fs.writeFileSync(path.join(home, 'bindings', `${id}.json`), JSON.stringify({ delivery: 'queue' }));
  };
  writeListener('listener-fresh', new Date().toISOString());
  assert.deepEqual(stopQueueListeners('s-restart', Date.now(), { dataRoot: home, stateRoot }), []);
  try { process.kill(child.pid, 0); } catch { assert.fail('fresh listener must stay alive'); }
  writeListener('listener-stale', new Date(Date.now() - 60_000).toISOString());
  fs.rmSync(path.join(stateRoot, 'listener-fresh.json'));
  assert.deepEqual(stopQueueListeners('s-restart', Date.now(), { dataRoot: home, stateRoot }), [child.pid]);
});
