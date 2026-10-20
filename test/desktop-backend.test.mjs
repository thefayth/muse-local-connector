import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DesktopBackend, DesktopMcpClient } from '../src/desktop-backend.mjs';

function fakeProcess(handle) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writable: true,
    write(data) {
      const message = JSON.parse(data);
      if (!Object.hasOwn(message, 'id')) return;
      queueMicrotask(() => {
        const response = handle(message);
        if (response !== undefined) child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`);
      });
    },
    end() { this.writable = false; },
  };
  child.kill = () => child.emit('exit', 0, null);
  return child;
}

async function contextClient(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-desktop-handoff-'));
  const desktopContextFile = join(dataDir, 'desktop-context.json');
  const callerThreadId = '019a0000-0000-7000-8000-000000000001';
  const children = [], requests = [], arrivals = [];
  const callerTurnId = '019a0000-0000-7000-8000-000000000003';
  const publish = (pipePath, updatedAt = new Date().toISOString(), turnId = callerTurnId) => writeFile(desktopContextFile, JSON.stringify({ pipePath, registrationId: randomUUID(), updatedAt, controllerThreadId: callerThreadId, callerTurnId: turnId, pid: process.pid }));
  const client = new DesktopMcpClient({
    desktopContextFile, callerThreadId, env: {}, serverPath: '/installed/server.mjs',
    processFactory: (_command, _args, options) => {
      const child = fakeProcess(message => {
        if (message.method === 'initialize') return { result: {} };
        const request = { child, message, pipePath: options.env.CODEX_APP_TOOLS_PIPE_PATH };
        requests.push(request);
        arrivals.shift()?.(request);
      });
      child.once('exit', () => { child.stopped = true; });
      children.push(child);
      return child;
    },
  });
  t.after(async () => { await client.close(); await rm(dataDir, { recursive: true, force: true }); });
  const nextRequest = () => new Promise(resolve => arrivals.push(resolve));
  const respond = (request, value) => request.child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: request.message.id, result: { structuredContent: value } })}\n`);
  return { client, children, requests, publish, nextRequest, respond, callerTurnId };
}

test('MCP initializes and forwards only allowlisted tool calls with the source chat metadata', async () => {
  const messages = [];
  const client = new DesktopMcpClient({
    serverPath: '/installed/codex-app-tools/server.mjs',
    callerThreadId: 'source-chat',
    env: { CODEX_APP_TOOLS_PIPE_PATH: 'provided-ipc' },
    processFactory: () => fakeProcess(message => {
      messages.push(message);
      if (message.method === 'initialize') return { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } };
      return { result: { content: [{ type: 'text', text: '{"ok":true}' }] } };
    }),
  });
  assert.deepEqual(await client.callTool('read_thread', { threadId: 'target-chat' }), { ok: true });
  assert.equal(messages[1].params._meta['openai/threadId'], 'source-chat');
  assert.equal(messages[1].params.arguments.threadId, 'target-chat');
  await assert.rejects(client.callTool('uninstall_plugin', {}), /not allowed/i);
  assert.equal(messages.length, 2);
  await client.close();
});

test('native tool errors are errors rather than successful payloads', async () => {
  const client = new DesktopMcpClient({
    serverPath: '/installed/server.mjs', callerThreadId: 'source', env: { CODEX_APP_TOOLS_PIPE_PATH: 'provided' },
    processFactory: () => fakeProcess(message => ({ result: message.method === 'initialize' ? {} : { isError: true, content: [{ type: 'text', text: 'Task is unavailable' }] } })),
  });
  await assert.rejects(client.callTool('read_thread', { threadId: 'missing' }), error => error.code === 'desktop_tool_error' && /unavailable/.test(error.message));
  await client.close();
});

