import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createComfyService, comfyInstanceResource } from '../qianmu-comfy-service.js';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { imageServiceChannelKey, normalizeImageServiceChannel } from '../qianmu-image-service-queue.js';
import { prepareComfySubmission } from '../qianmu-comfy-submission.js';
import { generateImage } from '../qianmu-image-gateway.js';

const req = (handle = 'alice') => ({ user: { profile: { handle, enabled: true, admin: true } } });
const binding = (attemptId = 'first', handle = 'alice') => ({ version: 1, attemptId, expectedAccount: imageServiceAccount(req(handle)).namespace, automatic: false });
const policy = { version: 1, automatic: false, outputNodeIds: ['save'], maxImages: 1, allowUnverified: false };
const input = (attemptId = 'first', extra = {}, handle = 'alice') => ({ provider: 'comfy', apiKey: 'test-key', baseUrl: 'https://comfy.test/api', prompt: 'private-test-prompt',
  comfyQueue: binding(attemptId, handle), comfyExecution: policy,
  parameters: { pollIntervalMs: 250, workflow: { image: { class_type: 'EmptyImage', inputs: { batch_size: 1, text: '%qianmu_prompt%' } }, save: { class_type: 'SaveImage', inputs: { images: ['image', 0] } } } }, ...extra });
const lookup = (attemptId = 'first', baseUrl = 'https://comfy.test/api', handle = 'alice') => ({ ...binding(attemptId, handle), baseUrl });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const result = { ok: true, provider: 'comfy', images: [{ data: 'test' }], upstreamId: 'original' };
async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-service-'));
  const stores = [], services = [];
  const store = () => { const value = createImageServiceStore({ dataRoot: dir, scope: 'comfy' }); stores.push(value); return value; };
  const service = options => {
    const value = createComfyService({ dataRoot: dir, store: store(), authorizeTarget: async () => async () => {}, prepareTransport: async () => assert.fail('unexpected network'),
      generate: async (_, hooks) => { await hooks.beforeSubmit(); await hooks.onComfyAccepted('original'); return result; }, ...extra, ...options });
    services.push(value); return value;
  };
  t.after(async () => {
    await Promise.allSettled(services.map(value => value.close())); await Promise.allSettled(stores.map(value => value.close()));
    assert.equal(path.dirname(dir), path.resolve(tmpdir())); assert.ok(path.basename(dir).startsWith('qianmu-comfy-service-')); await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, store, service };
}

test('Comfy instance identity uses canonical API roots, not Key, permissions or guessed aliases', () => {
  assert.equal(comfyInstanceResource('https://COMFY.test:443/api/'), comfyInstanceResource('https://comfy.test/api'));
  for (const root of ['https://comfy.test', 'https://comfy.test:444/api', 'https://alias.test/api', 'https://comfy.test/other']) assert.notEqual(comfyInstanceResource(root), comfyInstanceResource('https://comfy.test/api'));
});

test('same instance serializes different accounts and Keys and saves only bounded receipts in an isolated durable scope', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred(), calls = [];
  const service = f.service({ generate: async (body, hooks) => {
    calls.push(body.apiKey); await hooks.beforeSubmit(); await hooks.onComfyAccepted(`id-${calls.length}`);
    if (calls.length === 1) { started.resolve(); await finish.promise; } return result;
  } });
  const first = service.submit(req(), input()); await started.promise;
  const second = service.submit(req('bob'), input('second', { apiKey: '' }, 'bob'));
  await new Promise(resolve => setTimeout(resolve, 25)); assert.deepEqual(calls, ['test-key']);
  const pending = await service.query(req(), lookup()); assert.equal(pending.task.upstreamId, 'id-1'); assert.equal(pending.task.status, 'submitting');
  assert.equal((await service.query(req('bob'), lookup('first', undefined, 'bob'))).task, null);
  finish.resolve(); await Promise.all([first, second]); assert.deepEqual(calls, ['test-key', '']);
  const disk = path.join(f.dir, '.qianmu-service'); assert.deepEqual((await fs.readdir(disk)).sort(), ['comfy-queue-v1', 'comfy-results-v1']);
  const records = await fs.readdir(path.join(disk, 'comfy-queue-v1'));
  const contents = await fs.readFile(path.join(disk, 'comfy-queue-v1', records[0]), 'utf8');
  assert.ok(contents.includes('id-1')); assert.ok(!contents.includes('test-key') && !contents.includes('private-test-prompt') && !contents.includes('workflow'));
});

test('separate registered API roots can progress independently within the bounded global queue', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred();
  const service = f.service({ generate: async (body, hooks) => { await hooks.beforeSubmit(); await hooks.onComfyAccepted('original');
    if (body.baseUrl.endsWith('/api')) { started.resolve(); await finish.promise; } return result; } });
  const first = service.submit(req(), input()); await started.promise;
  assert.equal((await service.submit(req(), input('second', { baseUrl: 'https://comfy.test/other' }))).ok, true);
  finish.resolve(); await first;
});

