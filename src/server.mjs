import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_review']);
const ACTIVE = new Set(['submitting', 'running', 'needs_user', 'unknown']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY = new Set(['active', 'running', 'working', 'inProgress', 'waitingForApproval', 'waitingForUser', 'waiting_for_approval', 'waiting_for_user']);
const fail = (message, statusCode = 400, code = 'invalid_request') => Object.assign(new Error(message), { statusCode, code });
const safeErrorCode = error => typeof error?.code === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(error.code) ? error.code : 'desktop_error';
const digest = value => createHash('sha256').update(value).digest('hex');
const statusType = status => typeof status === 'object' && status ? status.type : status;

function hasTaggedReceipt(text, requestId, tag) {
  if (typeof text !== 'string' || typeof requestId !== 'string') return false;
  const escaped = requestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marked = '`' + escaped + '`';
  return new RegExp(`(?:^|\\s)${tag}:\\s*(?:${escaped}|${marked})(?=\\s|[.!?](?:\\s|$)|$)`).test(text);
}

export const hasReceipt = (text, requestId) => hasTaggedReceipt(text, requestId, 'Connector receipt');
const hasControlReceipt = (text, requestId) => hasTaggedReceipt(text, requestId, 'Control receipt');

export function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']?)[^\s"'&,;]{8,}/gi, '$1[REDACTED]');
}

function scrub(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
}

async function loadJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function saveJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}

export async function verifyExpansion(dataDir) {
  const proofs = await loadJson(join(dataDir, 'verification.json'), {});
  const jobs = await loadJson(join(dataDir, 'jobs.json'), []);
  for (const kind of ['task', 'computer']) {
    const proof = proofs[kind];
    const job = jobs.find(item => item.id === proof?.jobId);
    if (!proof?.verifiedAt || !job || job.kind !== kind || job.status !== 'completed' || !hasReceipt(job.result, job.requestId)) {
      throw fail('Expansion requires verified existing-chat and computer proof jobs.', 409, 'verification_required');
    }
  }
  return proofs;
}

function snapshot(raw, expectedThreadId) {
  const poll = raw.polls?.[0] || raw;
  const turn = poll.latestTurn || {};
  const message = poll.latestAssistantMessage || {};
  if ([poll.thread?.id, poll.threadId, turn.threadId, message.threadId].some(id => id && (typeof id !== 'string' || id.toLowerCase() !== expectedThreadId))) throw fail('The desktop returned progress for a different chat. The job remains reserved.', 502, 'thread_mismatch');
  return {
    cursor: poll.cursor || raw.cursor || null,
    turnId: turn.id || message.turnId || null,
    turnStatus: turn.status || null,
    completedFinalTurn: turn.status === 'completed' && typeof turn.id === 'string' && message.turnId === turn.id && message.phase === 'final_answer',
    status: turn.status || statusType(poll.thread?.status) || raw.status || 'unknown',
    threadStatus: statusType(poll.thread?.status) || raw.status || 'unknown',
    attention: (poll.thread?.status?.activeFlags || []).some(flag => /approval|userinput/i.test(flag)),
    turnError: turn.error?.message || null,
    finalText: message.phase === 'final_answer' || turn.status === 'completed' ? message.text || raw.finalText || '' : raw.finalText || '',
    error: raw.errors?.[0]?.message || null,
  };
}