test('concurrent MCP calls keep their own results when responses arrive out of order', { timeout: 5000 }, async t => {
  const requests = [], resolved = [];
  let child, receiveAll;
  const allReceived = new Promise(resolve => { receiveAll = resolve; });
  const client = new DesktopMcpClient({
    serverPath: '/installed/server.mjs', callerThreadId: 'source', env: { CODEX_APP_TOOLS_PIPE_PATH: 'provided' },
    processFactory: () => {
      child = fakeProcess(message => {
        if (message.method === 'initialize') return { result: {} };
        requests.push(message);
        if (requests.length === 4) receiveAll();
      });
      return child;
    },
  });
  t.after(() => client.close());
  await client.start();
  const calls = Array.from({ length: 4 }, (_, index) => client.callTool('read_thread', { threadId: `target-${index}` }).then(result => { resolved.push(result.threadId); return result; }));
  await allReceived;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(new Set(requests.map(message => message.id)).size, 4);
  for (const index of [2, 0, 3, 1]) {
    const message = requests[index];
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { threadId: message.params.arguments.threadId } } })}\n`);
  }
  assert.deepEqual(await Promise.all(calls), Array.from({ length: 4 }, (_, index) => ({ threadId: `target-${index}` })));
  assert.deepEqual(resolved, ['target-2', 'target-0', 'target-3', 'target-1']);
  assert.equal(client.pending.size, 0);
});

test('simultaneous first MCP calls share one child and wait for one initialization', { timeout: 5000 }, async t => {
  const requests = [];
  let child, spawned = 0, initializeRequest, receiveInitialize;
  const initialized = new Promise(resolve => { receiveInitialize = resolve; });
  const client = new DesktopMcpClient({
    serverPath: '/installed/server.mjs', callerThreadId: 'source', env: { CODEX_APP_TOOLS_PIPE_PATH: 'provided' },
    processFactory: () => {
      spawned += 1;
      child = fakeProcess(message => {
        requests.push(message);
        if (message.method === 'initialize') { initializeRequest = message; receiveInitialize(); return; }
        return { result: { structuredContent: { threadId: message.params.arguments.threadId } } };
      });
      return child;
    },
  });
  t.after(() => client.close());
  const calls = Array.from({ length: 4 }, (_, index) => client.callTool('read_thread', { threadId: `target-${index}` }));
  await initialized;
  assert.equal(spawned, 1);
  assert.deepEqual(requests.map(message => message.method), ['initialize']);
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: initializeRequest.id, result: {} })}\n`);
  assert.deepEqual(await Promise.all(calls), Array.from({ length: 4 }, (_, index) => ({ threadId: `target-${index}` })));
  assert.equal(spawned, 1);
  assert.equal(requests.filter(message => message.method === 'initialize').length, 1);
  assert.equal(requests.filter(message => message.method === 'tools/call').length, 4);
  assert.equal(new Set(requests.map(message => message.id)).size, 5);
});

test('JSON-lines transport preserves Unicode split across chunks', async () => {
  const client = new DesktopMcpClient({});
  const received = new Promise((resolve, reject) => {
    client.pending.set('7', { resolve, reject, timer: setTimeout(() => reject(new Error('No response')), 1000) });
  });
  const wire = Buffer.from(`${JSON.stringify({ id: 7, result: { title: 'Faith’s résumé ✨' } })}\n`);
  const at = wire.indexOf(Buffer.from('✨')) + 1;
  client.onData(wire.subarray(0, at));
  client.onData(wire.subarray(at));
  assert.equal((await received).title, 'Faith’s résumé ✨');
});

test('unresponsive MCP requests time out and close rejects pending calls', async () => {
  const client = new DesktopMcpClient({
    serverPath: '/installed/server.mjs', callerThreadId: 'source', env: { CODEX_APP_TOOLS_PIPE_PATH: 'provided' },
    requestTimeoutMs: 20, processFactory: () => fakeProcess(() => undefined),
  });
  await assert.rejects(client.start(), error => error.code === 'desktop_timeout');
  const pending = client.request('tools/list', {}, 1000);
  await client.close();
  await assert.rejects(pending, error => error.code === 'desktop_closed');
});

test('missing desktop IPC fails with an actionable message without spawning', async () => {
  let spawned = false;
  const client = new DesktopMcpClient({ env: {}, callerThreadId: 'source', processFactory: () => { spawned = true; } });
  await assert.rejects(client.start(), /launch.*Codex|Codex.*launch/i);
  assert.equal(spawned, false);
});

