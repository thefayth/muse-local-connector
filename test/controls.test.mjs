import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnector } from '../src/server.mjs';

const token = 'synthetic-private-control-test-credential';
const threads = [1, 2, 3].map(value => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`);
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { seed, allowedThreadIds = threads, backend: overrides, maxConcurrentJobs = 1 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-controls-test-'));
  if (seed) for (const [file, value] of Object.entries(seed)) await writeFile(join(dataDir, file), JSON.stringify(value));
  const calls = [];
  const states = new Map();
  const backend = {
    async listThreads() { return { tasks: threads.map(id => ({ id, status: 'idle' })) }; },
    async readThread(id) { return { thread: { id, status: 'idle' } }; },
    async sendMessage(id, prompt) { calls.push({ id, prompt }); states.set(id, { cursor: `active-${calls.length}`, status: 'running' }); },
    async waitThread(id) { return states.get(id) || { cursor: `baseline-${id}`, status: 'idle' }; },
    async close() {},
    ...overrides,
  };
  const config = { dataDir, port: 0, tokenSha256: hash(token), allowedThreadIds, maxConcurrentJobs };
  let connector;
  let base;
  const start = async () => { connector = await createConnector({ config, backend }); await connector.listen(); base = `http://127.0.0.1:${connector.address().port}`; };
  await start();
  t.after(async () => { await connector.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const submit = (threadId, requestId, prompt = 'Original queued private instruction.') => request('/v1/jobs', { threadId, requestId, prompt, execution: 'background' });
  const control = (id, requestId, action, prompt) => request(`/v1/jobs/${id}/controls`, { requestId, action, ...(prompt === undefined ? {} : { prompt }) });
  const waitStatus = async (id, status) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request(`/v1/jobs/${id}`);
      if (result.body.status === status) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Synthetic job did not reach ${status}`);
  };
  return { dataDir, calls, states, request, submit, control, waitStatus, restart: async () => { await connector.close(); await start(); } };
}

async function blockedJob(f) {
  const active = await f.submit(threads[0], 'active-blocker');
  await f.waitStatus(active.body.id, 'running');
  const queued = await f.submit(threads[1], 'queued-original');
  assert.equal(queued.body.status, 'queued');
  assert.deepEqual(queued.body.waitingFor, ['capacity']);
  return { active: active.body, queued: queued.body };
}

test('editing a queued job preserves submit idempotency and dispatches only the revised prompt', async t => {
  const f = await fixture(t);
  const { active, queued } = await blockedJob(f);
  const edited = await f.control(queued.id, 'edit-pending-unique', 'edit', 'Revised queued private instruction.');
  assert.equal(edited.status, 200);
  assert.equal(edited.body.status, 'completed');
  assert.equal(edited.body.revision, 1);
  const originalRetry = await f.submit(threads[1], 'queued-original');
  assert.equal(originalRetry.status, 202);
  assert.equal(originalRetry.body.id, queued.id);
  assert.equal(originalRetry.body.revision, 1);
  assert.equal((await f.control(queued.id, 'edit-pending-unique', 'edit', 'Revised queued private instruction.')).body.id, edited.body.id);
  assert.equal((await f.control(queued.id, 'edit-pending-unique', 'edit', 'Changed instruction.')).status, 409);
  f.states.set(threads[0], { cursor: 'completed-blocker', status: 'completed', finalText: `Done. Connector receipt: ${active.requestId}` });
  await f.waitStatus(active.id, 'completed');
  await f.waitStatus(queued.id, 'running');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].prompt.endsWith('Revised queued private instruction.'));
  assert.ok(!f.calls[1].prompt.includes('Original queued private instruction.'));
  const jobs = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'));
  assert.equal(jobs.find(job => job.id === queued.id).requestHash, hash(JSON.stringify({ threadId: threads[1], hostId: null, prompt: 'Original queued private instruction.', kind: 'task', execution: 'background' })));
});

test('simultaneous exact control retries produce one receipt and one revision', async t => {
  const f = await fixture(t);
  const { queued } = await blockedJob(f);
  const responses = await Promise.all([f.control(queued.id, 'edit-concurrent-retry', 'edit', 'One revised prompt.'), f.control(queued.id, 'edit-concurrent-retry', 'edit', 'One revised prompt.')]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.deepEqual(responses[0].body, responses[1].body);
  assert.equal(responses[0].body.revision, 1);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'controls.json'), 'utf8')).length, 1);
});

test('queued cancellation retains history, never dispatches the cancelled job, and allows the next job to advance', async t => {
  const f = await fixture(t);
  const { active, queued } = await blockedJob(f);
  const next = await f.submit(threads[2], 'after-cancel-next', 'Next queued instruction.');
  const cancelled = await f.control(queued.id, 'cancel-pending-unique', 'cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.jobStatus, 'cancelled');
  assert.deepEqual((await f.control(queued.id, 'cancel-pending-unique', 'cancel')).body, cancelled.body);
  assert.equal((await f.request(`/v1/jobs/${queued.id}`)).body.status, 'cancelled');
  assert.equal((await f.submit(threads[1], 'queued-original')).body.id, queued.id);
  assert.ok((await f.request('/v1/jobs')).body.jobs.some(job => job.id === queued.id));
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'pending-jobs.json'), 'utf8'))[queued.id], undefined);
  f.states.set(threads[0], { cursor: 'finished-active', status: 'completed', finalText: `Done. Connector receipt: ${active.requestId}` });
  await f.waitStatus(active.id, 'completed');
  await f.waitStatus(next.body.id, 'running');
  assert.deepEqual(f.calls.map(call => call.id), [threads[0], threads[2]]);
});

test('queued-only edit rejection is durable across a restart and never claims the native task stopped', async t => {
  const f = await fixture(t);
  const active = await f.submit(threads[0], 'active-control-target');
  await f.waitStatus(active.body.id, 'running');
  const rejected = await f.control(active.body.id, 'edit-active-rejected', 'edit', 'A queued-only edit.');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.status, 'rejected');
  assert.equal(rejected.body.jobStatus, 'running');
  await f.restart();
  const retry = await f.control(active.body.id, 'edit-active-rejected', 'edit', 'A queued-only edit.');
  assert.equal(retry.status, 409);
  assert.deepEqual(retry.body, rejected.body);
  assert.equal(f.calls.length, 1);
});

test('cooperative stop sends once and retains capacity until its fresh inactive native acknowledgement', async t => {
  const f = await fixture(t);
  const { active, queued } = await blockedJob(f);
  const requested = await f.control(active.id, 'active-stop-once', 'stop');
  assert.equal(requested.status, 202);
  assert.equal(requested.body.status, 'requested');
  assert.equal(requested.body.effect, 'stop');
  assert.deepEqual((await f.control(active.id, 'active-stop-once', 'stop')).body, requested.body);
  assert.equal((await f.control(active.id, 'another-pending-stop', 'stop')).status, 409);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].prompt, /cooperative stop/);
  assert.match(f.calls[1].prompt, /Execution class: background/);
  assert.match(f.calls[1].prompt, /Do not use browser/);
  f.states.set(threads[0], { cursor: 'original-final', status: 'completed', finalText: `Original done. Connector receipt: ${active.requestId}` });
  assert.equal((await f.request(`/v1/jobs/${active.id}`)).body.status, 'running');
  assert.equal((await f.request('/v1/status')).body.runningJobs, 1);
  assert.equal((await f.request(`/v1/jobs/${queued.id}`)).body.status, 'queued');
  const finalText = `Stopped. Connector receipt: ${active.requestId} Control receipt: active-stop-once`;
  f.states.set(threads[0], { cursor: 'stop-final-busy', status: 'running', finalText });
  assert.equal((await f.request(`/v1/jobs/${active.id}`)).body.status, 'running');
  f.states.set(threads[0], { polls: [{ cursor: 'stop-final-unknown', thread: { id: threads[0], status: { type: 'unknown' } }, latestTurn: { id: 'active-stop-turn', status: 'completed' }, latestAssistantMessage: { turnId: 'active-stop-turn', phase: 'final_answer', text: finalText } }] });
  assert.equal((await f.request(`/v1/jobs/${active.id}`)).body.status, 'running');
  f.states.set(threads[0], { cursor: 'stop-final-idle', status: 'completed', finalText });
  assert.equal((await f.request(`/v1/jobs/${active.id}`)).body.status, 'cancelled');
  const completed = await f.control(active.id, 'active-stop-once', 'stop');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.status, 'completed');
  await f.waitStatus(queued.id, 'running');
  assert.equal(f.calls.length, 3);
});

test('active cancel aliases cooperative stop and correct steers the same job without creating a duplicate', async t => {
  const f = await fixture(t, { maxConcurrentJobs: 2 });
  const first = await f.submit(threads[0], 'correct-active-original', 'Original active private instruction.');
  const second = await f.submit(threads[1], 'cancel-active-original');
  await f.waitStatus(first.body.id, 'running'); await f.waitStatus(second.body.id, 'running');
  const original = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8')).find(job => job.id === first.body.id);
  const corrected = await f.control(first.body.id, 'correct-active-once', 'correct', 'Corrected active private instruction.');
  assert.equal(corrected.status, 202);
  assert.equal(corrected.body.revision, 1);
  assert.ok(f.calls.findLast(call => call.id === threads[0]).prompt.includes('Corrected active private instruction.'));
  assert.equal((await f.control(second.body.id, 'cancel-active-once', 'cancel')).body.effect, 'stop');
  const retry = await f.submit(threads[0], 'correct-active-original', 'Original active private instruction.');
  assert.equal(retry.body.id, first.body.id);
  assert.equal(retry.body.execution, 'background');
  assert.equal(retry.body.revision, 1);
  f.states.set(threads[0], { cursor: 'corrected-final', status: 'completed', finalText: 'Corrected final. Connector receipt: correct-active-original Control receipt: correct-active-once' });
  assert.equal((await f.request(`/v1/jobs/${first.body.id}`)).body.status, 'completed');
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'));
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find(job => job.id === first.body.id).requestHash, original.requestHash);
  assert.equal(f.calls.length, 4);
  assert.equal((await f.control(first.body.id, 'correct-active-once', 'correct', 'Corrected active private instruction.')).status, 200);
});

test('queued stop and correct aliases retain queued cancellation and edit semantics', async t => {
  const f = await fixture(t);
  const { queued } = await blockedJob(f);
  assert.equal((await f.control(queued.id, 'correct-queued-alias', 'correct', 'Revised through correct.')).body.effect, 'edit');
  assert.equal((await f.control(queued.id, 'stop-queued-alias', 'stop')).body.jobStatus, 'cancelled');
  assert.equal(f.calls.length, 1);
});

test('an old in-flight poll cannot mutate job state after control admission', async t => {
  let release;
  let entered;
  let pause = false;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { backend: { async waitThread(id) {
    if (pause) { pause = false; entered(); return new Promise(resolve => { release = resolve; }); }
    return { cursor: `baseline-${id}`, status: 'idle' };
  } } });
  const active = await f.submit(threads[0], 'old-poll-original');
  await f.waitStatus(active.body.id, 'running');
  pause = true;
  const oldPoll = f.request(`/v1/jobs/${active.body.id}`);
  await enteredPromise;
  const control = await f.control(active.body.id, 'old-poll-stop', 'stop');
  assert.equal(control.status, 202);
  release({ cursor: 'stale-awaiting-owner', status: 'waitingForUser' });
  assert.equal((await oldPoll).body.status, 'running');
  assert.equal((await f.request(`/v1/jobs/${active.body.id}`)).body.status, 'running');
});

test('an uncertain control send remains reserved across retry and restart without being resent', async t => {
  let sends = 0;
  const f = await fixture(t, { backend: { async sendMessage() { sends++; if (sends > 1) throw new Error('synthetic control timeout'); } } });
  const active = await f.submit(threads[0], 'uncertain-control-original');
  await f.waitStatus(active.body.id, 'running');
  const control = await f.control(active.body.id, 'uncertain-active-stop', 'stop');
  assert.equal(control.status, 409);
  assert.equal(control.body.status, 'unknown');
  assert.equal((await f.request(`/v1/jobs/${active.body.id}`)).body.status, 'unknown');
  const queued = await f.submit(threads[1], 'uncertain-next-queued');
  assert.equal(queued.body.status, 'queued');
  assert.equal((await f.control(active.body.id, 'uncertain-active-stop', 'stop')).body.id, control.body.id);
  await f.restart();
  assert.equal((await f.control(active.body.id, 'uncertain-active-stop', 'stop')).body.id, control.body.id);
  assert.equal((await f.request(`/v1/jobs/${queued.body.id}`)).body.status, 'queued');
  assert.equal(sends, 2);
});

test('active correction receipts expose no private prompt and survive restart without resending', async t => {
  const f = await fixture(t);
  const active = await f.submit(threads[0], 'private-active-original');
  await f.waitStatus(active.body.id, 'running');
  const control = await f.control(active.body.id, 'private-active-correct', 'correct', 'Do this private corrected task.');
  assert.equal(control.status, 202);
  assert.ok(!JSON.stringify(control.body).includes('Do this private corrected task.'));
  await f.restart();
  assert.deepEqual((await f.control(active.body.id, 'private-active-correct', 'correct', 'Do this private corrected task.')).body, control.body);
  assert.equal(f.calls.length, 2);
  f.states.set(threads[0], { cursor: 'restart-correct-final', status: 'completed', finalText: 'Corrected. Connector receipt: private-active-original Control receipt: private-active-correct' });
  assert.equal((await f.request(`/v1/jobs/${active.body.id}`)).body.status, 'completed');
  assert.equal((await f.control(active.body.id, 'private-active-correct', 'correct', 'Do this private corrected task.')).status, 200);
});

test('restart during an active control send retains its reservation and never repeats the send', async t => {
  const jobId = '30000000-0000-4000-8000-000000000004';
  const requestId = 'active-stop-before-crash';
  const f = await fixture(t, { seed: {
    'jobs.json': [{ id: jobId, threadId: threads[0], kind: 'task', execution: 'ui', requestId: 'active-before-crash', requestHash: 'original-active-hash', status: 'running', submitted: true, baselineCursor: 'before-crash' }],
    'controls.json': [{ id: '40000000-0000-4000-8000-000000000004', jobId, requestId, requestHash: hash(JSON.stringify({ jobId, action: 'stop' })), action: 'stop', effect: 'stop', status: 'applying', httpStatus: 202 }],
  } });
  assert.equal((await f.control(jobId, requestId, 'stop')).body.status, 'unknown');
  assert.equal((await f.request(`/v1/jobs/${jobId}`)).body.status, 'unknown');
  const status = (await f.request('/v1/status')).body;
  assert.equal(status.runningJobs, 1);
  assert.equal(status.uiLaneBusy, true);
  assert.equal(f.calls.length, 0);
  f.states.set(threads[0], { cursor: 'after-crash-stop', status: 'completed', finalText: `Stopped. Connector receipt: active-before-crash Control receipt: ${requestId}` });
  assert.equal((await f.request(`/v1/jobs/${jobId}`)).body.status, 'cancelled');
  assert.equal((await f.control(jobId, requestId, 'stop')).status, 200);
  assert.equal(f.calls.length, 0);
});

test('startup reconciles a persisted acknowledged result if the receipt write was interrupted', async t => {
  const jobId = '30000000-0000-4000-8000-000000000005';
  const requestId = 'acknowledged-stop-crash';
  const f = await fixture(t, { seed: {
    'jobs.json': [{ id: jobId, threadId: threads[0], kind: 'task', execution: 'background', requestId: 'acknowledged-original', status: 'cancelled', submitted: true, result: `Stopped. Connector receipt: acknowledged-original Control receipt: ${requestId}` }],
    'controls.json': [{ id: '40000000-0000-4000-8000-000000000005', jobId, requestId, requestHash: hash(JSON.stringify({ jobId, action: 'stop' })), action: 'stop', effect: 'stop', status: 'requested', httpStatus: 202 }],
  } });
  const receipt = await f.control(jobId, requestId, 'stop');
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.status, 'completed');
  assert.equal(receipt.body.jobStatus, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('restart during a durable cancellation suppresses queued dispatch and an uncertain retry never replays', async t => {
  const jobId = '30000000-0000-4000-8000-000000000001';
  const requestId = 'cancel-before-crash';
  const f = await fixture(t, { seed: {
    'jobs.json': [{ id: jobId, threadId: threads[0], kind: 'task', execution: 'background', requestId: 'original-crash-job', requestHash: 'original-hash', status: 'queued', submitted: false }],
    'pending-jobs.json': { [jobId]: 'Never dispatch this cancelled private prompt.' },
    'controls.json': [{ id: '40000000-0000-4000-8000-000000000001', jobId, requestId, requestHash: hash(JSON.stringify({ jobId, action: 'cancel' })), action: 'cancel', status: 'applying', httpStatus: 200, previousPrompt: 'Never dispatch this cancelled private prompt.' }],
  } });
  assert.equal((await f.request(`/v1/jobs/${jobId}`)).body.status, 'cancelled');
  const retry = await f.control(jobId, requestId, 'cancel');
  assert.equal(retry.status, 409);
  assert.equal(retry.body.status, 'unknown');
  assert.equal(f.calls.length, 0);
  await f.restart();
  assert.deepEqual((await f.control(jobId, requestId, 'cancel')).body, retry.body);
  assert.equal(f.calls.length, 0);
});

test('restart during a queued edit keeps the job uncertain and never sends either prompt', async t => {
  const jobId = '30000000-0000-4000-8000-000000000002';
  const prompt = 'Revised crash private prompt.';
  const requestId = 'edit-before-crash';
  const f = await fixture(t, { seed: {
    'jobs.json': [{ id: jobId, threadId: threads[0], kind: 'task', execution: 'background', requestId: 'original-edit-crash', requestHash: 'original-hash', status: 'queued', submitted: false }],
    'pending-jobs.json': { [jobId]: prompt },
    'controls.json': [{ id: '40000000-0000-4000-8000-000000000002', jobId, requestId, requestHash: hash(JSON.stringify({ jobId, action: 'edit', prompt })), action: 'edit', status: 'applying', httpStatus: 200, previousPrompt: 'Old crash private prompt.', prompt }],
  } });
  const retry = await f.control(jobId, requestId, 'edit', prompt);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.status, 'unknown');
  assert.equal((await f.request(`/v1/jobs/${jobId}`)).body.status, 'unknown');
  assert.equal(f.calls.length, 0);
});

test('controls keep exact prior prompts privately while every public response excludes prompts and hashes', async t => {
  const f = await fixture(t);
  const { queued } = await blockedJob(f);
  const result = await f.control(queued.id, 'private-edit-receipt', 'edit', 'Revised queued private instruction.');
  const receipt = JSON.parse(await readFile(join(f.dataDir, 'controls.json'), 'utf8'))[0];
  assert.equal(receipt.previousPrompt, 'Original queued private instruction.');
  assert.equal(receipt.prompt, 'Revised queued private instruction.');
  const publicResponses = JSON.stringify([result.body, (await f.request('/v1/jobs')).body, (await f.request(`/v1/jobs/${queued.id}`)).body, (await f.request('/v1/status')).body, (await f.request('/openapi.json')).body]);
  for (const privateValue of [receipt.previousPrompt, receipt.prompt, receipt.requestHash, token, f.dataDir]) assert.ok(!publicResponses.includes(privateValue));
  assert.ok((await f.request('/v1/status')).body.capabilities.includes('edit_queued_job'));
  assert.ok((await f.request('/openapi.json')).body.paths['/v1/jobs/{jobId}/controls']);
  assert.equal((await f.control(queued.id, 'queued-original', 'cancel')).status, 409);
  assert.equal((await f.submit(threads[2], 'private-edit-receipt')).status, 409);
});

test('historical jobs remain subject to the current allowed chat scope', async t => {
  const jobId = '30000000-0000-4000-8000-000000000003';
  const f = await fixture(t, { allowedThreadIds: [threads[0]], seed: { 'jobs.json': [{ id: jobId, threadId: threads[1], status: 'completed', submitted: true, requestId: 'historical-outside-scope' }] } });
  assert.equal((await f.control(jobId, 'historical-cancel-denied', 'cancel')).status, 403);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'controls.json'), 'utf8')).length, 0);
});

test('submission diagnostics retain a safe original cause and phase when polling later fails', async t => {
  let attempted = false;
  const f = await fixture(t, { backend: {
    async sendMessage() { attempted = true; throw Object.assign(new Error('synthetic send failure'), { code: 'NATIVE_TOOL_ERROR' }); },
    async waitThread() { if (attempted) throw Object.assign(new Error('later progress failure'), { code: 'LATER_POLL_ERROR' }); return { cursor: 'before-send', status: 'idle' }; },
  } });
  const active = await f.submit(threads[0], 'diagnostic-original');
  const job = await f.waitStatus(active.body.id, 'unknown');
  assert.equal(job.body.submissionErrorCode, 'NATIVE_TOOL_ERROR');
  assert.equal(job.body.submissionErrorPhase, 'send_outcome_unknown');
  const polled = await f.request(`/v1/jobs/${active.body.id}`);
  assert.equal(polled.body.submissionErrorCode, 'NATIVE_TOOL_ERROR');
  assert.equal(polled.body.submissionErrorPhase, 'send_outcome_unknown');
  assert.match(polled.body.error, /later progress failure/);
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'jobs.json'), 'utf8'))[0];
  assert.equal(persisted.submissionErrorCode, 'NATIVE_TOOL_ERROR');
});

test('before-send diagnostics reject unsafe error-code text rather than persisting pipe metadata', async t => {
  const f = await fixture(t, { backend: { async waitThread() { throw Object.assign(new Error('synthetic baseline failure'), { code: 'private/pipe\\metadata' }); } } });
  const active = await f.submit(threads[0], 'diagnostic-before-send');
  const job = await f.waitStatus(active.body.id, 'failed');
  assert.equal(job.body.submissionErrorCode, 'desktop_error');
  assert.equal(job.body.submissionErrorPhase, 'before_send');
  assert.ok(!(await readFile(join(f.dataDir, 'jobs.json'), 'utf8')).includes('private/pipe'));
});
