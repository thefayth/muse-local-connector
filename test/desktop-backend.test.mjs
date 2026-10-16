import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
