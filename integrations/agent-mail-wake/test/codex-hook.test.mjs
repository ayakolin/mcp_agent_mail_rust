import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { handleHook, shouldAttach, parseHookEvent, sessionId, isFreshListener, stopQueueListeners } from '../codex-hook.mjs';
import { handleClaudeHook, extractRegisteredAgentName } from '../claude-channel.mjs';
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
    session_id: '01abc', cwd: home, source: 'startup', hook_event_name: 'SessionStart',
  }), { AGENT_MAIL_WAKE_HOME: home }, (command, args, options) => {
    spawned.push({ command, args, options });
    return { pid: 4242, unref() {} };
  }, { client: { endpoint: 'http://127.0.0.1:8765/mcp/', call: async (name) => name === 'register_agent' ? { name: 'HookCodex' } : {} } });
  assert.equal(result.spawned, true);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('attach'));
  assert.ok(spawned[0].args.includes('01abc'));
  assert.match(result.stdout, /Agent Mail auto-wake is enabled/);
  assert.match(result.stdout, /HookCodex/);
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
    session_id: '01clear', cwd: home, source: 'clear', hook_event_name: 'SessionStart',
  }), { AGENT_MAIL_WAKE_HOME: home }, (command, args) => {
    spawned.push({ command, args });
    return { pid: 4343, unref() {} };
  }, { client: { endpoint: 'http://127.0.0.1:8765/mcp/', call: async () => ({ name: 'ClearCodex' }) } });
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

test('PostToolUse hook stamps active turn and injects steer additionalContext', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-steer-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-1.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-1', host: 'codex', session: 's-steer', project: '/tmp/proj', agent: 'AgentA', cursor: 10,
  }));
  const events = [{ cursor: 15, message_id: 101, from: 'PeerB' }];
  const messages = new Map([[101, { id: 101, from: 'PeerB', subject: 'urgent steer', body_md: 'please stop task' }]]);
  const stubClient = {
    call: async (name, args) => {
      if (name === 'fetch_inbox_events') return { events, next_cursor: 15 };
      throw new Error(`unexpected call ${name}`);
    },
    message: async (id) => messages.get(id),
  };
  const event = {
    hook_event_name: 'PostToolUse',
    session_id: 's-steer',
    tool_name: 'Bash',
    cwd: '/tmp/proj',
  };
  const result = await handleHook(JSON.stringify(event), { AGENT_MAIL_WAKE_HOME: home }, () => {
    throw new Error('must not spawn listener');
  }, { client: stubClient });
  assert.equal(result.spawned, false);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.match(parsed.hookSpecificOutput?.additionalContext, /urgent steer/);
  assert.match(parsed.hookSpecificOutput?.additionalContext, /please stop task/);
  const updatedState = JSON.parse(fs.readFileSync(listenerFile, 'utf8'));
  assert.equal(updatedState.cursor, 15);
  assert.equal(updatedState.turnActive, true);
  assert.ok(updatedState.lastToolAt);
});

test('PostToolUse hook with no pending mail returns empty JSON and keeps turn active', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-empty-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-2.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-2', host: 'codex', session: 's-empty', project: '/tmp/proj', agent: 'AgentA', cursor: 20,
  }));
  const stubClient = {
    call: async () => ({ events: [], next_cursor: 20 }),
    message: async () => null,
  };
  const result = await handleHook(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's-empty', tool_name: 'ReadFile',
  }), { AGENT_MAIL_WAKE_HOME: home }, () => {
    throw new Error('must not spawn');
  }, { client: stubClient });
  assert.equal(result.spawned, false);
  assert.equal(result.stdout, '{}\n');
  const updated = JSON.parse(fs.readFileSync(listenerFile, 'utf8'));
  assert.equal(updated.cursor, 20);
  assert.equal(updated.turnActive, true);
  assert.ok(updated.lastToolAt);
});

test('Stop hook with pending mail blocks turn and injects steer reason, clearing turnActive', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-stop-steer-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-3.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-3', host: 'codex', session: 's-stop', project: '/tmp/proj', agent: 'AgentA', cursor: 5, turnActive: true,
  }));
  const events = [{ cursor: 8, message_id: 102, from: 'PeerC' }];
  const messages = new Map([[102, { id: 102, from: 'PeerC', subject: 'late mail', body_md: 'continue working' }]]);
  const stubClient = {
    call: async (name) => {
      if (name === 'fetch_inbox_events') return { events, next_cursor: 8 };
      throw new Error(name);
    },
    message: async (id) => messages.get(id),
  };
  const result = await handleHook(JSON.stringify({
    hook_event_name: 'Stop', session_id: 's-stop', cwd: '/tmp/proj',
  }), { AGENT_MAIL_WAKE_HOME: home }, () => {
    throw new Error('must not spawn');
  }, { client: stubClient });
  assert.equal(result.spawned, false);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /late mail/);
  assert.match(parsed.reason, /continue working/);
  const updated = JSON.parse(fs.readFileSync(listenerFile, 'utf8'));
  assert.equal(updated.cursor, 8);
  assert.equal(updated.turnActive, undefined);
});

