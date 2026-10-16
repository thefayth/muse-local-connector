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
const bridgePath = resolve('src/context-bridge.mjs');

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-context-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, controllerThreadId }));
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
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(context.pipePath, pipePath);
  assert.equal(context.controllerThreadId, controllerThreadId);
  assert.equal(context.pid, bridge.child.pid);
  assert.match(context.registrationId, /^[0-9a-f-]{36}$/i);
  assert.ok(Date.now() - Date.parse(context.updatedAt) < 3000);
  if (process.platform !== 'win32') assert.equal((await stat(contextPath)).mode & 0o777, 0o600);
  const listed = await bridge.request('tools/list');
  assert.equal(listed.result.tools.length, 1);
  const status = await bridge.request('tools/call', { name: listed.result.tools[0].name, arguments: {} });
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
  const first = JSON.parse(await readFile(contextPath, 'utf8'));
  const newer = registrar(t, configPath, '\\\\.\\pipe\\newer-muse-context');
  await newer.request('initialize');
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
  const status = await newer.request('tools/call', { name: 'desktop_context_status', arguments: {} });
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
  assert.equal(JSON.parse(await readFile(contextPath, 'utf8')).pid, bridge.child.pid);
  const exited = once(bridge.child, 'exit');
  bridge.child.stdin.end();
  assert.equal((await exited)[0], 0);
});

test('live older registrars recover after a newer registrar exits or crashes using their own native context', { concurrency: true, timeout: 22000 }, async t => {
  await Promise.all(['EOF', 'crash'].map(mode => t.test(mode, async t => {
    const { configPath, contextPath } = await fixture(t);
    const originalPipe = `\\\\.\\pipe\\original-muse-context-${mode}`;
    const older = registrar(t, configPath, originalPipe);
    await older.request('initialize');
    const original = JSON.parse(await readFile(contextPath, 'utf8'));
    const newer = registrar(t, configPath, `\\\\.\\pipe\\newer-muse-context-${mode}`);
    await newer.request('initialize');
    assert.notEqual(JSON.parse(await readFile(contextPath, 'utf8')).registrationId, original.registrationId);
    const newerExited = once(newer.child, 'exit');
    if (mode === 'EOF') newer.child.stdin.end();
    else newer.child.kill('SIGKILL');
    await newerExited;
    const deadline = Date.now() + 17000;
    let recovered;
    while (Date.now() < deadline) {
      try { recovered = JSON.parse(await readFile(contextPath, 'utf8')); } catch {}
      if (recovered?.registrationId === original.registrationId) break;
      await delay(100);
    }
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

test('an explicit different executor identity cannot replace the configured controller registration', { timeout: 4000 }, async t => {
  const { configPath, contextPath } = await fixture(t);
  const bridge = registrar(t, configPath, '\\\\.\\pipe\\wrong-caller-muse-context', '019a0000-0000-7000-8000-000000000002');
  const [code] = await once(bridge.child, 'exit');
  assert.notEqual(code, 0);
  await assert.rejects(readFile(contextPath), { code: 'ENOENT' });
  assert.equal(bridge.diagnostics().includes(controllerThreadId), false);
});
