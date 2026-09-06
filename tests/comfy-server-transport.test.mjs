import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createComfyServerTransport, pinnedComfyFetch } from '../qianmu-comfy-server-transport.js';
import { init, exit } from '../server-plugin.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { comfyTargetId } from '../qianmu-comfy-target-store.js';

const account = (admin = false) => ({ user: { profile: { handle: 'alice', enabled: true, admin } } });
const workflow = (refs = false) => ({ '1': { class_type: 'FixtureOutput', inputs: { text: '%qianmu_prompt%', ...(refs ? { refs: '%qianmu_references%' } : {}) } }, save: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } });
const input = (extra = {}) => ({ provider: 'comfy', baseUrl: 'https://comfy.test/api', apiKey: 'test-only-secret', model: 'workflow', prompt: 'rain',
  comfyQueue: { version: 1, attemptId: 'fixture-attempt', expectedAccount: imageServiceAccount(account()).namespace, automatic: false },
  comfyExecution: { version: 1, automatic: false, outputNodeIds: ['save'], maxImages: 1, allowUnverified: true },
  parameters: { pollIntervalMs: 250, workflow: workflow() }, ...extra });
const roots = [];
after(async () => { await exit(); for (const root of roots) { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('qianmu-comfy-routes-')); await fs.rm(root, { recursive: true, force: true }); } });
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
function mockNodeRequest(calls, respond = () => ({ body: {} })) {
  return (url, options, callback) => {
    const chunks = [], call = { url: new URL(url), options }; calls.push(call);
    return new Writable({
      write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        call.body = Buffer.concat(chunks); const result = respond(call);
        const incoming = new PassThrough(); incoming.statusCode = result.status || 200;
        incoming.headers = result.headers || { 'content-type': 'application/json' };
        callback(incoming); incoming.end(Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body || {})); done();
      },
    });
  };
}
const response = () => ({ statusCode: 200, headers: {}, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } });
async function routes(options = {}) {
  const handlers = new Map();
  const dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-routes-')); roots.push(dataRoot);
  const comfyTargetStore = { read: async () => ({ schemaVersion: 1, revision: 1, targets: [
    ['https://comfy.test/api', false], ['http://127.0.0.1:8188', true],
  ].map(([baseUrl, allowPrivateNetwork]) => ({ id: comfyTargetId(baseUrl, allowPrivateNetwork), baseUrl, allowPrivateNetwork, shared: !allowPrivateNetwork, name: 'Approved fixture', grantId: '00000000-0000-4000-8000-000000000000', updatedAt: 0 })) }) };
  await init({ get: (path, handler) => handlers.set(`GET ${path}`, handler), post: (path, handler) => handlers.set(`POST ${path}`, handler) }, { dataRoot, comfyTransportOptions: options, comfyTargetStore });
  return handlers;
}

test('every installed Comfy gateway operation requires ST identity and private administrator opt-in before DNS', async () => {
  const handlers = await routes({ resolveHost: () => assert.fail('unauthorized DNS'), requestImpl: () => assert.fail('unauthorized request') });
  for (const path of ['check', 'models', 'generate']) {
    for (const [req, body, status] of [[{}, input(), 401], [account(false), input({ allowPrivateNetwork: true }), 403]]) {
      const res = response(); await handlers.get(`POST /image/${path}`)({ ...req, body }, res);
      assert.equal(res.statusCode, status); assert.match(res.body.code, path === 'generate' && status === 403 ? /^comfy_targets_/ : /^comfy_transport_/); assert.equal(res.headers['cache-control'], 'no-store');
      if (path === 'generate') assert.equal(res.body.submissionState, 'not_submitted');
    }
  }
});

