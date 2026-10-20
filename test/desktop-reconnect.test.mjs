import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { saveOwnerGrant, readOwnerGrant, startDesktopReconnect, authorizeDesktopReconnect } from '../src/desktop-reconnect.mjs';
import { writeContext } from '../src/context-bridge.mjs';

const controllerThreadId = '019a0000-0000-7000-8000-000000000001';
const callerTurnId = '019a0000-0000-7000-8000-000000000002';
const foreignController = '019a0000-0000-7000-8000-000000000003';
const pipePath = String.raw`\\.\pipe\codex-app-tools-019a0000-0000-7000-8000-000000000004`;
const secondPipe = String.raw`\\.\pipe\codex-app-tools-019a0000-0000-7000-8000-000000000005`;

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-reconnect-test-'));
  const services = [];
  t.after(async () => {
    for (const service of services) await service.stop();
    const remainder = relative(resolve(tmpdir()), resolve(dataDir));
    assert.ok(remainder.startsWith('muse-reconnect-test-') && !isAbsolute(remainder) && !remainder.includes('..'));
    await rm(dataDir, { recursive: true, force: true });
  });
  const config = { dataDir, controllerThreadId, desktopContextFile: join(dataDir, 'desktop-context.json'), desktopReconnect: { enabled: true, appUserModelId: 'Synthetic.Package!App' } };
  const found = { pipePath, serverPid: process.pid, startedUtc: new Date(Date.now() - 10000).toISOString(), executable: resolve(dataDir, 'synthetic-app.exe') };
  const grant = () => saveOwnerGrant(dataDir, { controllerThreadId, callerTurnId });
  const context = async extra => {
    const value = { pipePath, controllerThreadId, callerTurnId, registrationId: randomUUID(), pid: process.pid, updatedAt: new Date().toISOString(), ...extra };
    await writeContext(config.desktopContextFile, value);
    return value;
  };
  const saved = async () => JSON.parse(await readFile(config.desktopContextFile, 'utf8'));
  const daemon = (options = {}) => {
    const service = startDesktopReconnect(config, { discover: async () => found, ...options });
    services.push(service);
    return service;
  };
  return { config, dataDir, found, grant, context, saved, daemon };
}

test('durable owner grants contain genuine UUIDs and reject missing, malformed, or foreign authorization', async t => {
  const h = await fixture(t);
  await assert.rejects(readOwnerGrant(h.dataDir, controllerThreadId));
  await assert.rejects(saveOwnerGrant(h.dataDir, { controllerThreadId, callerTurnId: 'synthetic-turn' }));
  await assert.rejects(saveOwnerGrant(h.dataDir, { controllerThreadId: '', callerTurnId }));
  await h.grant();
  const value = await readOwnerGrant(h.dataDir, controllerThreadId);
  assert.equal(value.version, 1);
  assert.equal(value.controllerThreadId, controllerThreadId);
  assert.equal(value.callerTurnId, callerTurnId);
  await assert.rejects(readOwnerGrant(h.dataDir, foreignController));
  await writeFile(join(h.dataDir, 'desktop-owner.json'), JSON.stringify({ ...value, version: 2 }));
  await assert.rejects(readOwnerGrant(h.dataDir, controllerThreadId));
});

test('reconnect rejects an unexpected lease file or unapproved startup configuration', async t => {
  const h = await fixture(t);
  for (const extra of [{ desktopContextFile: join(h.dataDir, 'other.json') }, { desktopContextFile: 'desktop-context.json' }, { dataDir: 'relative' }, { controllerThreadId: 'invented' }, { desktopReconnect: { enabled: false, appUserModelId: 'Synthetic.Package!App' } }, { desktopReconnect: { enabled: true, appUserModelId: 'unsafe argument' } }, { desktopReconnect: { ...h.config.desktopReconnect, powerShellPath: 'pwsh.exe' } }, { desktopReconnect: { ...h.config.desktopReconnect, powerShellPath: join(h.dataDir, 'absent-pwsh.exe') } }, { desktopReconnect: { ...h.config.desktopReconnect, powerShellPath: h.dataDir } }]) {
    assert.throws(() => startDesktopReconnect({ ...h.config, ...extra }));
  }
});

test('missing or foreign durable authorization never triggers discovery or claims a lease', async t => {
  const h = await fixture(t);
  let discoveries = 0;
  const service = h.daemon({ discover: async () => { discoveries++; return h.found; } });
  assert.equal((await service.tick()).status, 'unavailable');
  await saveOwnerGrant(h.dataDir, { controllerThreadId: foreignController, callerTurnId });
  assert.equal((await service.tick()).status, 'unavailable');
  assert.equal(discoveries, 0);
  await assert.rejects(h.saved(), { code: 'ENOENT' });
});

