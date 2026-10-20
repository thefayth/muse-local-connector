import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnector } from '../src/server.mjs';

const token = 'synthetic-concurrency-test-credential';
const ids = Array.from({ length: 8 }, (_, index) => `abcdefab-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const credentialHash = createHash('sha256').update(token).digest('hex');

async function until(check, message = 'Expected scheduler progress') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function fixture(t, options = {}) {
  const dataDir = options.dataDir || await mkdtemp(join(tmpdir(), 'muse-concurrent-'));
  const calls = [];
  const states = new Map();
  let checks = 0;
  let closed = false;
  const backend = {
    async listThreads() { return { tasks: ids.map(id => ({ id, status: 'idle' })) }; },
    async readThread(id) { return { thread: { id, status: 'idle' } }; },
    async sendMessage(id, prompt, host) {
      calls.push({ id, prompt, host });
      const requestId = prompt.match(/receipt ([A-Za-z0-9._:-]+)/)[1].replace(/\.$/, '');
      states.set(id, { cursor: `active-${calls.length}`, turnId: `turn-${calls.length}`, status: 'running', requestId });
    },
    async waitThread(id) { checks++; return states.get(id) || { cursor: `baseline-${id}`, turnId: `old-${id}`, status: 'idle' }; },
    async close() { closed = true; },
    ...options.backend,
  };
  const config = { dataDir, port: 0, tokenSha256: credentialHash, allowedThreadIds: ids, ...options.config };
  const connector = await createConnector({ config, backend, pollIntervalMs: 20 });
  await connector.listen();
  const base = `http://127.0.0.1:${connector.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const submit = (index, extra = {}) => request('/v1/jobs', { threadId: ids[index], prompt: `Synthetic work ${index}.`, requestId: `concurrent-job-${index}`, execution: 'background', ...extra });
  const finish = (index, text) => {
    const state = states.get(ids[index]);
    assert.ok(state, 'The job must have started before finishing it');
    states.set(ids[index], { ...state, cursor: `${state.cursor}-done`, status: 'completed', finalText: text || `Done. Connector receipt: ${state.requestId}` });
  };
  let disposed = false;
  const close = async () => { if (!disposed) { disposed = true; await connector.close(); } };
  t.after(async () => { await close(); if (!options.keepData) await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, connector, backend, calls, states, submit, finish, request, close, checks: () => checks, closed: () => closed };
}

test('runs four independent background jobs and automatically advances a durable fifth job', async t => {
  const f = await fixture(t);
  const jobs = await Promise.all(ids.slice(0, 5).map((_, index) => f.submit(index)));
  assert.deepEqual(jobs.map(job => job.status), [202, 202, 202, 202, 202]);
  await until(() => f.calls.length === 4);
  const waiting = await f.request(`/v1/jobs/${jobs[4].body.id}`);
  assert.equal(waiting.body.status, 'queued');
  assert.ok(waiting.body.waitingFor.includes('capacity'));
  const stored = await readFile(join(f.dataDir, 'jobs.json'), 'utf8');
  assert.ok(!stored.includes('Synthetic work'));
  const payloads = JSON.parse(await readFile(join(f.dataDir, 'pending-jobs.json'), 'utf8'));
  assert.equal(payloads[jobs[4].body.id], 'Synthetic work 4.');
  assert.ok(!JSON.stringify((await f.request('/v1/jobs')).body).includes('Synthetic work'));
  f.finish(0);
  await until(() => f.calls.length === 5, 'Autonomous polling must free capacity without Muse polling');
  const status = (await f.request('/v1/status')).body;
  assert.equal(status.serializedJobs, false);
  assert.equal(status.maxConcurrentJobs, 4);
  assert.equal(status.runningJobs, 4);
  assert.equal(status.queuedJobs, 0);
  assert.match(f.calls[0].prompt, /Do not use browser|Do not use any browser/i);
});

test('reserves capacity while native sends are still pending', async t => {
  const gates = [];
  const f = await fixture(t, { backend: { async sendMessage() { await new Promise(resolve => gates.push(resolve)); } } });
  t.after(() => { for (const release of gates) release(); });
  const jobs = await Promise.all(ids.slice(0, 5).map((_, index) => f.submit(index)));
  await until(() => gates.length === 4);
  assert.equal((await f.request(`/v1/jobs/${jobs[4].body.id}`)).body.status, 'queued');
  assert.equal((await f.request('/v1/status')).body.runningJobs, 4);
  for (const release of gates) release();
});

test('restart under a narrowed pilot scope durably rejects removed queued chats without dispatch or replay', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-narrowed-scope-'));
  const history = { id: 'abcdefab-0000-4000-8000-000000000009', threadId: ids[0], requestId: 'scope-earlier-job', status: 'completed', submitted: true, result: 'Earlier preserved result.' };
  const queued = { id: 'abcdefab-0000-4000-8000-000000000010', threadId: ids[1], requestId: 'scope-removed-queued', kind: 'task', execution: 'background', status: 'queued', submitted: false };
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([history, queued]));
  await writeFile(join(dataDir, 'pending-jobs.json'), JSON.stringify({ [queued.id]: 'Do not send this removed-scope instruction.' }));
  let targetReads = 0;
  const backend = { async waitThread() { targetReads++; return { status: 'idle' }; } };
  const f = await fixture(t, { dataDir, keepData: true, config: { allowedThreadIds: [ids[0]] }, backend });
  await until(async () => (await f.request(`/v1/jobs/${queued.id}`)).body.status === 'failed');
  await f.close();
  const saved = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'));
  assert.deepEqual(saved[0], history);
  assert.equal(saved[1].id, queued.id);
  assert.equal(saved[1].requestId, queued.requestId);
  assert.equal(saved[1].submitted, false);
  assert.equal(saved[1].submissionErrorCode, 'thread_not_allowed');
  assert.equal(saved[1].submissionErrorPhase, 'before_send');
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'pending-jobs.json'), 'utf8')), {});
  assert.deepEqual(f.calls, []);
  assert.equal(targetReads, 0);
  const restarted = await fixture(t, { dataDir, config: { allowedThreadIds: [ids[0]] }, backend });
  assert.equal((await restarted.request(`/v1/jobs/${queued.id}`)).body.status, 'failed');
  assert.deepEqual(restarted.calls, []);
  assert.equal(targetReads, 0);
});