test('Stop hook with no mail clears turnActive and returns empty JSON', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-stop-empty-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-4.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-4', host: 'codex', session: 's-stop-empty', project: '/tmp/proj', agent: 'AgentA', cursor: 12, turnActive: true,
  }));
  const stubClient = {
    call: async () => ({ events: [], next_cursor: 12 }),
    message: async () => null,
  };
  const result = await handleHook(JSON.stringify({
    hook_event_name: 'Stop', session_id: 's-stop-empty', cwd: '/tmp/proj',
  }), { AGENT_MAIL_WAKE_HOME: home }, () => {
    throw new Error('must not spawn');
  }, { client: stubClient });
  assert.equal(result.spawned, false);
  assert.equal(result.stdout, '{}\n');
  const updated = JSON.parse(fs.readFileSync(listenerFile, 'utf8'));
  assert.equal(updated.cursor, 12);
  assert.equal(updated.turnActive, undefined);
});

test('handleClaudeHook steers mail into PostToolUse and Stop', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-claude.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-claude', host: 'claude-code', session: 'claude-ses-1', project: '/tmp/proj', agent: 'AgentClaude', cursor: 100,
  }));
  const events = [{ cursor: 105, message_id: 201, from: 'PeerD' }];
  const messages = new Map([[201, { id: 201, from: 'PeerD', subject: 'claude steer', body_md: 'steer content' }]]);
  const stubClient = {
    call: async () => ({ events, next_cursor: 105 }),
    message: async (id) => messages.get(id),
  };
  // PostToolUse with mail
  const postResult = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'claude-ses-1', tool_name: 'Bash',
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: stubClient });
  const postParsed = JSON.parse(postResult.stdout);
  assert.equal(postParsed.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.match(postParsed.hookSpecificOutput?.additionalContext, /claude steer/);
  assert.match(postParsed.hookSpecificOutput?.additionalContext, /steer content/);
  assert.equal(JSON.parse(fs.readFileSync(listenerFile, 'utf8')).cursor, 105);

  // Stop with no mail resets turnActive
  const stopResult = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'Stop', session_id: 'claude-ses-1',
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: { call: async () => ({ events: [], next_cursor: 105 }) } });
  assert.equal(stopResult.stdout, '{}\n');
  assert.equal(JSON.parse(fs.readFileSync(listenerFile, 'utf8')).turnActive, undefined);

  const startResult = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'SessionStart', session_id: 'claude-ses-1', cwd: home,
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: stubClient });
  assert.match(JSON.parse(startResult.stdout).hookSpecificOutput?.additionalContext, /auto-wake is enabled for this Claude session/);
});

test('PostToolUse lazily registers a mailbox when no listener exists', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-lazy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const events = [{ cursor: 3, message_id: 301, from: 'PeerE' }];
  const messages = new Map([[301, { id: 301, from: 'PeerE', subject: 'lazy steer', body_md: 'default session mail' }]]);
  const stubClient = {
    endpoint: 'http://127.0.0.1:8765/mcp/',
    call: async (name, args) => {
      calls.push(name);
      if (name === 'ensure_project') return {};
      if (name === 'register_agent') return { name: 'LazyCodex' };
      if (name === 'fetch_inbox_events') return { events, next_cursor: 3 };
      throw new Error(name);
    },
    message: async (id) => messages.get(id),
  };
  const result = await handleHook(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's-lazy', tool_name: 'Bash', cwd: home,
  }), { AGENT_MAIL_WAKE_HOME: home }, () => {
    throw new Error('must not spawn listener');
  }, { client: stubClient });
  const parsed = JSON.parse(result.stdout);
  assert.ok(calls.includes('ensure_project'));
  assert.ok(calls.includes('register_agent'));
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.match(parsed.hookSpecificOutput?.additionalContext, /lazy steer/);
  assert.match(parsed.hookSpecificOutput?.additionalContext, /LazyCodex/);
});