test('dynamic context follows fresh registrations while preserving the original caller and never replays a send', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-desktop-context-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const desktopContextFile = join(dataDir, 'desktop-context.json');
  const callerThreadId = '019a0000-0000-7000-8000-000000000001';
  const calls = [], children = [];
  const publish = (pipePath, registrationId = randomUUID(), updatedAt = new Date().toISOString(), controllerThreadId = callerThreadId) => writeFile(desktopContextFile, JSON.stringify({ pipePath, registrationId, updatedAt, controllerThreadId, callerTurnId: '019a0000-0000-7000-8000-000000000003', pid: process.pid }));
  const client = new DesktopMcpClient({
    desktopContextFile, callerThreadId, env: {}, serverPath: '/installed/server.mjs',
    processFactory: (_command, _args, options) => {
      const pipePath = options.env.CODEX_APP_TOOLS_PIPE_PATH;
      const child = fakeProcess(message => {
        if (message.method === 'initialize') return { result: {} };
        calls.push({ pipePath, message });
        if (message.params.name === 'send_message_to_thread') return { error: { code: -32000, message: 'Submission reply lost' } };
        return { result: { structuredContent: { pipeGeneration: children.length } } };
      });
      child.once('exit', () => { child.stopped = true; });
      children.push(child);
      return child;
    },
  });
  t.after(() => client.close());
  await assert.rejects(client.callTool('read_thread', {}), error => error.statusCode === 503);
  assert.equal(children.length, 0);
  await publish('first-pipe');
  assert.deepEqual(await client.callTool('read_thread', {}), { pipeGeneration: 1 });
  await client.callTool('read_thread', {});
  assert.equal(children.length, 1);
  await publish('second-pipe');
  assert.deepEqual(await client.callTool('read_thread', {}), { pipeGeneration: 2 });
  assert.equal(children[0].stopped, true);
  assert.equal(calls.at(-1).pipePath, 'second-pipe');
  assert.ok(calls.every(call => call.message.params._meta['openai/threadId'] === callerThreadId));
  await assert.rejects(client.callTool('send_message_to_thread', { threadId: 'target', prompt: 'Approved instruction' }), error => error.code === 'desktop_rpc_error');
  assert.equal(calls.filter(call => call.message.params.name === 'send_message_to_thread').length, 1);
  await publish('second-pipe', randomUUID(), new Date(Date.now() - 61000).toISOString());
  await assert.rejects(client.callTool('read_thread', {}), error => error.statusCode === 503);
  assert.equal(children[1].stopped, true);
  const priorCallCount = calls.length;
  await publish('wrong-caller-pipe', randomUUID(), new Date().toISOString(), '019a0000-0000-7000-8000-000000000002');
  await assert.rejects(client.callTool('read_thread', {}), error => error.statusCode === 503);
  assert.equal(calls.length, priorCallCount);
  assert.equal(children.length, 2);
  await writeFile(desktopContextFile, JSON.stringify({ pipePath: 'dead-owner-pipe', registrationId: randomUUID(), updatedAt: new Date().toISOString(), controllerThreadId: callerThreadId, pid: 2147483647 }));
  await assert.rejects(client.callTool('read_thread', {}), error => error.statusCode === 503);
  assert.equal(calls.length, priorCallCount);
  assert.equal(children.length, 2);
});

test('same-pipe lease refresh preserves an authorized pending send and admits concurrent reads without replay', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  await h.publish('first-pipe');
  const sent = h.nextRequest();
  const send = h.client.callTool('send_message_to_thread', { threadId: 'original', prompt: 'Approved once' });
  const sendRequest = await sent;
  const nextTurnId = '019a0000-0000-7000-8000-000000000004';
  await h.publish('first-pipe', new Date().toISOString(), nextTurnId);
  const readArrived = h.nextRequest();
  const read = h.client.callTool('read_thread', { threadId: 'original' });
  const readRequest = await readArrived;
  assert.equal(sendRequest.message.params._meta['openai/turnId'], h.callerTurnId);
  assert.equal(readRequest.message.params._meta['openai/turnId'], nextTurnId);
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].stopped, undefined);
  h.respond(readRequest, { status: 'running' });
  h.respond(sendRequest, { turnId: 'approved-turn' });
  assert.deepEqual(await read, { status: 'running' });
  assert.deepEqual(await send, { turnId: 'approved-turn' });
  assert.equal(h.requests.filter(r => r.message.params.name === 'send_message_to_thread').length, 1);
});

