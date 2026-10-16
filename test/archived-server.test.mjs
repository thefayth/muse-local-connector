import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnector } from '../src/server.mjs';

const token = 'synthetic-archive-test-credential';
const archivedId = '30000000-0000-4000-8000-000000000001';

async function fixture(t, expanded = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-archive-test-'));
  const jobs = ['task', 'computer'].map(kind => ({ id: `verified-${kind}`, kind, requestId: `verified-${kind}`, status: 'completed', result: `Connector receipt: verified-${kind}` }));
  const verification = Object.fromEntries(jobs.map(job => [job.kind, { jobId: job.id, verifiedAt: '2026-01-01T00:00:00Z' }]));
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify(jobs));
  await writeFile(join(dataDir, 'verification.json'), JSON.stringify(verification));
  const calls = [];
  const backend = {
    async listThreads(options) {
      calls.push(options);
      return { tasks: [{ id: archivedId, title: 'Archived task', kind: options.source, archived: true }], nextCursor: 'next-native:opaque-cursor', partial: false, coverage: { source: options.source, archived: 'paginated' } };
    },
    async close() {},
    async sendMessage() { throw new Error('Archive discovery must never send a message'); },
  };
  const connector = await createConnector({ config: { dataDir, port: 0, tokenSha256: createHash('sha256').update(token).digest('hex'), allowAllTasks: expanded, allowedThreadIds: [] }, backend });
  await connector.listen();
  t.after(async () => { await connector.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async suffix => {
    const response = await fetch(`http://127.0.0.1:${connector.address().port}/v1/tasks${suffix}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  };
  return { request, calls };
}

test('expanded archive discovery forwards native source and opaque cursor without sending or restoring chats', async t => {
  const f = await fixture(t);
  const response = await f.request('?archived=true&source=chatgpt&limit=10&cursor=previous-native%3Aopaque-cursor');
  assert.equal(response.status, 200);
  assert.equal(response.body.tasks[0].archived, true);
  assert.equal(response.body.nextCursor, 'next-native:opaque-cursor');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].archived, true);
  assert.equal(f.calls[0].source, 'chatgpt');
  assert.equal(f.calls[0].cursor, 'previous-native:opaque-cursor');
  assert.equal(f.calls[0].limit, 10);
});

test('pilot scope cannot enumerate archived chats', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request('?archived=true&source=codex')).status, 403);
  assert.equal(f.calls.length, 0);
});

test('archive discovery rejects unsupported sources before any native call', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('?archived=true&source=untrusted')).status, 400);
  assert.equal(f.calls.length, 0);
});
