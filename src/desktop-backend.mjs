import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { readDesktopContext } from './context-bridge.mjs';

const ALLOWED_TOOLS = new Set(['list_threads', 'list_archived_threads', 'read_thread', 'send_message_to_thread', 'wait_threads']);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function failure(message, code = 'desktop_error', statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function discoverAppToolsServer(env = process.env) {
  if (env.CODEX_APP_TOOLS_SERVER) {
    const explicit = env.CODEX_APP_TOOLS_SERVER;
    if (!path.isAbsolute(explicit) || !fs.existsSync(explicit)) throw failure('CODEX_APP_TOOLS_SERVER must name an installed absolute server.mjs path.', 'desktop_not_installed', 503);
    return explicit;
  }
  const root = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  let versions;
  try { versions = fs.readdirSync(root, { withFileTypes: true }).filter(v => v.isDirectory()).map(v => v.name); }
  catch { throw failure('Codex desktop app-tools is not installed. Open Codex and enable its bundled app tools.', 'desktop_not_installed', 503); }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const server = versions.map(v => path.join(root, v, 'server.mjs')).find(p => fs.existsSync(p));
  if (!server) throw failure('No installed Codex desktop app-tools server was found.', 'desktop_not_installed', 503);
  return server;
}

// Standard MCP stdio only. The installed Codex server owns its native IPC implementation.
export class DesktopMcpClient {
  constructor(options = {}) {
    this.env = { ...(options.env || process.env) };
    this.callerThreadId = options.callerThreadId || this.env.CODEX_THREAD_ID;
    this.callerTurnId = options.callerTurnId;
    this.desktopContextFile = options.desktopContextFile;
    this.contextRegistrationId = null;
    this.serverPath = options.serverPath;
    this.processFactory = options.processFactory || spawn;
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.ready = false;
    this.admission = Promise.resolve();
    this.closeGeneration = 0;
    this.drainWaiters = new Set();
  }

  admit(action) {
    const generation = this.closeGeneration;
    const next = this.admission.then(async () => {
      this.checkGeneration(generation);
      return action(generation);
    });
    this.admission = next.catch(() => {});
    return next;
  }

  checkGeneration(generation) {
    if (generation !== this.closeGeneration) throw failure('Codex desktop connection closed.', 'desktop_closed', 503);
  }

  start() {
    return this.admit(generation => this.ensureStarted(generation));
  }

  async ensureStarted(generation) {
    try {
      if (this.desktopContextFile) {
        let context = await readDesktopContext(this.desktopContextFile, this.callerThreadId);
        this.checkGeneration(generation);
        if (this.contextRegistrationId === context.registrationId && this.env.CODEX_APP_TOOLS_PIPE_PATH !== context.pipePath) {
          throw failure('Codex desktop context changed without a new registration.', 'desktop_context_unavailable', 503);
        }
        if (this.env.CODEX_APP_TOOLS_PIPE_PATH !== context.pipePath) {
          await this.waitForPending();
          this.checkGeneration(generation);
          // A lease can change or expire while an authorized request finishes.
          context = await readDesktopContext(this.desktopContextFile, this.callerThreadId);
          this.checkGeneration(generation);
          if (this.contextRegistrationId === context.registrationId && this.env.CODEX_APP_TOOLS_PIPE_PATH !== context.pipePath) {
            throw failure('Codex desktop context changed without a new registration.', 'desktop_context_unavailable', 503);
          }
          if (this.env.CODEX_APP_TOOLS_PIPE_PATH !== context.pipePath) await this.disconnect();
          this.checkGeneration(generation);
        }
        this.env.CODEX_APP_TOOLS_PIPE_PATH = context.pipePath;
        this.contextRegistrationId = context.registrationId;
        this.callerTurnId = context.callerTurnId;
      }
      this.checkGeneration(generation);
      if (!this.ready) await this.startInternal();
      this.checkGeneration(generation);
    } catch (error) {
      if (generation === this.closeGeneration && !this.pending.size) await this.disconnect();
      throw error;
    }
  }

  waitForPending() {
    if (!this.pending.size) return Promise.resolve();
    return new Promise(resolve => this.drainWaiters.add(resolve));
  }

  notifyDrained() {
    if (this.pending.size) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  async startInternal() {
    if (!this.env.CODEX_APP_TOOLS_PIPE_PATH || !this.callerThreadId) throw failure('Launch this connector from an authorized Codex desktop chat so Codex provides its IPC endpoint and caller chat ID.', 'desktop_context_required', 503);
    const server = this.serverPath || discoverAppToolsServer(this.env);
    const child = this.processFactory(process.execPath, [server], { env: { ...this.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', data => { if (this.child === child) this.onData(data); });
    child.stderr.on('data', () => {}); // Consume diagnostics without logging private host data.
    child.once('error', () => { if (this.child === child) this.fail(failure('Codex app-tools could not start.', 'desktop_start_failed', 503)); });
    child.once('exit', () => { if (this.child === child) this.fail(failure('Codex app-tools disconnected. Relaunch the connector from Codex.', 'desktop_disconnected', 503)); });
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse-local-connector', version: '0.1.0' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.ready = true;
  }

  onData(data) {
    this.buffer += typeof data === 'string' ? data : this.decoder.write(data);
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) { this.fail(failure('Codex returned a response larger than the connector limit.', 'desktop_response_too_large')); this.child?.kill(); return; }
    while (this.buffer.includes('\n')) {
      const at = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(failure('Codex app-tools returned invalid MCP JSON.', 'desktop_protocol_error')); this.child?.kill(); return; }
      const waiting = this.pending.get(String(message.id));
      if (waiting && (Object.hasOwn(message, 'result') || message.error)) {
        this.pending.delete(String(message.id));
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(failure(String(message.error.message || 'Codex rejected the tool request.').slice(0, 500), 'desktop_rpc_error'));
        else waiting.resolve(message.result);
        this.notifyDrained();
      } else if (message.method && Object.hasOwn(message, 'id')) {
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'This connector does not handle server-initiated requests.' } });
      }
    }
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw failure('Codex app-tools is not connected.', 'desktop_closed', 503);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(failure('Codex desktop request timed out. Its outcome may be uncertain; check the target chat before retrying a send.', 'desktop_timeout', 504));
        this.notifyDrained();
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(String(id)); reject(error); this.notifyDrained(); }
    });
  }

  async callTool(name, args, timeoutMs) {
    if (!ALLOWED_TOOLS.has(name)) throw failure('The requested desktop tool is not allowed by this connector.', 'desktop_tool_not_allowed', 403);
    const { response } = await this.admit(async generation => {
      await this.ensureStarted(generation);
      this.checkGeneration(generation);
      // Admission ends after sending, so responses remain concurrent while a
      // connection handoff cannot race between readiness and request creation.
      return { response: this.request('tools/call', { name, arguments: args, _meta: { 'openai/threadId': this.callerThreadId, ...(this.callerTurnId ? { 'openai/turnId': this.callerTurnId } : {}) } }, timeoutMs) };
    });
    const result = await response;
    const texts = (result.content || []).filter(c => c.type === 'text').map(c => c.text);
    if (result.isError) throw failure(texts.join('\n').slice(0, 500) || 'Codex desktop tool failed.', 'desktop_tool_error');
    if (result.structuredContent) return result.structuredContent;
    for (const text of texts) { try { return JSON.parse(text); } catch {} }
    throw failure('Codex desktop returned an unsupported result format.', 'desktop_protocol_error');
  }

  fail(error) {
    this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.notifyDrained();
  }

  async close() {
    this.closeGeneration += 1;
    await this.disconnect();
  }

  async disconnect() {
    this.fail(failure('Codex desktop connection closed.', 'desktop_closed', 503));
    const child = this.child;
    this.child = null;
    child?.stdin?.end();
    child?.kill();
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }
}

