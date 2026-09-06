import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createImageService } from '../qianmu-image-service.js';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceResults } from '../qianmu-image-service-results.js';
import { imageServiceChannelKey } from '../qianmu-image-service-queue.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const actor = (handle = 'alice') => ({ user: { profile: { handle, enabled: true } } });
const request = { provider: 'novel', model: 'nai-diffusion-5-full', apiKey: 'mock-service-key', prompt: 'a quiet lake' };
const input = (attemptId, extra = {}) => ({ schemaVersion: 1, attemptId, automatic: true, request: { ...request }, ...extra });
const query = attemptId => ({ schemaVersion: 1, apiKey: request.apiKey, attemptId });
const response = () => new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { headers: { 'Content-Type': 'application/json' } });
const dns = async () => [{ address: '8.8.8.8', family: 4 }];
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-service-flow-'));
  t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^qianmu-service-flow-/); await fs.rm(real, { recursive: true }); });
  const store = createImageServiceStore({ dataRoot: root });
  const service = createImageService({ dataRoot: root, store, gatewayOptions: { resolveHost: dns, fetchImpl: response }, ...options });
  t.after(() => service.close()); return { root, store, service };
}

test('service authentication and missing-task query create no data and issue no upstream request', async t => {
  const { root, service } = await fixture(t);
  await assert.rejects(service.submit({}, input('bad')), { status: 401 });
  await assert.rejects(service.submit(actor(), { ...input('bad'), schemaVersion: 2 }), { code: 'image_service_version' });
  assert.equal((await service.query(actor(), query('absent'))).task, null);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(service.inspect().admitted, 0);
});

test('actual gateway result is cached, survives reopening, and repeated submission cannot charge again', async t => {
  let posts = 0;
  const { root, service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async () => { posts++; return response(); } } });
  const generated = await service.submit(actor(), input('once'));
  assert.equal(generated.images[0].data, PNG); assert.equal(generated.serviceTask.resultStored, true);
  assert.match(generated.serviceTask.receipt, /^[a-f0-9]{64}$/);
  assert.equal((await service.query(actor(), query('once'))).task.status, 'succeeded');
  assert.equal((await service.submit(actor(), input('once'))).images[0].data, PNG); assert.equal(posts, 1);
  await service.close();
  const reopened = createImageService({ dataRoot: root, generate: () => assert.fail('cannot regenerate a cached task') }); t.after(() => reopened.close());
  assert.equal((await reopened.result(actor(), query('once'))).images[0].data, PNG);
  assert.equal((await reopened.submit(actor(), input('once'))).images[0].data, PNG);
  await assert.rejects(reopened.submit(actor(), input('once', { request: { ...request, prompt: 'changed' } })), { code: 'image_service_conflict' });
});

test('results, metadata and receipts stay isolated between accounts sharing the same provider key', async t => {
  const { service } = await fixture(t);
  const generated = await service.submit(actor(), input('private'));
  assert.equal((await service.query(actor('bob'), query('private'))).task, null);
  await assert.rejects(service.result(actor('bob'), query('private')), { code: 'image_service_task_missing' });
  await assert.rejects(service.acknowledge(actor('bob'), { ...query('private'), archived: true, receipt: generated.serviceTask.receipt }));
  assert.equal((await service.result(actor(), query('private'))).images[0].data, PNG);
});

test('multiple simulated devices and accounts sharing a NAI key generate strictly one at a time', async t => {
  let active = 0, maximum = 0, posts = 0;
  const { service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async () => {
    posts++; maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return response();
  } } });
  await Promise.all(Array.from({ length: 6 }, (_, n) => service.submit(actor(n % 2 ? 'alice' : 'bob'), input(`shot-${n}`))));
  assert.equal(posts, 6); assert.equal(maximum, 1); assert.equal(service.inspect().admitted, 0);
});

