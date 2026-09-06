import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createComfyService } from '../qianmu-comfy-service.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { normalizeComfyReceipt } from '../qianmu-comfy-receipt.js';
import { recoverComfyImage } from '../qianmu-image-gateway.js';
import { pinnedComfyFetch } from '../qianmu-comfy-server-transport.js';
import { acknowledgeComfyImage } from '../qianmu-comfy-submission.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const account = (handle = 'alice') => ({ user: { profile: { handle, admin: true, enabled: true } } });
const binding = (handle = 'alice') => ({ version: 1, attemptId: 'original-attempt', expectedAccount: imageServiceAccount(account(handle)).namespace, automatic: false });
const connection = { baseUrl: 'https://comfy.test/api', apiKey: 'test-only-secret' };
const policy = { version: 1, automatic: false, outputNodeIds: ['save'], maxImages: 1, allowUnverified: false };
const receipt = () => normalizeComfyReceipt({ version: 1, model: 'original-model', previewNodeIds: ['preview'], execution: { ...policy, expectedImages: 1 } });
const input = () => ({ ...connection, provider: 'comfy', model: 'original-model', prompt: 'secret-workflow-prompt', comfyQueue: binding(), comfyExecution: policy,
  parameters: { pollIntervalMs: 250, workflow: {
    image: { class_type: 'EmptyImage', inputs: { batch_size: 1, text: '%qianmu_prompt%' } },
    save: { class_type: 'SaveImage', inputs: { images: ['image', 0] } }, preview: { class_type: 'PreviewImage', inputs: { images: ['image', 0] } },
  } } });