test('four concurrent sends retain the verified controller turn and resolve independently', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  await h.publish('first-pipe');
  const calls = Array.from({ length: 4 }, (_, index) => h.client.callTool('send_message_to_thread', { threadId: `target-${index}`, prompt: 'Approved once' }));
  while (h.requests.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.children.length, 1);
  assert.equal(h.client.pending.size, 4);
  assert.ok(h.requests.every(request => request.message.params._meta['openai/turnId'] === h.callerTurnId));
  for (const index of [2, 0, 3, 1]) h.respond(h.requests[index], { target: h.requests[index].message.params.arguments.threadId });
  assert.deepEqual(await Promise.all(calls), Array.from({ length: 4 }, (_, index) => ({ target: `target-${index}` })));
  assert.equal(h.requests.length, 4);
});

test('a dynamic lease without a real caller turn cannot submit work', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  for (const callerTurn of [undefined, 'mcp-turn-7']) {
    await h.publish('first-pipe', new Date().toISOString(), callerTurn === undefined ? null : callerTurn);
    await assert.rejects(h.client.callTool('send_message_to_thread', { threadId: 'original', prompt: 'Approved once' }), error => error.code === 'desktop_context_unavailable');
  }
  assert.equal(h.children.length, 0);
  assert.equal(h.requests.length, 0);
});

test('changed-pipe handoff drains authorized requests before admitting new calls and ignores late old-child frames', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  await h.publish('first-pipe');
  const sent = h.nextRequest();
  const send = h.client.callTool('send_message_to_thread', { threadId: 'original', prompt: 'Approved once' });
  const sendRequest = await sent;
  await h.publish('second-pipe');
  let draining;
  const waiting = new Promise(resolve => { draining = resolve; });
  const waitForPending = h.client.waitForPending.bind(h.client);
  h.client.waitForPending = () => { draining(); return waitForPending(); };
  const arrived = h.nextRequest();
  const reads = [h.client.callTool('read_thread', { threadId: 'first-read' }), h.client.callTool('read_thread', { threadId: 'second-read' })];
  await waiting;
  assert.equal(h.children.length, 1);
  assert.equal(h.requests.length, 1);
  h.respond(sendRequest, { turnId: 'approved-turn' });
  assert.deepEqual(await send, { turnId: 'approved-turn' });
  const firstRead = await arrived;
  const secondRead = h.requests.find(r => r.message.params.arguments.threadId === 'second-read') || await h.nextRequest();
  assert.equal(h.children.length, 2);
  assert.equal(h.children[0].stopped, true);
  assert.equal(firstRead.pipePath, 'second-pipe');
  assert.equal(secondRead.pipePath, 'second-pipe');
  h.children[0].stdout.emit('data', 'invalid old child frame\n');
  h.respond(firstRead, { threadId: 'first-read' });
  h.respond(secondRead, { threadId: 'second-read' });
  assert.deepEqual(await Promise.all(reads), [{ threadId: 'first-read' }, { threadId: 'second-read' }]);
  assert.equal(h.requests.filter(r => r.message.params.name === 'send_message_to_thread').length, 1);
});

test('stale context rejects new calls without cancelling a previously authorized pending send', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  await h.publish('first-pipe');
  const sent = h.nextRequest();
  const send = h.client.callTool('send_message_to_thread', { threadId: 'original', prompt: 'Approved once' });
  const sendRequest = await sent;
  await h.publish('first-pipe', new Date(Date.now() - 61000).toISOString());
  await assert.rejects(h.client.callTool('read_thread', { threadId: 'original' }), error => error.code === 'desktop_context_unavailable');
  assert.equal(h.children[0].stopped, undefined);
  assert.equal(h.requests.length, 1);
  h.respond(sendRequest, { turnId: 'approved-turn' });
  assert.deepEqual(await send, { turnId: 'approved-turn' });
  await h.publish('first-pipe');
  const arrived = h.nextRequest();
  const read = h.client.callTool('read_thread', { threadId: 'original' });
  h.respond(await arrived, { status: 'completed' });
  assert.deepEqual(await read, { status: 'completed' });
  assert.equal(h.children.length, 1);
});

