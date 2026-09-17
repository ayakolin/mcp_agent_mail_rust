#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_ROOT, STATE_ROOT, listStates, readJson, MailClient, batchPrompt, identityInstructions, findCodexListener, ensureHookListener, stampCodexTurn, claimSteerBatch, commitSteerBatch } from './common.mjs';

export function parseHookEvent(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export function isSessionEnd(event) {
  return event.hook_event_name === 'SessionEnd';
}

export function isPostToolUse(event) {
  return event.hook_event_name === 'PostToolUse';
}

export function isStop(event) {
  return event.hook_event_name === 'Stop';
}

export function sessionId(event) {
  return event?.session_id || event?.thread_id || event?.id || '';
}

export function shouldAttach(event, env = process.env) {
  return env.AGENT_MAIL_WAKE_ENABLED !== '0' && Boolean(sessionId(event)) &&
    event.source !== 'compact' && !isSessionEnd(event) && !isPostToolUse(event) && !isStop(event);
}

const FRESH_ATTACH_MS = 15_000;

export function isFreshListener(state, now = Date.now()) {
  const ts = Date.parse(state?.updatedAt || '');
  return Number.isFinite(ts) && (now - ts) < FRESH_ATTACH_MS;
}

export function stopQueueListeners(session, now = Date.now(), roots = {}) {
  if (!session) return [];
  const dataRoot = roots.dataRoot || DATA_ROOT;
  const stateRoot = roots.stateRoot || STATE_ROOT;
  const stopped = [];
  for (const state of listStates(stateRoot)) {
    if (state.host !== 'codex' || state.session !== session) continue;
    const binding = readJson(path.join(dataRoot, 'bindings', `${state.id}.json`), {});
    if (binding.delivery !== 'queue') continue;
    const full = readJson(path.join(stateRoot, `${state.id}.json`), {});
    if (!full.pid || full.pid === process.pid) continue;
    // Thread restart fires SessionEnd after SessionStart(clear). A just-attached
    // listener must survive that late stop so auto-wake stays online.
    if (isFreshListener(full, now)) continue;
    try { process.kill(full.pid, 'SIGTERM'); stopped.push(full.pid); } catch { /* already gone */ }
  }
  return stopped;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

export async function handlePostToolUse(event, env = process.env, extras = {}) {
  if (env.AGENT_MAIL_WAKE_ENABLED === '0') return {};
  const id = sessionId(event);
  if (!id) return {};
  const dataRoot = env.AGENT_MAIL_WAKE_HOME || DATA_ROOT;
  const stateRoot = env.AGENT_MAIL_WAKE_STATE_DIR || path.join(dataRoot, 'state');
  try {
    const client = extras.client || new MailClient(env.AGENT_MAIL_URL, {}, { timeoutMs: 5000 });
    const listener = await ensureHookListener(id, {
      host: 'codex', cwd: event.cwd, env, client, stateRoot, dataRoot,
    }) || findCodexListener(id, { stateRoot, dataRoot });
    if (!listener?.file) return {};
    stampCodexTurn(listener.file, { active: true });
    const claimed = await claimSteerBatch(listener.file, client, { timeoutMs: 1500 });
    if (!claimed?.batch) return {};
    if (!claimed.batch.messages?.length) {
      await commitSteerBatch(listener.file, claimed.batch);
      return {};
    }
    const prompt = batchPrompt(claimed.state, claimed.batch);
    await commitSteerBatch(listener.file, claimed.batch);
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: prompt,
      },
    };
  } catch {
    return {};
  }
}

export async function handleStop(event, env = process.env, extras = {}) {
  if (env.AGENT_MAIL_WAKE_ENABLED === '0') return {};
  const id = sessionId(event);
  if (!id) return {};
  const dataRoot = env.AGENT_MAIL_WAKE_HOME || DATA_ROOT;
  const stateRoot = env.AGENT_MAIL_WAKE_STATE_DIR || path.join(dataRoot, 'state');
  try {
    const client = extras.client || new MailClient(env.AGENT_MAIL_URL, {}, { timeoutMs: 5000 });
    const listener = await ensureHookListener(id, {
      host: 'codex', cwd: event.cwd, env, client, stateRoot, dataRoot,
    }) || findCodexListener(id, { stateRoot, dataRoot });
    if (!listener?.file) return {};
    const claimed = await claimSteerBatch(listener.file, client, { timeoutMs: 1500 });
    if (!claimed?.batch?.messages?.length) {
      if (claimed?.batch) await commitSteerBatch(listener.file, claimed.batch);
      stampCodexTurn(listener.file, { active: false });
      return {};
    }
    const prompt = batchPrompt(claimed.state, claimed.batch);
    await commitSteerBatch(listener.file, claimed.batch);
    stampCodexTurn(listener.file, { active: false });
    return {
      decision: 'block',
      reason: prompt,
    };
  } catch {
    const listener = findCodexListener(id, { stateRoot, dataRoot });
    if (listener?.file) stampCodexTurn(listener.file, { active: false });
    return {};
  }
}

export async function handleHook(raw, env = process.env, spawner = spawn, extras = {}) {
  const event = parseHookEvent(raw);
  const id = sessionId(event);
  if (isSessionEnd(event)) {
    const dataRoot = env.AGENT_MAIL_WAKE_HOME || DATA_ROOT;
    const stateRoot = env.AGENT_MAIL_WAKE_STATE_DIR || path.join(dataRoot, 'state');
    stopQueueListeners(id, Date.now(), { dataRoot, stateRoot });
    return { stdout: '{}\n', spawned: false };
  }
  if (isPostToolUse(event)) {
    const output = await handlePostToolUse(event, env, extras);
    return { stdout: JSON.stringify(output) + '\n', spawned: false };
  }
  if (isStop(event)) {
    const output = await handleStop(event, env, extras);
    return { stdout: JSON.stringify(output) + '\n', spawned: false };
  }
  if (!shouldAttach(event, env)) return { stdout: '{}\n', spawned: false };
  const dataRoot = env.AGENT_MAIL_WAKE_HOME || DATA_ROOT;
  const stateRoot = env.AGENT_MAIL_WAKE_STATE_DIR || path.join(dataRoot, 'state');
  let identity = 'Incoming peer mail is steered into active turns at tool boundaries, or queued when idle; use the listener mailbox identity, not a second mailbox.';
  try {
    const client = extras.client || new MailClient(env.AGENT_MAIL_URL, {}, { timeoutMs: 5000 });
    const listener = await ensureHookListener(id, {
      host: 'codex', cwd: event.cwd, env, client, stateRoot, dataRoot,
    });
    if (listener?.state?.agent) identity = identityInstructions(listener.state);
  } catch {}
  const logDir = path.join(dataRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(logDir, `codex-hook-${Date.now()}.log`), 'a', 0o600);
  const child = spawner(process.execPath, [
    path.join(ROOT, 'cli.mjs'), 'codex', 'attach',
    '--session', id,
    '--project', event.cwd || process.cwd(),
  ], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: event.cwd || process.cwd(),
    env,
  });
  child.unref?.();
  fs.closeSync(log);
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Agent Mail auto-wake is enabled for this Codex session. ${identity}`,
      },
    }) + '\n',
    spawned: true,
    pid: child.pid,
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await handleHook(await readStdin());
  process.stdout.write(result.stdout);
}