test('serializes the same chat across UUID casing and omitted or explicit host aliases', async t => {
  const f = await fixture(t);
  const first = await f.submit(0);
  const second = await f.submit(0, { threadId: ids[0].toUpperCase(), hostId: 'local', requestId: 'same-chat-followup' });
  assert.equal(second.status, 202);
  await until(() => f.calls.length === 1);
  const waiting = (await f.request(`/v1/jobs/${second.body.id}`)).body;
  assert.equal(waiting.status, 'queued');
  assert.ok(waiting.waitingFor.includes('chat'));
  assert.deepEqual(waiting.blockingJobIds, [first.body.id]);
  f.finish(0);
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].id, ids[0]);
});

test('holds one global UI lane while independent background jobs continue', async t => {
  const f = await fixture(t);
  const first = await f.submit(0, { execution: 'ui' });
  const second = await f.submit(1, { execution: undefined, hostId: 'another-host' });
  const background = await f.submit(2);
  await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls.map(call => call.id).sort(), [ids[0], ids[2]].sort());
  const waiting = (await f.request(`/v1/jobs/${second.body.id}`)).body;
  assert.equal(waiting.execution, 'ui');
  assert.ok(waiting.waitingFor.includes('ui'));
  assert.deepEqual(waiting.blockingJobIds, [first.body.id]);
  assert.equal(background.status, 202);
  f.finish(0);
  await until(() => f.calls.length === 3);
  assert.equal(f.calls[2].id, ids[1]);
});

test('requires UI execution for computer jobs and validates the execution class', async t => {
  const f = await fixture(t);
  for (const extra of [{ kind: 'computer', execution: 'background' }, { execution: 'desktop' }, { execution: null }]) {
    assert.equal((await f.submit(0, extra)).status, 400);
  }
  assert.equal(f.calls.length, 0);
  const accepted = await f.submit(0, { kind: 'computer', execution: undefined });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.execution, 'ui');
});

