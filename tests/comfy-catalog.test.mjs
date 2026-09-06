import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createComfyService } from '../qianmu-comfy-service.js';
import { createComfyRecoveryClient } from '../qianmu-comfy-recovery-client.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { normalizeComfyDelivery } from '../qianmu-comfy-delivery-store.js';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const account = (handle = 'alice') => ({ user: { profile: { handle, enabled: true, admin: true } } });
const scope = (handle = 'alice') => ({ version: 1, expectedAccount: imageServiceAccount(account(handle)).namespace });
const execution = { version: 1, automatic: false, maxImages: 1, outputNodeIds: ['save'], allowUnverified: false };
const receipt = { version: 1, model: 'fixture-model', previewNodeIds: [], execution: { ...execution, expectedImages: 1 } };
const request = (id = 'attempt-a', handle = 'alice') => ({ provider: 'comfy', baseUrl: 'https://original.test/api', apiKey: 'never-in-catalog-test-secret', model: 'fixture-model',
  prompt: 'private original scene', comfyExecution: execution, comfyQueue: { ...scope(handle), attemptId: id, automatic: false }, parameters: { workflow: { save: { class_type: 'SaveImage', inputs: {} } } } });
const packet = upstreamId => ({ ok: true, provider: 'comfy', model: 'fixture-model', upstreamId, durationMs: 10, images: [{ mime: 'image/png', data: png }] });
const deferred = () => { let resolve; return { promise: new Promise(yes => resolve = yes), resolve: value => resolve(value) }; };
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-catalog-'));
  let posts = 0, transportCalls = 0;
  const service = createComfyService({ dataRoot: root, authorizeTarget: async () => async () => {}, prepareTransport: async () => { transportCalls++; throw Error('no remote access expected'); },
    generate: async (_input, hooks) => { await hooks.beforeSubmit(); const id = `accepted-${++posts}`; await hooks.onComfyAccepted(id, receipt); return packet(id); }, ...overrides });
  t.after(async () => { await service.close(); assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('qianmu-comfy-catalog-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, service, get posts() { return posts; }, get transportCalls() { return transportCalls; } };
}
const selected = (row, handle = 'alice') => ({ ...scope(handle), attemptId: row.attemptId, taskLocator: row.taskLocator });

test('empty catalog is lazy, authenticated and does not create a data directory', async t => {
  const f = await fixture(t), data = await f.service.catalog(account(), scope());
  assert.equal(data.totals.count, 0); assert.equal(data.totals.tasks, 0); assert.deepEqual(await fs.readdir(f.root), []);
  await assert.rejects(f.service.catalog({}, scope()));
  await assert.rejects(f.service.catalog(account('bob'), scope()));
  assert.equal(f.posts, 0); assert.equal(f.transportCalls, 0);
});
test('catalog paginates ledger metadata, includes all owned originals and never reveals another account or credentials', async t => {
  const f = await fixture(t);
  await f.service.submit(account(), request()); await f.service.submit(account(), request('attempt-b'));
  await f.service.submit(account('bob'), request('bob-task', 'bob'));
  const first = await f.service.catalog(account(), { ...scope(), limit: 1 });
  assert.equal(first.originals.length, 2); assert.equal(first.tasks.length, 1); assert.ok(first.nextCursor);
  assert.equal(first.totals.tasks, 2); assert.equal(first.totals.imageBytes, 2 * Buffer.from(png, 'base64').length); assert.ok(first.totals.metadataBytes > 0);
  assert.ok(first.originals.every(row => row.canDiscard && row.resultAvailable && !row.recipeAvailable));
  const second = await f.service.catalog(account(), { ...scope(), cursor: first.nextCursor, limit: 1 });
  assert.equal(second.tasks.length, 1); assert.notEqual(first.tasks[0].attemptId, second.tasks[0].attemptId); assert.equal(second.nextCursor, null);
  for (const secret of ['bob-task','never-in-catalog-test-secret','private original scene','original.test','requestDigest','fence']) assert.ok(!JSON.stringify(first).includes(secret), secret);
  const bob = await f.service.catalog(account('bob'), { ...scope('bob'), namespace: scope().expectedAccount });
  assert.equal(bob.originals.length, 1); assert.equal(bob.originals[0].attemptId, 'bob-task');
  assert.equal((await f.service.query(account('bob'), selected(first.originals[0], 'bob'))).task, null);
});
test('a server locator retrieves cached original without a URL, Key, workflow or provider access', async t => {
  const f = await fixture(t); await f.service.submit(account(), request());
  const row = (await f.service.catalog(account(), scope())).originals[0], body = selected(row);
  const data = await f.service.result(account(), body);
  assert.equal(data.images[0].data, png); assert.equal(data.comfyTask.attemptId, row.attemptId); assert.equal(f.transportCalls, 0);
  await assert.rejects(f.service.result(account(), { ...body, baseUrl: 'https://wrong.test' }), { code: 'comfy_queue_locator' });
  await assert.rejects(f.service.result(account('bob'), { ...body, ...scope('bob') }), { code: 'comfy_queue_missing' });
  await f.service.acknowledge(account(), { ...body, receipt: data.comfyTask.receipt, archived: true });
  assert.equal((await f.service.catalog(account(), scope())).originals.length, 0);
  assert.equal((await f.service.query(account(), body)).task.status, 'succeeded'); assert.equal(f.posts, 1);
});
test('explicit deletion checks exact receipt, keeps paid ledger and never authorizes resubmission', async t => {
  const f = await fixture(t); await f.service.submit(account(), request());
  const row = (await f.service.catalog(account(), scope())).originals[0], body = { ...selected(row), receipt: row.cacheReceipt };
  await assert.rejects(f.service.discard(account(), body));
  await assert.rejects(f.service.discard(account(), { ...body, confirmed: true, receipt: '0'.repeat(64) }));
  await assert.rejects(f.service.discard(account('bob'), { ...body, ...scope('bob'), confirmed: true }));
  assert.equal((await f.service.catalog(account(), scope())).originals.length, 1);
  const removed = await f.service.discard(account(), { ...body, confirmed: true }); assert.ok(removed.bytes > 0);
  assert.equal((await f.service.catalog(account(), scope())).originals.length, 0);
  await assert.rejects(f.service.submit(account(), request()), { code: 'comfy_queue_already_exists' }); assert.equal(f.posts, 1);
  await assert.rejects(f.service.result(account(), selected(row)), { code: 'comfy_queue_original_connection' }); assert.equal(f.transportCalls, 0);
});
test('in-flight and uncertain slots report reservation without offering deletion or inventing completion', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { generate: async (_input, hooks) => { await hooks.beforeSubmit(); await hooks.onComfyAccepted('accepted', receipt); entered.resolve(); await release.promise; throw Object.assign(Error('lost response'), { submissionState: 'accepted' }); } });
  const work = f.service.submit(account(), request()).catch(error => error); await entered.promise;
  let row = (await f.service.catalog(account(), scope())).originals[0];
  assert.equal(row.live, true); assert.equal(row.canDiscard, false); assert.ok(row.reservedBytes > 0); assert.equal(row.cacheBytes, 0);
  await assert.rejects(f.service.discard(account(), { ...selected(row), receipt: row.cacheReceipt, confirmed: true }));
  release.resolve(); await work;
  row = (await f.service.catalog(account(), scope())).originals[0]; assert.equal(row.status, 'uncertain'); assert.equal(row.canDiscard, false);
  await assert.rejects(f.service.discard(account(), { ...selected(row), receipt: row.cacheReceipt, confirmed: true }));
  await assert.rejects(f.service.result(account(), selected(row)), { code: 'comfy_queue_original_connection' });
});
test('catalog bounds are checked before storage work and account changes during listing discard the response', async t => {
  let scans = 0; const requestAccount = account();
  const f = await fixture(t, { results: { inventory: async () => { scans++; requestAccount.user.profile.handle = 'bob'; return { entries: [], totals: {} }; } } });
  for (const change of [{ limit: 51 }, { limit: 0 }, { cursor: { channelKey: 'bad', attemptId: 'a' } }]) await assert.rejects(f.service.catalog(account(), { ...scope(), ...change }));
  assert.equal(scans, 0);
  await assert.rejects(f.service.catalog(requestAccount, scope()), { code: 'comfy_queue_account' }); assert.equal(scans, 1);
});

