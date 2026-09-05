import { EventEmitter } from 'node:events';
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