test('repeated or mutated attempts never submit again, including after service restart', async t => {
  const f = await fixture(t); let count = 0;
  const options = { generate: async (_, hooks) => { count++; await hooks.beforeSubmit(); await hooks.onComfyAccepted('remote-original'); return result; } };
  const service = f.service(options); await service.submit(req(), input());
  for (const change of [{}, { apiKey: 'changed' }, { prompt: 'changed' }]) await assert.rejects(service.submit(req(), input('first', change)), error => error.upstreamId === 'remote-original' && error.submissionState === 'accepted');
  await service.close(); const restarted = f.service(options);
  assert.equal((await restarted.query(req(), lookup())).task.upstreamId, 'remote-original');
  await assert.rejects(restarted.submit(req(), input()), { code: 'comfy_queue_already_exists' }); assert.equal(count, 1);
});

test('uncertain original tasks stop subsequent automatic and manual submission without acknowledgement by guessing', async t => {
  const f = await fixture(t); let count = 0;
  const service = f.service({ generate: async (_, hooks) => { count++; await hooks.beforeSubmit(); await hooks.onComfyAccepted('accepted');
    throw Object.assign(Error('lost response'), { submissionState: 'accepted' }); } });
  await assert.rejects(service.submit(req(), input())); assert.equal((await service.query(req(), lookup())).task.status, 'uncertain');
  for (const automatic of [false, true]) await assert.rejects(service.submit(req(), input('next', { comfyQueue: { ...binding('next'), automatic, confirmation: 'fake' }, comfyExecution: { ...policy, automatic } })), { code: 'image_service_confirmation_required' });
  assert.equal(count, 1);
});

test('disconnect cancels only waiting work; accepted work finishes and retains its receipt', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred(), controller = new AbortController(), waiting = new AbortController(); let count = 0;
  const service = f.service({ generate: async (_, hooks) => { count++; await hooks.beforeSubmit(); await hooks.onComfyAccepted('accepted'); started.resolve(); await finish.promise; return result; } });
  const first = service.submit(req(), input(), { signal: controller.signal }); await started.promise;
  const second = service.submit(req(), input('second'), { signal: waiting.signal }); const rejected = assert.rejects(second, { code: 'image_service_cancelled' });
  await new Promise(resolve => setTimeout(resolve, 25)); waiting.abort(); controller.abort(); finish.resolve();
  await rejected; assert.equal((await first).ok, true); assert.equal(count, 1); assert.equal((await service.query(req(), lookup())).task.status, 'succeeded');
});

test('disabled or mismatching ST identity, missing contracts and untrusted targets never authorize writes', async t => {
  const f = await fixture(t), service = f.service({ generate: () => assert.fail('generation'), authorizeTarget: async () => { throw Object.assign(Error('not trusted'), { code: 'comfy_targets_untrusted', status: 403, submissionState: 'not_submitted' }); } });
  await assert.rejects(service.submit({}, input()), { code: 'image_service_authentication_required' });
  await assert.rejects(service.submit(req('bob'), input()), { code: 'comfy_queue_binding' });
  await assert.rejects(service.submit(req(), input('first', { comfyQueue: undefined })), { code: 'comfy_queue_binding' });
  await assert.rejects(service.submit(req(), input('first', { comfyExecution: undefined })), { code: 'comfy_execution_contract' });
  await assert.rejects(service.submit(req(), input()), { code: 'comfy_targets_untrusted' }); assert.deepEqual(await fs.readdir(f.dir), []);
});

test('configuration is frozen before delayed authorization; changed account and revoked queued grants stop before provider IO', async t => {
  const f = await fixture(t), permit = deferred(), arrived = deferred(); let seen;
  const service = f.service({ authorizeTarget: async () => { arrived.resolve(); await permit.promise; return async () => {}; },
    generate: async (body, hooks) => { seen = body; await hooks.beforeSubmit(); return result; } });
  const body = input(), first = service.submit(req(), body); await arrived.promise; body.prompt = 'changed'; body.parameters.workflow.image.inputs.text = 'changed'; permit.resolve(); await first;
  assert.equal(seen.prompt, 'private-test-prompt'); assert.equal(seen.parameters.workflow.image.inputs.text, '%qianmu_prompt%');
  const live = req(), gate = deferred();
  const revoked = f.service({ authorizeTarget: async () => { await gate.promise; return async () => {}; }, generate: () => assert.fail('changed account generation') });
  const work = revoked.submit(live, input('other')); live.user.profile.handle = 'bob'; gate.resolve(); await assert.rejects(work, { code: 'comfy_queue_account' });
});

