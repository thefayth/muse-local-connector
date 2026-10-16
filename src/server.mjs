import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_review']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY = new Set(['active', 'running', 'working', 'inProgress', 'waitingForApproval', 'waitingForUser', 'waiting_for_approval', 'waiting_for_user']);
const fail = (message, statusCode = 400, code = 'invalid_request') => Object.assign(new Error(message), { statusCode, code });
const digest = value => createHash('sha256').update(value).digest('hex');
const statusType = status => typeof status === 'object' && status ? status.type : status;

export function hasReceipt(text, requestId) {
  if (typeof text !== 'string' || typeof requestId !== 'string') return false;
  const escaped = requestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)Connector receipt:\\s*${escaped}(?=\\s|[.!?](?:\\s|$)|$)`).test(text);
}

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
  await rename(temporary, file);
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

function snapshot(raw) {
  const poll = raw.polls?.[0] || raw;
  const turn = poll.latestTurn || {};
  const message = poll.latestAssistantMessage || {};
  return {
    cursor: poll.cursor || raw.cursor || null,
    turnId: turn.id || message.turnId || null,
    turnStatus: turn.status || null,
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
    info: { title: 'Muse Local Connector', version: '0.1.0', description: 'Continue existing desktop chats. Read the task state before requesting work. Use a unique requestId for each deliberate instruction and reuse it on network retry. Poll the returned job ID. Computer work runs through the target chat and retains local app permissions.' },
    ...(publicOrigin ? { servers: [{ url: publicOrigin }] } : {}),
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/v1/status': { get: operation('connector_status', 'Check connection mode and capabilities') },
      '/v1/tasks': { get: operation('list_existing_tasks', 'Search existing tasks within the current scope', { parameters: [{ name: 'search', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'archived', in: 'query', schema: { type: 'boolean', default: false } }, { name: 'source', in: 'query', schema: { type: 'string', enum: ['codex', 'chatgpt'], default: 'codex' } }] }) },
      '/v1/tasks/{threadId}': { get: operation('read_existing_task', 'Read recent context from an existing chat', { parameters: [taskId, { name: 'hostId', in: 'query', schema: { type: 'string' } }, { name: 'turnLimit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }] }) },
      '/v1/jobs': {
        get: operation('list_connector_jobs', 'List recent connector jobs'),
        post: operation('continue_existing_task', 'Submit one instruction to an existing chat; returns a job ID', {
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['threadId', 'prompt', 'requestId'], properties: { threadId: { type: 'string', format: 'uuid' }, hostId: { type: 'string', maxLength: 100 }, prompt: { type: 'string', minLength: 1, maxLength: 16000 }, requestId: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }, kind: { type: 'string', enum: ['task', 'computer'], default: 'task' } } } } } },
          responses: { 202: { description: 'Queued once; poll the returned id at /v1/jobs/{jobId}' }, 409: { description: 'Busy, conflicting requestId, or uncertain prior operation' } },
        }),
      },
      '/v1/jobs/{jobId}': { get: operation('get_job_result', 'Poll fresh task progress and retrieve its correlated reply', { parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }] }) },
    },
  };
}

export async function createConnector({ config, backend }) {
  if (!config.dataDir || !/^[a-f0-9]{64}$/i.test(config.tokenSha256 || '')) throw fail('A private dataDir and SHA-256 credential hash are required.');
  if (config.host && config.host !== '127.0.0.1') throw fail('The connector must bind to 127.0.0.1.');
  if (config.publicOrigin && new URL(config.publicOrigin).protocol !== 'https:') throw fail('publicOrigin must use HTTPS.');
  const publicBasePath = config.publicBasePath || '';
  if (typeof publicBasePath !== 'string' || (publicBasePath && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(publicBasePath))) throw fail('publicBasePath must be a simple absolute base path without a trailing slash.');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if (config.allowAllTasks) await verifyExpansion(config.dataDir);
  const jobFile = join(config.dataDir, 'jobs.json');
  const auditFile = join(config.dataDir, 'audit.jsonl');
  const jobs = await loadJson(jobFile, []);
  for (const job of jobs) if (!TERMINAL.has(job.status)) { job.status = 'unknown'; job.error = 'Connector restarted. Check the original chat before sending more work.'; }
  const running = new Map();
  const polling = new Map();
  let persistence = Promise.resolve();
  const persist = () => { persistence = persistence.then(() => saveJson(jobFile, jobs)); return persistence; };
  const audit = (event, job) => appendFile(auditFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...(job ? { jobId: job.id, threadId: job.threadId, kind: job.kind, status: job.status } : {}) })}\n`, { mode: 0o600 });
  const touch = job => { job.updatedAt = new Date().toISOString(); };
  const authorizeThread = id => {
    if (!UUID.test(id)) throw fail('threadId must be the existing chat UUID.');
    if (!config.allowAllTasks && !(config.allowedThreadIds || []).includes(id)) throw fail('This chat is outside the pilot scope.', 403, 'thread_not_allowed');
  };
  const publicJob = job => scrub(Object.fromEntries(Object.entries(job).filter(([key]) => !['requestHash', 'baselineCursor', 'baselineTurnId', 'afterCursor'].includes(key))));

  async function dispatch(job, prompt) {
    let attempted = false;
    try {
      const before = snapshot(await backend.waitThread(job.threadId, { hostId: job.hostId, timeoutMs: 0 }));
      if (before.error) throw fail('The desktop could not inspect this chat.', 502);
      if (BUSY.has(before.status) || BUSY.has(before.threadStatus)) throw fail('The target chat became active before submission. No instruction was sent.', 409, 'thread_busy');
      job.baselineCursor = before.cursor;
      job.baselineTurnId = before.turnId;
      job.afterCursor = before.cursor;
      job.status = 'submitting'; touch(job); await persist();
      const instruction = `[Authenticated owner request through Muse Local Connector; receipt ${job.requestId}.]\nContinue this existing chat with its context, project instructions, and app permissions. Do not reveal credentials. Include "Connector receipt: ${job.requestId}" in your final reply.\n${job.kind === 'computer' ? 'This request involves local computer work. Use the installed Computer Use skill for UI actions, verify the result visually, and return the evidence location when requested.\n' : ''}\n${prompt}`;
      attempted = true;
      await backend.sendMessage(job.threadId, instruction, { hostId: job.hostId });
      job.status = 'running'; job.submitted = true; touch(job);
      await persist(); await audit('submitted', job);
    } catch (error) {
      job.status = attempted ? 'unknown' : 'failed';
      job.error = attempted ? 'Submission outcome is uncertain. Reconcile this job and the original chat before sending again.' : redact(error.message || 'Desktop request failed.');
      touch(job); await persist(); await audit('dispatch_error', job);
    }
  }

  async function poll(job) {
    if (TERMINAL.has(job.status) || ['queued', 'submitting'].includes(job.status)) return;
    if (polling.has(job.id)) return polling.get(job.id);
    const operation = (async () => {
      try {
        const state = snapshot(await backend.waitThread(job.threadId, { hostId: job.hostId, afterCursor: job.afterCursor, timeoutMs: 0 }));
        if (state.error) { job.error = redact(state.error); return; }
        const fresh = state.turnId ? state.turnId !== job.baselineTurnId : state.cursor !== job.baselineCursor;
        const finished = (!state.turnStatus || state.turnStatus === 'completed') && !BUSY.has(state.status) && !BUSY.has(state.threadStatus) && !state.attention;
        if (fresh && ['failed', 'cancelled', 'interrupted'].includes(state.status)) {
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
        }
        if (state.cursor && (!state.finalText || finished)) job.afterCursor = state.cursor;
      } catch (error) {
        job.error = redact(error.message || 'Could not check desktop progress.'); touch(job); await persist();
      }
    })().finally(() => polling.delete(job.id));
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
    const { threadId, prompt, requestId, hostId } = body;
    const kind = body.kind || 'task';
    authorizeThread(threadId);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000 || typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId) || !['task', 'computer'].includes(kind) || (hostId != null && (typeof hostId !== 'string' || hostId.length > 100))) throw fail('Valid prompt, requestId, kind, and optional hostId are required.');
    if (Object.keys(body).some(key => !['threadId', 'prompt', 'requestId', 'kind', 'hostId'].includes(key))) throw fail('Unknown job properties are not allowed.');
    const requestHash = digest(JSON.stringify({ threadId, hostId: hostId || null, prompt, kind }));
    const existing = jobs.find(job => job.requestId === requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw fail('requestId already belongs to a different instruction.', 409, 'idempotency_conflict');
      return existing;
    }
    if (jobs.some(job => !TERMINAL.has(job.status))) throw fail('Another job is running or needs reconciliation. Check it before submitting more work.', 409, 'connector_busy');
    // The desktop router owns the chat. A fresh CLI process is never substituted.
    const catalog = await backend.listThreads({ limit: 50 });
    let task = catalog.tasks.find(item => item.id === threadId);
    if (!task) {
      const read = await backend.readThread(threadId, { hostId, turnLimit: 1 });
      task = read.thread || read;
    }
    if (BUSY.has(statusType(task.status))) throw fail('The target chat is active or awaiting input. Finish or hand off its current work first.', 409, 'thread_busy');
    const duplicate = jobs.find(job => job.requestId === requestId);
    if (duplicate) { if (duplicate.requestHash !== requestHash) throw fail('Conflicting requestId.', 409); return duplicate; }
    // Recheck after the awaited desktop read so simultaneous HTTP requests cannot both start work.
    if (jobs.some(job => !TERMINAL.has(job.status))) throw fail('Another job reserved the connector.', 409, 'connector_busy');
    const job = { id: randomUUID(), threadId, ...(hostId ? { hostId } : {}), kind, requestId, requestHash, status: 'queued', submitted: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    jobs.push(job); await persist(); await audit('queued', job);
    const operation = dispatch(job, prompt).finally(() => running.delete(job.id));
    running.set(job.id, operation);
    return job;
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
      if (request.method === 'GET' && url.pathname === '/v1/status') { await backend.listThreads({ limit: 1 }); return send(200, { desktopReachable: true, mode: config.allowAllTasks ? 'expanded' : 'pilot', execution: 'existing_desktop_chats', computerExecution: 'through_target_chat', serializedJobs: true, capabilities: ['list_tasks', 'read_task', 'continue_task', 'request_computer_work', 'poll_result'] }); }
      if (request.method === 'GET' && url.pathname === '/v1/tasks') return send(200, await tasks(url.searchParams));
      const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
      if (request.method === 'GET' && taskMatch) { const id = decodeURIComponent(taskMatch[1]); authorizeThread(id); return send(200, await backend.readThread(id, { hostId: url.searchParams.get('hostId') || undefined, turnLimit: Number(url.searchParams.get('turnLimit') || 3), cursor: url.searchParams.get('cursor') || undefined })); }
      if (request.method === 'GET' && url.pathname === '/v1/jobs') return send(200, { jobs: jobs.slice(-50).reverse().map(publicJob) });
      if (request.method === 'POST' && url.pathname === '/v1/jobs') return send(202, publicJob(await submit(await readBody(request))));
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && jobMatch) { const job = jobs.find(item => item.id === jobMatch[1]); if (!job) throw fail('Job not found.', 404, 'not_found'); await poll(job); return send(200, publicJob(job)); }
      throw fail('Route not found.', 404, 'not_found');
    } catch (error) { if (!response.headersSent) send(error.statusCode || 502, { error: error.code || 'connector_error', message: redact(error.message || 'Connector operation failed.') }); }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 18761, '127.0.0.1', resolve); }),
    address: () => server.address(),
    close: async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...running.values(), ...polling.values()]); await persistence; await backend.close(); },
  };
}
