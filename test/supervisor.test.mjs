import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedProcess, relayArguments, startSupervisor, stopSupervisor } from '../src/supervisor.mjs';

function child(pid = 12345) {
  const process = new EventEmitter();
  process.pid = pid;
  process.connected = true;
  process.messages = [];
  process.kill = () => { queueMicrotask(() => process.emit('exit', 0)); return true; };
  process.send = (message, callback) => { process.messages.push(message); callback?.(); process.kill(); };
  return process;
}

test('SSH relay uses a named host, fixed loopback binds, and no interactive authentication', () => {
  const args = relayArguments({ host: 'owned-relay', remotePort: 23000, localPort: 18761 }, 18761);
  assert.deepEqual(args, ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-R', '127.0.0.1:23000:127.0.0.1:18761', 'owned-relay']);
  for (const relay of [
    { host: '-F attacker', remotePort: 23000, localPort: 18761 },
    { host: 'user@server', remotePort: 23000, localPort: 18761 },
    { host: ['owned-relay'], remotePort: 23000, localPort: 18761 },
    { host: 'owned-relay', remotePort: 0, localPort: 18761 },
    { host: 'owned-relay', remotePort: 23000, localPort: 22 },
  ]) assert.throws(() => relayArguments(relay, 18761));
});

test('unexpected crashes recover after a long outage with capped delays and metadata-only logs', async t => {
  let starts = 0, recovered;
  const ready = new Promise(resolve => { recovered = resolve; });
  const retries = [], events = [];
  const worker = new ManagedProcess({ name: 'synthetic', command: 'fake-worker', args: ['private-value-not-to-log'] }, {
    processFactory() {
      const process = child(++starts);
      if (starts <= 8) queueMicrotask(() => process.emit('exit', 1));
      else recovered();
      return process;
    },
    sleep: async ms => { retries.push(ms); },
    log: async (...args) => { events.push(args); },
  });
  t.after(() => worker.stop());
  const done = worker.start();
  assert.equal(await Promise.race([ready.then(() => true), done.then(() => false)]), true);
  assert.equal(starts, 9);
  assert.deepEqual(retries, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.ok(!events.some(([event]) => event === 'retries_exhausted'));
  assert.ok(!JSON.stringify(events).includes('private-value-not-to-log'));
  await worker.stop();
  assert.equal(starts, 9);
});

test('intentional stop requests graceful gateway shutdown and never respawns', async () => {
  let starts = 0;
  const process = child();
  const worker = new ManagedProcess({ name: 'gateway', command: 'fake', args: [], ipc: true }, { processFactory: () => { starts++; return process; } });
  void worker.start();
  await delay(1);
  await worker.stop();
  assert.deepEqual(process.messages, [{ type: 'connector-shutdown' }]);
  assert.equal(starts, 1);
});

test('intentional stop cancels a capped crash retry without respawning', async t => {
  let starts = 0, retryStarted;
  const ready = new Promise(resolve => { retryStarted = resolve; });
  const worker = new ManagedProcess({ name: 'gateway', command: 'fake', args: [] }, {
    processFactory() { const process = child(++starts); queueMicrotask(() => process.emit('exit', 1)); return process; },
    sleep: async (ms, value, options) => {
      if (ms < 30000) return;
      retryStarted();
      await delay(ms, value, options);
    },
  });
  t.after(() => worker.stop());
  const done = worker.start();
  assert.equal(await Promise.race([ready.then(() => true), done.then(() => false)]), true);
  await worker.stop();
  assert.equal(worker.abort.signal.aborted, true);
  assert.equal(starts, 6);
});

test('gateway stays running while SSH recovers after a long outage', async t => {
  let gatewayStarts = 0, sshStarts = 0, recovered;
  const ready = new Promise(resolve => { recovered = resolve; });
  const gateway = new ManagedProcess({ name: 'gateway', command: 'fake', args: [], ipc: true }, { processFactory: () => { gatewayStarts++; return child(); } });
  const relay = new ManagedProcess({ name: 'ssh_relay', command: 'fake', args: [] }, {
    processFactory() {
      const process = child(++sshStarts);
      if (sshStarts <= 8) queueMicrotask(() => process.emit('exit', 1));
      else recovered();
      return process;
    },
    sleep: async () => {},
  });
  t.after(async () => { await relay.stop(); await gateway.stop(); });
  void gateway.start();
  const done = relay.start();
  assert.equal(await Promise.race([ready.then(() => true), done.then(() => false)]), true);
  assert.equal(sshStarts, 9);
  assert.equal(gatewayStarts, 1);
});

test('a live control lease rejects a duplicate supervisor without changing its record', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-supervisor-'));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, port: 18761 }));
  const supervisor = await startSupervisor(configPath, { controlPort: 0, processFactory: () => child() });
  t.after(async () => { await supervisor.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const before = await readFile(join(dataDir, 'supervisor-process.json'), 'utf8');
  await assert.rejects(startSupervisor(configPath, { controlPort: supervisor.controlPort, processFactory: () => child() }), error => error.code === 'EADDRINUSE');
  assert.equal(await readFile(join(dataDir, 'supervisor-process.json'), 'utf8'), before);
});

test('private control stop shuts down children and preserves config and job state', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-supervisor-stop-'));
  const configPath = join(dataDir, 'config.json');
  const config = JSON.stringify({ dataDir, port: 18761, sshRelay: { host: 'test-relay', remotePort: 23000, localPort: 18761 } });
  const jobs = JSON.stringify([{ id: 'synthetic-uncertain-job', status: 'unknown' }]);
  await writeFile(configPath, config);
  await writeFile(join(dataDir, 'jobs.json'), jobs);
  let starts = 0;
  const supervisor = await startSupervisor(configPath, { controlPort: 0, processFactory: () => { starts++; return child(12000 + starts); } });
  t.after(async () => { await supervisor.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await stopSupervisor(configPath);
  assert.equal(starts, 2);
  await assert.rejects(readFile(join(dataDir, 'supervisor-process.json')), error => error.code === 'ENOENT');
  assert.equal(await readFile(configPath, 'utf8'), config);
  assert.equal(await readFile(join(dataDir, 'jobs.json'), 'utf8'), jobs);
});

test('automatic native reconnect is supervised independently and stops without altering owner or jobs', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-reconnect-supervisor-'));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, port: 18761, desktopReconnect: { enabled: true, appUserModelId: 'Synthetic.Codex!App' }, sshRelay: { host: 'test-relay', remotePort: 23000, localPort: 18761 } }));
  const grant = JSON.stringify({ controllerThreadId: 'saved-owner', callerTurnId: 'saved-real-turn' });
  const jobs = JSON.stringify([{ id: 'original-job', status: 'unknown' }]);
  await writeFile(join(dataDir, 'desktop-owner.json'), grant);
  await writeFile(join(dataDir, 'jobs.json'), jobs);
  const spawned = [];
  const supervisor = await startSupervisor(configPath, { controlPort: 0, processFactory(command, args, options) { const process = child(13000 + spawned.length); spawned.push({ command, args, options, process }); return process; } });
  t.after(async () => { await supervisor.stop(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal(spawned.length, 3);
  assert.deepEqual(supervisor.workers.map(worker => worker.name), ['desktop_reconnect', 'gateway', 'ssh_relay']);
  assert.ok(spawned[0].args[0].endsWith('desktop-reconnect.mjs'));
  assert.equal(spawned[0].options.windowsHide, true);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'desktop-reconnect-process.json'), 'utf8')).pid, spawned[0].process.pid);
  await supervisor.stop();
  assert.deepEqual(spawned[0].process.messages, [{ type: 'connector-shutdown' }]);
  await assert.rejects(readFile(join(dataDir, 'desktop-reconnect-process.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(dataDir, 'desktop-owner.json'), 'utf8'), grant);
  assert.equal(await readFile(join(dataDir, 'jobs.json'), 'utf8'), jobs);
});

test('a mismatched control nonce cannot stop a live supervisor', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-supervisor-identity-'));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, port: 18761 }));
  const supervisor = await startSupervisor(configPath, { controlPort: 0, processFactory: () => child() });
  const recordPath = join(dataDir, 'supervisor-process.json');
  const original = await readFile(recordPath, 'utf8');
  t.after(async () => { await writeFile(recordPath, original); await supervisor.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const record = JSON.parse(original);
  await writeFile(recordPath, JSON.stringify({ ...record, nonce: 'wrong-instance-nonce' }));
  await assert.rejects(stopSupervisor(configPath), /did not confirm/);
  assert.equal(supervisor.workers[0].stopping, false);
  await writeFile(recordPath, original);
  await stopSupervisor(configPath);
});

test('invalid unauthenticated control payloads cannot crash or stop the supervisor', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-supervisor-parser-'));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, port: 18761 }));
  const supervisor = await startSupervisor(configPath, { controlPort: 0, processFactory: () => child() });
  t.after(async () => { await supervisor.stop(); await rm(dataDir, { recursive: true, force: true }); });
  for (const payload of ['null', '[]', 'true', '42', '"text"', '{"operation":"stop","nonce":null}']) {
    await new Promise(done => {
      const socket = net.connect(supervisor.controlPort, '127.0.0.1');
      socket.on('error', () => {});
      socket.once('connect', () => socket.end(`${payload}\n`));
      socket.once('close', done);
    });
  }
  assert.equal(supervisor.workers[0].stopping, false);
  await stopSupervisor(configPath);
});

test('an unresponsive child has a finite stop deadline and retains ownership until exit is confirmed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-supervisor-stop-deadline-'));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, port: 18761 }));
  const unresponsive = child();
  const signals = [];
  unresponsive.send = (_message, callback) => callback?.();
  unresponsive.kill = signal => { signals.push(signal); return false; };
  const supervisor = await startSupervisor(configPath, { controlPort: 0, processFactory: () => unresponsive, stopTimeoutMs: 10, forceStopTimeoutMs: 10 });
  t.after(async () => { unresponsive.emit('exit', 0); await supervisor.workers[0].done; await supervisor.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const outcome = await Promise.race([
    supervisor.stop().then(() => ({ stopped: true }), error => ({ error })),
    delay(500).then(() => ({ hung: true })),
  ]);
  assert.equal(outcome.error?.code, 'child_stop_timeout');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'connector-process.json'), 'utf8')).pid, unresponsive.pid);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'supervisor-process.json'), 'utf8')).pid, process.pid);
  assert.match(await readFile(join(dataDir, 'supervisor.log'), 'utf8'), /stop_failed/);
  unresponsive.emit('exit', 0);
  await supervisor.workers[0].done;
  await supervisor.stop();
  await assert.rejects(readFile(join(dataDir, 'supervisor-process.json')), error => error.code === 'ENOENT');
  await assert.rejects(readFile(join(dataDir, 'connector-process.json')), error => error.code === 'ENOENT');
});

