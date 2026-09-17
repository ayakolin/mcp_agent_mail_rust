import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installationPlan, applyInstallation, mergeCodexHooks, mergeClaudeHooks } from '../install.mjs';

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-wake-install-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, home: path.join(directory, "user's home with spaces") };
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('dry run describes a complete installation without creating a home directory', t => {
  const { home } = sandbox(t);
  const plan = installationPlan({ home });
  const result = applyInstallation(plan, { dryRun: true });
  assert.ok(result.changed.some(file => file.endsWith('codex-mail')));
  assert.ok(result.changed.some(file => file.endsWith('codex-hook.mjs')));
  assert.ok(result.changed.some(file => file.endsWith('index.ts')));
  assert.equal(fs.existsSync(home), false);
});

test('install preserves existing configuration, backs up originals and runs quoted launchers', t => {
  const { home } = sandbox(t);
  const claudeFile = path.join(home, '.claude.json');
  const original = { userPreference: 'keep', mcpServers: { existing: { command: 'existing-tool', env: { TEST_VALUE: 'unchanged' } } } };
  write(claudeFile, original);
  const codexFile = path.join(home, '.codex', 'config.toml');
  const toml = '# retain comment\nmodel = "existing-model"\n[mcp_servers.existing]\ncommand = "existing-tool"\n';
  write(codexFile, toml);
  const ompFile = path.join(home, '.omp', 'agent', 'mcp.json');
  write(ompFile, { disabledServers: ['existing'], mcpServers: { existing: { type: 'http', url: 'http://127.0.0.1:9010/mcp/' } } });
  const plan = installationPlan({ home, url: 'http://127.0.0.1:9123/mcp/' });
  const result = applyInstallation(plan);
  assert.deepEqual(read(claudeFile).mcpServers.existing, original.mcpServers.existing);
  assert.equal(read(claudeFile).userPreference, 'keep');
  assert.equal(read(claudeFile).mcpServers.agent_mail_wake.env.AGENT_MAIL_URL, 'http://127.0.0.1:9123/mcp/');
  const installedCodex = fs.readFileSync(codexFile, 'utf8');
  assert.ok(installedCodex.startsWith(toml));
  assert.match(installedCodex, /agent-mail-wake managed hooks/);
  assert.match(installedCodex, /\[\[hooks\.SessionStart\]\]/);
  assert.match(installedCodex, /matcher = "startup\|resume\|clear"/);
  assert.match(installedCodex, /\[\[hooks\.PostToolUse\]\]/);
  assert.match(installedCodex, /\[\[hooks\.Stop\]\]/);
  assert.deepEqual(read(ompFile).disabledServers, ['existing']);
  const manifest = read(path.join(result.backup, 'manifest.json'));
  const savedClaude = manifest.find(entry => entry.file === claudeFile);
  assert.deepEqual(read(savedClaude.backup), original);
  assert.equal(fs.statSync(savedClaude.backup).mode & 0o777, 0o600);
  const launcher = spawnSync(path.join(plan.binDir, 'codex-mail'), ['--help'], { encoding: 'utf8' });
  assert.equal(launcher.status, 0, launcher.stderr);
  assert.match(launcher.stdout, /Agent Mail Wake/);
  const listing = spawnSync(path.join(plan.binDir, 'agent-mail-wake'), ['list'], {
    encoding: 'utf8', env: { ...process.env, AGENT_MAIL_WAKE_HOME: path.join(home, 'isolated runtime') },
  });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(JSON.parse(listing.stdout), []);
  const second = applyInstallation(installationPlan({ home, url: 'http://127.0.0.1:9123/mcp/' }));
  assert.deepEqual(second.changed, []);
  assert.equal(second.backup, null);
});

test('Codex SessionStart matcher includes thread-restart clear', () => {
  const merged = mergeCodexHooks('', 'agent-mail-wake-hook');
  assert.match(merged, /matcher = "startup\|resume\|clear"/);
});

