import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Writable, PassThrough } from 'node:stream';
import { createComfyTargetStore, comfyTargetId } from '../qianmu-comfy-target-store.js';
import { createComfyTargets } from '../qianmu-comfy-targets.js';
import { requestComfyTargets, requireTrustedComfyConnection } from '../qianmu-comfy-targets-view.js';
import { init } from '../server-plugin.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';

const admin = () => ({ user: { profile: { handle: 'alice', enabled: true, admin: true } } });
const user = () => ({ user: { profile: { handle: 'bob', enabled: true, admin: false } } });
const trust = (revision = 0, extra = {}) => ({ action: 'trust', expectedRevision: revision, baseUrl: 'https://comfy.test/api', name: '我的 Comfy', allowPrivateNetwork: false, shared: false, ...extra });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-targets-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(tmpdir())); assert.ok(path.basename(dir).startsWith('qianmu-comfy-targets-')); await fs.rm(dir, { recursive: true, force: true }); });
  const store = createComfyTargetStore({ dataRoot: dir }); return { dir, store, service: createComfyTargets({ store }) };
}
const response = () => ({ statusCode: 200, headers: {}, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('opening a fresh registry is read-only; explicit trust persists under ST data, without keys or user supplied paths', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.service.list(admin())).targets, []); assert.deepEqual(await fs.readdir(f.dir), []);
  const result = await f.service.change(admin(), trust(0, { apiKey: 'must-not-persist', dataRoot: 'elsewhere', namespace: 'other-account' }));
  assert.equal(result.revision, 1); assert.equal(result.targets[0].baseUrl, 'https://comfy.test/api');
  const text = await fs.readFile(path.join(f.dir, '.qianmu-service/comfy-targets-v1/registry.json'), 'utf8');
  assert.ok(!/must-not-persist|elsewhere|other-account/.test(text));
  const restarted = createComfyTargets({ store: createComfyTargetStore({ dataRoot: f.dir }) });
  assert.deepEqual(await restarted.list(admin()), result); await (await restarted.acquire(admin(), trust()))();
});

test('non-administrators cannot register, revoke, view or use admin-only targets; explicit shared public grant enables only its exact root', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.change(user(), trust()), { status: 403 });
  await service.change(admin(), trust());
  assert.deepEqual((await service.list(user())).targets, []);
  await assert.rejects(service.acquire(user(), trust()), { code: 'comfy_targets_untrusted' });
  const shared = await service.change(admin(), trust(1, { shared: true }));
  assert.equal((await service.list(user())).targets.length, 1); await (await service.acquire(user(), trust()))();
  for (const baseUrl of ['https://comfy.test', 'https://comfy.test/api/child', 'https://other.test/api']) await assert.rejects(service.acquire(user(), { baseUrl }), { code: 'comfy_targets_untrusted' });
  await assert.rejects(service.change(user(), { action: 'revoke', expectedRevision: shared.revision, id: shared.targets[0].id }), { status: 403 });
});

test('private grants remain administrator-only and different from the public permission flag', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.change(admin(), trust(0, { allowPrivateNetwork: true, shared: true })), { code: 'comfy_targets_private_share' });
  await service.change(admin(), trust(0, { baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }));
  await assert.rejects(service.acquire(admin(), { baseUrl: 'http://127.0.0.1:8188' }), { code: 'comfy_targets_untrusted' });
  await assert.rejects(service.acquire(user(), { baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }), { code: 'comfy_targets_untrusted' });
  await (await service.acquire(admin(), { baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }))();
});

test('revocation and re-trust invalidate an existing operation even if the address is the same', async t => {
  const { service } = await fixture(t); const saved = await service.change(admin(), trust());
  const verify = await service.acquire(admin(), trust());
  await service.change(admin(), { action: 'revoke', expectedRevision: 1, id: saved.targets[0].id });
  await assert.rejects(verify(), { code: 'comfy_targets_revoked' });
  await service.change(admin(), trust(2)); await assert.rejects(verify(), { code: 'comfy_targets_revoked' });
  await (await service.acquire(admin(), trust()))();
});

