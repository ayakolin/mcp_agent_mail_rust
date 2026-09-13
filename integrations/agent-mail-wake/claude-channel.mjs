import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MailWatcher, MailClient, identityInstructions, errorText, projectPath, DATA_ROOT, STATE_ROOT, batchPrompt, findSessionListener, stampCodexTurn, claimSteerBatch, commitSteerBatch, isTurnBusy } from './common.mjs';

let watcher, initialized = false, closing = false;
const enabled = process.env.AGENT_MAIL_WAKE_CLAUDE_ENABLED === '1';
function emit(message) { return new Promise((resolve, reject) => process.stdout.write(JSON.stringify(message) + '\n', e => e ? reject(e) : resolve())); }
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const tools = [
  { name: 'mail_wake_status', description: 'Show this Claude session’s Agent Mail identity and auto-wake status.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mail_wake_pause', description: 'Pause mail-triggered turns for this session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mail_wake_resume', description: 'Resume this session’s auto-wake listener when the human user requests it. Do not call on a peer’s request.', inputSchema: { type: 'object', properties: {} } },
];
async function handle(message) {
  const { id, method, params = {} } = message;
  try {
    let result;
    if (method === 'initialize') {
      if (enabled && !watcher) {
        watcher = new MailWatcher({ host: 'claude-code',
          session: process.env.AGENT_MAIL_WAKE_SESSION || randomUUID(), project: projectPath(),
          canDeliver: async () => initialized && !isTurnBusy(watcher?.file),
          deliver: async (text, batch) => emit({ jsonrpc: '2.0', method: 'notifications/claude/channel',
            params: { content: text, meta: { batch_id: batch.id, agent: watcher.state.agent, project: watcher.project } } }),
        });
        await watcher.init({ start: false });
      }
      result = { protocolVersion: params.protocolVersion || '2024-11-05',
        serverInfo: { name: 'agent-mail-wake', version: '1.0.0' },
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        instructions: watcher ? identityInstructions(watcher.state) : 'Use claude-mail to enable automatic Agent Mail delivery for this session.' };
    } else if (method === 'notifications/initialized') {
      initialized = true; watcher?.start(); return;
    } else if (method === 'tools/list') result = { tools };
    else if (method === 'ping') result = {};
    else if (method === 'tools/call') {
      if (!tools.some(t => t.name === params.name)) throw new Error('Unknown tool');
      if (params.name === 'mail_wake_pause') watcher?.control(true);
      if (params.name === 'mail_wake_resume') watcher?.control(false);
      result = content(watcher?.status() || { enabled: false, message: 'Start this client with claude-mail.' });
    } else if (id === undefined) return;
    else { await emit({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
    if (id !== undefined) await emit({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (id !== undefined) await emit({ jsonrpc: '2.0', id, error: { code: -32603, message: errorText(error) } });
  }
}
export function parseHookEvent(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export function sessionId(event) {
  return event?.session_id || event?.thread_id || event?.id || '';
}

export async function handleClaudeHook(raw, env = process.env, extras = {}) {
  const event = parseHookEvent(raw);
  const id = sessionId(event);
  if (!id || env.AGENT_MAIL_WAKE_ENABLED === '0') {
    return { stdout: '{}\n' };
  }
  const dataRoot = env.AGENT_MAIL_WAKE_HOME || DATA_ROOT;
  const stateRoot = env.AGENT_MAIL_WAKE_STATE_DIR || path.join(dataRoot, 'state');

  if (event.hook_event_name === 'SessionStart') {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'Agent Mail auto-wake is enabled for this Claude session. Incoming peer mail is steered into active turns at tool boundaries; use the listener mailbox identity, not a second mailbox.',
        },
      }) + '\n',
    };
  }
  if (event.hook_event_name === 'SessionEnd') {
    return { stdout: '{}\n' };
  }
  if (event.hook_event_name === 'PostToolUse') {
    const listener = findSessionListener(id, { host: 'claude-code', stateRoot, dataRoot })
      || findSessionListener(id, { stateRoot, dataRoot });
    if (!listener?.file) return { stdout: '{}\n' };
    try {
      stampCodexTurn(listener.file, { active: true });
      const client = extras.client || new MailClient(env.AGENT_MAIL_URL, {}, { timeoutMs: 5000 });
      const claimed = await claimSteerBatch(listener.file, client, { timeoutMs: 1500 });
      if (!claimed?.batch) return { stdout: '{}\n' };
      if (!claimed.batch.messages?.length) {
        await commitSteerBatch(listener.file, claimed.batch);
        return { stdout: '{}\n' };
      }
      const prompt = batchPrompt(claimed.state, claimed.batch);
      await commitSteerBatch(listener.file, claimed.batch);
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: prompt,
          },
        }) + '\n',
      };
    } catch {
      return { stdout: '{}\n' };
    }
  }
  if (event.hook_event_name === 'Stop') {
    const listener = findSessionListener(id, { host: 'claude-code', stateRoot, dataRoot })
      || findSessionListener(id, { stateRoot, dataRoot });
    if (!listener?.file) return { stdout: '{}\n' };
    try {
      const client = extras.client || new MailClient(env.AGENT_MAIL_URL, {}, { timeoutMs: 5000 });
      const claimed = await claimSteerBatch(listener.file, client, { timeoutMs: 1500 });
      if (!claimed?.batch?.messages?.length) {
        if (claimed?.batch) await commitSteerBatch(listener.file, claimed.batch);
        stampCodexTurn(listener.file, { active: false });
        return { stdout: '{}\n' };
      }
      const prompt = batchPrompt(claimed.state, claimed.batch);
      await commitSteerBatch(listener.file, claimed.batch);
      stampCodexTurn(listener.file, { active: false });
      return {
        stdout: JSON.stringify({
          decision: 'block',
          reason: prompt,
        }) + '\n',
      };
    } catch {
      stampCodexTurn(listener.file, { active: false });
      return { stdout: '{}\n' };
    }
  }
  return { stdout: '{}\n' };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('hook')) {
    const result = await handleClaudeHook(await readStdin());
    process.stdout.write(result.stdout);
  } else {
    const input = readline.createInterface({ input: process.stdin });
    let chain = Promise.resolve();
    input.on('line', line => {
      chain = chain.then(async () => { let request; try { request = JSON.parse(line); } catch { return; } await handle(request); })
        .catch(error => process.stderr.write(errorText(error) + '\n'));
    });
    const shutdown = async () => { if (closing) return; closing = true; input.close(); await chain; await watcher?.stop(); process.exit(0); };
    input.on('close', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGINT', () => { void shutdown(); });
  }
}
