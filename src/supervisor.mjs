import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, appendFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { saveJson } from './server.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const port = value => Number.isInteger(value) && value > 0 && value < 65536;

export function relayArguments(relay, gatewayPort) {
  if (!relay || typeof relay.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(relay.host) || !port(relay.remotePort) || !port(relay.localPort) || relay.localPort !== gatewayPort) throw new Error('SSH relay requires a named SSH-config host and valid ports matching the connector.');
  return ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-R', `127.0.0.1:${relay.remotePort}:127.0.0.1:${relay.localPort}`, relay.host];
}

export class ManagedProcess {
  constructor({ name, command, args, ipc = false, onStart = async () => {}, onExit = async () => {} }, { processFactory = spawn, sleep = delay, log = async () => {}, stopTimeoutMs = 5000, forceStopTimeoutMs = 1000 } = {}) {
    Object.assign(this, { name, command, args, ipc, onStart, onExit, processFactory, sleep, log, stopTimeoutMs, forceStopTimeoutMs });
    this.stopping = false;
    this.abort = new AbortController();
    this.child = null;
  }

  start() { this.done ||= this.run(); return this.done; }

  async run() {
    let retryMs = 1000;
    while (!this.stopping) {
      let code = null;
      try {
        const child = this.processFactory(this.command, this.args, { windowsHide: true, stdio: this.ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' });
        this.child = child;
        const exited = new Promise(resolveExit => { child.once('exit', value => resolveExit(value)); child.once('error', () => resolveExit(null)); });
        if (child.pid) await this.onStart(child);
        await this.log('started', this.name);
        code = await exited;
      } catch {
        this.child?.kill();
      } finally {
        await this.onExit(this.child);
        this.child = null;
      }
      if (this.stopping) return;
      await this.log('exited', this.name, { code });
      await this.log('retry', this.name, { delayMs: retryMs });
      try { await this.sleep(retryMs, undefined, { signal: this.abort.signal }); } catch { return; }
      retryMs = Math.min(30000, retryMs * 2);
    }
  }

  async stop() {
    this.stopping = true;
    this.abort.abort();
    const child = this.child;
    if (!child) { await this.done; return; }
    const signal = name => { try { child.kill(name); } catch {} };
    if (this.ipc && child.connected) {
      try { child.send({ type: 'connector-shutdown' }, error => { if (error) signal('SIGTERM'); }); } catch { signal('SIGTERM'); }
    } else signal('SIGTERM');
    const force = setTimeout(() => signal('SIGTERM'), this.stopTimeoutMs);
    const last = setTimeout(() => signal('SIGKILL'), this.stopTimeoutMs + this.forceStopTimeoutMs);
    let deadline;
    try {
      await Promise.race([this.done, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Object.assign(new Error('Child exit was not confirmed before the shutdown deadline.'), { code: 'child_stop_timeout' })), this.stopTimeoutMs + this.forceStopTimeoutMs * 2);
      })]);
    } catch (error) {
      await this.log('stop_failed', this.name, { code: error.code || 'child_stop_failed' });
      throw error;
    } finally { clearTimeout(force); clearTimeout(last); clearTimeout(deadline); }
  }
}

