import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordProof, expandScope, validateControllerContext } from '../src/cli.mjs';

test('a direct launcher cannot use another chat as its controller', () => {
  assert.throws(() => validateControllerContext({ controllerThreadId: 'controller-a' }, { CODEX_THREAD_ID: 'controller-b', CODEX_APP_TOOLS_PIPE_PATH: 'test-context' }), /different|match/);
  assert.throws(() => validateControllerContext({}, {}), /Codex|context/);
  assert.equal(validateControllerContext({}, { CODEX_THREAD_ID: 'controller-a', CODEX_APP_TOOLS_PIPE_PATH: 'test-context' }), 'controller-a');
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