test('losing the client after submission does not cancel result persistence or permit a new charge', async t => {
  const abort = new AbortController(); let posts = 0;
  const { service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async () => { posts++; abort.abort(); return response(); } } });
  await service.submit(actor(), input('disconnected'), { signal: abort.signal });
  assert.equal((await service.result(actor(), query('disconnected'))).images[0].data, PNG);
  assert.equal(posts, 1);
});

test('waiting disconnect and invalidated accounts stop before any provider write', async t => {
  const gate = deferred(), begun = deferred(); let posts = 0;
  const { service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async () => { posts++; begun.resolve(); await gate.promise; return response(); } } });
  const held = service.submit(actor(), input('held')); await begun.promise;
  const abort = new AbortController(), waiting = service.submit(actor(), input('cancelled'), { signal: abort.signal }); abort.abort();
  await assert.rejects(waiting, { code: 'image_service_cancelled' });
  const changing = actor(), changed = service.submit(changing, input('changed')); changing.user.profile.enabled = false;
  await assert.rejects(changed);
  gate.resolve(); await held; assert.equal(posts, 1);
});

test('result acknowledgement removes only the cache and preserves non-replayable request history', async t => {
  const { service } = await fixture(t), generated = await service.submit(actor(), input('archive'));
  await assert.rejects(service.acknowledge(actor(), { ...query('archive'), archived: true, receipt: '0'.repeat(64) }), { code: 'image_service_result_changed' });
  await service.acknowledge(actor(), { ...query('archive'), archived: true, receipt: generated.serviceTask.receipt });
  const status = await service.query(actor(), query('archive'));
  assert.equal(status.task.status, 'succeeded'); assert.equal(status.task.resultAvailable, false);
  await assert.rejects(service.submit(actor(), input('archive')), { code: 'image_service_result_missing', submissionState: 'accepted' });
});

test('result corruption is reported, not silently replaced with a newly generated image', async t => {
  let posts = 0;
  const { root, service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async () => { posts++; return response(); } } });
  await service.submit(actor(), input('corrupt'));
  const base = path.join(root, '.qianmu-service', 'image-results-v1'), [slot] = await fs.readdir(base);
  await fs.writeFile(path.join(base, slot, 'image-0.bin'), Buffer.from('corrupt'));
  await assert.rejects(service.result(actor(), query('corrupt')), { code: 'image_service_result_corrupt' });
  assert.equal(posts, 1);
});

test('late cache failures preserve the generated image with a warning', async t => {
  const options = { results: { reserve: async () => {}, save: async () => { throw Error('disk full'); }, load: async () => null } };
  const { service } = await fixture(t, options);
  const result = await service.submit(actor(), input('save-failure'));
  assert.equal(result.images[0].data, PNG); assert.equal(result.serviceTask.resultStored, false); assert.ok(result.serviceTask.warning);
  assert.equal((await service.query(actor(), query('save-failure'))).task.status, 'succeeded');
});

test('a reserved-cache capacity failure stops before charging and a known reject releases its empty slot', async t => {
  const { root, store } = await fixture(t);
  const cache = createImageServiceResults({ dataRoot: root, store, maxSlots: 1 }); let posts = 0;
  const service = createImageService({ dataRoot: root, store, results: cache, gatewayOptions: { resolveHost: dns, fetchImpl: async () => { posts++; return posts === 1 ? new Response('{}', { status: 429 }) : response(); } } });
  t.after(() => service.close());
  await assert.rejects(service.submit(actor(), input('rejected')), { submissionState: 'rejected' });
  await service.submit(actor(), input('next'));
  await assert.rejects(service.submit(actor(), input('full')), { code: 'image_service_result_full' });
  assert.equal(posts, 2);
});