test('accepts an adjustable capacity and rejects invalid limits', async t => {
  const f = await fixture(t, { config: { maxConcurrentJobs: 2 } });
  await Promise.all([f.submit(0), f.submit(1), f.submit(2)]);
  await until(() => f.calls.length === 2);
  assert.equal((await f.request('/v1/status')).body.maxConcurrentJobs, 2);
  for (const maxConcurrentJobs of [0, 33, -1, 1.5, '4', null]) {
    await assert.rejects(createConnector({ config: { dataDir: f.dataDir, tokenSha256: credentialHash, maxConcurrentJobs }, backend: {} }), /maxConcurrentJobs/);
  }
});

test('concurrent idempotent retries create and execute one job', async t => {
  const f = await fixture(t, { backend: { async listThreads() { await delay(20); return { tasks: ids.map(id => ({ id, status: 'idle' })) }; } } });
  const results = await Promise.all(Array.from({ length: 6 }, () => f.submit(0)));
  assert.deepEqual(results.map(result => result.status), Array(6).fill(202));
  assert.equal(new Set(results.map(result => result.body.id)).size, 1);
  await until(() => f.calls.length === 1);
  assert.equal((await f.submit(0, { prompt: 'Conflicting payload.' })).status, 409);
});

test('an exact legacy retry preserves idempotency when its original UUID used uppercase', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-legacy-uppercase-'));
  const body = { threadId: ids[0].toUpperCase(), prompt: 'Original legacy instruction.', kind: 'task', requestId: 'legacy-uppercase-request' };
  const legacy = { id: 'abcdefab-0000-4000-8000-000000000011', threadId: body.threadId, kind: body.kind, requestId: body.requestId, requestHash: createHash('sha256').update(JSON.stringify({ threadId: body.threadId, hostId: null, prompt: body.prompt, kind: body.kind })).digest('hex'), status: 'completed', submitted: true, result: 'Original preserved final.' };
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([legacy]));
  const f = await fixture(t, { dataDir });
  const retry = await f.request('/v1/jobs', body);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.id, legacy.id);
  assert.equal(retry.body.threadId, ids[0]);
  assert.equal(retry.body.result, legacy.result);
  assert.equal((await f.request('/v1/jobs', { ...body, prompt: 'Changed legacy instruction.' })).status, 409);
  assert.deepEqual(f.calls, []);
  const saved = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].requestHash, legacy.requestHash);
});

test('uncertain submissions block only their own chat and UI lane, without retrying', async t => {
  let attempts = 0;
  const f = await fixture(t, { backend: { async sendMessage(id) { attempts++; if (id === ids[0]) throw new Error('Synthetic uncertain send'); } } });
  const unknown = await f.submit(0, { execution: 'ui' });
  await until(async () => (await f.request(`/v1/jobs/${unknown.body.id}`)).body.status === 'unknown');
  const same = await f.submit(0, { requestId: 'uncertain-followup' });
  const ui = await f.submit(1, { execution: 'ui' });
  const background = await f.submit(2);
  await until(() => attempts === 2);
  assert.equal((await f.request(`/v1/jobs/${same.body.id}`)).body.status, 'queued');
  assert.equal((await f.request(`/v1/jobs/${ui.body.id}`)).body.status, 'queued');
  assert.equal((await f.request(`/v1/jobs/${background.body.id}`)).body.status, 'running');
  await delay(60);
  assert.equal(attempts, 2);
});

test('an idle fresh reply without a receipt releases its UI lane as needs_review', async t => {
  const f = await fixture(t);
  const first = await f.submit(0, { execution: 'ui' });
  await f.submit(1, { execution: 'ui' });
  await until(() => f.calls.length === 1);
  f.finish(0, 'A fresh reply without the connector receipt.');
  await until(() => f.calls.length === 2);
  assert.equal((await f.request(`/v1/jobs/${first.body.id}`)).body.status, 'needs_review');
});