test('restart uses its durable grant without CODEX environment and refreshes the same verified peer', async t => {
  const h = await fixture(t);
  await h.grant();
  let timestamp = new Date().toISOString();
  const service = h.daemon({ now: () => timestamp });
  assert.equal((await service.tick()).status, 'registered');
  const first = await h.saved();
  assert.equal(first.controllerThreadId, controllerThreadId);
  assert.equal(first.callerTurnId, callerTurnId);
  assert.equal(first.source, 'startup');
  assert.equal(first.pid, process.pid);
  assert.deepEqual(first.serviceIdentity, { pid: process.pid, serverPid: h.found.serverPid, executable: h.found.executable, startedUtc: h.found.startedUtc });
  timestamp = new Date(Date.now() + 1000).toISOString();
  assert.equal((await service.tick()).status, 'registered');
  const refreshed = await h.saved();
  assert.equal(refreshed.registrationId, first.registrationId);
  assert.equal(refreshed.updatedAt, timestamp);
  await service.stop();
  await assert.rejects(h.saved(), { code: 'ENOENT' });
  const replacement = h.daemon();
  assert.equal((await replacement.tick()).status, 'registered');
  assert.notEqual((await h.saved()).registrationId, first.registrationId);
});

test('verified app pipe or peer process changes rotate the service registration', async t => {
  const h = await fixture(t);
  await h.grant();
  let found = h.found;
  const service = h.daemon({ discover: async () => found });
  await service.tick();
  const initial = await h.saved();
  found = { ...found, pipePath: secondPipe };
  assert.equal((await service.tick()).status, 'registered');
  const next = await h.saved();
  assert.notEqual(next.registrationId, initial.registrationId);
  assert.equal(next.pipePath, secondPipe);
  found = { ...found, serverPid: process.pid + 1 };
  await service.tick();
  assert.notEqual((await h.saved()).registrationId, next.registrationId);
});

test('a fresh registrar wins and a replacement service does not steal its lease', async t => {
  const h = await fixture(t);
  await h.grant();
  const original = await h.context();
  let discoveries = 0;
  const service = h.daemon({ discover: async () => { discoveries++; return h.found; } });
  assert.equal((await service.tick()).status, 'yielded');
  assert.equal(discoveries, 1);
  assert.deepEqual(await h.saved(), original);
  await service.stop();
  assert.deepEqual(await h.saved(), original);
});

test('an unchanged surviving owner registrar is replaced only when its app pipe fails verified discovery', async t => {
  const h = await fixture(t);
  await h.grant();
  const original = await h.context();
  const preferences = [];
  const service = h.daemon({ discover: async (config, signal, preferred) => { preferences.push(preferred); return { ...h.found, pipePath: secondPipe }; } });
  assert.equal((await service.tick()).status, 'registered');
  const replacement = await h.saved();
  assert.deepEqual(preferences, [original.pipePath]);
  assert.equal(replacement.pipePath, secondPipe);
  assert.equal(replacement.controllerThreadId, controllerThreadId);
  assert.equal(replacement.callerTurnId, callerTurnId);
  assert.notEqual(replacement.registrationId, original.registrationId);
});

test('verified discovery cannot displace a fresh foreign-controller registrar', async t => {
  const h = await fixture(t);
  await h.grant();
  const foreign = await h.context({ controllerThreadId: foreignController });
  const service = h.daemon({ discover: async () => ({ ...h.found, pipePath: secondPipe }) });
  assert.equal((await service.tick()).status, 'yielded');
  assert.deepEqual(await h.saved(), foreign);
});

test('an explicitly configured PowerShell executable must be an existing absolute file', async t => {
  const h = await fixture(t);
  await h.grant();
  const executable = join(h.dataDir, 'synthetic-pwsh.exe');
  await writeFile(executable, 'Synthetic configured executable; never executed by this test.');
  h.config.desktopReconnect.powerShellPath = executable;
  assert.equal((await h.daemon().tick()).status, 'registered');
});

test('a fresh registrar arriving during discovery remains the owner', async t => {
  const h = await fixture(t);
  await h.grant();
  let release, started;
  const discovered = new Promise(resolve => { release = resolve; });
  const begin = new Promise(resolve => { started = resolve; });
  const service = h.daemon({ discover: async () => { started(); return discovered; } });
  const tick = service.tick();
  await begin;
  const current = await h.context();
  release(h.found);
  assert.equal((await tick).status, 'yielded');
  assert.deepEqual(await h.saved(), current);
});

test('a changed genuine registrar is preserved even when the discovery result names its earlier pipe', async t => {
  const h = await fixture(t);
  await h.grant();
  await h.context();
  let release, started;
  const discovered = new Promise(resolve => { release = resolve; });
  const begin = new Promise(resolve => { started = resolve; });
  const service = h.daemon({ discover: async () => { started(); return discovered; } });
  const tick = service.tick();
  await begin;
  const current = await h.context({ pipePath: secondPipe });
  release(h.found);
  assert.equal((await tick).status, 'yielded');
  assert.deepEqual(await h.saved(), current);
});