function normalizeTask(task, archived = false) {
  return { id: task.id || task.threadId, title: task.title || task.name || '', kind: task.kind || task.source || 'codex', hostId: task.hostId || null, status: task.status || 'unknown', cwd: task.cwd || null, summary: task.summary || '', archived };
}

function canReadInsteadOfWait(error) {
  if ([401, 403].includes(error.statusCode) || /auth|forbidden|permission|access denied|metadata|context|token|expired|disconnect|closed|timed? ?out/i.test(error.message || '')) return false;
  if (!['desktop_rpc_error', 'desktop_tool_error'].includes(error.code)) return false;
  return /Codex app tool request failed|unknown.*wait_threads|method not found|not supported|unsupported|not available/i.test(error.message || '');
}

function readSnapshot(read, threadId, hostId, afterCursor) {
  const thread = read.thread || { id: threadId, hostId };
  const turn = read.turns?.[0] || null;
  const messages = (turn?.items || []).filter(item => item.type === 'agentMessage');
  const message = messages.findLast(item => item.phase === 'final_answer') || messages.at(-1);
  const cursor = `read:${createHash('sha256').update(JSON.stringify({ id: thread.id, status: thread.status, turnId: turn?.id, turnStatus: turn?.status, message })).digest('base64url')}`;
  const changed = cursor !== afterCursor;
  const latestTurn = turn ? Object.fromEntries(['id', 'status', 'error', 'startedAt', 'completedAt', 'durationMs'].filter(key => turn[key] !== undefined).map(key => [key, turn[key]])) : undefined;
  return {
    timedOut: !changed,
    source: 'read_thread_fallback',
    polls: [{ cursor, changed, thread: { id: thread.id || threadId, hostId: thread.hostId || hostId, status: thread.status || { type: 'unknown' } }, ...(latestTurn ? { latestTurn } : {}), ...(changed && message ? { latestAssistantMessage: { id: message.id, turnId: turn.id, phase: message.phase, text: message.text || '' } } : {}) }],
  };
}

