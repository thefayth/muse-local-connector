import fs from 'node:fs';
import path from 'node:path';
import { DesktopMcpClient } from './desktop-backend.mjs';

function launchSpec(env) {
  const candidates = [
    env.MUSE_CODEX_JS,
    path.join(path.dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')),
  ].filter(Boolean);
  const entry = candidates.find(p => path.isAbsolute(p) && fs.existsSync(p));
  if (entry) return { command: process.execPath, args: [entry, 'app-server', '--stdio'] };
  return { command: 'codex', args: ['app-server', '--stdio'] };
}

// The same JSON-lines transport framing; this client has no mutation methods.
export class LocalCatalogClient extends DesktopMcpClient {
  async startInternal() {
    const spec = launchSpec(this.env);
    const child = this.processFactory(spec.command, spec.args, { env: { ...this.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', data => this.onData(data));
    child.stderr.on('data', () => {});
    child.once('error', () => { if (this.child === child) this.fail(Object.assign(new Error('Codex CLI could not start its read-only task catalog. Install Codex CLI or set MUSE_CODEX_JS.'), { code: 'catalog_unavailable', statusCode: 503 })); });
    child.once('exit', () => { if (this.child === child) this.fail(Object.assign(new Error('The read-only Codex task catalog disconnected.'), { code: 'catalog_disconnected', statusCode: 503 })); });
    await this.request('initialize', { clientInfo: { name: 'muse-local-catalog', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    this.ready = true;
  }

  request(method, params, timeoutMs) {
    if (!['initialize', 'thread/list'].includes(method)) return Promise.reject(Object.assign(new Error('This read-only catalog method is not allowed.'), { code: 'catalog_read_only', statusCode: 403 }));
    return super.request(method, params, timeoutMs);
  }

  async callTool() { throw Object.assign(new Error('The local task catalog cannot execute tools.'), { code: 'catalog_read_only', statusCode: 403 }); }
}

export class LocalCatalog {
  constructor(options = {}) { this.client = options.client || new LocalCatalogClient(options); }

  async listAll({ archived = false } = {}) {
    await this.client.start();
    const tasks = new Map();
    const seen = new Set();
    let cursor;
    do {
      const page = await this.client.request('thread/list', { limit: 100, archived, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true, ...(cursor ? { cursor } : {}) });
      for (const t of page.data || []) tasks.set(t.id, { id: t.id, title: t.name || '', kind: 'codex', hostId: 'local', status: 'unknown', cwd: t.cwd || null, summary: t.preview || '', archived });
      const next = page.nextCursor || null;
      if (next && seen.has(next)) throw Object.assign(new Error('Codex task catalog returned a repeated page cursor.'), { code: 'catalog_pagination_error', statusCode: 502 });
      if (next) seen.add(next);
      cursor = next;
    } while (cursor);
    return { tasks: [...tasks.values()], nextCursor: null, partial: false };
  }

  close() { return this.client.close(); }
}

export function mergeTaskCatalogs(desktop, local) {
  const tasks = new Map(local.tasks.map(t => [t.id, t]));
  for (const task of desktop.tasks) tasks.set(task.id, task);
  return { tasks: [...tasks.values()], nextCursor: local.nextCursor || null, partial: Boolean(local.partial), coverage: { codex: local.partial ? 'partial_local_unarchived' : 'all_local_unarchived', chatgpt: 'recent_and_pinned' } };
}