test('another service process cannot steal a persistent in-flight instance slot', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred();
  const firstService = f.service({ generate: async (_, hooks) => { await hooks.beforeSubmit(); await hooks.onComfyAccepted('original'); started.resolve(); await finish.promise; return result; } });
  const work = firstService.submit(req(), input()); await started.promise;
  const other = f.service({ generate: () => assert.fail('concurrent provider execution') });
  await assert.rejects(other.submit(req(), input('other')), { code: 'image_service_busy' });
  finish.resolve(); await work;
});

test('accepted task persistence precedes history; receipt failure preserves acceptance and never repeats prompt', async t => {
  const f = await fixture(t), calls = [], store = f.store();
  const service = f.service({ store: { ...store, transaction: (key, reduce) => store.transaction(key, state => { const result = reduce(state); if (result.state.entries.some(row => row.upstreamId)) throw Error('disk fault'); return result; }) },
    generate: generateImage, prepareTransport: async () => ({ base: new URL('https://comfy.test/api'), verify: async () => {}, fetchImpl: async (url, init) => {
      calls.push([new URL(url).pathname, init.method]); return new Response(JSON.stringify({ prompt_id: 'original-id' }));
    } }),
  });
  await assert.rejects(service.submit(req(), input()), error => error.upstreamId === 'original-id' && error.submissionState === 'accepted');
  assert.deepEqual(calls, [['/api/prompt', 'POST']]);
  assert.equal((await service.query(req(), lookup())).task.status, 'uncertain');
});

test('store scopes are a closed host choice and never move existing NAI records', async t => {
  const f = await fixture(t);
  for (const scope of ['../other', 'all', '', null]) assert.throws(() => createImageServiceStore({ dataRoot: f.dir, scope }));
  const novel = createImageServiceStore({ dataRoot: f.dir }); t.after(() => novel.close());
  const key = imageServiceChannelKey('nai-key'); await novel.transaction(key, state => ({ state: normalizeImageServiceChannel(state, key), result: null }));
  await f.service().submit(req(), input());
  assert.deepEqual((await fs.readdir(path.join(f.dir, '.qianmu-service'))).sort(), ['comfy-queue-v1', 'comfy-results-v1', 'image-queue-v1']);
});

test('lazy browser binding uses the original attempt and the actual ST account, never a fresh retry id', async () => {
  const job = { id: 'job-1', source: 'comfy', automatic: true, imageAdmission: { version: 1, namespace: 'st-user:alice', attemptId: 'job-1' } };
  const result = await prepareComfySubmission(job, { account: async () => 'st-user:alice' });
  assert.deepEqual(result, { ...binding('job-1'), automatic: true });
  assert.equal(result.expectedAccount, `st-user:${createHash('sha256').update('alice').digest('hex')}`);
  for (const bad of [{ ...job, id: 'other' }, { ...job, imageAdmission: undefined }, { ...job, source: 'novel' }]) await assert.rejects(prepareComfySubmission(bad, { account: async () => 'st-user:alice' }));
  let reads = 0; await assert.rejects(prepareComfySubmission(job, { account: async () => ++reads === 1 ? 'st-user:alice' : 'st-user:bob' }));
});

test('receipt cannot be recorded before dispatch, replaced, or used to authorize a second provider write', async t => {
  const f = await fixture(t);
  const service = f.service({ generate: async (_, hooks) => {
    await assert.rejects(hooks.onComfyAccepted('too-early'));
    await hooks.beforeSubmit(); await assert.rejects(hooks.onComfyAccepted('../wrong'));
    await hooks.onComfyAccepted('original'); await hooks.onComfyAccepted('original');
    await assert.rejects(hooks.onComfyAccepted('replacement'));
    await assert.rejects(hooks.beforeSubmit(), { code: 'image_service_already_submitted' });
    return result;
  } });
  await service.submit(req(), input()); assert.equal((await service.query(req(), lookup())).task.upstreamId, 'original');
});

test('queued grants are rechecked, and a revoked grant never enters provider generation', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred(); let revoked = false, calls = 0;
  const service = f.service({ authorizeTarget: async () => async () => { if (revoked) throw Object.assign(Error('revoked'), { code: 'comfy_targets_revoked', submissionState: 'not_submitted' }); },
    generate: async (_, hooks) => { calls++; await hooks.beforeSubmit(); await hooks.onComfyAccepted('original'); started.resolve(); await finish.promise; return result; } });
  const first = service.submit(req(), input()); await started.promise;
  const second = service.submit(req(), input('second')); const rejected = assert.rejects(second, { code: 'comfy_targets_revoked' });
  await new Promise(resolve => setTimeout(resolve, 25)); revoked = true; finish.resolve(); await first; await rejected;
  assert.equal(calls, 1); assert.equal((await service.query(req(), lookup('second'))).task.status, 'released');
});