function clientFor(service, { confirm = async () => true } = {}) {
  const rows = new Map(), calls = []; let namespace = 'st-user:alice';
  const store = { list: async ns => [...rows.values()].filter(row => row.namespace === ns).map(row => structuredClone(row)),
    get: async (ns, id) => structuredClone(rows.get(`${ns}/${id}`) || null), put: async value => { const row = normalizeComfyDelivery(value, 'https://st.test'); rows.set(`${row.namespace}/${row.attemptId}`, row); },
    remove: async row => rows.delete(`${row.namespace}/${row.attemptId}`), close() {} };
  const client = createComfyRecoveryClient({ origin: 'https://st.test', account: async () => namespace, store, confirm,
    locks: { request: async (_name, _options, work) => work({}) },
    fetchImpl: async (url, init) => { const action = url.split('/').at(-1), body = JSON.parse(init.body); calls.push({ action, body });
      assert.ok(['catalog','query','result','acknowledge','discard'].includes(action));
      try { return new Response(JSON.stringify(await service[action](account(namespace.slice(8)), body))); }
      catch (error) { return new Response(JSON.stringify({ ok: false, message: error.message }), { status: error.status || 409 }); } },
  });
  return { client, rows, calls, switchAccount: () => { namespace = 'st-user:bob'; } };
}
test('actual browser client and server compose original-only recovery without inventing a recipe', async t => {
  const f = await fixture(t); await f.service.submit(account(), request());
  const c = clientFor(f.service), row = (await c.client.catalog()).originals[0];
  const result = await c.client.retrieveOriginal(row, { chatKey: 'current-chat', deliver: async (job, data, files, checkpoint, guard) => {
    await guard(); assert.equal(job.originalOnly, true); assert.equal(job.target, 'gallery'); assert.equal(job.inlineByDefault, false);
    assert.deepEqual(job.payload, {}); assert.equal(job.prompt, ''); assert.equal(job.connection.baseUrl, ''); assert.equal(data.images[0].data, png);
    await checkpoint([{ url: '/user/images/original.png' }]); return true;
  } });
  assert.equal(result.archived, true); assert.equal([...c.rows.values()][0].version, 2); assert.equal([...c.rows.values()][0].status, 'confirmed');
  assert.ok(!JSON.stringify([...c.rows.values()]).includes('private original scene'));
  assert.equal(f.posts, 1); assert.equal(f.transportCalls, 0);
  assert.equal((await c.client.list()).rows.length, 1);
  assert.equal((await c.client.removeLocal((await c.client.list()).rows)).removed, 1); assert.equal(c.rows.size, 0);
  assert.equal((await f.service.query(account(), selected(row))).task.status, 'succeeded');
});
test('cancelling original-only import or cleanup makes no mutation; stale account cannot reuse selection', async t => {
  const f = await fixture(t); await f.service.submit(account(), request());
  const c = clientFor(f.service, { confirm: async () => false }), row = (await c.client.catalog()).originals[0];
  assert.equal((await c.client.retrieveOriginal(row, { chatKey: 'chat', deliver: () => assert.fail('cancelled') })).cancelled, true);
  assert.equal(c.rows.size, 0); assert.equal((await c.client.discard([row])).cancelled, true);
  assert.equal(c.calls.some(call => ['result','discard','acknowledge'].includes(call.action)), false);
  c.switchAccount(); await assert.rejects(c.client.discard([row]), { code: 'comfy_delivery_account' });
});

