import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleHook, shouldAttach, parseHookEvent, sessionId } from '../codex-hook.mjs';
import { findCodexBinary } from '../common.mjs';

test('SessionStart startup and resume attach; compact and opt-out do not', async () => {
  assert.equal(shouldAttach({ session_id: 's1', source: 'startup' }), true);
  assert.equal(shouldAttach({ session_id: 's1', source: 'resume' }), true);
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
  const cliPath = path.resolve('integrations/agent-mail-wake/cli.mjs');
  // Running codex queue --help through cli.mjs forwards to native codex instead of throwing
  const queueHelp = spawnSync(process.execPath, [cliPath, 'codex', 'queue', '--help'], { encoding: 'utf8' });
  assert.equal(queueHelp.status, 0, queueHelp.stderr);
  assert.match(queueHelp.stdout, /queue/i);
  // Running codex resume --help forwards to native codex instead of throwing
  const resumeHelp = spawnSync(process.execPath, [cliPath, 'codex', 'resume', '--help'], { encoding: 'utf8' });
  assert.equal(resumeHelp.status, 0, resumeHelp.stderr);
  assert.match(resumeHelp.stdout, /resume/i);
});
