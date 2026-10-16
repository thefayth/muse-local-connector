import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalCatalog, LocalCatalogClient, mergeTaskCatalogs } from '../src/local-catalog.mjs';

test('local catalog paginates every local task using metadata-only reads', async () => {
  const calls = [];
  const catalog = new LocalCatalog({ client: { start: async () => {}, request: async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [{ id: 'old', name: 'Older task', cwd: '/old', source: 'vscode', status: { type: 'notLoaded' } }], nextCursor: null } : { data: [{ id: 'new', name: 'New task', cwd: '/new', source: 'vscode' }], nextCursor: 'older' };
  }, close: async () => {} } });
  const result = await catalog.listAll();
  assert.deepEqual(result.tasks.map(t => t.id), ['new', 'old']);
  assert.equal(result.partial, false);
  assert.equal(result.tasks[1].status, 'unknown');
  assert.equal(calls[0].params.useStateDbOnly, true);
  assert.equal(calls[1].params.cursor, 'older');
  assert.ok(calls.every(c => c.method === 'thread/list'));
});

test('local catalog transport refuses every mutation, including raw resume requests', async () => {
  const client = new LocalCatalogClient({});
  await assert.rejects(client.request('thread/resume', { threadId: 'existing' }), /read.only|not allowed/i);
  await assert.rejects(client.request('turn/start', { threadId: 'existing' }), /read.only|not allowed/i);
});

test('merge keeps current desktop status and fills older local tasks without duplicate IDs', () => {
  const result = mergeTaskCatalogs(
    { tasks: [{ id: 'known', title: 'Desktop title', status: 'active', kind: 'codex' }, { id: 'cloud', title: 'Cloud title', kind: 'chatgpt' }], partial: true },
    { tasks: [{ id: 'known', title: 'Old title', status: 'unknown', kind: 'codex' }, { id: 'older', title: 'Older task', status: 'unknown', kind: 'codex' }], partial: false, nextCursor: null },
  );
  assert.equal(result.tasks.length, 3);
  assert.equal(result.tasks.find(t => t.id === 'known').status, 'active');
  assert.equal(result.tasks.find(t => t.id === 'known').title, 'Desktop title');
  assert.equal(result.coverage.codex, 'all_local_unarchived');
  assert.equal(result.coverage.chatgpt, 'recent_and_pinned');
});
