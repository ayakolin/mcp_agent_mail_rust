#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA_ROOT, STATE_ROOT, listStates, readJson } from './common.mjs';

export function parseHookEvent(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export function isSessionEnd(event) {
  return event.hook_event_name === 'SessionEnd';
}

export function shouldAttach(event, env = process.env) {
  return env.AGENT_MAIL_WAKE_ENABLED !== '0' && Boolean(event.session_id) &&
    event.source !== 'compact' && !isSessionEnd(event);
}

export function stopQueueListeners(session) {
  if (!session) return [];
  const stopped = [];
  for (const state of listStates()) {
    if (state.host !== 'codex' || state.session !== session) continue;
    const binding = readJson(path.join(DATA_ROOT, 'bindings', `${state.id}.json`), {});
    if (binding.delivery !== 'queue') continue;
    const full = readJson(path.join(STATE_ROOT, `${state.id}.json`), {});
    if (!full.pid || full.pid === process.pid) continue;
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

export async function handleHook(raw, env = process.env, spawner = spawn) {
  const event = parseHookEvent(raw);
  if (isSessionEnd(event)) {
    stopQueueListeners(event.session_id);
    return { stdout: '{}\n', spawned: false };
  }
  if (!shouldAttach(event, env)) return { stdout: '{}\n', spawned: false };
  const dataRoot = env.AGENT_MAIL_WAKE_HOME || DATA_ROOT;
  const logDir = path.join(dataRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(logDir, `codex-hook-${Date.now()}.log`), 'a', 0o600);
  const child = spawner(process.execPath, [
    path.join(ROOT, 'cli.mjs'), 'codex', 'attach',
    '--session', event.session_id,
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
        additionalContext: 'Agent Mail auto-wake is enabled for this Codex session. Incoming peer mail is queued into this thread; use the listener mailbox identity, not a second mailbox.',
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
