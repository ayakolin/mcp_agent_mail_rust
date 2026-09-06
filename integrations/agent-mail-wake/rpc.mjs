import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { localUrl } from './common.mjs';

export class CodexRPC extends EventEmitter {
  constructor(url) { super(); this.url = localUrl(url); this.pending = new Map(); this.counter = 0; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Codex connection timeout')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Codex WebSocket connection failed')); }, { once: true });
    });
    this.ws.addEventListener('message', event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== undefined && this.pending.has(message.id) && !message.method) {
        const p = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(p.timeout);
        message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
      } else if (message.method) this.emit('notification', message);
    });
    this.ws.addEventListener('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timeout); p.reject(new Error('Codex connection closed')); }
      this.pending.clear(); this.emit('disconnected');
    });
    await this.request('initialize', { clientInfo: { name: 'agent_mail_wake', title: 'Agent Mail Wake', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    this.notify('initialized');
    return this;
  }
  notify(method, params = {}) { this.ws.send(JSON.stringify({ method, params })); }
  request(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timeout); this.pending.delete(id); reject(e); }
    });
  }
  close() { this.ws?.close(); }
}

export class CodexAdapter {
  constructor(rpc, session) { this.rpc = rpc; this.session = session; this.busy = false; }
  async canDeliver() {
    const { thread } = await this.rpc.request('thread/read', { threadId: this.session, includeTurns: false });
    return !['active', 'systemError'].includes(thread.status?.type);
  }
  async deliver(text, batch) {
    // Recover an accepted turn after a watcher restart without appending the same batch again.
    const { thread } = await this.rpc.request('thread/read', { threadId: this.session, includeTurns: true });
    if (JSON.stringify(thread.turns || []).includes(`[Agent Mail delivery ${batch.id}]`)) return;
    if (thread.status?.type === 'active') throw new Error('Codex became busy; delivery remains pending');
    await this.rpc.request('turn/start', { threadId: this.session, input: [{ type: 'text', text }] });
  }
}

export class KimiAdapter {
  constructor(url, tokenReader, session) { this.url = localUrl(url).replace(/\/$/, ''); this.tokenReader = tokenReader; this.session = session; }
  async request(route, body) {
    const response = await fetch(this.url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.tokenReader()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      const error = new Error(`Kimi ${result.code || response.status}: ${result.msg || 'request failed'}`);
      error.code = result.code; throw error;
    }
    return result.data;
  }
  async canDeliver() {
    const session = await this.request(`/api/v1/sessions/${encodeURIComponent(this.session)}`);
    return !session.main_turn_active && session.pending_interaction === 'none';
  }
  async deliver(text, batch) {
    try {
      return await this.request(`/api/v1/sessions/${encodeURIComponent(this.session)}/prompts`, {
        prompt_id: `mail_${batch.id}`, content: [{ type: 'text', text }],
      });
    } catch (error) {
      if ([40903, 40927].includes(error.code)) return { alreadyAccepted: true };
      throw error;
    }
  }
}

