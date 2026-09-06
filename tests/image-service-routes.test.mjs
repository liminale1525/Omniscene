import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { init, exit } from '../server-plugin.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const key = 'mock-route-key';
const input = attemptId => ({ schemaVersion: 1, attemptId, automatic: true, request: { provider: 'novel', model: 'nai-diffusion-5-full', apiKey: key, prompt: 'lake' } });
const query = attemptId => ({ schemaVersion: 1, attemptId, apiKey: key });
const response = () => new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, { fetchImpl = response, shutdown = () => {} } = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-http-test-'));
  const routes = new Map();
  await init({ get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) }, {
    dataRoot: root, imageTaskOptions: { gatewayOptions: { resolveHost: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl } },
  });
  const server = http.createServer(async (req, res) => {
    // An isolated host-auth stub; the production plugin receives Request.user
    // from SillyTavern, not from this test-only header or a JSON body.
    const account = req.headers['x-test-account']; if (account) req.user = { profile: { handle: account, enabled: true } };
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    try { req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch (_) { res.statusCode = 400; res.end(); return; }
    res.set = (name, value) => { res.setHeader(name, value); return res; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return res; };
    const handler = routes.get(`${req.method} ${req.url}`);
    if (!handler) { res.statusCode = 404; res.end(); return; }
    await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await exit();
    const real = await fs.realpath(root); assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^qianmu-http-test-/); await fs.rm(real, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, account = 'alice', options = {}) => fetch(`${base}/image/tasks/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(account ? { 'x-test-account': account } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options,
  });
  return { root, call };
}

test('task capability handshake is authenticated, does not create storage, and names its coordination boundary', async t => {
  const { root, call } = await fixture(t);
  assert.equal((await call('capabilities', undefined, '')).status, 401);
  const result = await call('capabilities');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = await result.json(); assert.equal(body.schemaVersion, 1); assert.equal(body.scope, 'coordinated-endpoints-only');
  assert.deepEqual(body.providers, ['novel']); assert.equal(body.automaticRestartReplay, false);
  assert.deepEqual(await fs.readdir(root), []);
});

test('real HTTP submission survives normal request-body close and uses query/result/acknowledge routes', async t => {
  let posts = 0; const { call } = await fixture(t, { fetchImpl: async () => { posts++; return response(); } });
  const created = await call('submit', input('http-once')); assert.equal(created.status, 200);
  const generated = await created.json(); assert.equal(generated.images[0].data, PNG);
  assert.equal((await (await call('query', query('http-once'))).json()).task.resultStored, true);
  assert.equal((await (await call('query', query('http-once'), 'bob')).json()).task, null);
  assert.equal((await call('result', query('http-once'), 'bob')).status, 404);
  const original = await (await call('result', query('http-once'))).json(); assert.equal(original.images[0].data, PNG);
  assert.equal((await call('acknowledge', { ...query('http-once'), archived: true, receipt: generated.serviceTask.receipt })).status, 200);
  assert.equal((await call('result', query('http-once'))).status, 409);
  assert.equal((await call('submit', input('http-once'))).status, 409); assert.equal(posts, 1);
});

test('real HTTP client disconnect after provider submission still leaves a retrievable result', async t => {
  const gate = deferred(), begun = deferred(); let posts = 0;
  const { call } = await fixture(t, { fetchImpl: async () => { posts++; begun.resolve(); await gate.promise; return response(); }, shutdown: gate.resolve });
  const abort = new AbortController(), pending = call('submit', input('lost-client'), 'alice', { signal: abort.signal });
  await begun.promise; abort.abort(); await assert.rejects(pending); gate.resolve();
  let state;
  for (let n = 0; n < 80; n++) {
    state = await (await call('query', query('lost-client'))).json();
    if (state.task?.resultStored && !state.task.live) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.task.resultStored, true);
  assert.equal((await (await call('result', query('lost-client'))).json()).images[0].data, PNG);
  assert.equal(posts, 1);
});

test('body-supplied accounts and filesystem paths never authenticate task routes', async t => {
  const { root, call } = await fixture(t);
  const forged = { ...input('forged'), user: { profile: { handle: 'alice', admin: true } }, dataRoot: '/somewhere', namespace: 'alice' };
  assert.equal((await call('submit', forged, '')).status, 401);
  assert.deepEqual(await fs.readdir(root), []);
});