test('revoked authorization or failed discovery removes only the service own lease', async t => {
  for (const cause of ['missing grant', 'foreign grant', 'failed discovery', 'invalid peer']) {
    await t.test(cause, async t => {
      const h = await fixture(t);
      await h.grant();
      let found = h.found;
      const service = h.daemon({ discover: async () => { if (found instanceof Error) throw found; return found; } });
      await service.tick();
      if (cause === 'missing grant') await unlink(join(h.dataDir, 'desktop-owner.json'));
      if (cause === 'foreign grant') await saveOwnerGrant(h.dataDir, { controllerThreadId: foreignController, callerTurnId });
      if (cause === 'failed discovery') found = new Error('App has exited.');
      if (cause === 'invalid peer') found = { ...found, pipePath: String.raw`\\.\pipe\unverified-app` };
      assert.equal((await service.tick()).status, 'unavailable');
      await assert.rejects(h.saved(), { code: 'ENOENT' });
    });
  }
});

test('service shutdown removes its own lease and preserves a newer registrar', async t => {
  const h = await fixture(t);
  await h.grant();
  const service = h.daemon();
  await service.tick();
  const newer = await h.context();
  await service.stop();
  assert.deepEqual(await h.saved(), newer);
  assert.equal((await service.tick()).status, 'stopped');
});

test('late discovery cannot activate after shutdown', async t => {
  const h = await fixture(t);
  await h.grant();
  let release, started;
  const discoverResult = new Promise(resolve => { release = resolve; });
  const begin = new Promise(resolve => { started = resolve; });
  const service = h.daemon({ discover: async () => { started(); return discoverResult; } });
  const tick = service.tick();
  await begin;
  await service.stop();
  release(h.found);
  assert.equal((await tick).status, 'stopped');
  await assert.rejects(h.saved(), { code: 'ENOENT' });
});

test('a changed grant during discovery cannot publish stale owner metadata', async t => {
  const h = await fixture(t);
  await h.grant();
  let release, started;
  const discoverResult = new Promise(resolve => { release = resolve; });
  const begin = new Promise(resolve => { started = resolve; });
  const service = h.daemon({ discover: async () => { started(); return discoverResult; } });
  const tick = service.tick();
  await begin;
  await saveOwnerGrant(h.dataDir, { controllerThreadId, callerTurnId: foreignController });
  release(h.found);
  assert.equal((await tick).status, 'unavailable');
  await assert.rejects(h.saved(), { code: 'ENOENT' });
});

test('failures retry with bounded backoff and healthy renewals use fifteen seconds', async t => {
  const h = await fixture(t);
  await h.grant();
  const pauses = [];
  let attempts = 0, service;
  service = h.daemon({
    discover: async () => { if (++attempts <= 7) throw new Error('App unavailable.'); return h.found; },
    wait: async ms => { pauses.push(ms); if (pauses.length === 8) await service.stop(); },
  });
  await service.run();
  assert.deepEqual(pauses, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 15000]);
});

test('authorization migration requires a fresh genuine owner lease and the exact verified pipe', async t => {
  const h = await fixture(t);
  const preferences = [];
  const options = { discover: async (config, signal, preferred) => { preferences.push(preferred); return h.found; } };
  await assert.rejects(authorizeDesktopReconnect(h.config, options));
  await h.context();
  await assert.rejects(authorizeDesktopReconnect(h.config, { discover: async () => ({ ...h.found, pipePath: secondPipe }) }));
  const grant = await authorizeDesktopReconnect(h.config, options);
  assert.equal(grant.controllerThreadId, controllerThreadId);
  assert.equal(grant.callerTurnId, callerTurnId);
  assert.deepEqual(preferences, [pipePath]);
  assert.deepEqual(await readOwnerGrant(h.dataDir, controllerThreadId), grant);
  await h.context({ source: 'startup', serviceIdentity: {} });
  await assert.rejects(authorizeDesktopReconnect(h.config, options));
});

test('authorization migration rejects a replaced lease or stale native context', async t => {
  const h = await fixture(t);
  await h.context({ updatedAt: new Date(Date.now() - 61000).toISOString() });
  await assert.rejects(authorizeDesktopReconnect(h.config, { discover: async () => h.found }));
  await h.context();
  await assert.rejects(authorizeDesktopReconnect(h.config, { discover: async () => { await h.context(); return h.found; } }));
  await assert.rejects(readOwnerGrant(h.dataDir, controllerThreadId));
});

test('run exits promptly when stopped during its healthy timer', async t => {
  const h = await fixture(t);
  await h.grant();
  const service = h.daemon();
  const run = service.run();
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await h.saved()).source === 'startup') break; } catch {}
    await delay(5);
  }
  await service.stop();
  await run;
  await assert.rejects(h.saved(), { code: 'ENOENT' });
});
