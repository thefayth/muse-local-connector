import { readFile, stat, unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readDesktopContext, withLeaseLock, writeContext } from './context-bridge.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PIPE = /^\\\\\.\\pipe\\codex-app-tools-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const runFile = promisify(execFile);
const failure = () => Object.assign(new Error('Authorized desktop startup context is unavailable.'), { code: 'desktop_reconnect_unavailable', statusCode: 503 });

async function json(file) {
  if ((await stat(file)).size > 65536) throw failure();
  return JSON.parse(await readFile(file, 'utf8'));
}

function owner(value, expectedController) {
  if (value?.version !== 1 || !UUID.test(value.controllerThreadId || '') || !UUID.test(value.callerTurnId || '') ||
      value.controllerThreadId !== expectedController || !Number.isFinite(Date.parse(value.authorizedAt)) || Date.parse(value.authorizedAt) > Date.now() + 5000) throw failure();
  return { version: 1, controllerThreadId: value.controllerThreadId, callerTurnId: value.callerTurnId, authorizedAt: value.authorizedAt };
}

export async function saveOwnerGrant(dataDir, { controllerThreadId, callerTurnId, authorizedAt = new Date().toISOString() }) {
  if (!isAbsolute(dataDir || '')) throw failure();
  const grant = owner({ version: 1, controllerThreadId, callerTurnId, authorizedAt }, controllerThreadId);
  await writeContext(join(dataDir, 'desktop-owner.json'), grant);
  return grant;
}

export async function readOwnerGrant(dataDir, expectedController) {
  try {
    if (!isAbsolute(dataDir || '') || !UUID.test(expectedController || '')) throw failure();
    return owner(await json(join(dataDir, 'desktop-owner.json')), expectedController);
  } catch { throw failure(); }
}

function validate(config) {
  if (!isAbsolute(config?.dataDir || '') || !UUID.test(config.controllerThreadId || '') ||
      config.desktopReconnect?.enabled !== true ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}![A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(config.desktopReconnect.appUserModelId || '') ||
      !isAbsolute(config.desktopContextFile || '') || resolve(config.desktopContextFile) !== join(resolve(config.dataDir), 'desktop-context.json')) throw failure();
  if (config.desktopReconnect.powerShellPath !== undefined) powerShellPath(config);
}

function powerShellPath(config) {
  const file = config.desktopReconnect.powerShellPath || join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (!isAbsolute(file) || !statSync(file).isFile()) throw failure();
  return file;
}

function peer(value) {
  if (!PIPE.test(value?.pipePath || '') || !Number.isInteger(value.serverPid) || value.serverPid < 1 ||
      !Number.isFinite(Date.parse(value.startedUtc)) || Date.parse(value.startedUtc) > Date.now() + 5000 ||
      typeof value.executable !== 'string' || !isAbsolute(value.executable) || value.executable.includes('\0')) throw failure();
  return value;
}

async function discover(config, signal, preferredPipePath) {
  if (process.platform !== 'win32') throw failure();
  const helper = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/discover-desktop-pipe.ps1');
  const args = ['-NoProfile', '-NonInteractive', '-File', helper, '-AppUserModelId', config.desktopReconnect.appUserModelId];
  if (preferredPipePath && PIPE.test(preferredPipePath)) args.push('-PreferredPipePath', preferredPipePath);
  const { stdout } = await runFile(powerShellPath(config), args, {
    windowsHide: true, timeout: 12000, maxBuffer: 65536, signal,
  });
  return peer(JSON.parse(stdout));
}

async function currentContext(file) {
  try {
    const stored = await json(file);
    if (!UUID.test(stored.controllerThreadId || '')) return null;
    return await readDesktopContext(file, stored.controllerThreadId);
  } catch { return null; }
}