test('a missing recorded supervisor rejects the stop and preserves possible orphan ownership records', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-supervisor-stale-'));
  const configPath = join(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir, port: 18761 }));
  const supervisor = await startSupervisor(configPath, { controlPort: 0, processFactory: () => child() });
  const supervisorRecord = join(dataDir, 'supervisor-process.json');
  const original = await readFile(supervisorRecord, 'utf8');
  t.after(async () => { await writeFile(supervisorRecord, original); await supervisor.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const missingPid = 2147483647;
  assert.throws(() => process.kill(missingPid, 0), error => error.code === 'ESRCH');
  const stale = JSON.stringify({ ...JSON.parse(original), pid: missingPid });
  const gatewayRecord = await readFile(join(dataDir, 'connector-process.json'), 'utf8');
  const relayRecord = JSON.stringify({ pid: 12346, configPath });
  await writeFile(supervisorRecord, stale);
  await writeFile(join(dataDir, 'ssh-relay-process.json'), relayRecord);
  await assert.rejects(stopSupervisor(configPath), error => error.code === 'stale_supervisor' && /reconcile/.test(error.message));
  assert.equal(await readFile(supervisorRecord, 'utf8'), stale);
  assert.equal(await readFile(join(dataDir, 'connector-process.json'), 'utf8'), gatewayRecord);
  assert.equal(await readFile(join(dataDir, 'ssh-relay-process.json'), 'utf8'), relayRecord);
  assert.equal(supervisor.workers[0].stopping, false);
});