async function removeRecord(file, pid) {
  try { if (JSON.parse(await readFile(file, 'utf8')).pid === pid) await unlink(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function startSupervisor(configPath, options = {}) {
  configPath = resolve(configPath);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.dataDir || !port(config.port)) throw new Error('A private data directory and connector port are required.');
  const controlPort = options.controlPort ?? config.supervisorPort ?? config.port + 1;
  if (!(port(controlPort) || options.controlPort === 0) || controlPort === config.port) throw new Error('A distinct supervisorPort between 1 and 65535 is required.');
  const sshArgs = config.sshRelay ? relayArguments(config.sshRelay, config.port) : null;
  const dataDir = resolve(config.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const recordPath = join(dataDir, 'supervisor-process.json');
  const gatewayRecord = join(dataDir, 'connector-process.json');
  const relayRecord = join(dataDir, 'ssh-relay-process.json');
  const nonce = randomUUID();
  const workers = [];
  let stopping;
  const log = async (event, component, details = {}) => {
    await appendFile(join(dataDir, 'supervisor.log'), `${JSON.stringify({ at: new Date().toISOString(), event, component, ...details })}\n`, { mode: 0o600 });
  };
  const control = net.createServer(socket => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy());
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 256) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      let message;
      try { message = JSON.parse(input); } catch { socket.destroy(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return; }
      const supplied = Buffer.from(typeof message.nonce === 'string' ? message.nonce : '');
      const expected = Buffer.from(nonce);
      if (message.operation !== 'stop' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { socket.destroy(); return; }
      socket.end('stopping\n');
      void stop().catch(() => {});
    });
  });
  await new Promise((ready, reject) => { control.once('error', reject); control.listen(controlPort, '127.0.0.1', ready); });
  const stop = () => {
    stopping ||= (async () => {
      await log('stopping', 'supervisor');
      const results = await Promise.allSettled(workers.map(worker => worker.stop()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      await new Promise(done => control.close(done));
      await removeRecord(recordPath, process.pid);
      await log('stopped', 'supervisor');
    })().catch(async error => {
      stopping = undefined;
      await log('stop_failed', 'supervisor', { code: error.code || 'child_stop_failed' });
      throw error;
    });
    return stopping;
  };
  try {
    await saveJson(recordPath, { pid: process.pid, startedUtc: new Date(Date.now() - process.uptime() * 1000).toISOString(), executable: process.execPath, scriptPath, configPath, controlPort: control.address().port, nonce });
    const cli = join(fileURLToPath(new URL('.', import.meta.url)), 'cli.mjs');
    workers.push(new ManagedProcess({
      name: 'gateway', command: process.execPath, args: [cli, '--config', configPath], ipc: true,
      onStart: child => saveJson(gatewayRecord, { pid: child.pid, startedUtc: new Date().toISOString(), executable: process.execPath, scriptPath: cli, configPath }),
      onExit: child => child?.pid ? removeRecord(gatewayRecord, child.pid) : undefined,
    }, { ...options, log }));
    if (sshArgs) {
      const ssh = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
      workers.push(new ManagedProcess({ name: 'ssh_relay', command: ssh, args: sshArgs,
        onStart: child => saveJson(relayRecord, { pid: child.pid, startedUtc: new Date().toISOString(), executable: ssh, configPath, host: config.sshRelay.host, remotePort: config.sshRelay.remotePort, localPort: config.sshRelay.localPort }),
        onExit: child => child?.pid ? removeRecord(relayRecord, child.pid) : undefined,
      }, { ...options, log }));
    }
    for (const worker of workers) void worker.start();
    await log('ready', 'supervisor');
    return { stop, workers, controlPort: control.address().port };
  } catch (error) { await stop(); throw error; }
}

export async function stopSupervisor(configPath) {
  configPath = resolve(configPath);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const file = join(resolve(config.dataDir), 'supervisor-process.json');
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (record.configPath !== configPath || record.scriptPath !== scriptPath || record.executable !== process.execPath || !port(record.controlPort) || typeof record.nonce !== 'string') throw new Error('Supervisor record does not match this installation; no process was stopped.');
  try { process.kill(record.pid, 0); } catch (error) {
    if (error.code === 'ESRCH') throw Object.assign(new Error('The recorded supervisor is no longer running. Gateway or SSH relay processes may remain active. Preserve the records and reconcile those owned processes before reporting a full stop.'), { code: 'stale_supervisor' });
    throw error;
  }
  await new Promise((done, reject) => {
    const socket = net.connect(record.controlPort, '127.0.0.1');
    socket.setTimeout(5000, () => socket.destroy(new Error('Supervisor stop request timed out.')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({ operation: 'stop', nonce: record.nonce })}\n`));
    let reply = '';
    socket.on('data', data => { reply += data; });
    socket.once('end', () => reply === 'stopping\n' ? done() : reject(new Error('Supervisor did not confirm the stop request.')));
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const current = JSON.parse(await readFile(file, 'utf8')); if (current.pid !== record.pid || current.nonce !== record.nonce) throw new Error('Supervisor changed while stopping; inspect its state.'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await delay(100);
  }
  throw new Error('Supervisor has not finished stopping; inspect private supervisor logs.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const configPath = args[args.indexOf('--config') + 1];
  const run = async () => {
    if (args.indexOf('--config') < 0 || !configPath) throw new Error('Supply --config with the private configuration path.');
    if (args[0] === 'stop') { await stopSupervisor(configPath); return; }
    if (args[0]?.startsWith('--') !== true) throw new Error('Supported command: stop, or --config to start.');
    const supervisor = await startSupervisor(configPath);
    const shutdown = () => { void supervisor.stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  };
  run().catch(error => { console.error(error.code === 'stale_supervisor' ? `Supervisor: stale_supervisor: ${error.message}` : 'Supervisor operation failed. Inspect the private supervisor log and configuration.'); process.exitCode = 1; });
}
