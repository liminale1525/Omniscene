import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageAttemptStore } from '../qianmu-image-attempt-store.js';
const scope = { namespace: 'test', chatKey: 'chat', messageKey: 'message', revisionId: 'revision' };
const request = { attemptId: 'a', logicalShotId: 's', operationKey: 'o', ownerId: 'page', kind: 'automatic', maxAutomatic: 3, imageCount: 1 };

test('ledger factory and disposal are lazy and never touch legacy media databases', () => {
  let opens = 0;
  const store = createImageAttemptStore({ indexedDB: { open() { opens++; } } });
  assert.equal(opens, 0); store.close(); assert.equal(opens, 0);
});

test('invalid identity fails before opening storage and disabled storage never grants admission', async () => {
  let opens = 0;
  const store = createImageAttemptStore({ indexedDB: { open() { opens++; throw new Error('mock private browser'); } } });
  await assert.rejects(() => store.claim({ ...scope, namespace: '' }, request), { code: 'image_attempt_identity' });
  assert.equal(opens, 0);
  await assert.rejects(() => store.claim(scope, request), { code: 'image_attempt_storage' }); assert.equal(opens, 1);
  await assert.rejects(() => store.claim(scope, request), { code: 'image_attempt_storage' }); assert.equal(opens, 2, 'a failed open is not cached forever');
  store.close();
});

test('blocked open rejects promptly and closes a late success instead of reviving its request', async () => {
  const pending = {}; let closes = 0;
  const store = createImageAttemptStore({ indexedDB: { open: () => pending } });
  const claim = store.claim(scope, request); pending.onblocked();
  await assert.rejects(() => claim, { code: 'image_attempt_storage_blocked' });
  pending.result = { close: () => { closes++; } }; pending.onsuccess();
  assert.equal(closes, 1); store.close();
});

test('opening timeout is bounded and late database handles are closed', async () => {
  const pending = {}; let closes = 0;
  const store = createImageAttemptStore({ indexedDB: { open: () => pending }, timeoutMs: 100 });
  await assert.rejects(() => store.claim(scope, request), { code: 'image_attempt_storage_timeout' });
  pending.result = { close: () => { closes++; } }; pending.onsuccess();
  assert.equal(closes, 1); store.close();
});

test('a closed session never resolves an outstanding open as authorized', async () => {
  const pending = {}; let closes = 0;
  const store = createImageAttemptStore({ indexedDB: { open: () => pending } });
  const claim = store.claim(scope, request); store.close();
  pending.result = { close: () => { closes++; } }; pending.onsuccess();
  await assert.rejects(() => claim, { code: 'image_attempt_closed' }); assert.equal(closes, 1);
  await assert.rejects(() => store.inspect(scope), { code: 'image_attempt_closed' });
});