function openApi(publicOrigin) {
  const operation = (operationId, summary, extra = {}) => ({ operationId, summary, security: [{ bearerAuth: [] }], responses: { 200: { description: 'Operation result as JSON' }, 401: { description: 'Missing or invalid credential' }, 409: { description: 'Busy or uncertain operation; reconcile before retry' } }, ...extra });
  const taskId = { name: 'threadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  return {
    openapi: '3.1.0',
    info: { title: 'Muse Local Connector', version: '0.1.0', description: 'Continue existing desktop chats. Read task state before requesting work. Submit independent jobs before polling their returned IDs; the connector queues them and runs up to its configured capacity. Each chat has one active instruction and all browser/desktop UI work shares one exclusive lane. Set execution=background only for work that will not use browser or desktop UI tools; otherwise use ui (the default). Use a unique requestId per deliberate instruction and reuse it on network retry. Computer work retains local app permissions.' },
    ...(publicOrigin ? { servers: [{ url: publicOrigin }] } : {}),
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/v1/status': { get: operation('connector_status', 'Check connection mode and capabilities') },
      '/v1/tasks': { get: operation('list_existing_tasks', 'Search existing tasks within the current scope', { parameters: [{ name: 'search', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'archived', in: 'query', schema: { type: 'boolean', default: false } }, { name: 'source', in: 'query', schema: { type: 'string', enum: ['codex', 'chatgpt'], default: 'codex' } }] }) },
      '/v1/tasks/{threadId}': { get: operation('read_existing_task', 'Read recent context from an existing chat', { parameters: [taskId, { name: 'hostId', in: 'query', schema: { type: 'string' } }, { name: 'turnLimit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }] }) },
      '/v1/jobs': {
        get: operation('list_connector_jobs', 'List recent connector jobs'),
        post: operation('continue_existing_task', 'Submit one instruction to an existing chat; returns a job ID', {
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['threadId', 'prompt', 'requestId'], properties: { threadId: { type: 'string', format: 'uuid' }, hostId: { type: 'string', maxLength: 100 }, prompt: { type: 'string', minLength: 1, maxLength: 16000 }, requestId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }, kind: { type: 'string', enum: ['task', 'computer'], default: 'task' }, execution: { type: 'string', enum: ['background', 'ui'], default: 'ui', description: 'background forbids browser, computer, and desktop UI tools. Use ui for any browser or native UI action; computer jobs must use ui. Queued jobs are automatically started when their chat, resources, and capacity become available.' } } } } } },
          responses: { 202: { description: 'Queued once; poll the returned id at /v1/jobs/{jobId}' }, 409: { description: 'Busy, conflicting requestId, or uncertain prior operation' } },
        }),
      },
      '/v1/jobs/{jobId}': { get: operation('get_job_result', 'Poll fresh task progress and retrieve its correlated reply', { parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }] }) },
      '/v1/jobs/{jobId}/controls': { post: operation('control_connector_job', 'Cancel/edit queued work or cooperatively stop/correct a running instruction in its existing chat', {
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['action', 'requestId'], properties: { action: { type: 'string', enum: ['cancel', 'edit', 'stop', 'correct'], description: 'Queued stop aliases cancel and queued correct aliases edit. Active cancel aliases cooperative stop; active correct steers the existing turn. Edit is queued-only. Cooperative control is acknowledged only by a correlated final reply after the native turn becomes inactive.' }, requestId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: 'A new unique control operation ID. Reuse the exact same body and ID on a network retry.' }, prompt: { type: 'string', minLength: 1, maxLength: 16000, description: 'Required for edit/correct; private revised instruction. Stop/cancel do not accept a prompt.' } } } } } },
        responses: { 200: { description: 'Durable completed control receipt without private prompts' }, 202: { description: 'Cooperative stop/correction requested; the native task remains reserved until its correlated final acknowledgement' }, 409: { description: 'Rejected, conflicting, or uncertain control. A retry never repeats an uncertain operation.' } },
      }) },
    },
  };
}