test('stale page revisions and concurrent processes cannot overwrite a newer grant', async t => {
  const { dir, service } = await fixture(t); await service.change(admin(), trust());
  await assert.rejects(service.change(admin(), trust(0, { name: 'stale' })), { code: 'comfy_targets_revision' });
  const second = createComfyTargets({ store: createComfyTargetStore({ dataRoot: dir }) });
  const results = await Promise.allSettled([service.change(admin(), trust(1, { name: 'one' })), second.change(admin(), trust(1, { name: 'two' }))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal((await service.list(admin())).revision, 2);
});

test('corrupt, oversized or hard-linked registry files never become an empty permission registry', async t => {
  for (const mode of ['corrupt', 'oversized', 'hardlink']) {
    const f = await fixture(t); await f.service.change(admin(), trust()); const file = path.join(f.dir, '.qianmu-service/comfy-targets-v1/registry.json');
    if (mode === 'corrupt') await fs.writeFile(file, '{}');
    if (mode === 'oversized') await fs.writeFile(file, 'a'.repeat(65537));
    if (mode === 'hardlink') await fs.link(file, path.join(f.dir, 'linked.json'));
    await assert.rejects(f.service.list(admin())); await assert.rejects(f.service.acquire(admin(), trust())); await assert.rejects(f.service.change(admin(), trust()));
  }
});

test('unfinished lock is not automatically broken, and admin/account changes cannot mutate another account intent', async t => {
  const f = await fixture(t); await f.service.change(admin(), trust());
  await fs.writeFile(path.join(f.dir, '.qianmu-service/comfy-targets-v1/.lock'), 'original');
  await assert.rejects(f.service.change(admin(), trust(1)), { code: 'comfy_targets_busy' });
  const req = admin(), service = createComfyTargets({ store: { update: async (_, change) => { req.user.profile.admin = false; return change([]); } } });
  await assert.rejects(service.change(req, trust()), { code: 'comfy_targets_admin' });
});

test('read and revoke freeze the originally chosen target, not a changed pending request body', async t => {
  const f = await fixture(t); const first = await f.service.change(admin(), trust());
  await f.service.change(admin(), trust(1, { baseUrl: 'https://second.test' }));
  const input = { action: 'revoke', expectedRevision: 2, id: first.targets[0].id };
  const service = createComfyTargets({ store: { ...f.store, update: async (revision, change) => {
    input.id = comfyTargetId('https://second.test', false); return f.store.update(revision, change);
  } } });
  const result = await service.change(admin(), input); assert.deepEqual(result.targets.map(row => row.baseUrl), ['https://second.test']);
});

test('installed routes persist trust, reject before DNS, and stop polling a task revoked after its accepted prompt', async t => {
  const f = await fixture(t), routes = new Map(), calls = []; let revoke, resolutions = 0;
  await init({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) }, { dataRoot: f.dir, comfyTransportOptions: {
    resolveHost: async () => { resolutions++; return [{ address: '8.8.8.8' }]; }, requestImpl: (url, _, callback) => new Writable({ write(_chunk, _encoding, done) { done(); },
      final(done) { calls.push(url.pathname); const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' };
        callback(incoming); incoming.end(JSON.stringify({ prompt_id: 'original-only' })); void revoke?.(); done(); },
    }),
  } });
  const body = { provider: 'comfy', baseUrl: trust().baseUrl, prompt: 'test',
    comfyQueue: { version: 1, attemptId: 'trusted-attempt', expectedAccount: imageServiceAccount(admin()).namespace, automatic: false },
    comfyExecution: { version: 1, automatic: false, outputNodeIds: ['save'], maxImages: 1, allowUnverified: false },
    parameters: { pollIntervalMs: 250, workflow: { a: { class_type: 'EmptyImage', inputs: { text: '%qianmu_prompt%', batch_size: 1 } }, save: { class_type: 'SaveImage', inputs: { images: ['a', 0] } } } } };
  for (const path of ['check', 'models', 'generate']) { const res = response(); await routes.get(`POST /image/${path}`)({ ...admin(), body }, res); assert.equal(res.body.code, 'comfy_targets_untrusted'); }
  assert.deepEqual(calls, []); assert.equal(resolutions, 0);
  const save = response(); await routes.get('POST /image/comfy/targets')({ ...admin(), body: trust() }, save);
  assert.equal(save.body.revision, 1); assert.equal(save.headers['cache-control'], 'no-store');
  revoke = () => f.service.change(admin(), { action: 'revoke', expectedRevision: 1, id: save.body.targets[0].id });
  const generated = response(); await routes.get('POST /image/generate')({ ...admin(), body }, generated);
  assert.deepEqual(calls, ['/api/prompt']); assert.equal(generated.body.submissionState, 'accepted'); assert.equal(generated.body.upstreamId, 'original-only');
  assert.equal(generated.body.code, 'comfy_targets_revoked');
  const queried = response(); await routes.get('POST /image/comfy/tasks/query')({ ...admin(), body: { ...body.comfyQueue, baseUrl: body.baseUrl } }, queried);
  assert.equal(queried.body.task.upstreamId, 'original-only'); assert.equal(queried.body.task.status, 'uncertain');
  const foreign = response(); await routes.get('POST /image/comfy/tasks/query')({ ...user(), body: { ...body.comfyQueue, expectedAccount: imageServiceAccount(user()).namespace, baseUrl: body.baseUrl } }, foreign);
  assert.equal(foreign.body.task, null); assert.deepEqual(calls, ['/api/prompt'], 'local receipt queries never read remote history or resubmit');
  const anonymous = response(); await routes.get('GET /image/comfy/targets')({}, anonymous); assert.equal(anonymous.statusCode, 401);
});

test('trusted registry refuses junction directories and host roots supplied outside a valid absolute data directory', async t => {
  for (const dataRoot of ['', 'relative', path.parse(path.resolve(tmpdir())).root, 'C:\\bad\0path']) assert.throws(() => createComfyTargetStore({ dataRoot }));
  const f = await fixture(t), other = path.join(f.dir, 'other'); await fs.mkdir(other);
  await fs.symlink(other, path.join(f.dir, '.qianmu-service'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.list(admin()), { code: 'comfy_targets_path' });
  await assert.rejects(f.service.change(admin(), trust()), { code: 'comfy_targets_path' });
  assert.deepEqual(await fs.readdir(other), []);
});

test('registry has a hard capacity and does not evict a previously trusted address to make room', async t => {
  const f = await fixture(t);
  const first = await f.service.change(admin(), trust());
  const seed = (await f.store.read()).targets[0];
  await f.store.update(first.revision, () => Array.from({ length: 64 }, (_, i) => {
    const baseUrl = `https://comfy-${i}.test`; return { ...seed, baseUrl, id: comfyTargetId(baseUrl, false) };
  }));
  await assert.rejects(f.service.change(admin(), trust(2)), { code: 'comfy_targets_full' });
  const saved = await f.service.list(admin()); assert.equal(saved.revision, 2); assert.equal(saved.targets.length, 64);
});

test('client preflight requests only ST registry and never transmits model credentials', async () => {
  const row = { id: comfyTargetId('https://comfy.test/api', false), name: 'mine', baseUrl: 'https://comfy.test/api', shared: false, allowPrivateNetwork: false };
  let count = 0;
  const options = { headers: () => ({ 'X-CSRF-Token': 'st-csrf' }), fetchImpl: async (url, init) => {
    count++; assert.equal(url, '/api/plugins/qianmu-tts/image/comfy/targets'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.headers['X-CSRF-Token'], 'st-csrf');
    assert.ok(!JSON.stringify(init).includes('image-secret')); return json({ ok: true, schemaVersion: 1, admin: true, revision: 1, targets: [row] });
  } };
  await requireTrustedComfyConnection({ baseUrl: row.baseUrl + '/', apiKey: 'image-secret', options: {} }, options);
  await assert.rejects(requireTrustedComfyConnection({ baseUrl: 'https://different.test' }, options), /管理员登记/); assert.equal(count, 2);
});

test('client rejects old service, wrong schemas, oversized streaming data and lost connection context', async () => {
  await assert.rejects(requestComfyTargets({ fetchImpl: async () => new Response('', { status: 404 }) }), /更新增强服务/);
  await assert.rejects(requestComfyTargets({ fetchImpl: async () => json({ ok: true, schemaVersion: 9 }) }), /版本不兼容/);
  await assert.rejects(requestComfyTargets({ fetchImpl: async () => new Response('a'.repeat(131073)) }), /返回过大/);
  await assert.rejects(requireTrustedComfyConnection({ baseUrl: 'https://comfy.test' }, { fetchImpl: async () => json({ ok: true, schemaVersion: 1, admin: true, revision: 0, targets: [] }), assertCurrent() { throw Error('changed'); } }), /changed/);
});