test('client selection only installs selected host entry points', t => {
  const { home } = sandbox(t);
  const plan = installationPlan({ home, clients: ['kimi'] });
  applyInstallation(plan);
  assert.equal(fs.existsSync(path.join(plan.binDir, 'kimi-mail')), true);
  assert.equal(fs.existsSync(path.join(plan.binDir, 'codex-mail')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.omp')), false);
});

test('existing Agent Mail credentials and quoted TOML tables remain intact', t => {
  const { home } = sandbox(t);
  const file = path.join(home, '.codex', 'config.toml');
  const original = '[mcp_servers."mcp_agent_mail"]\nurl = "http://127.0.0.1:9100/mcp/"\nbearer_token_env_var = "EXISTING_TOKEN"\n';
  write(file, original);
  const kimiFile = path.join(home, '.kimi-code', 'mcp.json');
  const kimi = { mcpServers: { mcp_agent_mail: { url: 'http://127.0.0.1:9100/mcp/', bearerTokenEnvVar: 'EXISTING_TOKEN', enabled: false } } };
  write(kimiFile, kimi);
  applyInstallation(installationPlan({ home, clients: ['codex', 'kimi'] }));
  const installed = fs.readFileSync(file, 'utf8');
  assert.ok(installed.startsWith(original));
  assert.match(installed, /bearer_token_env_var = "EXISTING_TOKEN"/);
  assert.match(installed, /agent-mail-wake managed hooks/);
  assert.equal(installed, mergeCodexHooks(original, `${process.execPath} ${path.join(home, '.local', 'share', 'agent-mail', 'wake', 'codex-hook.mjs')}`));
  assert.deepEqual(read(kimiFile), kimi);
});

test('grok, opencode and codex entries embed the discovered bearer token once', async t => {
  const { home } = sandbox(t);
  process.env.AGENT_MAIL_BEARER_TOKEN = 'TEST-TOK';
  t.after(() => { delete process.env.AGENT_MAIL_BEARER_TOKEN; });
  const plan = installationPlan({ home, clients: ['grok', 'opencode', 'codex'] });
  applyInstallation(plan);
  const grok = fs.readFileSync(path.join(home, '.grok', 'config.toml'), 'utf8');
  assert.match(grok, /\[mcp_servers\.mcp_agent_mail\]\nurl = /);
  assert.match(grok, /\[mcp_servers\.mcp_agent_mail\.headers\]\nAuthorization = "Bearer TEST-TOK"/);
  const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /http_headers = \{ Authorization = "Bearer TEST-TOK" \}/);
  assert.deepEqual(read(path.join(home, '.opencode', 'opencode.json')).mcp.mcp_agent_mail,
    { type: 'remote', url: 'http://127.0.0.1:8765/mcp/', enabled: true, headers: { Authorization: 'Bearer TEST-TOK' } });
  for (const name of ['grok-mail', 'opencode-mail']) {
    const launcher = spawnSync(path.join(plan.binDir, name), ['--help'], { encoding: 'utf8' });
    assert.equal(launcher.status, 0, launcher.stderr);
    assert.match(launcher.stdout, /Agent Mail Wake/);
  }
  assert.deepEqual(applyInstallation(installationPlan({ home, clients: ['grok', 'opencode', 'codex'] })).changed, []);
});

test('codex hook install is idempotent and keeps existing MCP tables', t => {
  const { home } = sandbox(t);
  const file = path.join(home, '.codex', 'config.toml');
  write(file, 'model = "keep"\n');
  applyInstallation(installationPlan({ home, clients: ['codex'] }));
  const first = fs.readFileSync(file, 'utf8');
  assert.match(first, /\[\[hooks\.SessionStart\]\]/);
  assert.match(first, /\[\[hooks\.SessionEnd\]\]/);
  assert.match(first, /\[\[hooks\.PostToolUse\]\]/);
  assert.match(first, /\[\[hooks\.Stop\]\]/);
  assert.equal(first.split('agent-mail-wake managed hooks').length - 1, 1);
  applyInstallation(installationPlan({ home, clients: ['codex'] }));
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

test('unrelated launchers and concurrent config edits are not overwritten', t => {
  const first = sandbox(t);
  write(path.join(first.home, '.local', 'bin', 'codex-mail'), '# unrelated script\n');
  assert.throws(() => installationPlan({ home: first.home }), /unrelated executable/);
  const second = sandbox(t);
  const file = path.join(second.home, '.claude.json');
  write(file, { theme: 'before' });
  const plan = installationPlan({ home: second.home });
  write(file, { theme: 'changed concurrently' });
  assert.throws(() => applyInstallation(plan), /Concurrent modification/);
  assert.equal(read(file).theme, 'changed concurrently');
  assert.equal(fs.existsSync(path.join(second.home, '.local', 'bin', 'codex-mail')), false);
});

test('claude hook install is idempotent and merges hooks into settings.json preserving existing settings', t => {
  const { home } = sandbox(t);
  const file = path.join(home, '.claude', 'settings.json');
  const original = { model: 'fable', hooks: { ExistingHook: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } };
  write(file, original);
  applyInstallation(installationPlan({ home, clients: ['claude'] }));
  const installed = read(file);
  assert.equal(installed.model, 'fable');
  assert.equal(installed.hooks.ExistingHook.length, 1);
  assert.equal(installed.hooks.PreToolUse.length, 1);
  assert.equal(installed.hooks.SessionStart.length, 1);
  assert.equal(installed.hooks.SessionStart[0].matcher, undefined);
  assert.equal(installed.hooks.PostToolUse.length, 1);
  assert.equal(installed.hooks.Stop.length, 1);
  assert.equal(installed.hooks.SessionEnd.length, 1);
  assert.match(installed.hooks.PostToolUse[0].hooks[0].command, /claude-channel\.mjs hook/);
  const second = applyInstallation(installationPlan({ home, clients: ['claude'] }));
  assert.deepEqual(second.changed, []);
  assert.deepEqual(read(file), installed);
});