test('third-party result URLs are remembered before downloading and retry only uses GET', async t => {
  let posts = 0, gets = 0;
  const { service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async (url, init) => {
    if (init.method === 'POST') { posts++; return new Response(JSON.stringify({ images: [{ url: 'https://images.example.test/picture.png?sig=mock', mime_type: 'image/png' }] }), { headers: { 'Content-Type': 'application/json' } }); }
    gets++; assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, undefined); assert.equal(init.redirect, 'error');
    if (gets === 1) throw Error('temporary media download failure'); return new Response(Buffer.from(PNG, 'base64'));
  } } });
  const initial = await service.submit(actor(), input('remote'));
  assert.equal(initial.serviceTask.resultStored, false); assert.ok(initial.serviceTask.warning);
  assert.equal((await service.query(actor(), query('remote'))).task.resultAvailable, true);
  const recovered = await service.result(actor(), query('remote'));
  assert.equal(recovered.images[0].data, PNG); assert.equal(recovered.serviceTask.resultStored, true);
  assert.equal(posts, 1); assert.equal(gets, 2);
});

test('private-network result URLs are never followed and provider authorization is not sent to image hosts', async t => {
  let posts = 0, gets = 0;
  const { service } = await fixture(t, { gatewayOptions: {
    resolveHost: async host => [{ address: host === 'unsafe.example.test' ? '127.0.0.1' : '8.8.8.8', family: 4 }],
    fetchImpl: async (_url, init) => { if (init.method === 'GET') { gets++; assert.fail('no private request'); } posts++;
      return new Response(JSON.stringify({ images: [{ url: 'https://unsafe.example.test/private' }] }), { headers: { 'Content-Type': 'application/json' } }); },
  } });
  assert.ok((await service.submit(actor(), input('unsafe'))).serviceTask.warning);
  await assert.rejects(service.result(actor(), query('unsafe')), { code: 'image_service_result_download' });
  assert.equal(posts, 1); assert.equal(gets, 0);
});

test('cached completion can reconcile a stale submitting ledger without requesting another image', async t => {
  const { service, store } = await fixture(t);
  await service.submit(actor(), input('reconcile'));
  await store.transaction(imageServiceChannelKey(request.apiKey), state => { state.entries[0].status = 'submitting'; return { state }; });
  assert.equal((await service.result(actor(), query('reconcile'))).images[0].data, PNG);
  assert.equal((await service.query(actor(), query('reconcile'))).task.status, 'succeeded');
});

test('explicit temporary-result cleanup never clears an unknown request’s protective ledger', async t => {
  const { service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async () => { throw Error('upstream disconnected'); } } });
  await assert.rejects(service.submit(actor(), input('unknown')), { submissionState: 'unknown' });
  const status = await service.query(actor(), query('unknown'));
  assert.equal(status.task.status, 'uncertain'); assert.ok(status.task.cacheReceipt);
  await service.discard(actor(), { ...query('unknown'), confirmed: true, receipt: status.task.cacheReceipt });
  assert.equal((await service.query(actor(), query('unknown'))).task.status, 'uncertain');
  await assert.rejects(service.submit(actor(), input('new-auto')), { code: 'image_service_confirmation_required' });
});

test('configuration edits while queued cannot change the frozen generation request', async t => {
  const gate = deferred(), begun = deferred(), prompts = [];
  const { service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async (_url, init) => {
    prompts.push(JSON.parse(init.body).input); begun.resolve(); if (prompts.length === 1) await gate.promise; return response();
  } } });
  const held = service.submit(actor(), input('first')); await begun.promise;
  const mutable = input('frozen'), second = service.submit(actor(), mutable);
  mutable.request.prompt = 'wrong replacement'; mutable.automatic = false; mutable.request.apiKey = 'different';
  gate.resolve(); await Promise.all([held, second]);
  assert.deepEqual(prompts, ['a quiet lake', 'a quiet lake']);
});

test('an account change after charging cannot return its image to a different account', async t => {
  const person = actor();
  const { service } = await fixture(t, { gatewayOptions: { resolveHost: dns, fetchImpl: async () => { person.user.profile.handle = 'bob'; return response(); } } });
  await assert.rejects(service.submit(person, input('ownership')), { code: 'image_service_authentication_changed', submissionState: 'accepted' });
  assert.equal((await service.query(actor('bob'), query('ownership'))).task, null);
  assert.equal((await service.result(actor(), query('ownership'))).images[0].data, PNG);
});
