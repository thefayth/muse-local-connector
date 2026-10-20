import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnector } from '../src/server.mjs';

const threadId = '20000000-0000-4000-8000-000000000001';
const token = 'synthetic-review-credential-for-tests-only';

function nativeState({ turnId = 'baseline-turn', status = 'completed', text = 'Old reply', cursor = 'baseline-cursor', error = null } = {}) {
  return {
    timedOut: false,
    polls: [{
      cursor,
      changed: true,
      thread: { id: threadId, hostId: 'local', status: { type: status === 'inProgress' ? 'active' : 'idle' } },
      latestTurn: { id: turnId, status, error },
      ...(text ? { latestAssistantMessage: { turnId, phase: status === 'completed' ? 'final_answer' : 'commentary', text } } : {}),
    }],
  };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-review-'));
  let sent = 0;
  const backend = {
    async listThreads() { return { tasks: [{ id: threadId, title: 'Synthetic existing task', status: 'idle' }] }; },
    async readThread() { return { thread: { id: threadId, status: 'idle' } }; },
    async sendMessage() { sent++; },
    async waitThread() { return options.state ? options.state(sent) : nativeState(); },
    async close() {},
  };
  const connector = await createConnector({ config: { dataDir, port: 0, tokenSha256: createHash('sha256').update(token).digest('hex'), allowedThreadIds: [threadId], allowAllTasks: false }, backend });
  await connector.listen();
  t.after(async () => { await connector.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${connector.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const submit = requestId => request('/v1/jobs', { threadId, requestId, prompt: 'Perform the synthetic check.' });
  const settle = async id => {
    let result;
    for (let i = 0; i < 20; i++) {
      result = await request(`/v1/jobs/${id}`);
      if (!['queued', 'submitting'].includes(result.body.status)) return result.body;
      await delay(5);
    }
    return result.body;
  };
  return { request, submit, settle, sent: () => sent };
}

test('correlates replies using the actual nested desktop wait shape', async t => {
  const f = await fixture(t, { state: sent => sent ? nativeState({ turnId: 'fresh-turn', cursor: 'fresh-cursor', text: 'Verified. Connector receipt: native-shape-proof' }) : nativeState() });
  const accepted = await f.submit('native-shape-proof');
  assert.equal(accepted.status, 202);
  const job = await f.settle(accepted.body.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.turnId, 'fresh-turn');
});

test('does not send if the fresh baseline finds work started after the catalog read', async t => {
  const f = await fixture(t, { state: () => nativeState({ status: 'inProgress', text: null }) });
  const accepted = await f.submit('busy-baseline-proof');
  await f.settle(accepted.body.id);
  assert.equal(f.sent(), 0, 'An active baseline must block the native send');
});

for (const status of ['failed', 'cancelled', 'interrupted']) {
  test(`a fresh native ${status} turn releases the job with a terminal status`, async t => {
    const f = await fixture(t, { state: sent => sent ? nativeState({ turnId: 'fresh-turn', cursor: 'fresh-cursor', status, text: null, error: status === 'failed' ? { message: 'Synthetic execution failed' } : null }) : nativeState() });
    const accepted = await f.submit(`native-${status}-proof`);
    const job = await f.settle(accepted.body.id);
    assert.equal(job.status, status === 'interrupted' ? 'cancelled' : status);
  });
}

test('a prior final reply cannot complete a new job even if it contains its request ID', async t => {
  const f = await fixture(t, { state: () => nativeState({ text: 'Connector receipt: old-turn-proof' }) });
  const accepted = await f.submit('old-turn-proof');
  const job = await f.settle(accepted.body.id);
  assert.notEqual(job.status, 'completed');
});

test('a longer receipt ID cannot satisfy a different job', async t => {
  const f = await fixture(t, { state: sent => sent ? nativeState({ turnId: 'fresh-turn', cursor: 'fresh-cursor', text: 'Connector receipt: short-receipt-extra' }) : nativeState() });
  const accepted = await f.submit('short-receipt');
  const job = await f.settle(accepted.body.id);
  assert.notEqual(job.status, 'completed');
});

test('desktop approval flags surface as needs_user while a turn is in progress', async t => {
  const f = await fixture(t, { state: sent => {
    if (!sent) return nativeState();
    const state = nativeState({ turnId: 'fresh-turn', status: 'inProgress', text: null });
    state.polls[0].thread.status.activeFlags = ['waitingOnApproval'];
    return state;
  } });
  const accepted = await f.submit('approval-flag-proof');
  assert.equal((await f.settle(accepted.body.id)).status, 'needs_user');
});

for (const requestId of [12345678, ['array-request-id'], { toString: 'object-request-id' }]) {
  test(`rejects a ${Array.isArray(requestId) ? 'array' : typeof requestId} request ID before touching the desktop`, async t => {
    const f = await fixture(t);
    const result = await f.submit(requestId);
    assert.equal(result.status, 400);
    assert.equal(f.sent(), 0);
    assert.deepEqual((await f.request('/v1/jobs')).body.jobs, []);
  });
}

test('a final-answer message keeps the job reserved until its native turn completes', async t => {
  let completed = false;
  const f = await fixture(t, { state: sent => {
    if (!sent) return nativeState();
    const state = nativeState({ turnId: 'fresh-turn', cursor: completed ? 'completed-cursor' : 'streaming-cursor', status: completed ? 'completed' : 'inProgress', text: 'Connector receipt: streaming-final-proof' });
    state.polls[0].latestAssistantMessage.phase = 'final_answer';
    return state;
  } });
  const accepted = await f.submit('streaming-final-proof');
  assert.equal((await f.settle(accepted.body.id)).status, 'running');
  const queued = await f.submit('another-request-while-active');
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, 'queued');
  assert.equal(f.sent(), 1);
  completed = true;
  assert.equal((await f.request(`/v1/jobs/${accepted.body.id}`)).body.status, 'completed');
  assert.equal((await f.submit('another-request-after-completion')).status, 202);
});

test('a snapshot without a native turn status must become idle before its final answer completes', async t => {
  let active = true;
  const f = await fixture(t, { state: sent => sent ? {
    polls: [{
      cursor: active ? 'active-message-cursor' : 'idle-message-cursor',
      thread: { id: threadId, status: { type: active ? 'active' : 'idle' } },
      latestAssistantMessage: { turnId: 'fresh-message-turn', phase: 'final_answer', text: 'Connector receipt: cloud-final-proof' },
    }],
  } : nativeState() });
  const accepted = await f.submit('cloud-final-proof');
  assert.equal((await f.settle(accepted.body.id)).status, 'running');
  active = false;
  assert.equal((await f.request(`/v1/jobs/${accepted.body.id}`)).body.status, 'completed');
});