// The grant originates in a genuine controller tool call. Discovery verifies the
// current installed app's pipe; this service never creates model turns or jobs.
export function startDesktopReconnect(config, options = {}) {
  validate(config);
  const discoverPeer = options.discover || discover;
  const wait = options.wait || ((ms, signal) => delay(ms, undefined, { signal }));
  const now = options.now || (() => new Date().toISOString());
  const abort = new AbortController();
  let closed = false, generation = 0, registration = null, operation = null, running = null;
  const file = config.desktopContextFile;
  const owns = context => registration && context?.registrationId === registration.id && context.pid === process.pid;
  const revoke = () => withLeaseLock(config.dataDir, async () => {
    let stored;
    try { stored = await json(file); } catch {}
    if (owns(stored)) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    registration = null;
  });
  const tick = () => {
    if (closed) return Promise.resolve({ status: 'stopped' });
    if (operation) return operation;
    const epoch = generation;
    operation = (async () => {
      try {
        const grant = await readOwnerGrant(config.dataDir, config.controllerThreadId);
        const before = await withLeaseLock(config.dataDir, async () => {
          if (closed || generation !== epoch) return null;
          return currentContext(file);
        });
        if (closed || generation !== epoch) return { status: 'stopped' };
        const found = peer(await discoverPeer(config, abort.signal, before?.pipePath));
        if (closed || generation !== epoch) return { status: 'stopped' };
        return await withLeaseLock(config.dataDir, async () => {
          if (closed || generation !== epoch) return { status: 'stopped' };
          const latest = await readOwnerGrant(config.dataDir, config.controllerThreadId);
          if (JSON.stringify(latest) !== JSON.stringify(grant)) throw failure();
          const current = await currentContext(file);
          if (current && !owns(current)) {
            const changed = !before || ['registrationId', 'pid', 'controllerThreadId', 'callerTurnId', 'pipePath'].some(key => current[key] !== before[key]);
            if (current.controllerThreadId !== grant.controllerThreadId || changed || current.pipePath === found.pipePath) {
              registration = null; return { status: 'yielded' };
            }
            // A surviving registrar can renew an app pipe that died at restart.
            // Replace only the unchanged owner lease after verifying the new app.
            registration = null;
          }
          if (!registration || registration.pipePath !== found.pipePath || registration.serverPid !== found.serverPid || registration.startedUtc !== found.startedUtc) {
            registration = { id: randomUUID(), pipePath: found.pipePath, serverPid: found.serverPid, startedUtc: found.startedUtc };
          }
          await writeContext(file, {
            pipePath: found.pipePath, controllerThreadId: grant.controllerThreadId, callerTurnId: grant.callerTurnId,
            registrationId: registration.id, pid: process.pid, updatedAt: now(), source: 'startup',
            serviceIdentity: { pid: process.pid, serverPid: found.serverPid, startedUtc: found.startedUtc, executable: found.executable },
          });
          return { status: 'registered' };
        });
      } catch {
        await revoke().catch(() => {});
        return { status: closed ? 'stopped' : 'unavailable' };
      }
    })().finally(() => { operation = null; });
    return operation;
  };
  const run = () => {
    if (running) return running;
    running = (async () => {
      let retryMs = 1000;
      while (!closed) {
        const state = await tick();
        if (closed) break;
        const healthy = state.status === 'registered' || state.status === 'yielded';
        const pause = healthy ? 15000 : retryMs;
        retryMs = healthy ? 1000 : Math.min(retryMs * 2, 30000);
        try { await wait(pause, abort.signal); } catch { if (!closed) throw failure(); }
      }
    })();
    return running;
  };
  const stop = async () => {
    if (!closed) { closed = true; generation++; abort.abort(); }
    await revoke();
  };
  return { tick, run, stop };
}

export async function authorizeDesktopReconnect(config, options = {}) {
  validate(config);
  const context = await readDesktopContext(config.desktopContextFile, config.controllerThreadId);
  if (context.source === 'startup' || context.serviceIdentity) throw failure();
  const found = peer(await (options.discover || discover)(config, undefined, context.pipePath));
  if (context.pipePath !== found.pipePath) throw failure();
  return withLeaseLock(config.dataDir, async () => {
    const latest = await readDesktopContext(config.desktopContextFile, config.controllerThreadId);
    if (latest.registrationId !== context.registrationId || latest.callerTurnId !== context.callerTurnId || latest.pipePath !== found.pipePath || latest.source === 'startup' || latest.serviceIdentity) throw failure();
    return saveOwnerGrant(config.dataDir, { controllerThreadId: latest.controllerThreadId, callerTurnId: latest.callerTurnId });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const authorize = args[0] === 'authorize';
  if (authorize) args.shift();
  if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) throw failure();
  const config = await json(args[1]);
  if (authorize) { await authorizeDesktopReconnect(config); console.log('Desktop startup owner authorization saved.'); return; }
  const reconnect = startDesktopReconnect(config);
  const stop = () => { reconnect.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('message', message => { if (message?.type === 'connector-shutdown') stop(); });
  try { await reconnect.run(); }
  finally { await reconnect.stop(); if (process.connected) process.disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Desktop startup reconnect could not start. Check its private configuration and owner authorization.'); process.exitCode = 1; });
}