// Grok Build exposes a long-lived agent over ACP (JSON-RPC, newline-delimited)
// via `grok agent stdio`. This is the same managed-session pattern as the Kimi
// Server API adapter: the launcher owns the session and prompts it per batch.
// session/prompt resolves when the turn ends, but BYOK/proxy backends can fail
// response deserialization after streaming; `_x.ai/session/prompt_complete`
// (observed on the wire) is the authoritative turn-end notification, so await
// that and treat the response itself as advisory.
export class GrokACP extends EventEmitter {
  constructor(proc) {
    super(); this.proc = proc; this.pending = new Map(); this.counter = 0;
    this.promptWaiters = new Set(); this.turnText = ''; this.textSink = null;
    this.lineReader = createInterface({ input: proc.stdout });
    this.lineReader.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && this.pending.has(message.id) && !message.method) {
        const p = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(p.timeout);
        p.resolve(message); return;
      }
      if (!message.method) return;
      if (/prompt_complete/.test(message.method)) {
        for (const w of this.promptWaiters) w(); this.promptWaiters.clear();
      } else if (message.method === 'session/update') {
        const u = message.params?.update;
        if (u?.sessionUpdate === 'agent_message_chunk') {
          const text = u.content?.text || ''; this.turnText += text; this.textSink?.write(text);
        }
      }
      if (message.id !== undefined) { // server->client request: always-approve sessions should not emit these
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
      }
    });
    proc.on('exit', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timeout); p.resolve({ error: { message: 'Grok agent exited' } }); }
      this.pending.clear(); this.emit('disconnected');
    });
  }
  get alive() { return this.proc.exitCode === null && !this.proc.killed; }
  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error('Grok agent is not running'));
      const id = ++this.counter;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Grok ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
  async call(method, params, timeoutMs) {
    const message = await this.request(method, params, timeoutMs);
    if (message.error) throw new Error(`Grok ${method}: ${message.error.message || JSON.stringify(message.error)}`.slice(0, 500));
    return message.result;
  }
  async connect() {
    await this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: false } });
    return this;
  }
  async openSession(project, sessionId, rules) {
    if (sessionId) {
      await this.call('session/load', { sessionId, cwd: project, mcpServers: [] }, 120000);
      return sessionId;
    }
    const result = await this.call('session/new',
      { cwd: project, mcpServers: [], ...(rules ? { _meta: { rules } } : {}) }, 120000);
    return result.sessionId;
  }
  deliver(text) {
    if (!this.alive) throw new Error('Grok agent exited; delivery remains pending');
    const turn = new Promise(resolve => this.promptWaiters.add(resolve));
    turn.catch(() => {});
    this.turnText = '';
    this.request('session/prompt', { sessionId: this.session, prompt: [{ type: 'text', text }] }, 30 * 60000)
      .then(message => { if (message.error) process.stderr.write(`grok prompt response: ${message.error.message}\n`); })
      .catch(error => { if (this.promptWaiters.size) { for (const w of this.promptWaiters) w(error); this.promptWaiters.clear(); } });
    return turn;
  }
}

// OpenCode exposes a headless HTTP server (`opencode serve`) whose
// POST /session/:id/message call blocks until the assistant turn completes,
// so the response doubles as the delivery acknowledgment.
export class OpenCodeAdapter {
  constructor(url, fetchImpl = fetch) { this.url = localUrl(url).replace(/\/$/, ''); this.fetch = fetchImpl; }
  async request(path, body) {
    const response = await fetch(this.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
    if (!response.ok) throw new Error(`OpenCode ${response.status} ${path}: ${JSON.stringify(data).slice(0, 250)}`);
    return data;
  }
  async openSession(title) { return (await this.request('/session', { title })).id; }
  async history(sessionId) { const rows = await this.request(`/session/${encodeURIComponent(sessionId)}/message`); return Array.isArray(rows) ? rows : rows.data || []; }
  async canDeliver(sessionId) { await this.history(sessionId); return true; }
  async deliver(sessionId, text, batch, model) {
    const history = await this.history(sessionId);
    const marker = `[Agent Mail delivery ${batch.id}]`;
    if (JSON.stringify(history).includes(marker)) return { alreadyAccepted: true };
    const body = { parts: [{ type: 'text', text }], ...(model ? { model } : {}) };
    const message = await new Promise((resolve, reject) => {
      fetch(this.url + `/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30 * 60000),
      }).then(async response => {
        const payload = await response.text();
        let data; try { data = JSON.parse(payload); } catch { data = payload.slice(0, 200); }
        response.ok ? resolve(data) : reject(new Error(`OpenCode prompt failed: ${JSON.stringify(data).slice(0, 300)}`));
      }).catch(reject);
    });
    return { reply: (message.parts || []).filter(p => p.type === 'text').map(p => p.text).join(' ').slice(0, 400) };
  }
}