test('uncertain jobs keep capacity reserved until native correlation safely resolves them', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-uncertain-capacity-'));
  const jobs = ids.slice(0, 4).map((threadId, index) => ({ id: ids[index + 4], threadId, status: 'running', execution: 'background', submitted: true, kind: 'task', requestId: `old-uncertain-${index}`, baselineCursor: `before-${index}` }));
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify(jobs));
  const f = await fixture(t, { dataDir });
  const queued = await f.submit(4);
  assert.equal(queued.status, 202);
  await delay(60);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/v1/status')).body.runningJobs, 4);
  f.states.set(ids[0], { cursor: 'resolved', status: 'completed', finalText: 'Connector receipt: old-uncertain-0' });
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].id, ids[4]);
});

test('an approved native turn returns from needs_user to running', async t => {
  const f = await fixture(t);
  const first = await f.submit(0);
  await until(() => f.calls.length === 1);
  f.states.set(ids[0], { cursor: 'approval', status: 'waitingForApproval' });
  await until(async () => (await f.request(`/v1/jobs/${first.body.id}`)).body.status === 'needs_user');
  f.states.set(ids[0], { cursor: 'approved', status: 'running' });
  await until(async () => (await f.request(`/v1/jobs/${first.body.id}`)).body.status === 'running');
});

test('progress belonging to another chat cannot complete a job or release its resources', async t => {
  let submitted = false;
  const f = await fixture(t, { backend: {
    async sendMessage() { submitted = true; },
    async waitThread() { return submitted ? { polls: [{ thread: { id: ids[1], status: 'idle' }, latestTurn: { id: 'wrong-chat-turn', status: 'completed' }, latestAssistantMessage: { phase: 'final_answer', text: 'Connector receipt: concurrent-job-0' } }] } : { cursor: 'old', status: 'idle' }; },
  } });
  const first = await f.submit(0, { execution: 'ui' });
  const second = await f.submit(1, { execution: 'ui' });
  await until(() => submitted);
  const job = (await f.request(`/v1/jobs/${first.body.id}`)).body;
  assert.equal(job.status, 'running');
  assert.match(job.error, /different chat/);
  assert.equal((await f.request(`/v1/jobs/${second.body.id}`)).body.status, 'queued');
});

test('restart resumes only durable never-attempted jobs and never replays uncertain work', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-restart-queue-'));
  const makeJob = (id, threadId, status, execution = 'ui') => ({ id, threadId, status, execution, submitted: false, kind: 'task', requestId: id, requestHash: 'synthetic-hash', createdAt: '2026-01-01T00:00:00Z' });
  const jobs = [makeJob('prior-submitting', ids[0], 'submitting'), makeJob('waiting-ui', ids[1], 'queued'), makeJob('waiting-background', ids[2], 'queued', 'background'), makeJob('missing-payload', ids[3], 'queued', 'background')];
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify(jobs));
  await writeFile(join(dataDir, 'pending-jobs.json'), JSON.stringify({ 'prior-submitting': 'Must never replay.', 'waiting-ui': 'UI after safe reconciliation.', 'waiting-background': 'Safe queued work.' }));
  const f = await fixture(t, { dataDir });
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].id, ids[2]);
  const stored = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'));
  assert.equal(stored.find(job => job.id === 'prior-submitting').status, 'unknown');
  assert.equal(stored.find(job => job.id === 'missing-payload').status, 'unknown');
  assert.equal(stored.find(job => job.id === 'waiting-ui').status, 'queued');
  assert.ok(!JSON.stringify(JSON.parse(await readFile(join(dataDir, 'pending-jobs.json'), 'utf8'))).includes('Must never replay.'));
});

test('closing the connector stops autonomous polling and leaves queued work unsent', async t => {
  const f = await fixture(t);
  await f.submit(0, { execution: 'ui' });
  await f.submit(1, { execution: 'ui' });
  await until(() => f.calls.length === 1 && f.checks() > 1);
  await f.close();
  const checks = f.checks();
  f.finish(0);
  await delay(80);
  assert.equal(f.checks(), checks);
  assert.equal(f.calls.length, 1);
  assert.equal(f.closed(), true);
});