test('original-only recovery preserves a partially saved v1 journal and verifies its old connection', async t => {
  const output = { ...receipt, execution: { ...execution, maxImages: 2, expectedImages: 2 } };
  const f = await fixture(t, { generate: async (_input, hooks) => {
    await hooks.beforeSubmit(); await hooks.onComfyAccepted('accepted-partial', output);
    const result = packet('accepted-partial'); result.images.push({ ...result.images[0] }); return result;
  } });
  const input = request(); input.comfyExecution = { ...input.comfyExecution, maxImages: 2 };
  await f.service.submit(account(), input);
  const c = clientFor(f.service), original = (await c.client.catalog()).originals[0];
  const previous = normalizeComfyDelivery({ version: 1, namespace: 'st-user:alice', attemptId: original.attemptId,
    baseUrl: input.baseUrl, credentialId: 'original-reference', chatKey: 'same-chat', createdAt: 1,
    status: 'available', receipt: original.cacheReceipt, imageCount: 2, files: [{ imageIndex: 0, url: '/user/images/already-saved.png' }] }, 'https://st.test');
  c.rows.set(`st-user:alice/${original.attemptId}`, previous);
  const result = await c.client.retrieveOriginal(original, { chatKey: 'same-chat', deliver: async (job, data, files, checkpoint) => {
    assert.equal(job.originalOnly, true); assert.equal(job.connection.credentialId, 'original-reference');
    assert.equal(data.images.length, 2); assert.deepEqual(files, previous.files);
    await checkpoint([...files, { url: '/user/images/second.png' }]); return true;
  } });
  assert.equal(result.archived, true);
  const saved = [...c.rows.values()][0]; assert.equal(saved.version, 2); assert.equal(saved.files[0].url, previous.files[0].url);
  assert.equal(saved.status, 'confirmed'); assert.equal(saved.baseUrl, previous.baseUrl);
  assert.ok(c.calls.some(call => call.action === 'query' && call.body.baseUrl === previous.baseUrl && call.body.taskLocator));
  assert.equal(c.calls.some(call => call.body.apiKey), false); assert.equal(f.transportCalls, 0);
});