test('changed-pipe handoff honors the original request timeout without replaying an uncertain send', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  h.client.requestTimeoutMs = 40;
  await h.publish('first-pipe');
  const sent = h.nextRequest();
  const send = h.client.callTool('send_message_to_thread', { threadId: 'original', prompt: 'Approved once' });
  const timedOut = assert.rejects(send, error => error.code === 'desktop_timeout');
  await sent;
  await h.publish('second-pipe');
  const arrived = h.nextRequest();
  const read = h.client.callTool('read_thread', { threadId: 'original' });
  await timedOut;
  const request = await arrived;
  assert.equal(request.pipePath, 'second-pipe');
  h.respond(request, { status: 'inspect-before-retry' });
  assert.deepEqual(await read, { status: 'inspect-before-retry' });
  assert.equal(h.children[0].stopped, true);
  assert.equal(h.requests.filter(r => r.message.params.name === 'send_message_to_thread').length, 1);
});

test('explicit close rejects in-flight and queued admissions without reconnecting after a drain', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  await h.publish('first-pipe');
  const sent = h.nextRequest();
  const send = h.client.callTool('send_message_to_thread', { threadId: 'original', prompt: 'Approved once' });
  const sendClosed = assert.rejects(send, error => error.code === 'desktop_closed');
  await sent;
  await h.publish('second-pipe');
  let draining;
  const waiting = new Promise(resolve => { draining = resolve; });
  const waitForPending = h.client.waitForPending.bind(h.client);
  h.client.waitForPending = () => { draining(); return waitForPending(); };
  const readsClosed = ['first-read', 'second-read'].map(threadId => assert.rejects(h.client.callTool('read_thread', { threadId }), error => error.code === 'desktop_closed'));
  await waiting;
  await h.client.close();
  await Promise.all([sendClosed, ...readsClosed]);
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].stopped, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.client.pending.size, 0);
});

test('explicit close during handoff disconnect cannot spawn a replacement child', { timeout: 5000 }, async t => {
  const h = await contextClient(t);
  await h.publish('first-pipe');
  await h.client.start();
  await h.publish('second-pipe');
  let disconnected, resume, paused = false;
  const stopped = new Promise(resolve => { disconnected = resolve; });
  const resumed = new Promise(resolve => { resume = resolve; });
  const disconnect = h.client.disconnect.bind(h.client);
  h.client.disconnect = async () => {
    await disconnect();
    if (!paused) { paused = true; disconnected(); await resumed; }
  };
  const readClosed = assert.rejects(h.client.callTool('read_thread', { threadId: 'original' }), error => error.code === 'desktop_closed');
  await stopped;
  await h.client.close();
  resume();
  await readClosed;
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].stopped, true);
  assert.equal(h.client.child, null);
  assert.equal(h.requests.length, 0);
});

test('task catalog preserves source IDs, deduplicates pinned tasks, and labels discovery limits', async () => {
  const calls = [];
  const native = { pinnedThreads: [{ id: 'p', title: 'Pinned', kind: 'chatgpt', status: 'idle' }], threads: [{ id: 'p', title: 'Pinned', kind: 'chatgpt' }, { id: 'r', title: 'Recent', kind: 'codex', hostId: 'local', cwd: '/project', summary: 'context', status: 'active' }] };
  const backend = new DesktopBackend({ client: { callTool: async (name, args) => { calls.push({ name, args }); return native; }, close: async () => {} } });
  const result = await backend.listThreads({ limit: 100 });
  assert.equal(calls[0].args.limit, 50);
  assert.deepEqual(result.tasks.map(t => t.id), ['p', 'r']);
  assert.equal(result.tasks[1].title, 'Recent');
  assert.equal(result.tasks[1].status, 'active');
  assert.equal(result.tasks[0].kind, 'chatgpt');
  assert.equal((await backend.listThreads({ search: 'context' })).tasks[0].id, 'r');
  assert.equal((await backend.listThreads({ limit: 2 })).partial, true);
});

