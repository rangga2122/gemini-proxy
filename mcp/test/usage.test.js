import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore } from '../lib/usage.js';

test('usage totals persist and remain separated by account and feature', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-store-'));
  const file = join(dir, 'usage.json');
  const store = new UsageStore(file);
  await store.load();
  await Promise.all([
    store.record('user:one', 'imageGenerate', 2),
    store.record('user:one', 'imageEdit'),
    store.record('user:two', 'chat'),
    store.record('admin', 'audio'),
  ]);
  const users = [{ id: 'one', email: 'one@example.com', label: 'One' }, { id: 'two', email: 'two@example.com', label: '' }];
  let report = await store.report(users);
  assert.deepEqual(report.totals, { imageGenerate: 2, imageEdit: 1, vision: 0, chat: 1, audio: 1, images: 3, overall: 5 });
  assert.equal(report.users[0].images, 3);
  assert.equal(report.users[0].overall, 3);
  assert.equal(report.users[1].chat, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reloaded = new UsageStore(file);
  await reloaded.load();
  report = await reloaded.report(users);
  assert.equal(report.totals.overall, 5);
  assert.equal(report.users[0].imageGenerate, 2);
});