export class DesktopBackend {
  constructor(options = {}) {
    this.client = options.client || new DesktopMcpClient(options);
    this.localCatalog = options.localCatalog;
    // Native waits require an active caller turn; the leased connector outlives it.
    this.useReadPolling = Boolean(this.client.desktopContextFile);
  }

  async listThreads({ limit = 100, search, archived = false, cursor, source = 'codex' } = {}) {
    const size = Math.min(50, Math.max(1, Number(limit) || 50));
    let result, tasks, nextCursor = null, partial = false;
    if (archived) {
      result = await this.client.callTool('list_archived_threads', { limit: size, source, ...(cursor ? { cursor } : {}) });
      tasks = (result.threads || result.archivedThreads || []).map(t => normalizeTask(t, true));
      nextCursor = result.nextCursor || null;
    } else {
      if (cursor) throw failure('Codex desktop recent task discovery does not support a pagination cursor.', 'catalog_cursor_unsupported', 400);
      result = await this.client.callTool('list_threads', { limit: size });
      tasks = [...new Map([...(result.pinnedThreads || []), ...(result.threads || [])].map(t => [t.id, normalizeTask(t)])).values()];
      partial = (result.threads || []).length >= size;
    }
    if (search) { const term = String(search).toLowerCase(); tasks = tasks.filter(t => `${t.title}\n${t.summary}`.toLowerCase().includes(term)); }
    return { tasks, nextCursor, partial, coverage: archived ? { source, archived: 'paginated' } : { codex: 'recent_and_pinned', chatgpt: 'recent_and_pinned' } };
  }

  async listAllLocalThreads({ search } = {}) {
    const { LocalCatalog, mergeTaskCatalogs } = await import('./local-catalog.mjs');
    this.localCatalog ||= new LocalCatalog({ env: this.client.env || process.env });
    const [desktop, local] = await Promise.all([this.listThreads({ limit: 50 }), this.localCatalog.listAll()]);
    const result = mergeTaskCatalogs(desktop, local);
    if (search) { const term = String(search).toLowerCase(); result.tasks = result.tasks.filter(t => `${t.title}\n${t.summary}`.toLowerCase().includes(term)); }
    return result;
  }

  readThread(threadId, { hostId, cursor, turnLimit = 3 } = {}) {
    return this.client.callTool('read_thread', { threadId, turnLimit: Math.min(10, Math.max(1, Number(turnLimit) || 3)), includeOutputs: false, ...(hostId ? { hostId } : {}), ...(cursor ? { cursor } : {}) });
  }

  async sendMessage(threadId, prompt, { hostId } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw failure('A nonempty task instruction is required.', 'instruction_required', 400);
    return this.client.callTool('send_message_to_thread', { threadId, prompt, ...(hostId ? { hostId } : {}) });
  }

  async waitThread(threadId, { hostId, afterCursor, timeoutMs = 0 } = {}) {
    const duration = Math.min(60000, Math.max(0, Number(timeoutMs) || 0));
    if (!this.useReadPolling) {
      try { return await this.client.callTool('wait_threads', { targets: [{ threadId, ...(hostId ? { hostId } : {}), ...(afterCursor ? { afterCursor } : {}) }], timeoutMs: duration }, duration + 30000); }
      catch (error) { if (!canReadInsteadOfWait(error)) throw error; }
    }
    const read = await this.readThread(threadId, { hostId, turnLimit: 1 });
    this.useReadPolling = true;
    return readSnapshot(read, threadId, hostId, afterCursor);
  }

  async close() {
    await this.client.close();
    await this.localCatalog?.close();
  }
}

export const createDesktopBackend = options => new DesktopBackend(options);
