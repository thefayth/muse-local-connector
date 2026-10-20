import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { recordProof, expandScope, setConcurrency, validateControllerContext } from '../src/cli.mjs';

test('local concurrency adjustment preserves other private configuration and requires a bounded integer', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-concurrency-config-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const configPath = join(dataDir, 'config.json');
  const original = { dataDir, tokenSha256: 'synthetic-private-verifier', allowedThreadIds: ['synthetic-chat'], desktopContextFile: join(dataDir, 'context.json'), allowAllTasks: true, customSetting: { preserved: true } };
  await writeFile(configPath, JSON.stringify(original));
  for (const limit of [1, 4, 32]) {
    await setConcurrency(configPath, limit);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { ...original, maxConcurrentJobs: limit });
  }
  const beforeInvalid = await readFile(configPath, 'utf8');
  for (const invalid of [undefined, null, true, 0, -1, 33, 1.5, NaN, Infinity, '', '1.5', '4x']) {
    await assert.rejects(setConcurrency(configPath, invalid), /integer from 1 to 32/);
    assert.equal(await readFile(configPath, 'utf8'), beforeInvalid);
  }
});

test('concurrency CLI updates configuration without requiring desktop context or printing private fields', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-concurrency-cli-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const configPath = join(dataDir, 'config.json');
  const original = { tokenSha256: 'synthetic-private-verifier', controllerThreadId: 'synthetic-controller' };
  await writeFile(configPath, JSON.stringify(original));
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_APP_TOOLS_PIPE_PATH;
  const result = await promisify(execFile)(process.execPath, [resolve('src/cli.mjs'), 'concurrency', '--max-jobs', '6', '--config', configPath], { env, windowsHide: true });
  assert.match(result.stdout, /Restart the connector to apply/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private|synthetic-controller/);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { ...original, maxConcurrentJobs: 6 });
  await assert.rejects(promisify(execFile)(process.execPath, [resolve('src/cli.mjs'), 'concurrency', '--max-jobs', '33', '--config', configPath], { env, windowsHide: true }), /integer from 1 to 32/);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { ...original, maxConcurrentJobs: 6 });
});

test('a direct launcher cannot use another chat as its controller', () => {
  assert.throws(() => validateControllerContext({ controllerThreadId: 'controller-a' }, { CODEX_THREAD_ID: 'controller-b', CODEX_APP_TOOLS_PIPE_PATH: 'test-context' }), /different|match/);
  assert.throws(() => validateControllerContext({}, {}), /Codex|context/);
  assert.equal(validateControllerContext({}, { CODEX_THREAD_ID: 'controller-a', CODEX_APP_TOOLS_PIPE_PATH: 'test-context' }), 'controller-a');
});

test('dynamic context startup preserves the configured controller without inherited desktop variables', () => {
  const controllerThreadId = '019a0000-0000-7000-8000-000000000001';
  const desktopContextFile = join(tmpdir(), 'muse-context.json');
  assert.equal(validateControllerContext({ controllerThreadId, desktopContextFile }, {}), controllerThreadId);
  assert.throws(() => validateControllerContext({ desktopContextFile }, {}), /controller/i);
  assert.throws(() => validateControllerContext({ controllerThreadId, desktopContextFile: 'relative.json' }, {}), /absolute/i);
});

test('a supervised CLI waits for fresh desktop context and shuts down gracefully over IPC', { timeout: 5000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-supervised-cli-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const configPath = join(dataDir, 'config.json');
  const token = 'test-key-for-local-supervisor';
  await writeFile(configPath, JSON.stringify({ dataDir, port: 0, tokenSha256: createHash('sha256').update(token).digest('hex'), controllerThreadId: '019a0000-0000-7000-8000-000000000001', desktopContextFile: join(dataDir, 'desktop-context.json'), allowedThreadIds: [] }));
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_APP_TOOLS_PIPE_PATH;
  const child = spawn(process.execPath, [resolve('src/cli.mjs'), '--config', configPath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const [started] = await once(lines, 'line');
  const port = started.match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port, 'The gateway must start while desktop context is unavailable');
  const response = await fetch(`http://127.0.0.1:${port}/v1/tasks`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 503);
  const exited = once(child, 'exit');
  child.send({ type: 'connector-shutdown' });
  assert.equal((await exited)[0], 0);
});

test('expansion requires matching completed jobs and a real computer evidence file', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-proof-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, allowAllTasks: false }));
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([
    { id: 'chat-proof', kind: 'task', status: 'completed', requestId: 'request-chat', result: 'Connector receipt: request-chat' },
    { id: 'computer-proof', kind: 'computer', status: 'completed', requestId: 'request-computer', result: '4. Connector receipt: request-computer' },
  ]));
  await assert.rejects(expandScope(configPath), /verification|proof/i);
  await recordProof(configPath, { kind: 'task', jobId: 'chat-proof' });
  await assert.rejects(recordProof(configPath, { kind: 'computer', jobId: 'computer-proof' }), /evidence/i);
  const imagePath = join(dataDir, 'proof.png');
  await writeFile(imagePath, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  await recordProof(configPath, { kind: 'computer', jobId: 'computer-proof', evidence: imagePath });
  await expandScope(configPath);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).allowAllTasks, true);
});
