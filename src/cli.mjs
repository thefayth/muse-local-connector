import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnector, hasReceipt, saveJson, verifyExpansion } from './server.mjs';
import { createDesktopBackend } from './desktop-backend.mjs';

async function configuration(configPath) {
  if (!configPath) throw new Error('Supply --config with a private configuration path, or set MUSE_CONNECTOR_CONFIG.');
  return JSON.parse(await readFile(configPath, 'utf8'));
}

export function validateControllerContext(config, env = process.env) {
  if (config.desktopContextFile) {
    if (!isAbsolute(config.desktopContextFile)) throw new Error('desktopContextFile must be an absolute private path.');
    if (!config.controllerThreadId) throw new Error('Dynamic context requires the original configured controller chat.');
    return config.controllerThreadId;
  }
  if (!env.CODEX_APP_TOOLS_PIPE_PATH || !env.CODEX_THREAD_ID) throw new Error('Start the connector from a Codex desktop execution context.');
  if (config.controllerThreadId && config.controllerThreadId !== env.CODEX_THREAD_ID) throw new Error('The configured controller chat does not match this Codex context. Start from the original controller chat.');
  return env.CODEX_THREAD_ID;
}

export async function recordProof(configPath, { kind, jobId, evidence }) {
  if (!['task', 'computer'].includes(kind)) throw new Error('Proof kind must be task or computer.');
  const config = await configuration(configPath);
  const jobs = JSON.parse(await readFile(join(config.dataDir, 'jobs.json'), 'utf8'));
  const job = jobs.find(item => item.id === jobId);
  if (!job || job.kind !== kind || job.status !== 'completed' || !hasReceipt(job.result, job.requestId)) throw new Error('Proof requires a completed, correlated connector job of the same kind.');
  if (kind === 'computer') {
    if (!evidence || !(await stat(evidence)).isFile()) throw new Error('Computer proof requires a locally inspected image evidence file.');
    const header = (await readFile(evidence)).subarray(0, 12);
    const isImage = header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) || (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP');
    if (!isImage) throw new Error('Computer evidence must be a PNG, JPEG, or WebP image.');
  }
  const proofPath = join(config.dataDir, 'verification.json');
  let proofs = {};
  try { proofs = JSON.parse(await readFile(proofPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  proofs[kind] = { jobId, verifiedAt: new Date().toISOString(), ...(evidence ? { evidence: resolve(evidence) } : {}) };
  await saveJson(proofPath, proofs);
}

export async function expandScope(configPath) {
  const config = await configuration(configPath);
  await verifyExpansion(config.dataDir);
  config.allowAllTasks = true;
  await saveJson(configPath, config);
}

export async function setConcurrency(configPath, maxConcurrentJobs) {
  const validType = typeof maxConcurrentJobs === 'number' || (typeof maxConcurrentJobs === 'string' && /^\d+$/.test(maxConcurrentJobs));
  const limit = Number(maxConcurrentJobs);
  if (!validType || !Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Supply --max-jobs with an integer from 1 to 32.');
  const config = await configuration(configPath);
  config.maxConcurrentJobs = limit;
  await saveJson(configPath, config);
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'start';
  const configPath = option('--config') || process.env.MUSE_CONNECTOR_CONFIG;
  if (command === 'proof') {
    await recordProof(configPath, { kind: option('--kind'), jobId: option('--job'), evidence: option('--evidence') });
    console.log('Verified job receipt recorded in private state.');
    return;
  }
  if (command === 'expand') { await expandScope(configPath); console.log('Task scope expanded after both live proofs. Restart the connector to apply.'); return; }
  if (command === 'concurrency') { await setConcurrency(configPath, option('--max-jobs')); console.log('Concurrency limit saved. Restart the connector to apply.'); return; }
  if (command === 'set-origin') {
    const config = await configuration(configPath);
    const url = new URL(option('--origin'));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Supply an HTTPS origin without credentials, query, or path.');
    config.publicOrigin = url.origin;
    await saveJson(configPath, config);
    console.log('Public HTTPS origin saved. Restart the connector to apply.');
    return;
  }
  if (command !== 'start') throw new Error('Supported commands: start, proof, expand, concurrency, set-origin.');
  const config = await configuration(configPath);
  const backend = createDesktopBackend({ callerThreadId: validateControllerContext(config), desktopContextFile: config.desktopContextFile });
  const connector = await createConnector({ config, backend });
  await connector.listen();
  console.log(`Muse Local Connector listening on 127.0.0.1:${connector.address().port} (${config.allowAllTasks ? 'expanded' : 'pilot'}).`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await connector.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('message', message => { if (message?.type === 'connector-shutdown') stop(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Connector: ${error.code || 'startup_failed'}: ${error.message}`); process.exitCode = 1; });
}
