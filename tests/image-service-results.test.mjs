import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceResults } from '../qianmu-image-service-results.js';
import { pinnedImageResultFetch } from '../qianmu-image-gateway.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const identity = (attemptId = 'one', extra = {}) => ({ namespace: 'account', channelKey: 'a'.repeat(64), requestDigest: 'b'.repeat(64), fence: 'private-fence', attemptId, ...extra });
const result = { ok: true, provider: 'novel', model: 'nai-diffusion-5-full', images: [{ data: PNG }] };
async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-result-test-'));
  const store = createImageServiceStore({ dataRoot: root }), cache = createImageServiceResults({ dataRoot: root, store, ...options });
  t.after(async () => { await store.close(); const real = await fs.realpath(root); assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^qianmu-result-test-/); await fs.rm(real, { recursive: true }); });
  return { root, store, cache };
}

test('public media lookup is pinned to copied validated addresses and never forwards authentication', async () => {
  const url = 'https://image.example.test/p.png?sig=mock', addresses = [{ address: '8.8.8.8', family: 4 }]; let options;
  const fetcher = pinnedImageResultFetch(url, addresses, (_url, init, callback) => {
    options = init; const request = new EventEmitter();
    request.end = () => { const incoming = Readable.from([Buffer.from(PNG, 'base64')]); incoming.statusCode = 200; incoming.headers = { 'content-type': 'image/png' }; callback(incoming); };
    return request;
  });
  addresses[0].address = '127.0.0.1';
  const response = await fetcher(url, { method: 'GET', headers: { Authorization: 'must-not-forward', Cookie: 'private-cookie' } });
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), PNG);
  assert.deepEqual(options.headers, { Accept: 'image/*' });
  const pinned = await new Promise((resolve, reject) => options.lookup('image.example.test', { all: true }, (error, records) => error ? reject(error) : resolve(records)));
  assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(fetcher('https://elsewhere.example.test/p.png', { method: 'GET' }), { code: 'unsafe_image_host' });
});

test('private addresses, changed methods and redirects cannot turn media retrieval into another request', async () => {
  const url = 'https://image.example.test/p.png';
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1']) assert.throws(() => pinnedImageResultFetch(url, [{ address, family: 4 }]), { code: 'unsafe_image_host' });
  const fetcher = pinnedImageResultFetch(url, [{ address: '8.8.8.8', family: 4 }], (_url, _init, callback) => {
    const request = new EventEmitter(); request.end = () => { const incoming = Readable.from([]); incoming.statusCode = 302; incoming.headers = { location: 'https://private.example.test' }; callback(incoming); }; return request;
  });
  await assert.rejects(fetcher(url, { method: 'POST' }), { code: 'unsafe_image_host' });
  await assert.rejects(fetcher(url, { method: 'GET' }), { code: 'image_redirect_blocked' });
});

test('result reservation counts worst-case bytes and does not create an over-capacity slot', async t => {
  const { root, cache } = await fixture(t, { maxSlots: 3, maxBytes: 96 * 1024 * 1024 });
  await cache.reserve(identity('a')); await cache.reserve(identity('b'));
  await assert.rejects(cache.reserve(identity('c')), { code: 'image_service_result_full' });
  assert.equal((await fs.readdir(path.join(root, '.qianmu-service', 'image-results-v1'))).length, 2);
  const first = await cache.load(identity('a'), { metadataOnly: true });
  await cache.discard(identity('a'), first.receipt);
  await cache.reserve(identity('c'));
});

test('request fences and exact receipts protect result ownership and cleanup', async t => {
  const { cache } = await fixture(t);
  await cache.reserve(identity()); const saved = await cache.save(identity(), result);
  await assert.rejects(cache.load(identity('one', { fence: 'different-fence' })), { code: 'image_service_result_corrupt' });
  await assert.rejects(cache.discard(identity(), saved.receipt, { valid: () => false }), { code: 'image_service_result_cancelled' });
  assert.equal((await cache.load(identity())).images[0].data, PNG);
  await assert.rejects(cache.save(identity(), result), { code: 'image_service_result_exists' });
});

test('unknown files and directory junctions are never swept by temporary result cleanup', async t => {
  const { root, cache } = await fixture(t); await cache.reserve(identity()); const saved = await cache.save(identity(), result);
  const base = path.join(root, '.qianmu-service', 'image-results-v1'), [name] = await fs.readdir(base), folder = path.join(base, name);
  await fs.writeFile(path.join(folder, 'user-note.txt'), 'keep');
  await assert.rejects(cache.discard(identity(), saved.receipt), { code: 'image_service_result_corrupt' });
  assert.equal(await fs.readFile(path.join(folder, 'user-note.txt'), 'utf8'), 'keep');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const staged = path.join(root, '.qianmu-service', 'image-results-saved'); await fs.rename(base, staged); await fs.symlink(outside, base, 'junction');
  await assert.rejects(cache.reserve(identity('new')), { code: 'image_service_result_path' });
  assert.deepEqual(await fs.readdir(outside), []);
});
