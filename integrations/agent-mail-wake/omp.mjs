import { MailWatcher, identityInstructions, errorText, projectPath } from './common.mjs';

export default function agentMailWake(pi) {
  let watcher, generation = 0, initPromise;
  const show = (ctx, text) => { if (ctx.hasUI) ctx.ui.notify(text, 'info'); };
  async function start(ctx) {
    const current = ++generation;
    if (watcher) await watcher.stop();
    watcher = undefined;
    // Normal interactive OMP sessions opt in through the installed extension.
    // RPC/print child processes need explicit opt-in to avoid registering every task worker.
    if (process.env.AGENT_MAIL_WAKE_ENABLED === '0' ||
      (!ctx.hasUI && process.env.AGENT_MAIL_WAKE_ENABLED !== '1')) return;
    try {
      const candidate = new MailWatcher({ host: 'omp', session: ctx.sessionManager.getSessionId(),
        project: projectPath(process.env.AGENT_MAIL_PROJECT || ctx.cwd), model: ctx.model?.id,
        interval: Number(process.env.AGENT_MAIL_WAKE_INTERVAL_MS || 3000),
        canDeliver: async () => current === generation && ctx.isIdle() && !ctx.hasPendingMessages(),
        deliver: async (text, batch) => {
          if (ctx.sessionManager.getEntries().some(entry => entry.type === 'custom_message' &&
            entry.customType === 'agent-mail-incoming' && entry.details?.batchId === batch.id)) return;
          pi.sendMessage({ customType: 'agent-mail-incoming', content: text, display: true,
            details: { batchId: batch.id } }, { triggerTurn: true, deliverAs: 'followUp' });
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
  pi.on('session_shutdown', async () => { generation++; await initPromise; await watcher?.stop(); });
  pi.on('input', event => {
    if (event.source === 'interactive' && watcher && !watcher.state.paused) {
      watcher.state.wakeups = 0; watcher.save();
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
