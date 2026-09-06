import test from 'node:test';
import assert from 'node:assert/strict';
import { imageServiceAccount, imageServiceAccountStillMatches, queryImageServiceTask } from '../qianmu-image-service-access.js';
import { imageServiceChannelKey, normalizeImageServiceChannel } from '../qianmu-image-service-queue.js';

const account = (handle = 'alice', admin = false) => ({ user: { profile: { handle, enabled: true, admin } } });
const input = { apiKey: 'mock-access-key', attemptId: 'original-attempt' };
const key = imageServiceChannelKey(input.apiKey);
const row = (who, extra = {}) => ({ namespace: imageServiceAccount(account(who)).namespace, attemptId: input.attemptId,
  requestDigest: 'a'.repeat(64), ownerId: 'private-owner', fence: 'private-fence', status: 'uncertain',
  automatic: true, createdAt: 1, updatedAt: 2, ...extra });
const state = entries => ({ ...normalizeImageServiceChannel(undefined, key), entries });
const never = () => assert.fail('must not access another account or mutate storage');

test('only the host authenticated profile can establish service identity', () => {
  for (const request of [undefined, {}, { body: account().user }, { body: { user: account().user } }, { user: { handle: 'alice' } },
    account(''), account(' alice'), account('a\nb'), account('a'.repeat(241)), { user: { profile: { handle: 'alice', enabled: false } } }]) {
    assert.throws(() => imageServiceAccount(request), { code: 'image_service_authentication_required', status: 401 });
  }
  const identity = imageServiceAccount(account());
  assert.ok(Object.isFrozen(identity)); assert.match(identity.namespace, /^st-user:[a-f0-9]{64}$/);
  assert.ok(!identity.namespace.includes('alice')); assert.notEqual(identity.namespace, imageServiceAccount(account('bob')).namespace);
  assert.equal(imageServiceAccount({ user: { profile: { handle: 'alice', admin: 'true' } } }).admin, false);
});

test('body namespaces, paths and admin flags never affect the query account', async () => {
  const request = { ...account(), body: { namespace: imageServiceAccount(account('bob')).namespace, admin: true, dataRoot: '/secret' } };
  const response = await queryImageServiceTask(request, { ...input, ...request.body }, { store: {
    transaction: never, inspectChannel: async actual => { assert.equal(actual, key); return state([row('alice'), row('bob')]); },
  } });
  assert.deepEqual(response.task, { attemptId: input.attemptId, status: 'uncertain', automatic: true, createdAt: 1, updatedAt: 2, needsReview: true });
  assert.doesNotMatch(JSON.stringify(response), /namespace|owner|fence|digest|apiKey|alice|bob/);
});

test('someone else’s task and a nonexistent task return identical responses, including for admin', async () => {
  const store = { inspectChannel: async () => state([row('bob')]) };
  for (const admin of [false, true]) {
    const foreign = await queryImageServiceTask(account('alice', admin), input, { store });
    const absent = await queryImageServiceTask(account('alice', admin), { ...input, attemptId: 'missing' }, { store });
    assert.deepEqual(foreign, absent); assert.deepEqual(foreign, { ok: true, schemaVersion: 1, task: null });
  }
});

test('account switching or disabling during a read cannot return the previous account’s task', async () => {
  for (const change of [request => { request.user.profile.handle = 'bob'; }, request => { request.user.profile.enabled = false; }]) {
    const request = account(), store = { inspectChannel: async () => { change(request); return state([row('alice')]); } };
    await assert.rejects(queryImageServiceTask(request, input, { store }), { code: 'image_service_authentication_changed' });
  }
  assert.equal(imageServiceAccountStillMatches({}, imageServiceAccount(account())), false);
});

test('query captures its original task identity across storage waits', async () => {
  const mutable = { ...input }, store = { inspectChannel: async () => { mutable.attemptId = 'other'; return state([row('alice')]); } };
  assert.equal((await queryImageServiceTask(account(), mutable, { store })).task.attemptId, input.attemptId);
});

test('invalid queries do not reach storage and never invoke an upstream generation', async () => {
  const store = { inspectChannel: never, transaction: never };
  for (const bad of [{}, { channelKey: key, attemptId: 'original' }, { ...input, attemptId: '' }, { ...input, attemptId: 'x\0y' }]) {
    await assert.rejects(queryImageServiceTask(account(), bad, { store }));
  }
  await assert.rejects(queryImageServiceTask({}, input, { store }), { status: 401 });
  await assert.rejects(queryImageServiceTask(account(), input), { code: 'image_service_storage' });
});

test('corrupted records cannot be presented as a missing or retryable task', async () => {
  await assert.rejects(queryImageServiceTask(account(), input, { store: { inspectChannel: async () => ({ schema: 'future' }) } }), { code: 'image_service_state' });
});

test('a running or previously acknowledged task does not get mislabeled as requiring another retry decision', async () => {
  for (const status of ['reserved', 'submitting', 'acknowledged', 'succeeded', 'released', 'rejected']) {
    const result = await queryImageServiceTask(account(), input, { store: { inspectChannel: async () => state([row('alice', { status })]) } });
    assert.equal(result.task.status, status); assert.equal(result.task.needsReview, false);
  }
});