test('original-only recovery cannot move an existing receipt to another chat or substitute its connection', async t => {
  const f = await fixture(t); await f.service.submit(account(), request());
  const c = clientFor(f.service), original = (await c.client.catalog()).originals[0];
  const previous = normalizeComfyDelivery({ version: 1, namespace: 'st-user:alice', attemptId: original.attemptId,
    baseUrl: 'https://different.test', chatKey: 'original-chat', createdAt: 1, status: 'prepared', imageCount: 0, files: [] }, 'https://st.test');
  c.rows.set(`st-user:alice/${original.attemptId}`, previous);
  await assert.rejects(c.client.retrieveOriginal(original, { chatKey: 'other-chat' }), { code: 'comfy_delivery_chat' });
  await assert.rejects(c.client.retrieveOriginal(original, { chatKey: 'original-chat' }), /原连接与任务不匹配/);
  assert.equal([...c.rows.values()][0].version, 1); assert.deepEqual([...c.rows.values()][0], previous);
  assert.equal(c.calls.some(call => ['result','discard','acknowledge'].includes(call.action)), false);
});
test('client cleanup is explicit, bounded and preserves partial error reporting', async t => {
  const f = await fixture(t); await f.service.submit(account(), request()); await f.service.submit(account(), request('attempt-b'));
  const c = clientFor(f.service), rows = (await c.client.catalog()).originals;
  await assert.rejects(c.client.discard(Array(21).fill(rows[0]))); await assert.rejects(c.client.discard([rows[0], rows[0]]));
  const mixed = [{ ...rows[0], cacheReceipt: '0'.repeat(64) }, rows[1]];
  const result = await c.client.discard(mixed); assert.equal(result.removed, 1); assert.equal(result.errors.length, 1);
  assert.equal((await f.service.catalog(account(), scope())).originals.length, 1); assert.equal(f.posts, 2);
});

test('global storage meter counts Comfy journal by constant-size usage read, without remote listing or recipe scans', async () => {
  let reads = 0;
  const context = vm.createContext({ navigator: { storage: { estimate: async () => ({ usage: 1000, quota: 100000 }) } },
    blobStore: { estimateBlobStoreUsage: async () => ({ totalBytes: 0, categories: [], recoverableBytes: 0 }), auditOrphanedReaderBlobs: async () => ({ count: 0, bytes: 0 }), classifyStoragePressure: () => ({}) },
    featureRuntime: { load: async () => ({ manageImageAdmissionStorage: async () => ({ count: 1, bytes: 10 }) }) },
    storyboardManageImageChannels: async () => ({ count: 1, bytes: 20 }), storyboardImageServiceRuntime: async () => ({ manage: async () => ({ count: 1, bytes: 30 }) }),
    storyboardComfyRecoveryRuntime: async () => ({ usage: async () => { reads++; return { count: 2, bytes: 40 }; }, list: () => assert.fail('no row scan'), catalog: () => assert.fail('no network') }),
    storageJsonBytes: () => 0, storageSettingsSnapshotWithoutDiagnostics: () => ({}), getChatStore: () => ({}), storageDiagnosticSnapshot: () => ({}),
  });
  vm.runInContext(storyboardFunctionSource('collectStorageInventory'), context);
  const inventory = await context.collectStorageInventory();
  assert.equal(reads, 1); assert.equal(inventory.comfyReceipts.count, 2); assert.equal(inventory.trackedBytes, 100); assert.equal(inventory.manageableBytes, 100);
  assert.equal(inventory.categories.find(item => item.category === 'logs').bytes, 100);
});