export async function createConnector({ config, backend, pollIntervalMs = 5000 }) {
  if (!config.dataDir || !/^[a-f0-9]{64}$/i.test(config.tokenSha256 || '')) throw fail('A private dataDir and SHA-256 credential hash are required.');
  if (config.host && config.host !== '127.0.0.1') throw fail('The connector must bind to 127.0.0.1.');
  if (config.publicOrigin && new URL(config.publicOrigin).protocol !== 'https:') throw fail('publicOrigin must use HTTPS.');
  const maxConcurrentJobs = config.maxConcurrentJobs === undefined ? 4 : config.maxConcurrentJobs;
  if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 32) throw fail('maxConcurrentJobs must be an integer from 1 to 32.');
  const publicBasePath = config.publicBasePath || '';
  if (typeof publicBasePath !== 'string' || (publicBasePath && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(publicBasePath))) throw fail('publicBasePath must be a simple absolute base path without a trailing slash.');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if (config.allowAllTasks) await verifyExpansion(config.dataDir);
  const jobFile = join(config.dataDir, 'jobs.json');
  const pendingFile = join(config.dataDir, 'pending-jobs.json');
  const controlsFile = join(config.dataDir, 'controls.json');
  const auditFile = join(config.dataDir, 'audit.jsonl');
  const jobs = await loadJson(jobFile, []);
  const pending = await loadJson(pendingFile, {});
  const controls = await loadJson(controlsFile, []);
  for (const control of controls) {
    const job = jobs.find(item => item.id === control.jobId);
    if (['requested', 'applying', 'unknown'].includes(control.status) && ['stop', 'correct'].includes(control.effect) && TERMINAL.has(job?.status) && hasReceipt(job.result, job.requestId) && hasControlReceipt(job.result, control.requestId)) {
      control.status = 'completed'; control.httpStatus = 200; control.jobStatus = job.status; control.updatedAt = new Date().toISOString(); delete control.error; delete control.message;
    }
    if (control.status !== 'applying') continue;
    if (job?.status === 'queued' && job.submitted === false) {
      job.status = ['cancel', 'stop'].includes(control.action) ? 'cancelled' : 'unknown';
      job.error = ['cancel', 'stop'].includes(control.action) ? undefined : 'Connector restarted during a queued edit. Inspect the private control receipt before sending more work.';
      job.updatedAt = new Date().toISOString();
    }
    if (job && ['stop', 'correct'].includes(control.effect) && !TERMINAL.has(job.status)) job.status = 'unknown';
    control.status = 'unknown'; control.httpStatus = 409; control.error = 'control_outcome_unknown';
    control.message = 'Connector restarted before this control finished. The operation will not be replayed.';
    control.jobStatus = job?.status || control.jobStatus; control.updatedAt = new Date().toISOString();
  }
  for (const job of jobs) {
    job.threadId = job.threadId?.toLowerCase();
    if (!TERMINAL.has(job.status) && !(job.status === 'queued' && job.submitted === false && typeof pending[job.id] === 'string')) {
      job.status = 'unknown'; job.error = 'Connector restarted. Check the original chat before sending more work.';
    }
  }
  for (const id of Object.keys(pending)) if (!jobs.some(job => job.id === id && job.status === 'queued')) delete pending[id];
  const running = new Map();
  const polling = new Map();
  const controlOperations = new Map();
  const controlLeases = new Set();
  const controlEpochs = new Map();
  const accepted = new Set(jobs.map(job => job.id));
  let stopping = false;
  let pollTimer;
  let pollCycle;
  let persistence = Promise.resolve();
  const persist = () => { persistence = persistence.catch(() => {}).then(async () => { await saveJson(pendingFile, pending); await saveJson(jobFile, jobs); }); return persistence; };
  const persistControls = () => { persistence = persistence.catch(() => {}).then(() => saveJson(controlsFile, controls)); return persistence; };
  const audit = (event, job) => appendFile(auditFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...(job ? { jobId: job.id, threadId: job.threadId, kind: job.kind, status: job.status } : {}) })}\n`, { mode: 0o600 });
  const touch = job => { job.updatedAt = new Date().toISOString(); };
  const authorizeThread = id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw fail('threadId must be the existing chat UUID.');
    if (!config.allowAllTasks && !(config.allowedThreadIds || []).some(allowed => allowed.toLowerCase() === id.toLowerCase())) throw fail('This chat is outside the pilot scope.', 403, 'thread_not_allowed');
  };
  const execution = job => job.execution || 'ui';
  const holdsResource = job => !TERMINAL.has(job.status) && job.status !== 'queued';
  const activeCount = () => jobs.filter(job => ACTIVE.has(job.status)).length;
  function waiting(job) {
    const blockers = jobs.filter(other => other.id !== job.id && holdsResource(other) && (other.threadId === job.threadId || (execution(job) === 'ui' && execution(other) === 'ui')));
    return {
      waitingFor: [...(activeCount() >= maxConcurrentJobs ? ['capacity'] : []), ...(blockers.some(other => other.threadId === job.threadId) ? ['chat'] : []), ...(execution(job) === 'ui' && blockers.some(other => execution(other) === 'ui') ? ['ui'] : [])],
      blockingJobIds: blockers.map(other => other.id),
    };
  }
  const canControlQueued = job => job.status === 'queued' && job.submitted === false && typeof pending[job.id] === 'string' && !controlLeases.has(job.id);
  const activeControl = job => controls.findLast(control => control.jobId === job.id && ['stop', 'correct'].includes(control.effect) && ['applying', 'requested', 'unknown'].includes(control.status));
  const canControlActive = job => ['running', 'needs_user'].includes(job.status) && !controlLeases.has(job.id) && !activeControl(job);
  const publicJob = job => scrub({ ...Object.fromEntries(Object.entries(job).filter(([key]) => !['requestHash', 'baselineCursor', 'baselineTurnId', 'afterCursor'].includes(key))), execution: execution(job), revision: job.revision || 0, controls: { cancel: canControlQueued(job) || canControlActive(job), edit: canControlQueued(job), stop: canControlQueued(job) || canControlActive(job), correct: canControlQueued(job) || canControlActive(job) }, ...(activeControl(job) ? { pendingControlId: activeControl(job).id } : {}), ...(job.status === 'queued' ? waiting(job) : {}) });
  const publicControl = control => scrub(Object.fromEntries(Object.entries(control).filter(([key]) => !['requestHash', 'httpStatus', 'previousPrompt', 'prompt'].includes(key))));

  function schedule() {
    if (stopping) return;
    for (const job of jobs) {
      if (job.status !== 'queued' || !accepted.has(job.id) || controlLeases.has(job.id) || waiting(job).waitingFor.length) continue;
      // Reserve capacity, chat, and the UI lane before any awaited desktop call.
      job.status = 'submitting'; touch(job);
      const operation = dispatch(job, pending[job.id]).catch(error => {
        job.submissionErrorCode ??= safeErrorCode(error); job.submissionErrorPhase ??= 'send_outcome_unknown';
        job.status = 'unknown'; job.error = 'Could not durably record submission state. Reconcile the original chat before sending again.'; touch(job);
      }).finally(() => { running.delete(job.id); schedule(); });
      running.set(job.id, operation);
    }
  }

  async function dispatch(job, prompt) {
    let attempted = false;
    try {
      authorizeThread(job.threadId);
      await persist();
      const before = snapshot(await backend.waitThread(job.threadId, { hostId: job.hostId, timeoutMs: 0 }), job.threadId);
      if (before.error) throw fail('The desktop could not inspect this chat.', 502);
      if (BUSY.has(before.status) || BUSY.has(before.threadStatus) || before.attention) throw fail('The target chat became active before submission. No instruction was sent.', 409, 'thread_busy');
      job.baselineCursor = before.cursor;
      job.baselineTurnId = before.turnId;
      job.afterCursor = before.cursor;
      delete pending[job.id];
      touch(job); await persist();
      if (stopping) { job.status = 'queued'; pending[job.id] = prompt; touch(job); await persist(); return; }
      const instruction = `[Authenticated owner request through Muse Local Connector; receipt ${job.requestId}.]\nContinue this existing chat with its context, project instructions, and app permissions. Do not reveal credentials. Include "Connector receipt: ${job.requestId}" in your final reply.\n${execution(job) === 'background' ? 'Execution class: background. Do not use any browser, computer, mouse, keyboard, or native desktop UI tools. File, terminal, API, and reasoning work may run alongside other chats. If browser or desktop UI is needed, finish by reporting that requirement so Muse can submit a separate UI job; never escalate to UI within this job.\n' : 'Execution class: ui. This job holds the connector exclusive browser and desktop UI lane until its native turn ends. Do not delegate UI work that could outlive this job.\n'}${job.kind === 'computer' ? 'This request involves local computer work. Use the installed Computer Use skill for UI actions, verify the result visually, and return the evidence location when requested.\n' : ''}\n${prompt}`;
      attempted = true;
      await backend.sendMessage(job.threadId, instruction, { hostId: job.hostId });
      job.status = 'running'; job.submitted = true; touch(job);
      await persist(); await audit('submitted', job);
    } catch (error) {
      delete pending[job.id];
      job.submissionErrorCode = safeErrorCode(error); job.submissionErrorPhase = attempted ? 'send_outcome_unknown' : 'before_send';
      job.status = attempted ? 'unknown' : 'failed';
      job.error = attempted ? 'Submission outcome is uncertain. Reconcile this job and the original chat before sending again.' : redact(error.message || 'Desktop request failed.');
      touch(job); await persist(); await audit('dispatch_error', job);
    }
  }

  async function poll(job, reconcileReview = false) {
    const reviewing = job.status === 'needs_review' && reconcileReview === true;
    if ((TERMINAL.has(job.status) && !reviewing) || ['queued', 'submitting'].includes(job.status) || controlLeases.has(job.id) || (reviewing && activeControl(job))) return;
    if (polling.has(job.id)) return polling.get(job.id);
    const epoch = controlEpochs.get(job.id) || 0;
    const operation = (async () => {
      try {
        const state = snapshot(await backend.waitThread(job.threadId, { hostId: job.hostId, afterCursor: reviewing ? undefined : job.afterCursor, timeoutMs: 0 }), job.threadId);
        if (controlLeases.has(job.id) || epoch !== (controlEpochs.get(job.id) || 0)) return;
        if (state.error) { if (!reviewing) job.error = redact(state.error); return; }
        const fresh = state.turnId ? state.turnId !== job.baselineTurnId : state.cursor !== job.baselineCursor;
        const finished = (!state.turnStatus || state.turnStatus === 'completed') && !BUSY.has(state.status) && !BUSY.has(state.threadStatus) && !state.attention;
        const reviewInactive = ['idle', 'completed', 'failed', 'cancelled', 'interrupted'].includes(state.threadStatus) || (state.threadStatus === 'notLoaded' && state.turnStatus === 'completed');
        if (reviewing && (!state.finalText || !fresh || !finished || !['idle', 'completed'].includes(state.status) || !reviewInactive || !hasReceipt(state.finalText, job.requestId))) return;
        const control = activeControl(job);
        if (control) {
          const controlInactive = ['idle', 'completed', 'failed', 'cancelled', 'interrupted'].includes(state.threadStatus) || (state.threadStatus === 'notLoaded' && state.completedFinalTurn);
          if (state.finalText && fresh && finished && controlInactive && hasReceipt(state.finalText, job.requestId) && hasControlReceipt(state.finalText, control.requestId)) {
            job.status = control.effect === 'stop' ? 'cancelled' : 'completed'; job.result = redact(state.finalText); job.turnId = state.turnId; delete job.error;
            touch(job); await persist();
            control.status = 'completed'; control.httpStatus = 200; control.jobStatus = job.status; control.updatedAt = new Date().toISOString(); delete control.error; delete control.message;
            await persistControls(); await audit('control_acknowledged', job);
          } else if (fresh && ['failed', 'cancelled', 'interrupted'].includes(state.status) && !BUSY.has(state.threadStatus) && !state.attention) {
            job.status = 'unknown'; job.error = 'The native turn ended without this control acknowledgement. Reconcile the original chat before sending more work.';
            control.status = 'unknown'; control.httpStatus = 409; control.jobStatus = 'unknown'; control.error = 'control_outcome_unknown'; control.message = job.error; control.updatedAt = new Date().toISOString();
            touch(job); await persist(); await persistControls();
          } else if (state.attention || /approval|attention|waiting|input/i.test(`${state.status} ${state.threadStatus}`)) {
            job.status = 'needs_user'; touch(job); await persist();
          } else if (job.status === 'needs_user' && (BUSY.has(state.status) || BUSY.has(state.threadStatus))) {
            job.status = 'running'; touch(job); await persist();
          }
          if (state.cursor && (!state.finalText || TERMINAL.has(job.status))) job.afterCursor = state.cursor;
          return;
        }
        if (fresh && ['failed', 'cancelled', 'interrupted'].includes(state.status) && !BUSY.has(state.threadStatus) && !state.attention) {
          job.status = state.status === 'failed' ? 'failed' : 'cancelled';
          job.error = redact(state.turnError || `Desktop turn ${state.status}.`);
          touch(job); await persist(); await audit('turn_ended', job);
        } else if (state.finalText && fresh && finished) {
          if (hasReceipt(state.finalText, job.requestId)) {
            job.status = 'completed'; job.result = redact(state.finalText); delete job.error;
            job.turnId = state.turnId;
          } else {
            job.status = 'needs_review'; job.error = 'A new reply arrived without this job receipt. Inspect the original chat before treating it as the result.';
          }
          touch(job); await persist(); await audit('reply_received', job);
        } else if (state.attention || /approval|attention|waiting|input/i.test(`${state.status} ${state.threadStatus}`)) {
          job.status = 'needs_user'; touch(job); await persist();
        } else if (job.status === 'needs_user' && (BUSY.has(state.status) || BUSY.has(state.threadStatus))) {
          job.status = 'running'; touch(job); await persist();
        }
        if (state.cursor && (!state.finalText || finished)) job.afterCursor = state.cursor;
      } catch (error) {
        if (controlLeases.has(job.id) || epoch !== (controlEpochs.get(job.id) || 0)) return;
        if (reviewing) return;
        job.error = redact(error.message || 'Could not check desktop progress.'); touch(job); await persist();
      }
    })().finally(() => { polling.delete(job.id); schedule(); });
    polling.set(job.id, operation);
    return operation;
  }

  async function tasks(query) {
    if (query.get('archived') === 'true') {
      if (!config.allowAllTasks) throw fail('Archived discovery is outside the pilot scope.', 403, 'thread_not_allowed');
      const source = query.get('source') || 'codex';
      const limit = Number(query.get('limit') || 50);
      if (!['codex', 'chatgpt'].includes(source) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('Invalid archived source or limit.');
      return backend.listThreads({ archived: true, source, limit: Math.min(limit, 50), cursor: query.get('cursor') || undefined, search: query.get('search') || undefined });
    }
    let result = config.allowAllTasks && backend.listAllLocalThreads ? await backend.listAllLocalThreads({ search: query.get('search') || undefined }) : await backend.listThreads({ limit: 50, search: undefined });
    if (!config.allowAllTasks) {
      const allowed = config.allowedThreadIds || [];
      result.tasks = result.tasks.filter(task => allowed.includes(task.id));
      for (const id of allowed) if (!result.tasks.some(task => task.id === id)) {
        const read = await backend.readThread(id, { turnLimit: 1 });
        const thread = read.thread || read;
        result.tasks.push({ id, title: thread.title || thread.name || id, kind: thread.kind || 'codex', hostId: thread.hostId || 'local', status: statusType(thread.status) || 'unknown' });
      }
      result.partial = false;
      result.coverage = { mode: 'pilot' };
    }
    if (query.get('search')) { const term = query.get('search').toLowerCase(); result.tasks = result.tasks.filter(task => `${task.title || ''}\n${task.summary || ''}`.toLowerCase().includes(term)); }
    const offset = Number(query.get('cursor') || 0);
    const limit = Number(query.get('limit') || 50);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('Invalid catalog cursor or limit.');
    const total = result.tasks.length;
    return { ...result, tasks: result.tasks.slice(offset, offset + limit), total, nextCursor: offset + limit < total ? String(offset + limit) : null };
  }

  async function submit(body) {
    const { prompt, requestId, hostId } = body;
    const threadId = typeof body.threadId === 'string' ? body.threadId.toLowerCase() : body.threadId;
    const kind = body.kind || 'task';
    const executionClass = body.execution === undefined ? 'ui' : body.execution;
    authorizeThread(threadId);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000 || typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId) || !['task', 'computer'].includes(kind) || !['background', 'ui'].includes(executionClass) || (kind === 'computer' && executionClass !== 'ui') || (hostId != null && (typeof hostId !== 'string' || hostId.length > 100))) throw fail('Valid prompt, requestId, kind, execution (computer jobs require ui), and optional hostId are required.');
    if (Object.keys(body).some(key => !['threadId', 'prompt', 'requestId', 'kind', 'hostId', 'execution'].includes(key))) throw fail('Unknown job properties are not allowed.');
    if (controls.some(control => control.requestId === requestId)) throw fail('requestId already belongs to a control operation.', 409, 'idempotency_conflict');
    const requestHash = digest(JSON.stringify({ threadId, hostId: hostId || null, prompt, kind, execution: executionClass }));
    const legacyHash = digest(JSON.stringify({ threadId: body.threadId, hostId: hostId || null, prompt, kind }));
    const matches = job => job.requestHash === requestHash || (!job.execution && executionClass === 'ui' && job.requestHash === legacyHash);
    const existing = jobs.find(job => job.requestId === requestId);
    if (existing) {
      if (!matches(existing)) throw fail('requestId already belongs to a different instruction.', 409, 'idempotency_conflict');
      await persistence;
      if (existing.status === 'queued' && !accepted.has(existing.id) && typeof pending[existing.id] === 'string') {
        await audit('queued', existing); accepted.add(existing.id); schedule();
      }
      return existing;
    }
    // The desktop router owns the chat. A fresh CLI process is never substituted.
    const catalog = await backend.listThreads({ limit: 50 });
    let task = catalog.tasks.find(item => item.id?.toLowerCase() === threadId);
    if (!task) {
      const read = await backend.readThread(threadId, { hostId, turnLimit: 1 });
      task = read.thread || read;
    }
    if (BUSY.has(statusType(task.status)) && !jobs.some(job => job.threadId === threadId && holdsResource(job))) throw fail('The target chat is active or awaiting input. Finish or hand off its current work first.', 409, 'thread_busy');
    const duplicate = jobs.find(job => job.requestId === requestId);
    if (duplicate) { if (!matches(duplicate)) throw fail('Conflicting requestId.', 409, 'idempotency_conflict'); await persistence; return duplicate; }
    if (controls.some(control => control.requestId === requestId)) throw fail('requestId already belongs to a control operation.', 409, 'idempotency_conflict');
    const job = { id: randomUUID(), threadId, ...(hostId ? { hostId } : {}), kind, execution: executionClass, requestId, requestHash, status: 'queued', submitted: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    pending[job.id] = prompt;
    jobs.push(job); await persist(); await audit('queued', job);
    accepted.add(job.id); schedule();
    return job;
  }

  async function controlJob(job, body) {
    authorizeThread(job.threadId);
    const { action, requestId, prompt } = body;
    const revises = ['edit', 'correct'].includes(action);
    if (!['cancel', 'edit', 'stop', 'correct'].includes(action) || typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId) || (revises && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000)) || (!revises && prompt !== undefined) || Object.keys(body).some(key => !['action', 'requestId', 'prompt'].includes(key))) throw fail('A valid cancel, edit, stop, or correct action and unique requestId are required; edit/correct require a prompt.');
    const requestHash = digest(JSON.stringify({ jobId: job.id, action, ...(revises ? { prompt } : {}) }));
    const existing = controls.find(control => control.requestId === requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw fail('requestId already belongs to a different control operation.', 409, 'idempotency_conflict');
      await (controlOperations.get(existing.id) || persistence);
      return existing;
    }
    if (jobs.some(item => item.requestId === requestId)) throw fail('requestId already belongs to a job submission.', 409, 'idempotency_conflict');
    const queued = canControlQueued(job);
    const active = action !== 'edit' && canControlActive(job);
    const available = queued || active;
    const effect = queued ? revises ? 'edit' : 'cancel' : revises ? 'correct' : 'stop';
    const now = new Date().toISOString();
    const control = { id: randomUUID(), jobId: job.id, requestId, requestHash, action, effect, status: available ? 'applying' : 'rejected', httpStatus: available ? active ? 202 : 200 : 409, jobStatus: job.status, revision: job.revision || 0, createdAt: now, updatedAt: now, ...(available ? { ...(queued ? { previousPrompt: pending[job.id] } : {}), ...(revises ? { prompt } : {}) } : { error: 'job_not_controllable', message: 'Edit requires never-submitted queued work. Stop/cancel/correct also support running work or work awaiting the owner; submitting, uncertain, finished, or already-controlled jobs must be reconciled first.' }) };
    // Reserve the operation ID and queue entry before any awaited file write.
    controls.push(control);
    if (available) { controlLeases.add(job.id); controlEpochs.set(job.id, (controlEpochs.get(job.id) || 0) + 1); }
    const operation = (async () => {
      try {
        // This durable marker prevents a queued cancellation from dispatching after a crash.
        await persistControls();
        if (queued) {
          if (effect === 'cancel') { job.status = 'cancelled'; delete pending[job.id]; }
          else { pending[job.id] = prompt; job.revision = (job.revision || 0) + 1; }
          touch(job); await persist();
          control.status = 'completed'; control.jobStatus = job.status; control.revision = job.revision || 0; control.updatedAt = new Date().toISOString();
          await persistControls();
        } else if (active) {
          const instruction = `[Authenticated owner control through Muse Local Connector; control receipt ${requestId}.]\nThis control applies to the existing chat and current instruction with Connector receipt: ${job.requestId}. Preserve this chat, its history, project instructions, and app permissions. Do not create a replacement task or reveal credentials.\nExecution class: ${execution(job)}. ${execution(job) === 'background' ? 'Do not use browser, computer, mouse, keyboard, or native desktop UI tools. If UI work is needed, report that requirement without using UI tools.' : 'Retain the exclusive browser and desktop UI lane until this native turn ends. Do not delegate UI work that could outlive this turn.'}\n${effect === 'stop' ? 'The owner requests a cooperative stop. Stop the current task safely at the next opportunity, do no further task work, acknowledge this request, and finish the current turn.' : `The owner is correcting the current instruction. Apply this revised instruction now within this same chat and current turn, preserving context and completed history:\n\n${prompt}`}\n\nInclude both "Connector receipt: ${job.requestId}" and "Control receipt: ${requestId}" in your final reply.`;
          await backend.sendMessage(job.threadId, instruction, { hostId: job.hostId });
          if (effect === 'correct') job.revision = (job.revision || 0) + 1;
          touch(job); await persist();
          control.status = 'requested'; control.jobStatus = job.status; control.revision = job.revision || 0; control.updatedAt = new Date().toISOString();
          await persistControls();
        }
        await appendFile(auditFile, `${JSON.stringify({ at: new Date().toISOString(), event: `control_${control.status}`, controlId: control.id, jobId: job.id, threadId: job.threadId, action, status: control.status })}\n`, { mode: 0o600 });
      } catch {
        control.status = 'unknown'; control.httpStatus = 409; control.error = 'control_outcome_unknown';
        control.message = 'The control could not be durably completed. It will not be replayed; inspect the original job and private receipt.'; control.updatedAt = new Date().toISOString();
        if (available && !TERMINAL.has(job.status)) { job.status = 'unknown'; job.error = control.message; touch(job); }
        control.jobStatus = job.status;
        await persist().catch(() => {}); await persistControls().catch(() => {});
      } finally {
        if (available) controlLeases.delete(job.id);
        controlOperations.delete(control.id); schedule();
      }
    })();
    controlOperations.set(control.id, operation);
    await operation;
    return control;
  }

  async function readBody(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw fail('Content-Type must be application/json.', 415);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw fail('Request body exceeds 64 KiB.', 413, 'body_too_large'); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
    catch { throw fail('A JSON object is required.'); }
  }

  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(scrub(value))); };
    try {
      const localHosts = new Set([`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`, ...(config.publicOrigin ? [new URL(config.publicOrigin).host] : [])]);
      if (!localHosts.has(request.headers.host)) throw fail('Unrecognized connector host.', 403, 'host_not_allowed');
      const origin = request.headers.origin;
      if (origin && !new Set([`http://127.0.0.1:${server.address()?.port}`, `http://localhost:${server.address()?.port}`, config.publicOrigin]).has(origin)) throw fail('Browser origin is not allowed.', 403, 'origin_not_allowed');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok', name: 'muse-local-connector', version: '0.1.0' });
      if (request.method === 'GET' && url.pathname === '/openapi.json') return send(200, openApi(config.publicOrigin ? `${config.publicOrigin}${publicBasePath}` : undefined));
      if (request.method === 'GET' && url.pathname === '/') return send(200, { name: 'Muse Local Connector', setup: 'Add a custom connector using /openapi.json. Enter the bearer credential only in the secure credential prompt.', authentication: 'Authorization: Bearer <credential>', status: '/health' });
      const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!bearer || !timingSafeEqual(Buffer.from(digest(bearer), 'hex'), Buffer.from(config.tokenSha256, 'hex'))) return send(401, { error: 'unauthorized', message: 'A valid bearer credential is required.' });
      if (request.method === 'GET' && url.pathname === '/v1/status') { await backend.listThreads({ limit: 1 }); return send(200, { desktopReachable: true, mode: config.allowAllTasks ? 'expanded' : 'pilot', execution: 'existing_desktop_chats', computerExecution: 'through_target_chat', serializedJobs: false, maxConcurrentJobs, runningJobs: activeCount(), queuedJobs: jobs.filter(job => job.status === 'queued').length, uiLaneBusy: jobs.some(job => holdsResource(job) && execution(job) === 'ui'), capabilities: ['list_tasks', 'read_task', 'continue_task', 'request_computer_work', 'poll_result', 'concurrent_jobs', 'durable_queue', 'exclusive_ui_lane', 'cancel_queued_job', 'edit_queued_job', 'cooperative_stop', 'correct_active_job', 'idempotent_controls'] }); }
      if (request.method === 'GET' && url.pathname === '/v1/tasks') return send(200, await tasks(url.searchParams));
      const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
      if (request.method === 'GET' && taskMatch) { const id = decodeURIComponent(taskMatch[1]); authorizeThread(id); return send(200, await backend.readThread(id, { hostId: url.searchParams.get('hostId') || undefined, turnLimit: Number(url.searchParams.get('turnLimit') || 3), cursor: url.searchParams.get('cursor') || undefined })); }
      if (request.method === 'GET' && url.pathname === '/v1/jobs') return send(200, { jobs: jobs.slice(-50).reverse().map(publicJob) });
      if (request.method === 'POST' && url.pathname === '/v1/jobs') return send(202, publicJob(await submit(await readBody(request))));
      const controlMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)\/controls$/i);
      if (request.method === 'POST' && controlMatch) { const job = jobs.find(item => item.id === controlMatch[1]); if (!job) throw fail('Job not found.', 404, 'not_found'); const control = await controlJob(job, await readBody(request)); return send(control.httpStatus, publicControl(control)); }
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && jobMatch) { const job = jobs.find(item => item.id === jobMatch[1]); if (!job) throw fail('Job not found.', 404, 'not_found'); await poll(job, true); return send(200, publicJob(job)); }
      throw fail('Route not found.', 404, 'not_found');
    } catch (error) { if (!response.headersSent) send(error.statusCode || 502, { error: error.code || 'connector_error', message: redact(error.message || 'Connector operation failed.') }); }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  await persistControls(); await persist();
  function startPolling() {
    if (stopping) return;
    pollCycle = Promise.allSettled(jobs.filter(job => holdsResource(job) && job.status !== 'submitting').map(poll)).finally(() => {
      pollCycle = null;
      if (!stopping) { pollTimer = setTimeout(startPolling, pollIntervalMs); pollTimer.unref(); }
    });
  }
  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 18761, '127.0.0.1', () => { schedule(); startPolling(); resolve(); }); }),
    address: () => server.address(),
    close: async () => { stopping = true; clearTimeout(pollTimer); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...running.values(), ...polling.values(), ...controlOperations.values(), ...(pollCycle ? [pollCycle] : [])]); await persistence; await backend.close(); },
  };
}