test('handleClaudeHook SessionStart and PostToolUse create a mailbox on ordinary claude', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-lazy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const events = [{ cursor: 9, message_id: 401, from: 'PeerF' }];
  const messages = new Map([[401, { id: 401, from: 'PeerF', subject: 'plain claude', body_md: 'steer now' }]]);
  const stubClient = {
    endpoint: 'http://127.0.0.1:8765/mcp/',
    call: async (name) => {
      if (name === 'ensure_project') return {};
      if (name === 'register_agent') return { name: 'PlainClaude' };
      if (name === 'fetch_inbox_events') return { events, next_cursor: 9 };
      throw new Error(name);
    },
    message: async (id) => messages.get(id),
  };
  const start = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'SessionStart', session_id: 'claude-plain-1', cwd: home, source: 'startup',
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: stubClient });
  assert.match(JSON.parse(start.stdout).hookSpecificOutput?.additionalContext, /PlainClaude/);
  const post = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'claude-plain-1', tool_name: 'Bash', cwd: home,
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: stubClient });
  assert.match(JSON.parse(post.stdout).hookSpecificOutput?.additionalContext, /plain claude/);
});

test('extractRegisteredAgentName extracts names from register_agent and macro responses', () => {
  assert.equal(extractRegisteredAgentName({
    tool_name: 'mcp__mcp_agent_mail__register_agent',
    tool_response: { name: 'BronzePond' },
  }), 'BronzePond');
  assert.equal(extractRegisteredAgentName({
    tool_name: 'register_agent',
    tool_response: '{"agent_name": "SilverFox"}',
  }), 'SilverFox');
  assert.equal(extractRegisteredAgentName({
    tool_name: 'mcp__agent_mail__macro_start_session',
    tool_response: { content: [{ type: 'text', text: '{"agent":{"name":"GoldHawk"}}' }] },
  }), 'GoldHawk');
  assert.equal(extractRegisteredAgentName({
    tool_name: 'mcp__mcp_agent_mail__register_agent',
    tool_response: [{ type: 'text', text: '{"id":147,"name":"RubyPelican"}' }],
  }), 'RubyPelican');
  assert.equal(extractRegisteredAgentName({
    tool_name: 'Bash',
    tool_response: { name: 'Ignored' },
  }), null);
});

test('handleClaudeHook PostToolUse synchronizes newly registered agent identity', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-sync-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-sync.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-sync', host: 'claude-code', session: 'claude-sync-1', project: '/tmp/proj', agent: 'OldIdentity', cursor: 42,
  }));
  const stubClient = {
    endpoint: 'http://127.0.0.1:8765/mcp/',
    call: async (name, args) => {
      if (name === 'fetch_inbox_events') {
        assert.equal(args.agent_name, 'NewIdentity');
        assert.equal(args.after, 0);
        return { events: [], next_cursor: 0 };
      }
      throw new Error(name);
    },
  };
  const post = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'claude-sync-1', tool_name: 'mcp__mcp_agent_mail__register_agent',
    tool_response: { name: 'NewIdentity' },
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: stubClient });
  assert.equal(post.stdout, '{}\n');
  const updated = JSON.parse(fs.readFileSync(listenerFile, 'utf8'));
  assert.equal(updated.agent, 'NewIdentity');
  assert.equal(updated.cursor, 0);
});

test('handleClaudeHook PreToolUse blocks redundant register_agent call', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-pre-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-pre.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-pre', host: 'claude-code', session: 'claude-pre-1', project: '/tmp/proj', agent: 'AssignedAgent', cursor: 0,
  }));
  const pre = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 'claude-pre-1', tool_name: 'mcp__mcp_agent_mail__register_agent',
    cwd: home,
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: { call: async () => ({}) } });
  const parsed = JSON.parse(pre.stdout);
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput?.permissionDecisionReason, /AssignedAgent/);
});

test('handleClaudeHook Stop hook returns exitCode 2 with pending mail prompt', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-stop-mail-'));
  const stateRoot = path.join(home, 'state');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(stateRoot, { recursive: true });
  const listenerFile = path.join(stateRoot, 'listener-stop.json');
  fs.writeFileSync(listenerFile, JSON.stringify({
    id: 'listener-stop', host: 'claude-code', session: 'claude-stop-1', project: '/tmp/proj', agent: 'TargetClaude', cursor: 10,
  }));
  const events = [{ cursor: 15, message_id: 501, from: 'PeerG' }];
  const messages = new Map([[501, { id: 501, from: 'PeerG', subject: 'wake now', body_md: 'urgent message' }]]);
  const stubClient = {
    call: async () => ({ events, next_cursor: 15 }),
    message: async (id) => messages.get(id),
  };
  const stopResult = await handleClaudeHook(JSON.stringify({
    hook_event_name: 'Stop', session_id: 'claude-stop-1',
  }), { AGENT_MAIL_WAKE_HOME: home }, { client: stubClient });
  assert.equal(stopResult.exitCode, 2);
  assert.match(stopResult.prompt, /wake now/);
  assert.match(JSON.parse(stopResult.stdout).reason, /wake now/);
});