const ready = (extra = {}) => ({ 'original-id': { status: { completed: true, status_str: 'success' }, outputs: { save: { images: [{ filename: 'original.png', type: 'output' }] },
  preview: { images: [{ filename: 'preview.png', type: 'output' }] } }, ...extra } });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-recovery-')), services = [], calls = []; let failCollection = true;
  const prepareTransport = async (_request, _connection, operation) => ({ base: new URL(connection.baseUrl), verify: async () => {}, fetchImpl: async (url, init) => {
    const target = new URL(url); calls.push([operation, init.method, target.pathname, target.search]);
    if (operation === 'recover') assert.equal(init.method, 'GET');
    if (target.pathname.endsWith('/prompt')) return json({ prompt_id: 'original-id' });
    if (target.pathname.includes('/history/')) { if (failCollection) throw Error('simulated lost response'); return json(ready()); }
    if (target.pathname.endsWith('/view')) return new Response(Buffer.from(png, 'base64'));
    assert.fail(target.pathname);
  } });
  const create = extra => {
    const service = createComfyService({ dataRoot: root, authorizeTarget: async () => async () => {}, prepareTransport, ...options, ...extra });
    services.push(service); return service;
  };
  t.after(async () => { await Promise.allSettled(services.map(service => service.close())); assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('qianmu-comfy-recovery-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, create, calls, allowCollection: () => { failCollection = false; } };
}

test('output receipts are bounded projections, preserve manual unknown counts and cannot change automatic budgets', () => {
  assert.deepEqual(receipt().execution.outputNodeIds, ['save']);
  assert.ok(!Object.hasOwn(normalizeComfyReceipt({ ...receipt(), execution: { ...policy, expectedImages: null }, workflow: 'ignored', apiKey: 'ignored' }), 'apiKey'));
  for (const change of [{ version: 2 }, { previewNodeIds: ['save'] }, { previewNodeIds: ['x', 'x'] }, { execution: { ...policy, automatic: true } },
    { execution: { ...policy, expectedImages: 2 } }, { execution: { ...policy, outputNodeIds: [] } }, { model: 'x'.repeat(241) }]) assert.throws(() => normalizeComfyReceipt({ ...receipt(), ...change }));
});

test('native recovery never submits; it applies original node selection, preview exclusion and static-image bytes', async () => {
  const calls = [];
  const result = await recoverComfyImage(connection, 'original-id', receipt(), { prepareComfyTransport: async (_, operation) => {
    assert.equal(operation, 'recover'); return { base: new URL(connection.baseUrl), verify: async () => {}, fetchImpl: async (url, options) => {
      const target = new URL(url); calls.push(target.pathname); assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer test-only-secret');
      if (target.pathname.includes('/history/')) return json(ready());
      assert.equal(target.searchParams.get('filename'), 'original.png'); return new Response(Buffer.from(png, 'base64'));
    } };
  } });
  assert.deepEqual(calls, ['/api/history/original-id', '/api/view']); assert.equal(result.status, 'ready'); assert.equal(result.model, 'original-model'); assert.equal(result.images[0].mime, 'image/png');
  assert.equal(result.durationMs, 0, 'download time is not GPU generation duration'); assert.ok(result.recoveryDurationMs >= 0);
});

test('pending and running originals only read status and never expose another queued workflow', async () => {
  for (const status of ['running', 'queued']) {
    const calls = [], data = { queue_running: [], queue_pending: [['other', 'another-id', { secret: 'do-not-return' }]] };
    data[status === 'running' ? 'queue_running' : 'queue_pending'].push([1, 'original-id', { secret: 'own-workflow' }]);
    const result = await recoverComfyImage(connection, 'original-id', receipt(), { prepareComfyTransport: async () => ({ base: new URL(connection.baseUrl), verify: async () => {}, fetchImpl: async (url, init) => {
      const route = new URL(url).pathname; calls.push(route); assert.equal(init.method, 'GET'); return json(route.endsWith('/queue') ? data : {});
    } }) });
    assert.equal(result.status, status); assert.equal(result.images, undefined); assert.ok(!JSON.stringify(result).includes('workflow')); assert.equal(calls.length, 2);
  }
});

test('a completion race is rechecked once; an absent history is never treated as cancellation or permission to replay', async () => {
  for (const late of [false, true]) {
    let histories = 0, writes = 0;
    const result = await recoverComfyImage(connection, 'original-id', receipt(), { prepareComfyTransport: async () => ({ base: new URL(connection.baseUrl), verify: async () => {}, fetchImpl: async (url, init) => {
      if (init.method !== 'GET') writes++; const route = new URL(url).pathname;
      if (route.includes('/history/')) return json(++histories === 2 && late ? ready() : {});
      if (route.endsWith('/queue')) return json({ queue_running: [], queue_pending: [] });
      return new Response(Buffer.from(png, 'base64'));
    } }) });
    assert.equal(result.status, late ? 'ready' : 'unavailable'); assert.equal(histories, 2); assert.equal(writes, 0);
  }
});

test('execution failure, wrong task, output mismatch and non-image responses retain original acceptance', async () => {
  for (const [history, image, code] of [[ready({ status: { status_str: 'error' } }), png, 'comfy_execution_failed'],
    [{ prompt_id: 'different' }, png, 'comfy_history_mismatch'], [ready({ outputs: { save: { images: [] } } }), png, 'comfy_missing_final_image'],
    [ready(), Buffer.from('not an image').toString('base64'), 'comfy_invalid_image']]) {
    await assert.rejects(recoverComfyImage(connection, 'original-id', receipt(), { prepareComfyTransport: async () => ({ base: new URL(connection.baseUrl), verify: async () => {}, fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET'); return new URL(url).pathname.includes('/history/') ? json(history) : new Response(Buffer.from(image, 'base64'));
    } }) }), { code, upstreamId: 'original-id', submissionState: 'accepted' });
  }
});

test('recovery transport cannot POST prompt/upload/interrupt or access another path', async () => {
  const fetcher = pinnedComfyFetch('https://comfy.test/api', [{ address: '8.8.8.8' }], { operation: 'recover', requestImpl: () => assert.fail('forbidden request') });
  for (const [route, method] of [['prompt', 'POST'], ['upload/image', 'POST'], ['queue', 'POST'], ['interrupt', 'POST'], ['history', 'GET'], ['system_stats', 'GET'], ['queue?x=1', 'GET']]) await assert.rejects(fetcher(`https://comfy.test/api/${route}`, { method }), { code: 'comfy_transport_target_changed' });
});

test('failed initial collection recovers by owned durable receipt, survives restart, caches and acknowledges without deleting its ledger', async t => {
  const f = await fixture(t), service = f.create(), request = input();
  await assert.rejects(service.submit(account(), request), error => error.submissionState === 'accepted');
  const query = { ...binding(), ...connection };
  assert.equal((await service.query(account(), query)).task.recoverable, true);
  await service.close(); f.allowCollection(); const next = f.create();
  const recovered = await next.result(account(), { ...query, upstreamId: 'forged-id', comfyReceipt: { outputNodeIds: ['evil'] } });
  assert.equal(recovered.upstreamId, 'original-id'); assert.equal(recovered.comfyTask.resultStored, true);
  assert.equal((await next.query(account(), query)).task.status, 'succeeded');
  const count = f.calls.length;
  const cached = await next.result(account(), query); assert.equal(cached.images[0].data, png); assert.equal(f.calls.length, count);
  assert.equal(f.calls.filter(([, method]) => method === 'POST').length, 1);
  await assert.rejects(next.acknowledge(account(), { ...query, archived: true, receipt: 'a'.repeat(64) }));
  const removed = await next.acknowledge(account(), { ...query, archived: true, receipt: cached.comfyTask.receipt }); assert.ok(removed.bytes > 0);
  const after = (await next.query(account(), query)).task; assert.equal(after.status, 'succeeded'); assert.equal(after.resultStored, false); assert.equal(after.upstreamId, 'original-id');
  await assert.rejects(next.submit(account(), request), { code: 'comfy_queue_already_exists' });
});

test('wrong account or root cannot obtain an original; a revoked target blocks uncached recovery before GET', async t => {
  const f = await fixture(t), service = f.create(); await assert.rejects(service.submit(account(), input())); f.allowCollection();
  const count = f.calls.length;
  await assert.rejects(service.result(account('bob'), { ...binding('bob'), ...connection }), { code: 'comfy_queue_missing' });
  await assert.rejects(service.result(account(), { ...binding(), baseUrl: 'https://different.test' }), { code: 'comfy_queue_missing' });
  const revoked = f.create({ prepareTransport: async () => { throw Object.assign(Error('revoked'), { code: 'comfy_targets_revoked' }); } });
  await assert.rejects(revoked.result(account(), { ...binding(), ...connection }), { code: 'comfy_targets_revoked' }); assert.equal(f.calls.length, count);
});

test('malformed or oversized queue payloads never become an invented missing task', async () => {
  for (const queue of [{ queue_running: [], queue_pending: null }, { queue_running: Array(4097).fill([]), queue_pending: [] }, 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    await assert.rejects(recoverComfyImage(connection, 'original-id', receipt(), { prepareComfyTransport: async () => ({ base: new URL(connection.baseUrl), verify: async () => {}, fetchImpl: async url => new URL(url).pathname.endsWith('/queue') ? json(queue) : json({}) }) }));
  }
});

test('browser acknowledgement happens only for the matching archived result and sends no Key', async () => {
  const job = { id: 'original-attempt', source: 'comfy', connection, imageAdmission: { version: 1, namespace: 'st-user:alice', attemptId: 'original-attempt' } };
  const data = { comfyTask: { version: 1, attemptId: job.id, resultStored: true, receipt: 'a'.repeat(64) } }; let calls = 0;
  const options = { account: async () => 'st-user:alice', fetchImpl: async (url, init) => { calls++; assert.ok(url.endsWith('/acknowledge')); const body = JSON.parse(init.body);
    assert.equal(body.archived, true); assert.equal(body.attemptId, job.id); assert.ok(!init.body.includes('test-only-secret')); return json({ ok: true }); } };
  assert.equal(await acknowledgeComfyImage(job, data, options), ''); assert.equal(calls, 1);
  assert.notEqual(await acknowledgeComfyImage(job, data, { ...options, account: async () => 'st-user:bob' }), ''); assert.equal(calls, 1);
  assert.equal(await acknowledgeComfyImage(job, { comfyTask: { resultStored: false } }, options), ''); assert.equal(calls, 1);
});

test('an explicit native execution error preserves failed history, frees empty cache and permits a new attempt, not replay', async t => {
  const f = await fixture(t); let posts = 0;
  const service = f.create({ prepareTransport: async () => ({ base: new URL(connection.baseUrl), verify: async () => {}, fetchImpl: async (url, init) => {
    if (init.method === 'POST') { posts++; return json({ prompt_id: 'original-id' }); }
    return json(ready({ status: { status_str: 'error', completed: false } }));
  } }) });
  await assert.rejects(service.submit(account(), input()), { code: 'comfy_execution_failed', submissionState: 'accepted' });
  const row = (await service.query(account(), { ...binding(), ...connection })).task;
  assert.equal(row.status, 'failed'); assert.equal(row.upstreamId, 'original-id'); assert.equal(row.cacheReceipt, undefined);
  await assert.rejects(service.submit(account(), input()), { code: 'comfy_queue_already_exists' }); assert.equal(posts, 1);
  await assert.rejects(service.submit(account(), { ...input(), comfyQueue: { ...binding(), attemptId: 'new-attempt' } }), { code: 'comfy_execution_failed' });
  assert.equal(posts, 2); assert.deepEqual(await fs.readdir(path.join(f.root, '.qianmu-service', 'comfy-results-v1')), []);
});

test('missing legacy output receipts and cache reservation failures never cause another provider submission', async t => {
  const f = await fixture(t);
  const legacy = f.create({ generate: async (_, hooks) => { await hooks.beforeSubmit(); await hooks.onComfyAccepted('original-id'); throw Object.assign(Error('old response lost'), { submissionState: 'accepted' }); } });
  await assert.rejects(legacy.submit(account(), input()));
  await assert.rejects(legacy.result(account(), { ...binding(), ...connection }), { code: 'comfy_queue_receipt_missing' }); assert.equal(f.calls.length, 0);
  const full = f.create({ results: { reserve: async () => { throw Object.assign(Error('full'), { code: 'image_service_result_full', submissionState: 'not_submitted' }); }, load: async () => null }, generate: () => assert.fail('no GPU on full cache') });
  await assert.rejects(full.submit(account(), { ...input(), baseUrl: 'https://separate.test' }), { code: 'image_service_result_full', submissionState: 'not_submitted' });
});

const runJob = storyboardFunctionSource('storyboardRunJob');
const deliveryStart = runJob.indexOf("    if (job.source === 'comfy' && data.comfyTask?.version === 1)");
const deliveryBlock = runJob.slice(deliveryStart, runJob.indexOf('  } catch (error) {', deliveryStart));
assert.ok(deliveryStart > 0 && deliveryBlock.includes('runtime.deliver'));
for (const archived of [true, false]) test(`actual Comfy delivery ${archived ? 'acknowledges only after durable archive' : 'retains server cache and accepted state when archive is incomplete'}`, async () => {
  const calls = [], job = { source: 'comfy' };
  const context = vm.createContext({ job, log: {}, data: { comfyTask: { version: 1 } }, storyboardRequestHeaders() {}, toast() {},
    storyboardComfyRecoveryRuntime: async () => ({ deliver: async (value, data, deliver) => {
      assert.equal(value, job); const saved = await deliver(data, [], async () => {}, async () => calls.push('guard'));
      if (saved) calls.push('acknowledge'); return { archived: saved };
    } }),
    storyboardDeliverGatewayResult: async (_job, _log, _data, options) => { assert.equal(options.service, true); assert.equal(options.archiveFiles.length, 0); assert.equal(typeof options.checkpoint, 'function'); await options.guard(); calls.push('archive'); return archived; },
  });
  vm.runInContext(`async function run() { let admissionOutcome = 'accepted'; ${deliveryBlock} return admissionOutcome; }`, context);
  assert.equal(await context.run(), archived ? 'succeeded' : 'accepted');
  assert.deepEqual(calls, archived ? ['guard', 'archive', 'acknowledge'] : ['guard', 'archive']);
});