test('read, send, and wait use native desktop routing without creating or resuming a replacement task', async () => {
  const calls = [];
  const backend = new DesktopBackend({ client: { callTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; }, close: async () => {} } });
  await backend.readThread('original', { hostId: 'local' });
  await backend.sendMessage('original', 'Run the approved check', { hostId: 'local' });
  await backend.waitThread('original', { hostId: 'local', timeoutMs: 0, afterCursor: 'cursor' });
  assert.deepEqual(calls.map(c => c.name), ['read_thread', 'send_message_to_thread', 'wait_threads']);
  assert.equal(calls[1].args.threadId, 'original');
  assert.equal(calls[1].args.model, undefined);
  assert.deepEqual(calls[2].args, { targets: [{ threadId: 'original', hostId: 'local', afterCursor: 'cursor' }], timeoutMs: 0 });
  await assert.rejects(backend.sendMessage('original', ''), /instruction|required/i);
});

test('unsupported native wait falls back to one recent turn read with correlated IDs', async () => {
  const calls = [];
  const read = { thread: { id: 'original', hostId: 'local', status: { type: 'notLoaded' } }, turns: [{ id: 'real-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'comment', phase: 'commentary', text: 'Working' }, { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Connector receipt: approved-job' }] }] };
  const backend = new DesktopBackend({ client: { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'wait_threads') throw Object.assign(new Error('MCP error -32000: Codex app tool request failed'), { code: 'desktop_rpc_error' });
    return read;
  } } });
  const first = await backend.waitThread('original', { hostId: 'local' });
  assert.deepEqual(calls.map(c => c.name), ['wait_threads', 'read_thread']);
  assert.equal(calls[1].args.turnLimit, 1);
  assert.equal(first.polls[0].latestTurn.id, 'real-turn');
  assert.equal(first.polls[0].latestAssistantMessage.id, 'answer');
  assert.equal(first.polls[0].latestAssistantMessage.turnId, 'real-turn');
  assert.equal(first.polls[0].latestAssistantMessage.text, 'Connector receipt: approved-job');
  const unchanged = await backend.waitThread('original', { hostId: 'local', afterCursor: first.polls[0].cursor });
  assert.equal(unchanged.polls[0].changed, false);
  assert.equal(unchanged.polls[0].latestAssistantMessage, undefined);
  assert.ok(calls.every(c => ['wait_threads', 'read_thread'].includes(c.name)));
});

test('wait fallback never masks authentication, authorization, IPC, or timeout failures', async () => {
  for (const [code, message, statusCode] of [
    ['desktop_rpc_error', 'Authentication failed', 401],
    ['desktop_rpc_error', 'Permission denied', 403],
    ['desktop_context_required', 'Missing caller context', 503],
    ['desktop_timeout', 'Request timed out', 504],
    ['desktop_disconnected', 'Desktop disconnected', 503],
  ]) {
    const calls = [];
    const backend = new DesktopBackend({ client: { callTool: async name => { calls.push(name); throw Object.assign(new Error(message), { code, statusCode }); } } });
    await assert.rejects(backend.waitThread('original'), error => error.code === code);
    assert.deepEqual(calls, ['wait_threads']);
  }
});

test('a dynamic lease polls through reads after the controller turn has finished', async () => {
  const calls = [];
  const backend = new DesktopBackend({ client: {
    desktopContextFile: '/private/desktop-context.json',
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'wait_threads') throw Object.assign(new Error('The controller has no active native turn.'), { code: 'desktop_timeout' });
      return { thread: { id: 'original', status: { type: 'idle' } }, turns: [{ id: 'finished-turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', phase: 'final_answer', text: 'A completed reply.' }] }] };
    },
  } });
  const state = await backend.waitThread('original', { hostId: 'local', timeoutMs: 0 });
  assert.equal(state.source, 'read_thread_fallback');
  assert.equal(state.polls[0].latestTurn.id, 'finished-turn');
  assert.deepEqual(calls.map(call => call.name), ['read_thread']);
});
