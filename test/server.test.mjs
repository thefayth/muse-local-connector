import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createConnector } from '../src/server.mjs';

const token = 'test-only-credential-that-is-never-a-live-key';
const threadId = '10000000-0000-4000-8000-000000000001';
const otherThreadId = '10000000-0000-4000-8000-000000000002';

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-connector-test-'));
  const calls = [];
  const backend = {
    async listThreads() { calls.push('list'); return { tasks: [{ id: threadId, title: 'Existing test chat', kind: 'codex', status: 'idle' }, { id: otherThreadId, title: 'Other chat', kind: 'codex', status: 'idle' }], partial: false }; },
    async readThread(id) { calls.push('read'); return { threadId: id, turns: [] }; },
    async sendMessage(id, prompt) { calls.push({ id, prompt }); return { accepted: true }; },
    async waitThread() { return { cursor: 'baseline', status: 'idle' }; },
    async close() {},
    ...overrides.backend,
  };
  const config = { dataDir, port: 0, tokenSha256: createHash('sha256').update(token).digest('hex'), controllerThreadId: otherThreadId, allowedThreadIds: [threadId], allowAllTasks: false, ...overrides.config };
  const connector = await createConnector({ config, backend });
  await connector.listen();
  const base = `http://127.0.0.1:${connector.address().port}`;
  t.after(async () => { await connector.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    return { status: response.status, body: await response.json() };
  };
  const settle = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request(`/v1/jobs/${id}`);
      if (!['queued', 'submitting'].includes(result.body.status)) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('The synthetic job did not finish submitting');
  };
  return { connector, config, backend, calls, dataDir, request, settle, base };
}

test('requires authentication before revealing or touching tasks', async t => {
  const f = await fixture(t);
  const denied = await f.request('/v1/tasks', { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(denied.status, 401);
  assert.deepEqual(f.calls, []);
  assert.equal((await fetch(`${f.base}/health`)).status, 200);
});

test('pilot discovery and reads expose only the selected existing chat', async t => {
  const f = await fixture(t);
  const result = await f.request('/v1/tasks');
  assert.deepEqual(result.body.tasks.map(task => task.id), [threadId]);
  assert.equal((await f.request(`/v1/tasks/${otherThreadId}`)).status, 403);
});

test('rejects foreign browser origins and oversized requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/tasks', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const tooLarge = await f.request('/v1/jobs', { method: 'POST', body: JSON.stringify({ threadId, requestId: 'request-large', prompt: 'x'.repeat(70000) }) });
  assert.equal(tooLarge.status, 413);
  assert.equal(f.calls.length, 0);
});

test('durable idempotency prevents duplicate submissions and rejects changed requests', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ threadId, prompt: 'Report a connection check.', kind: 'task', requestId: 'request-unique' });
  const first = await f.request('/v1/jobs', { method: 'POST', body });
  const again = await f.request('/v1/jobs', { method: 'POST', body });
  assert.equal(first.status, 202);
  assert.equal(first.body.id, again.body.id);
  assert.equal((await f.request('/v1/jobs', { method: 'POST', body: JSON.stringify({ threadId, prompt: 'Different work.', requestId: 'request-unique' }) })).status, 409);
  await f.settle(first.body.id);
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
  const persisted = await readFile(join(f.dataDir, 'jobs.json'), 'utf8');
  assert.ok(persisted.includes('request-unique'));
  assert.ok(!persisted.includes('Report a connection check.'));
  assert.ok(!persisted.includes(token));
});

test('simultaneous retries reserve a single durable job', async t => {
  const f = await fixture(t, { backend: { async listThreads() { await new Promise(resolve => setTimeout(resolve, 25)); return { tasks: [{ id: threadId, status: 'idle' }] }; } } });
  const body = JSON.stringify({ threadId, prompt: 'Check once.', requestId: 'request-parallel' });
  const results = await Promise.all([f.request('/v1/jobs', { method: 'POST', body }), f.request('/v1/jobs', { method: 'POST', body })]);
  assert.deepEqual(results.map(result => result.status), [202, 202]);
  assert.equal(results[0].body.id, results[1].body.id);
});

test('serializes jobs and refuses a busy existing desktop chat', async t => {
  const f = await fixture(t, { backend: { async listThreads() { return { tasks: [{ id: threadId, status: 'active' }] }; } } });
  const result = await f.request('/v1/jobs', { method: 'POST', body: JSON.stringify({ threadId, prompt: 'Do a check.', requestId: 'request-busy' }) });
  assert.equal(result.status, 409);
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 0);
});

test('a submission with uncertain outcome is never retried', async t => {
  const f = await fixture(t, { backend: { async sendMessage() { throw new Error('transport disconnected'); } } });
  const result = await f.request('/v1/jobs', { method: 'POST', body: JSON.stringify({ threadId, prompt: 'A check.', requestId: 'request-uncertain' }) });
  const job = await f.settle(result.body.id);
  assert.equal(job.body.status, 'unknown');
  assert.equal((await f.request('/v1/jobs', { method: 'POST', body: JSON.stringify({ threadId, prompt: 'A check.', requestId: 'request-uncertain' }) })).body.id, result.body.id);
});

test('requires a matching receipt in a fresh reply before claiming completion', async t => {
  let sent = false;
  const f = await fixture(t, { backend: {
    async sendMessage() { sent = true; return { accepted: true }; },
    async waitThread() { return sent ? { cursor: 'new', status: 'completed', finalText: 'Verified. Connector receipt: request-proof.' } : { cursor: 'old', status: 'idle' }; },
  } });
  const result = await f.request('/v1/jobs', { method: 'POST', body: JSON.stringify({ threadId, prompt: 'Check.', requestId: 'request-proof' }) });
  const job = await f.settle(result.body.id);
  assert.equal(job.body.status, 'completed');
  assert.match(job.body.result, /request-proof/);
});

test('public schema and health contain no private configuration', async t => {
  const f = await fixture(t);
  const schema = await (await fetch(`${f.base}/openapi.json`)).text();
  assert.ok(schema.includes('bearerAuth'));
  assert.ok(!schema.includes(threadId));
  assert.ok(!schema.includes(f.dataDir));
  assert.ok(!schema.includes(token));
});

test('schema advertises an isolated reverse-proxy base path without widening host or origin access', async t => {
  const f = await fixture(t, { config: { publicOrigin: 'https://connector.example', publicBasePath: '/local-connector' } });
  const schema = await (await fetch(`${f.base}/openapi.json`)).json();
  assert.deepEqual(schema.servers, [{ url: 'https://connector.example/local-connector' }]);
  const withHost = host => new Promise((resolve, reject) => {
    const req = httpRequest(`${f.base}/v1/status`, { headers: { Host: host, Authorization: `Bearer ${token}` } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    req.once('error', reject); req.end();
  });
  assert.equal(await withHost('connector.example'), 200);
  assert.equal(await withHost('other.example'), 403);
  assert.equal((await f.request('/v1/status', { headers: { Origin: 'https://other.example' } })).status, 403);
});

test('rejects unsafe reverse-proxy base paths at startup', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-base-path-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  for (const publicBasePath of ['/../outside', '//elsewhere', '/with?query', '/with#fragment', '/trailing/']) {
    await assert.rejects(createConnector({ config: { dataDir, tokenSha256: 'a'.repeat(64), publicBasePath }, backend: {} }), /base.path/i);
  }
});

test('expanded mode cannot start without both recorded live proofs', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-connector-gate-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(createConnector({ config: { dataDir, tokenSha256: 'a'.repeat(64), allowAllTasks: true }, backend: {} }), /verification|proof/i);
});
