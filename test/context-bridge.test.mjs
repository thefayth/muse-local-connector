import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const controllerThreadId = '019a0000-0000-7000-8000-000000000001';
const callerTurnId = '019a0000-0000-7000-8000-000000000003';
const bridgePath = resolve('src/context-bridge.mjs');

async function fixture(t, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-context-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, controllerThreadId, ...extra }));
  return { dataDir, configPath, contextPath: join(dataDir, 'desktop-context.json') };
}

function registrar(t, configPath, pipePath, callerThreadId) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_APP_TOOLS_PIPE_PATH;
  if (pipePath) env.CODEX_APP_TOOLS_PIPE_PATH = pipePath;
  if (callerThreadId) env.CODEX_THREAD_ID = callerThreadId;
  const child = spawn(process.execPath, [bridgePath, '--config', configPath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const waiting = new Map();
  let output = '', diagnostics = '', id = 0;
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { diagnostics += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    const handler = waiting.get(response.id);
    if (handler) { waiting.delete(response.id); handler(response); }
  });
  return {
    child,
    output: () => output,
    diagnostics: () => diagnostics,
    activate(metadata = { 'openai/threadId': controllerThreadId, 'openai/turnId': callerTurnId }) {
      return this.request('tools/call', { name: 'desktop_context_status', arguments: {}, _meta: metadata });
    },
    request(method, params = {}) {
      const requestId = ++id;
      const response = new Promise((resolveResponse, reject) => {
        const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('Registrar did not reply')); }, 3000);
        waiting.set(requestId, value => { clearTimeout(timer); resolveResponse(value); });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      return response;
    },
  };
}

test('stdio registrar publishes a private fresh lease, exposes no endpoint, and removes its lease on EOF', async t => {
  const { configPath, contextPath } = await fixture(t);
  const pipePath = '\\\\.\\pipe\\muse-registrar-test-private';
  const bridge = registrar(t, configPath, pipePath);
  const initialized = await bridge.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  await assert.rejects(readFile(contextPath), { code: 'ENOENT' });
  assert.deepEqual((await bridge.activate()).result.structuredContent, { registered: true });
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(context.pipePath, pipePath);
  assert.equal(context.controllerThreadId, controllerThreadId);
  assert.equal(context.callerTurnId, callerTurnId);
  assert.equal(context.pid, bridge.child.pid);
  assert.match(context.registrationId, /^[0-9a-f-]{36}$/i);
  assert.ok(Date.now() - Date.parse(context.updatedAt) < 3000);
  if (process.platform !== 'win32') assert.equal((await stat(contextPath)).mode & 0o777, 0o600);
  const listed = await bridge.request('tools/list');
  assert.equal(listed.result.tools.length, 1);
  const status = await bridge.activate();
  assert.deepEqual(status.result.structuredContent, { registered: true });
  assert.equal(bridge.output().includes(pipePath), false);
  assert.equal(bridge.output().includes(controllerThreadId), false);
  assert.equal(bridge.diagnostics().includes(pipePath), false);
  const exited = once(bridge.child, 'exit');
  bridge.child.stdin.end();
  assert.equal((await exited)[0], 0);
  await assert.rejects(readFile(contextPath), { code: 'ENOENT' });
});

test('a newer registrar retains its lease across older heartbeats and older EOF', { timeout: 22000 }, async t => {
  const { configPath, contextPath } = await fixture(t);
  const older = registrar(t, configPath, '\\\\.\\pipe\\older-muse-context');
  await older.request('initialize');
  await older.activate();
  const first = JSON.parse(await readFile(contextPath, 'utf8'));
  const newer = registrar(t, configPath, '\\\\.\\pipe\\newer-muse-context');
  await newer.request('initialize');
  await newer.activate();
  const second = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.notEqual(second.registrationId, first.registrationId);
  await delay(15600);
  const refreshed = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(refreshed.registrationId, second.registrationId);
  assert.ok(Date.parse(refreshed.updatedAt) > Date.parse(second.updatedAt));
  const exited = once(older.child, 'exit');
  older.child.stdin.end();
  await exited;
  assert.equal(JSON.parse(await readFile(contextPath, 'utf8')).registrationId, second.registrationId);
  const status = await newer.activate();
  assert.deepEqual(status.result.structuredContent, { registered: true });
  const newerExited = once(newer.child, 'exit');
  newer.child.stdin.end();
  await newerExited;
  await assert.rejects(readFile(contextPath), { code: 'ENOENT' });
});

test('registrar without native desktop context exits without publishing a lease or printing configuration', async t => {
  const { configPath, contextPath } = await fixture(t);
  const bridge = registrar(t, configPath);
  const [code] = await once(bridge.child, 'exit');
  assert.notEqual(code, 0);
  await assert.rejects(readFile(contextPath), { code: 'ENOENT' });
  assert.equal(bridge.output(), '');
  assert.equal(bridge.diagnostics().includes(controllerThreadId), false);
  assert.equal(bridge.diagnostics().includes(configPath), false);
});

test('a registrar can recover a registration lock left by a process that no longer exists', async t => {
  const { dataDir, configPath, contextPath } = await fixture(t);
  await writeFile(join(dataDir, '.desktop-context.lock'), JSON.stringify({ pid: 2147483647 }));
  const bridge = registrar(t, configPath, '\\\\.\\pipe\\recovered-muse-context');
  await bridge.request('initialize');
  await bridge.activate();
  assert.equal(JSON.parse(await readFile(contextPath, 'utf8')).pid, bridge.child.pid);
  const exited = once(bridge.child, 'exit');
  bridge.child.stdin.end();
  assert.equal((await exited)[0], 0);
});

