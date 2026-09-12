import { MailWatcher, identityInstructions, errorText, projectPath, readJson } from './common.mjs';

export default function agentMailWake(pi) {
  let watcher, generation = 0, keepEpoch = 0, initPromise;
  const show = (ctx, text) => { if (ctx.hasUI) ctx.ui.notify(text, 'info'); };
  async function start(ctx) {
    const session = ctx.sessionManager.getSessionId();
    // Same-session reload/switch/branch must keep the live listener. Stopping it
    // here is what drops auto-wake when a thread restarts in-process.
    if (watcher && watcher.session === session && !watcher.stopped) {
      keepEpoch++;
      const state = watcher.state = readJson(watcher.file, watcher.state);
      if (state.paused && state.error?.includes('automatic deliveries')) {
        watcher.control(false);
      }
      return;
    }
    const current = ++generation;
    if (watcher) await watcher.stop();
    watcher = undefined;
    // Normal interactive OMP sessions opt in through the installed extension.
    // RPC/print child processes need explicit opt-in to avoid registering every task worker.
    if (process.env.AGENT_MAIL_WAKE_ENABLED === '0' ||
      (!ctx.hasUI && process.env.AGENT_MAIL_WAKE_ENABLED !== '1')) return;
    try {
      const candidate = new MailWatcher({ host: 'omp', session, project: projectPath(process.env.AGENT_MAIL_PROJECT || ctx.cwd),
        model: ctx.model?.id, interval: Number(process.env.AGENT_MAIL_WAKE_INTERVAL_MS || 3000),
        // deliverAs:"aside" injects at the next agent step boundary without
        // interrupting the current tool batch, and starts a turn when idle — so
        // mail is deliverable mid-run, not only between turns.
        canDeliver: async () => current === generation,
        deliver: async (text, batch) => {
          if (ctx.sessionManager.getEntries().some(entry => entry.type === 'custom_message' &&
            entry.customType === 'agent-mail-incoming' && entry.details?.batchId === batch.id)) return;
          pi.sendMessage({ customType: 'agent-mail-incoming', content: text, display: true,
            details: { batchId: batch.id } }, { deliverAs: 'aside' });
        },
        onStatus: state => {
          if (ctx.hasUI) ctx.ui.setStatus('agent-mail', `Mail: ${state.agent || 'connecting'}${state.paused ? ' [paused]' : ''}${state.error ? ' !' : ''}`);
        },
      });
      await candidate.init();
      if (current !== generation) { await candidate.stop(); return; }
      watcher = candidate;
      pi.sendMessage({ customType: 'agent-mail-identity', content: identityInstructions(watcher.state), display: false },
        { triggerTurn: false, deliverAs: 'nextTurn' });
      show(ctx, `Agent Mail 自动收件已开启，邮箱：${watcher.state.agent}。/mail-wake 可查看或暂停。`);
    } catch (error) { show(ctx, `Agent Mail：${errorText(error)}。服务恢复后运行 /mail-wake start。`); }
  }
  pi.on('session_start', (_, ctx) => { initPromise = start(ctx); return initPromise; });
  pi.on('session_switch', (_, ctx) => { initPromise = start(ctx); return initPromise; });
  pi.on('session_branch', (_, ctx) => { initPromise = start(ctx); return initPromise; });
  pi.on('session_shutdown', async () => {
    const existing = watcher;
    const shutting = generation;
    const keepAt = keepEpoch;
    await initPromise;
    // Same-session keep increments keepEpoch so a late dispose cannot
    // kill the listener that thread restart just reaffirmed.
    if (watcher !== existing || generation !== shutting || keepEpoch !== keepAt) return;
    generation++;
    await existing?.stop();
    if (watcher === existing) watcher = undefined;
  });
  const onUserInput = () => {
    if (!watcher) return;
    const state = watcher.state = readJson(watcher.file, watcher.state);
    if (state.paused && state.error?.includes('automatic deliveries')) {
      watcher.control(false);
    } else if (!state.paused && (state.wakeups || 0) > 0) {
      state.wakeups = 0;
      watcher.save();
      watcher.onStatus(watcher.status());
    }
  };
  pi.on('message_start', event => {
    const msg = event?.message;
    if (msg?.role === 'user' && !msg?.synthetic && msg?.attribution !== 'agent') {
      onUserInput();
    }
  });
  pi.on('input', event => {
    if (event?.source === 'interactive') {
      onUserInput();
    }
  });
  pi.registerCommand('mail-wake', {
    description: 'Agent Mail 自动收件：status / pause / resume / start',
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      if (action === 'start') { initPromise = start(ctx); await initPromise; }
      else if (action === 'pause') watcher?.control(true);
      else if (action === 'resume') { if (watcher) watcher.control(false); else await start(ctx); }
      else if (action !== 'status') { show(ctx, '用法：/mail-wake status|pause|resume|start'); return; }
      show(ctx, watcher ? JSON.stringify(watcher.status(), null, 2) : '自动收件未启动');
    },
  });
}
