import { open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => Object.assign(new Error('Fresh Codex desktop context is unavailable. Wait for the Codex context registrar to reconnect.'), { code: 'desktop_context_unavailable', statusCode: 503 });

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function readDesktopContext(file, controllerThreadId) {
  try {
    if (!isAbsolute(file) || !controllerThreadId || (await stat(file)).size > 65536) throw unavailable();
    const context = JSON.parse(await readFile(file, 'utf8'));
    const age = Date.now() - Date.parse(context.updatedAt);
    if (context.controllerThreadId !== controllerThreadId || !UUID.test(context.registrationId || '') ||
        typeof context.pipePath !== 'string' || !context.pipePath.trim() || context.pipePath.includes('\0') ||
        !Number.isInteger(context.pid) || context.pid < 1 || !processIsAlive(context.pid) ||
        !Number.isFinite(age) || age < -5000 || age > 60000) throw unavailable();
    return context;
  } catch { throw unavailable(); }
}

async function withLeaseLock(dataDir, action) {
  const file = join(dataDir, '.desktop-context.lock');
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await open(file, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const contents = await readFile(file, 'utf8');
        const owner = JSON.parse(contents);
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw unavailable();
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH' && await readFile(file, 'utf8') === contents) await unlink(file);
        }
      } catch {
        try { if (Date.now() - (await stat(file)).mtimeMs > 5000) await unlink(file); } catch {}
      }
      await delay(20);
    }
  }
  if (!handle) throw unavailable();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return await action();
  } finally {
    await handle.close();
    await unlink(file).catch(() => {});
  }
}

async function writeContext(file, context) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(context)}\n`); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

// The launcher is a standard stdio MCP server. Native IPC remains owned by the
// installed app-tools runtime; its environment forwarding is version-dependent.
async function main() {
  const args = process.argv.slice(2);
  const configPath = args[args.indexOf('--config') + 1];
  if (!args.includes('--config') || !configPath || !process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim()) throw unavailable();
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!isAbsolute(config.dataDir || '') || !UUID.test(config.controllerThreadId || '')) throw unavailable();
  if (process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== config.controllerThreadId) throw unavailable();
  const file = join(config.dataDir, 'desktop-context.json');
  if (config.desktopContextFile && resolve(config.desktopContextFile) !== file) throw unavailable();
  const registrationId = randomUUID();
  const context = { pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH, controllerThreadId: config.controllerThreadId, registrationId, pid: process.pid, updatedAt: new Date().toISOString() };
  let closed = false, operations = Promise.resolve();
  const serialized = action => { const next = operations.then(action); operations = next.catch(() => {}); return next; };
  const ownsLease = async () => {
    try { return (await readDesktopContext(file, config.controllerThreadId)).registrationId === registrationId; }
    catch { return false; }
  };
  await withLeaseLock(config.dataDir, () => writeContext(file, context));
  const heartbeat = setInterval(() => {
    serialized(() => withLeaseLock(config.dataDir, async () => {
      let current;
      try {
        const stored = JSON.parse(await readFile(file, 'utf8'));
        current = await readDesktopContext(file, stored.controllerThreadId);
      } catch {}
      if (!closed && (!current || current.registrationId === registrationId)) await writeContext(file, { ...context, updatedAt: new Date().toISOString() });
    })).catch(() => {});
  }, 15000);
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    await serialized(() => withLeaseLock(config.dataDir, async () => {
      try {
        if (JSON.parse(await readFile(file, 'utf8')).registrationId === registrationId) await unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })).catch(() => {});
  };
  const lines = createInterface({ input: process.stdin });
  const respond = value => { if (process.stdout.writable) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); };
  lines.on('line', line => {
    serialized(async () => {
      let message;
      try { if (Buffer.byteLength(line) > 65536) throw new Error(); message = JSON.parse(line); }
      catch { respond({ id: null, error: { code: -32700, message: 'Invalid JSON request.' } }); return; }
      if (!Object.hasOwn(message, 'id')) return;
      if (message.method === 'initialize') respond({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'muse-desktop-context', version: '0.1.0' } } });
      else if (message.method === 'ping') respond({ id: message.id, result: {} });
      else if (message.method === 'tools/list') respond({ id: message.id, result: { tools: [{ name: 'desktop_context_status', description: 'Report whether this Codex runtime owns the current local connector context registration.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false }, outputSchema: { type: 'object', properties: { registered: { type: 'boolean' } }, required: ['registered'], additionalProperties: false } }] } });
      else if (message.method === 'tools/call' && message.params?.name === 'desktop_context_status') {
        const status = { registered: await ownsLease() };
        respond({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status } });
      } else respond({ id: message.id, error: { code: -32601, message: 'Method or tool is not available.' } });
    }).catch(() => { respond({ id: null, error: { code: -32603, message: 'Desktop context is unavailable.' } }); });
  });
  lines.once('close', () => { shutdown().catch(() => {}); });
  process.once('SIGINT', () => { lines.close(); process.stdin.destroy(); });
  process.once('SIGTERM', () => { lines.close(); process.stdin.destroy(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Codex context registrar could not start. Check its local configuration and Codex launch environment.'); process.exitCode = 1; });
}