test('an older registration cannot resurrect a prior caller turn after its replacement exits', { concurrency: true, timeout: 22000 }, async t => {
  await Promise.all(['EOF', 'crash'].map(mode => t.test(mode, async t => {
    const { configPath, contextPath } = await fixture(t);
    const originalPipe = `\\\\.\\pipe\\original-muse-context-${mode}`;
    const older = registrar(t, configPath, originalPipe);
    await older.request('initialize');
    await older.activate();
    const original = JSON.parse(await readFile(contextPath, 'utf8'));
    const newer = registrar(t, configPath, `\\\\.\\pipe\\newer-muse-context-${mode}`);
    await newer.request('initialize');
    await newer.activate({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: controllerThreadId, turn_id: '019a0000-0000-7000-8000-000000000004' }) });
    assert.notEqual(JSON.parse(await readFile(contextPath, 'utf8')).registrationId, original.registrationId);
    const newerExited = once(newer.child, 'exit');
    if (mode === 'EOF') newer.child.stdin.end();
    else newer.child.kill('SIGKILL');
    await newerExited;
    await delay(15600);
    let recovered;
    try { recovered = JSON.parse(await readFile(contextPath, 'utf8')); } catch {}
    assert.notEqual(recovered?.registrationId, original.registrationId);
    await older.activate();
    recovered = JSON.parse(await readFile(contextPath, 'utf8'));
    assert.equal(recovered?.registrationId, original.registrationId);
    assert.equal(recovered.pipePath, originalPipe);
    assert.equal(recovered.controllerThreadId, controllerThreadId);
    assert.equal(recovered.pid, older.child.pid);
    assert.ok(Date.parse(recovered.updatedAt) > Date.parse(original.updatedAt));
    const exited = once(older.child, 'exit');
    older.child.stdin.end();
    assert.equal((await exited)[0], 0);
  })));
});

test('a foreign or unidentified MCP runtime cannot replace the controller lease', { timeout: 5000 }, async t => {
  const { configPath, contextPath } = await fixture(t);
  const owner = registrar(t, configPath, '\\\\.\\pipe\\owner-context');
  await owner.request('initialize');
  await owner.activate();
  const original = JSON.parse(await readFile(contextPath, 'utf8'));
  const foreign = registrar(t, configPath, '\\\\.\\pipe\\foreign-context');
  await foreign.request('initialize');
  assert.equal(JSON.parse(await readFile(contextPath, 'utf8')).registrationId, original.registrationId);
  for (const metadata of [null, {}, { 'openai/threadId': '019a0000-0000-7000-8000-000000000002', 'openai/turnId': callerTurnId }, { 'openai/threadId': controllerThreadId, 'openai/turnId': 'mcp-turn-7' }]) {
    assert.deepEqual((await foreign.activate(metadata)).result.structuredContent, { registered: false });
    assert.equal(JSON.parse(await readFile(contextPath, 'utf8')).registrationId, original.registrationId);
  }
  const nextTurn = '019a0000-0000-7000-8000-000000000005';
  assert.deepEqual((await owner.activate({ 'x-codex-turn-metadata': { thread_id: controllerThreadId, turn_id: nextTurn } })).result.structuredContent, { registered: true });
  const renewed = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(renewed.registrationId, original.registrationId);
  assert.equal(renewed.callerTurnId, nextTurn);
});


test('an explicit different executor identity cannot replace the configured controller registration', { timeout: 4000 }, async t => {
  const { configPath, contextPath } = await fixture(t);
  const bridge = registrar(t, configPath, '\\\\.\\pipe\\wrong-caller-muse-context', '019a0000-0000-7000-8000-000000000002');
  const [code] = await once(bridge.child, 'exit');
  assert.notEqual(code, 0);
  await assert.rejects(readFile(contextPath), { code: 'ENOENT' });
  assert.equal(bridge.diagnostics().includes(controllerThreadId), false);
});

test('automatic reconnect retains a genuine owner grant after the registering chat closes', async t => {
  const { dataDir, configPath, contextPath } = await fixture(t, { desktopReconnect: { enabled: true, appUserModelId: 'Synthetic.Codex!App' } });
  const bridge = registrar(t, configPath, '\\\\.\\pipe\\synthetic-owner-grant');
  await bridge.request('initialize');
  const grantPath = join(dataDir, 'desktop-owner.json');
  assert.deepEqual((await bridge.activate({})).result.structuredContent, { registered: false });
  await assert.rejects(readFile(grantPath), { code: 'ENOENT' });
  assert.deepEqual((await bridge.activate()).result.structuredContent, { registered: true });
  const grant = JSON.parse(await readFile(grantPath, 'utf8'));
  assert.equal(grant.controllerThreadId, controllerThreadId);
  assert.equal(grant.callerTurnId, callerTurnId);
  const saved = await readFile(grantPath, 'utf8');
  await bridge.activate({ 'openai/threadId': '019a0000-0000-7000-8000-000000000002', 'openai/turnId': callerTurnId });
  assert.equal(await readFile(grantPath, 'utf8'), saved);
  const exited = once(bridge.child, 'exit');
  bridge.child.stdin.end();
  await exited;
  await assert.rejects(readFile(contextPath), { code: 'ENOENT' });
  assert.equal(await readFile(grantPath, 'utf8'), saved);
  assert.equal(bridge.output().includes(callerTurnId), false);
});