test('invalid protocol, root path, graph and DNS answers never open a socket', async () => {
  const denied = { operation: 'check', resolveHost: () => assert.fail('invalid URL DNS'), requestImpl: () => assert.fail('socket') };
  for (const baseUrl of ['file:///etc/passwd', 'https://a.test/api/../b', 'https://a.test/%2e%2e/b', 'https://a.test/api//b', 'https://a.test/api%2fb',
    'https://user:pass@a.test', 'https://a.test?a=b', 'https://a.test/#x', 'https://a.test/\\api', 'http://a.test', 'https://a.test/ api']) {
    await assert.rejects(createComfyServerTransport(account(), input({ baseUrl }), denied));
  }
  for (const addresses of [[], Array(33).fill({ address: '8.8.8.8' }), [{ address: 'junk' }], [{ address: '8.8.8.8', family: 6 }]]) {
    await assert.rejects(createComfyServerTransport(account(), input(), { operation: 'check', resolveHost: async () => addresses }), { code: 'comfy_transport_address' });
  }
  const handlers = await routes(denied), res = response();
  await handlers.get('POST /image/generate')({ ...account(), body: input({ parameters: { workflow: {} } }) }, res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.submissionState, 'not_submitted');
});

test('private opt-in never permits link-local, unspecified, multicast or IPv6 translation targets', async () => {
  for (const address of ['0.0.0.0', '169.254.169.254', '224.0.0.1', '::', '0:0:0:0:0:0:0:0', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    await assert.rejects(createComfyServerTransport(account(true), input({ allowPrivateNetwork: true }), { resolveHost: async () => [{ address }] }), { code: 'comfy_transport_unsafe_target' });
  }
  for (const address of ['127.0.0.1', '192.168.1.3', 'fd00::1', '0:0:0:0:0:0:0:1']) {
    await assert.rejects(createComfyServerTransport(account(), input(), { resolveHost: async () => [{ address }] }), { code: 'private_network_blocked' });
  }
});

test('DNS has a bounded timeout; cancelling or changing identity during resolution does not connect', async () => {
  await assert.rejects(createComfyServerTransport(account(), input(), { resolveHost: async () => { throw new Error('getaddrinfo private details'); } }), { code: 'comfy_transport_dns', message: '无法解析 Comfy 地址，请核对域名与 ST 主机网络' });
  await assert.rejects(createComfyServerTransport(account(), input(), { resolveHost: () => new Promise(() => {}), dnsTimeoutMs: 5 }), { code: 'comfy_transport_dns_timeout' });
  const req = account(), controller = new AbortController();
  await assert.rejects(createComfyServerTransport(req, input(), { signal: controller.signal, resolveHost: async () => { controller.abort(); return publicDns(); } }), { name: 'AbortError' });
  await assert.rejects(createComfyServerTransport(req, input(), { resolveHost: async () => { req.user.profile.handle = 'bob'; return publicDns(); } }), { code: 'comfy_transport_account_changed' });
});

test('pinned transport limits each operation to exact native paths and excludes cookies, redirects and arbitrary reads', async () => {
  const base = new URL('https://comfy.test/api'), addresses = [{ address: '8.8.8.8' }];
  for (const [operation, route, method] of [['check', 'prompt', 'POST'], ['models', 'history/x', 'GET'], ['readiness', 'object_info', 'GET'],
    ['readiness', 'object_info/A/extra', 'GET'], ['generate', 'queue', 'POST'], ['generate', 'interrupt', 'POST'], ['generate', 'history', 'GET'],
    ['generate', 'view?filename=a.png&type=input', 'GET'], ['generate', 'view?filename=a.png&type=output&url=https://else.test', 'GET'],
    ['generate', 'view?filename=a.png&type=output&type=output', 'GET'], ['generate', 'view?filename=a.png&type=output&subfolder=../x', 'GET']]) {
    const fetcher = pinnedComfyFetch(base, addresses, { operation, requestImpl: () => assert.fail('must not connect') });
    await assert.rejects(fetcher(new URL(route, `${base}/`), { method }), { code: 'comfy_transport_target_changed' });
  }
  const fetcher = pinnedComfyFetch(base, addresses, { operation: 'check', requestImpl: () => assert.fail('must not connect') });
  await assert.rejects(fetcher('https://other.test/api/system_stats'), { code: 'comfy_transport_target_changed' });
  await assert.rejects(fetcher(`${base}/system_stats`, { headers: { Cookie: 'session=secret' } }), { code: 'comfy_transport_headers' });
  await assert.rejects(fetcher(`${base}/system_stats`, { body: 'not read-only' }), { code: 'comfy_transport_body' });
});

test('check and model routes use pinned Node transport with auth, never the generic browser fetch', async () => {
  const calls = []; let resolutions = 0;
  const handlers = await routes({ resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls, call => ({ body: call.url.pathname.endsWith('object_info')
    ? { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors']] } } } } : { system: {} } })) });
  const first = response(); await handlers.get('POST /image/check')({ ...account(), body: input() }, first);
  assert.equal(first.body.ok, true); assert.equal(first.body.verified, false); assert.equal(first.body.message, '地址可达，请以生图验证');
  const second = response(); await handlers.get('POST /image/models')({ ...account(), body: input() }, second);
  assert.equal(second.body.models[0].id, 'model.safetensors'); assert.equal(resolutions, 2); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.headers.authorization, 'Bearer test-only-secret');
    call.options.lookup('comfy.test', { all: true }, (error, list) => { assert.equal(error, null); assert.deepEqual(list, [{ address: '8.8.8.8', family: 4 }]); });
    call.options.lookup('changed.test', {}, error => assert.ok(error));
  }
});

test('actual generation route pins upload, prompt, original history and view to one DNS snapshot with streaming multipart', async () => {
  const calls = []; let resolutions = 0;
  const handlers = await routes({ resolveHost: async () => { resolutions++; return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1' }]; }, requestImpl: mockNodeRequest(calls, call => {
    const path = call.url.pathname;
    if (path.endsWith('/upload/image')) {
      assert.match(call.options.headers['content-type'], /^multipart\/form-data; boundary=/);
      assert.match(call.body.toString(), /name="overwrite"\r\n\r\nfalse/); assert.ok(call.body.includes(png));
      return { body: { name: 'uploaded.png' } };
    }
    if (path.endsWith('/prompt')) { assert.deepEqual(JSON.parse(call.body).prompt['1'].inputs, { text: 'rain', refs: ['uploaded.png'] }); return { body: { prompt_id: 'original-id' } }; }
    if (path.endsWith('/history/original-id')) return { body: { 'original-id': { status: { completed: true }, outputs: { save: { images: [{ filename: 'done.png', type: 'output' }] } } } } };
    if (path.endsWith('/view')) return { body: png, headers: { 'content-type': 'image/png' } };
    assert.fail(path);
  }) });
  const res = response(); await handlers.get('POST /image/generate')({ ...account(), body: input({ referenceImages: [{ data: png.toString('base64'), mime: 'image/png' }],
    parameters: { pollIntervalMs: 250, workflow: workflow(true) } }) }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.upstreamId, 'original-id'); assert.equal(res.body.images.length, 1);
  assert.equal(resolutions, 1); assert.equal(calls.length, 4);
  for (const call of calls) { assert.equal(call.options.headers.authorization, 'Bearer test-only-secret'); call.options.lookup('comfy.test', {}, (error, ip) => { assert.equal(error, null); assert.equal(ip, '8.8.8.8'); }); }
});

test('redirects are not followed and a failure after acceptance retains the original id without submitting twice', async () => {
  const calls = [];
  const handlers = await routes({ resolveHost: publicDns, requestImpl: mockNodeRequest(calls, call => call.url.pathname.endsWith('prompt') ? { body: { prompt_id: 'original-id' } }
    : { status: 302, headers: { location: 'http://127.0.0.1/secret?key=test-only-secret' } }) });
  const res = response(); await handlers.get('POST /image/generate')({ ...account(), body: input() }, res);
  assert.equal(res.statusCode, 502); assert.equal(res.body.code, 'comfy_transport_redirect'); assert.equal(res.body.upstreamId, 'original-id');
  assert.equal(res.body.submissionState, 'accepted'); assert.equal(calls.length, 2); assert.ok(!JSON.stringify(res.body).includes('test-only-secret'));
});

test('installed result and acknowledgement routes recover the original by GET only, then release only its cached files', async () => {
  const calls = []; let available = false;
  const handlers = await routes({ resolveHost: publicDns, requestImpl: mockNodeRequest(calls, call => {
    const route = call.url.pathname;
    if (route.endsWith('/prompt')) return { body: { prompt_id: 'original-id' } };
    if (route.includes('/history/')) return available ? { body: { 'original-id': { status: { completed: true }, outputs: { save: { images: [{ filename: 'done.png', type: 'output' }] } } } } } : { status: 502 };
    if (route.endsWith('/view')) return { body: png, headers: { 'content-type': 'image/png' } };
    assert.fail(route);
  }) });
  const submitted = response(); await handlers.get('POST /image/generate')({ ...account(), body: input() }, submitted);
  assert.equal(submitted.body.submissionState, 'accepted'); available = true;
  const body = { ...input().comfyQueue, baseUrl: input().baseUrl, apiKey: input().apiKey };
  const recovered = response(); await handlers.get('POST /image/comfy/tasks/result')({ ...account(), body }, recovered);
  assert.equal(recovered.statusCode, 200); assert.equal(recovered.body.status, 'ready'); assert.equal(recovered.body.images.length, 1);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  const done = response(); await handlers.get('POST /image/comfy/tasks/acknowledge')({ ...account(), body: { ...body, archived: true, receipt: recovered.body.comfyTask.receipt } }, done);
  assert.equal(done.body.ok, true); assert.ok(done.body.bytes > 0);
  const queried = response(); await handlers.get('POST /image/comfy/tasks/query')({ ...account(), body }, queried);
  assert.equal(queried.body.task.status, 'succeeded'); assert.equal(queried.body.task.resultStored, false);
});

test('revoking private admin stops subsequent reads and response delivery', async () => {
  const req = account(true), calls = [];
  const handlers = await routes({ resolveHost: async () => [{ address: '127.0.0.1' }], requestImpl: mockNodeRequest(calls, () => {
    req.user.profile.admin = false; return { body: { system: {} } };
  }) });
  const res = response(); await handlers.get('POST /image/check')({ ...req, body: input({ baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }) }, res);
  assert.equal(res.statusCode, 401); assert.equal(res.body.code, 'comfy_transport_account_changed'); assert.equal(calls.length, 1);
});

test('real local HTTP stub verifies streaming bodies, response byte reads and explicit local administrator connection', async () => {
  const seen = []; const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ prompt_id: 'local-stub' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const transport = await createComfyServerTransport(account(true), input({ baseUrl, allowPrivateNetwork: true }), { operation: 'generate' });
    const result = await transport.fetchImpl(`${baseUrl}/prompt`, { method: 'POST', headers: { Authorization: 'Bearer local-only', 'Content-Type': 'application/json' }, body: '{"prompt":{}}' });
    assert.deepEqual(await result.json(), { prompt_id: 'local-stub' });
    assert.deepEqual(seen, [{ path: '/prompt', method: 'POST', auth: 'Bearer local-only', body: '{"prompt":{}}' }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('pending DNS cannot retarget the API root and pinned addresses cannot be mutated or reused from a global pool', async () => {
  const body = input(), calls = [], addresses = [{ address: '8.8.8.8', family: 4 }];
  const transport = await createComfyServerTransport(account(), body, { operation: 'check', resolveHost: async () => {
    body.baseUrl = 'https://else.test/new'; return addresses;
  }, requestImpl: mockNodeRequest(calls) });
  addresses[0].address = '127.0.0.1'; transport.base.pathname = '/changed';
  await transport.fetchImpl('https://comfy.test/api/system_stats');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.agent, false);
  calls[0].options.lookup('comfy.test', {}, (error, ip) => { assert.equal(error, null); assert.equal(ip, '8.8.8.8'); });
  assert.throws(() => pinnedComfyFetch(new URL('https://1.1.1.1'), addresses, { operation: 'check' }), { code: 'comfy_transport_address' });
});

test('non-Comfy route preserves its legacy transport without requiring Comfy credentials, DNS or service coordination', async () => {
  const handlers = await routes({ resolveHost: () => assert.fail('not Comfy'), requestImpl: () => assert.fail('not Comfy') });
  const originalFetch = globalThis.fetch; let count = 0;
  try {
    globalThis.fetch = async (url, options) => {
      count++; assert.equal(String(url), 'https://8.8.8.8/models'); assert.equal(options.headers.Authorization, 'Bearer nai-test');
      return new Response('{}', { status: 404 });
    };
    // Ordinary model API behavior stays on the existing path, not the durable queue or Comfy requester.
    const res = response(); await handlers.get('POST /image/check')({ body: { provider: 'novel', apiKey: 'nai-test', baseUrl: 'https://8.8.8.8' } }, res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.verified, false); assert.equal(count, 1);
  } finally { globalThis.fetch = originalFetch; }
});
