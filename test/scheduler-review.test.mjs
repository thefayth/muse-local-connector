import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnector, hasReceipt } from '../src/server.mjs';

const token = 'synthetic-ui-reservation-test-credential';
const threadIds = ['abcdefab-0000-4000-8000-000000000001', 'abcdefab-0000-4000-8000-000000000002'];

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Expected UI scheduler progress');
}

for (const turnStatus of ['failed', 'cancelled', 'interrupted']) {
  test(`a ${turnStatus} turn retains its UI lane while the native chat is still busy`, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), 'muse-ui-reservation-'));
    const sent = [], states = new Map();
    const backend = {
      async listThreads() { return { tasks: threadIds.map(id => ({ id, status: 'idle' })) }; },
      async sendMessage(id) {
        sent.push(id);
        states.set(id, { polls: [{ thread: { id, status: { type: 'active' } }, latestTurn: { id: `new-${id}`, status: 'inProgress' } }] });
      },
      async waitThread(id) { return states.get(id) || { polls: [{ cursor: `old-${id}`, thread: { id, status: { type: 'idle' } }, latestTurn: { id: `old-${id}`, status: 'completed' } }] }; },
      async close() {},
    };
    const connector = await createConnector({ config: { dataDir, port: 0, tokenSha256: createHash('sha256').update(token).digest('hex'), allowedThreadIds: threadIds }, backend, pollIntervalMs: 20 });
    await connector.listen();
    t.after(async () => { await connector.close(); await rm(dataDir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${connector.address().port}`;
    const request = async (path, body) => {
      const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(response.ok);
      return response.json();
    };
    const first = await request('/v1/jobs', { threadId: threadIds[0], requestId: `first-ui-${turnStatus}`, prompt: 'Synthetic UI action.', execution: 'ui' });
    const second = await request('/v1/jobs', { threadId: threadIds[1], requestId: `next-ui-${turnStatus}`, prompt: 'Synthetic next UI action.', execution: 'ui' });
    await until(() => sent.length === 1);
    const state = states.get(threadIds[0]);
    state.polls[0].latestTurn.status = turnStatus;
    state.polls[0].thread.status.activeFlags = ['waitingForApproval'];
    const waiting = await request(`/v1/jobs/${first.id}`);
    assert.equal(waiting.status, 'needs_user');
    assert.equal((await request(`/v1/jobs/${second.id}`)).status, 'queued');
    assert.deepEqual(sent, [threadIds[0]]);
    state.polls[0].thread.status = { type: 'idle' };
    await until(() => sent.length === 2);
    assert.equal((await request(`/v1/jobs/${first.id}`)).status, turnStatus === 'failed' ? 'failed' : 'cancelled');
    assert.deepEqual(sent, threadIds);
  });
}

test('an idempotent retry starts a durable queued job after its audit append recovers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-audit-recovery-'));
  const sent = [];
  const backend = {
    async listThreads() { return { tasks: [{ id: threadIds[0], status: 'idle' }] }; },
    async sendMessage(id) { sent.push(id); },
    async waitThread() { return { cursor: 'baseline', status: 'idle' }; },
    async close() {},
  };
  const connector = await createConnector({ config: { dataDir, port: 0, tokenSha256: createHash('sha256').update(token).digest('hex'), allowedThreadIds: threadIds }, backend, pollIntervalMs: 20 });
  await connector.listen();
  t.after(async () => { await connector.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${connector.address().port}`;
  const body = { threadId: threadIds[0], requestId: 'audit-append-recovery', prompt: 'Synthetic background action.', execution: 'background' };
  const submit = () => fetch(`${base}/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await mkdir(join(dataDir, 'audit.jsonl'));
  const failed = await submit();
  assert.equal(failed.status, 502);
  const stored = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'queued');
  assert.deepEqual(sent, []);
  await rm(join(dataDir, 'audit.jsonl'), { recursive: true });
  const retry = await submit();
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).id, stored[0].id);
  await until(() => sent.length === 1);
  const duplicate = await submit();
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).id, stored[0].id);
  await delay(60);
  assert.deepEqual(sent, [threadIds[0]]);
});

async function reviewFixture(t, controls = [], jobOverrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-review-recovery-'));
  const job = { id: 'abcdefab-0000-4000-8000-000000000003', threadId: threadIds[0], hostId: 'local', kind: 'task', execution: 'background', requestId: 'original-review-request', requestHash: 'original-private-hash', status: 'needs_review', submitted: true, baselineCursor: 'before-request', baselineTurnId: 'before-turn', afterCursor: 'reviewed-reply', createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:01:00.000Z', error: 'Original reply needs review.', ...jobOverrides };
  const history = { id: 'abcdefab-0000-4000-8000-000000000004', threadId: threadIds[1], kind: 'task', requestId: 'earlier-completed-request', status: 'completed', result: 'Earlier result.' };
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([history, job]));
  await writeFile(join(dataDir, 'controls.json'), JSON.stringify(controls));
  const calls = { waits: [], sends: [] };
  let state = { polls: [{ cursor: 'reviewed-reply', thread: { id: job.threadId, status: { type: 'idle' } }, latestTurn: { id: 'original-job-turn', status: 'completed' }, latestAssistantMessage: { id: 'recovered-message', turnId: 'original-job-turn', phase: 'final_answer', text: 'Recovered final.\nConnector receipt: original-review-request' } }] };
  const backend = {
    async listThreads() { return { tasks: [{ id: job.threadId, status: 'idle' }] }; },
    async waitThread(id, options) { calls.waits.push({ id, options }); if (state instanceof Error) throw state; return state; },
    async sendMessage(...args) { calls.sends.push(args); throw new Error('Reconciliation must not resend an instruction.'); },
    async close() {},
  };
  const connector = await createConnector({ config: { dataDir, port: 0, tokenSha256: createHash('sha256').update(token).digest('hex'), allowedThreadIds: threadIds }, backend, pollIntervalMs: 10 });
  await connector.listen();
  t.after(async () => { await connector.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${connector.address().port}`;
  const request = async path => {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { job, history, calls, state, setState(value) { state = value; }, request, saved: async () => JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8')), savedControls: async () => JSON.parse(await readFile(join(dataDir, 'controls.json'), 'utf8')) };
}

test('an explicit poll recovers a needs_review job from its original inactive chat without resending', async t => {
  const h = await reviewFixture(t);
  await delay(35);
  assert.equal(h.calls.waits.length, 0);
  assert.equal((await h.request('/v1/jobs')).jobs.find(job => job.id === h.job.id).status, 'needs_review');
  const result = await h.request(`/v1/jobs/${h.job.id}`);
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'Recovered final.\nConnector receipt: original-review-request');
  assert.equal(result.turnId, 'original-job-turn');
  assert.equal(result.error, undefined);
  assert.equal(result.id, h.job.id);
  assert.equal(result.threadId, h.job.threadId);
  assert.equal(result.requestId, h.job.requestId);
  assert.equal(result.createdAt, h.job.createdAt);
  assert.deepEqual(h.calls.waits, [{ id: h.job.threadId, options: { hostId: 'local', afterCursor: undefined, timeoutMs: 0 } }]);
  assert.deepEqual(h.calls.sends, []);
  const saved = await h.saved();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], h.history);
  assert.equal(saved[1].status, 'completed');
  assert.equal(saved[1].requestHash, h.job.requestHash);
  assert.equal(saved[1].result, result.result);
});

test('receipt correlation accepts exact plain IDs or one paired single-backtick span', () => {
  const requestId = 'synthetic-deploy-request-01';
  for (const text of ['Connector receipt: synthetic-deploy-request-01', 'Connector receipt: synthetic-deploy-request-01.', 'Connector receipt: `synthetic-deploy-request-01`', 'Finished.\nConnector receipt: `synthetic-deploy-request-01`.']) assert.equal(hasReceipt(text, requestId), true, text);
  for (const text of ['Connector receipt: synthetic-deploy-request-010', 'Connector receipt: `synthetic-deploy-request-010`', 'Connector receipt: `synthetic-deploy-request-01', 'Connector receipt: synthetic-deploy-request-01`', 'Connector receipt: ``synthetic-deploy-request-01``', 'Connector receipt: `synthetic-deploy-request-01``', 'Connector receipt: ` synthetic-deploy-request-01 `', 'Connector receipt: `synthetic-deploy-request-01`-other']) assert.equal(hasReceipt(text, requestId), false, text);
});

test('the completed synthetic final recovers needs_review while its native chat is notLoaded', async t => {
  const h = await reviewFixture(t, [], { requestId: 'synthetic-deploy-request-01' });
  const poll = h.state.polls[0];
  poll.thread.status.type = 'notLoaded';
  poll.latestTurn.id = 'abcdefab-0000-4000-8000-000000000006';
  poll.latestAssistantMessage.turnId = poll.latestTurn.id;
  poll.latestAssistantMessage.text = 'Connector receipt: `synthetic-deploy-request-01`';
  const result = await h.request(`/v1/jobs/${h.job.id}`);
  assert.equal(result.status, 'completed');
  assert.equal(result.turnId, 'abcdefab-0000-4000-8000-000000000006');
  assert.equal(result.result, 'Connector receipt: `synthetic-deploy-request-01`');
  assert.equal(result.requestId, 'synthetic-deploy-request-01');
  assert.deepEqual(h.calls.sends, []);
  assert.equal((await h.saved())[1].status, 'completed');
});

test('review reconciliation preserves the exact saved job unless the matching final is fresh and affirmatively inactive', async t => {
  for (const scenario of ['baseline turn', 'baseline cursor', 'unrelated receipt', 'busy chat', 'attention flag', 'unknown chat', 'active turn', 'failed turn', 'failed chat without turn status', 'cancelled chat without turn status', 'interrupted chat without turn status', 'notLoaded without completed turn', 'notLoaded active turn', 'notLoaded with attention', 'desktop error', 'different chat', 'transport error']) {
    await t.test(scenario, async t => {
      const h = await reviewFixture(t);
      const poll = h.state.polls[0];
      if (scenario === 'baseline turn') poll.latestTurn.id = h.job.baselineTurnId;
      if (scenario === 'baseline cursor') { delete poll.latestTurn.id; delete poll.latestAssistantMessage.turnId; poll.cursor = h.job.baselineCursor; }
      if (scenario === 'unrelated receipt') poll.latestAssistantMessage.text = 'Connector receipt: original-review-request-other';
      if (scenario === 'busy chat') poll.thread.status.type = 'active';
      if (scenario === 'attention flag') poll.thread.status.activeFlags = ['waitingForApproval'];
      if (scenario === 'unknown chat') delete poll.thread.status;
      if (scenario === 'active turn') poll.latestTurn.status = 'inProgress';
      if (scenario === 'failed turn') poll.latestTurn.status = 'failed';
      if (scenario.endsWith('chat without turn status')) { poll.thread.status.type = scenario.split(' ')[0]; delete poll.latestTurn.status; }
      if (scenario.startsWith('notLoaded')) poll.thread.status.type = 'notLoaded';
      if (scenario === 'notLoaded without completed turn') delete poll.latestTurn.status;
      if (scenario === 'notLoaded active turn') poll.latestTurn.status = 'inProgress';
      if (scenario === 'notLoaded with attention') poll.thread.status.activeFlags = ['waitingForApproval'];
      if (scenario === 'desktop error') h.state.errors = [{ message: 'Synthetic native error.' }];
      if (scenario === 'different chat') poll.thread.id = threadIds[1];
      if (scenario === 'transport error') h.setState(new Error('Synthetic connection failure.'));
      const before = (await h.request('/v1/jobs')).jobs.find(job => job.id === h.job.id);
      assert.deepEqual(await h.request(`/v1/jobs/${h.job.id}`), before);
      assert.deepEqual(await h.saved(), [h.history, h.job]);
      assert.deepEqual(h.calls.sends, []);
    });
  }
});

test('review reconciliation cannot bypass a pending control even when a final includes both receipts', async t => {
  const control = { id: 'abcdefab-0000-4000-8000-000000000005', jobId: 'abcdefab-0000-4000-8000-000000000003', requestId: 'pending-review-control', action: 'correct', effect: 'correct', status: 'requested', httpStatus: 202, jobStatus: 'needs_review' };
  const h = await reviewFixture(t, [control]);
  h.state.polls[0].latestAssistantMessage.text += '\nControl receipt: pending-review-control';
  const before = (await h.request('/v1/jobs')).jobs.find(job => job.id === h.job.id);
  assert.deepEqual(await h.request(`/v1/jobs/${h.job.id}`), before);
  assert.deepEqual(await h.saved(), [h.history, h.job]);
  assert.deepEqual(await h.savedControls(), [control]);
  assert.deepEqual(h.calls.sends, []);
});

test('a notLoaded completed same-turn final acknowledges an active control without resending', async t => {
  for (const action of ['stop', 'correct']) {
    await t.test(action, async t => {
      const control = { id: 'abcdefab-0000-4000-8000-000000000005', jobId: 'abcdefab-0000-4000-8000-000000000003', requestId: 'pending-review-control', action, effect: action, status: 'requested', httpStatus: 202, jobStatus: 'unknown' };
      const h = await reviewFixture(t, [control], { status: 'unknown', execution: 'ui' });
      h.state.polls[0].thread.status.type = 'notLoaded';
      h.state.polls[0].latestAssistantMessage.text = 'Connector receipt: `original-review-request`\nControl receipt: `pending-review-control`';
      const result = await h.request(`/v1/jobs/${h.job.id}`);
      assert.equal(result.status, action === 'stop' ? 'cancelled' : 'completed');
      assert.equal(result.turnId, 'original-job-turn');
      const status = await h.request('/v1/status');
      assert.equal(status.runningJobs, 0);
      assert.equal(status.uiLaneBusy, false);
      assert.equal((await h.savedControls())[0].status, 'completed');
      assert.deepEqual(h.calls.sends, []);
    });
  }
});

test('notLoaded control acknowledgement retains its reservation without a fresh completed same-turn final and both receipts', async t => {
  for (const scenario of ['no latest turn', 'missing turn status', 'active latest turn', 'different final turn', 'nonfinal message', 'baseline turn', 'missing job receipt', 'missing control receipt', 'attention flag']) {
    await t.test(scenario, async t => {
      const control = { id: 'abcdefab-0000-4000-8000-000000000005', jobId: 'abcdefab-0000-4000-8000-000000000003', requestId: 'pending-review-control', action: 'stop', effect: 'stop', status: 'requested', httpStatus: 202, jobStatus: 'unknown' };
      const h = await reviewFixture(t, [control], { status: 'unknown' });
      const poll = h.state.polls[0];
      poll.thread.status.type = 'notLoaded';
      poll.latestAssistantMessage.text = 'Connector receipt: original-review-request\nControl receipt: pending-review-control';
      if (scenario === 'no latest turn') delete poll.latestTurn;
      if (scenario === 'missing turn status') delete poll.latestTurn.status;
      if (scenario === 'active latest turn') poll.latestTurn.status = 'inProgress';
      if (scenario === 'different final turn') poll.latestAssistantMessage.turnId = 'different-job-turn';
      if (scenario === 'nonfinal message') poll.latestAssistantMessage.phase = 'commentary';
      if (scenario === 'baseline turn') { poll.latestTurn.id = h.job.baselineTurnId; poll.latestAssistantMessage.turnId = h.job.baselineTurnId; }
      if (scenario === 'missing job receipt') poll.latestAssistantMessage.text = 'Control receipt: pending-review-control';
      if (scenario === 'missing control receipt') poll.latestAssistantMessage.text = 'Connector receipt: original-review-request';
      if (scenario === 'attention flag') poll.thread.status.activeFlags = ['waitingForApproval'];
      const result = await h.request(`/v1/jobs/${h.job.id}`);
      assert.ok(['unknown', 'needs_user'].includes(result.status));
      assert.equal(result.pendingControlId, control.id);
      assert.equal((await h.request('/v1/status')).runningJobs, 1);
      assert.deepEqual(await h.savedControls(), [control]);
      assert.deepEqual(h.calls.sends, []);
    });
  }
});
