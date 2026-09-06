import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceQueue, imageServiceChannelKey, describeImageServiceRequest, normalizeImageServiceChannel } from '../qianmu-image-service-queue.js';
import { generateImage } from '../qianmu-image-gateway.js';

const key = imageServiceChannelKey('mock-persistence-key');
const never = () => assert.fail('must not authorize another request');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const request = { provider: 'novel', model: 'nai-diffusion-5-full', apiKey: 'mock-persistence-key', prompt: 'a quiet lake' };
const args = id => ({ apiKey: request.apiKey, namespace: 'account-a', attemptId: id, automatic: true, ...describeImageServiceRequest(request) });
const metadata = (id = 'first') => ({ schema: 'qianmu.image-service-channel.v1', channelKey: key, entries: [{
  namespace: 'account-a', attemptId: id, requestDigest: args(id).requestDigest, ownerId: 'server-a', fence: `fence-${id}`,
  status: 'submitting', automatic: true, createdAt: 1, updatedAt: 1,
}] });
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-service-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^qianmu-service-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  const store = createImageServiceStore({ dataRoot: root });
  t.after(() => store.close());
  return { root, store, directory: path.join(root, '.qianmu-service', 'image-queue-v1') };
}
async function child(script) {
  const instance = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const pipe of [instance.stdout, instance.stderr]) pipe.on('data', chunk => { output += chunk; });
  return new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.once('close', code => code === 0 ? resolve(output) : reject(Error(`test child failed ${code}: ${output.slice(0, 1000)}`)));
  });
}
const storeUrl = new URL('../qianmu-image-service-store.js', import.meta.url).href;
const queueUrl = new URL('../qianmu-image-service-queue.js', import.meta.url).href;

test('private store is lazy and rejects untrusted roots and channel path traversal', async t => {
  for (const dataRoot of [undefined, '', '.', '/', path.parse(process.cwd()).root, 'a\0b']) assert.throws(() => createImageServiceStore({ dataRoot }), { code: 'image_service_storage_root' });
  const { root, store } = await fixture(t);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(store.inspect().initialized, false);
  for (const invalid of ['../../secrets', 'key', 'f'.repeat(65), key.toUpperCase()]) await assert.rejects(store.transaction(invalid, never), { code: 'image_service_storage_identity' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('atomic metadata survives another store instance without persisting credentials, prompts or media', async t => {
  const { root, store, directory } = await fixture(t);
  assert.equal(await store.transaction(key, () => ({ state: { ...metadata(), apiKey: request.apiKey, prompt: 'private-text', image: 'private-image' }, result: 'committed' })), 'committed');
  assert.deepEqual(await fs.readdir(directory), [`${key}.json`]);
  const text = await fs.readFile(path.join(directory, `${key}.json`), 'utf8');
  assert.doesNotMatch(text, /mock-persistence-key|private-text|private-image|apiKey/);
  const next = createImageServiceStore({ dataRoot: root }); t.after(() => next.close());
  assert.deepEqual(await next.inspectChannel(key), metadata());
  assert.deepEqual(await next.transaction(key, state => ({ state, result: state.entries[0].attemptId })), 'first');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, `${key}.json`), 'utf8')).revision, 2);
});

test('completed real adapter requests remain non-replayable after reopening the disk store', async t => {
  const { root, store } = await fixture(t), queue = createImageServiceQueue({ store }); let posts = 0;
  const result = await queue.run(args('once'), ticket => generateImage(request, {
    beforeSubmit: ticket.beforeSubmit, resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => {
      assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting'); posts++;
      return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=' }] }), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  assert.ok(result); assert.equal(posts, 1); queue.close(); await store.close();
  const reopened = createImageServiceStore({ dataRoot: root }), next = createImageServiceQueue({ store: reopened });
  t.after(async () => { next.close(); await reopened.close(); });
  await assert.rejects(next.run(args('once'), never), { code: 'image_service_already_finished' });
  assert.equal((await reopened.inspectChannel(key)).entries[0].status, 'succeeded');
});

test('same-process transactions serialize and return only after disk commit', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, n) => store.transaction(key, previous => {
    const state = previous || normalizeImageServiceChannel(undefined, key);
    const row = metadata(`request-${n}`).entries[0]; row.status = 'succeeded'; state.entries.push(row);
    return { state, result: n };
  })));
  assert.equal((await store.inspectChannel(key)).entries.length, 12);
  assert.equal(store.inspect().pending, 0);
});

test('two store instances cannot enter the same disk transaction at once', async t => {
  const { root, directory } = await fixture(t), gate = deferred(), acquired = deferred();
  const slow = createImageServiceStore({ dataRoot: root, fileSystem: { ...fs, rename: async (...input) => { acquired.resolve(); await gate.promise; return fs.rename(...input); } } });
  const other = createImageServiceStore({ dataRoot: root }); t.after(async () => { await slow.close(); await other.close(); });
  const first = slow.transaction(key, () => ({ state: metadata() })); await acquired.promise;
  await assert.rejects(other.transaction(key, never), { code: 'image_service_storage_busy' });
  assert.ok((await fs.readdir(directory)).includes('.transaction.lock'));
  gate.resolve(); await first;
  await other.transaction(key, state => ({ state }));
});

test('a real process exit after submit leaves a persistent fence and never authorizes an automatic retry', async t => {
  const { root, store } = await fixture(t);
  await child(`import {createImageServiceStore} from ${JSON.stringify(storeUrl)};
    import {createImageServiceQueue} from ${JSON.stringify(queueUrl)};
    const store=createImageServiceStore({dataRoot:${JSON.stringify(root)}}), queue=createImageServiceQueue({store});
    await queue.run(${JSON.stringify(args('crashed'))}, async ticket=>{await ticket.beforeSubmit();process.exit(0)});`);
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting');
  const queue = createImageServiceQueue({ store }); t.after(() => queue.close());
  await assert.rejects(queue.run(args('after-restart'), never), { code: 'image_service_busy' });
});

test('crash during an atomic write leaves evidence and is not reset by a fresh session', async t => {
  const { root, store, directory } = await fixture(t);
  await child(`import * as fs from 'node:fs/promises';import {createImageServiceStore} from ${JSON.stringify(storeUrl)};
    const store=createImageServiceStore({dataRoot:${JSON.stringify(root)},fileSystem:{...fs,rename:async()=>process.exit(0)}});
    await store.transaction(${JSON.stringify(key)},()=>({state:${JSON.stringify(metadata())}}));`);
  const before = await fs.readdir(directory);
  assert.ok(before.includes('.transaction.lock')); assert.ok(before.some(name => name.endsWith('.tmp')));
  await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_busy' });
  assert.deepEqual(await fs.readdir(directory), before, 'stale lock and staged metadata are not silently swept');
});

test('invalid JSON, checksum mismatch and null records cannot be treated as an empty database', async t => {
  const { root, directory, store } = await fixture(t);
  await store.transaction(key, () => ({ state: metadata() }));
  const target = path.join(directory, `${key}.json`), original = await fs.readFile(target, 'utf8');
  for (const body of ['null', '{', '{}', original.replace('submitting', 'succeeded')]) {
    await fs.writeFile(target, body);
    const next = createImageServiceStore({ dataRoot: root }); t.after(() => next.close());
    await assert.rejects(next.transaction(key, never), { code: 'image_service_storage_corrupt' });
    assert.equal(await fs.readFile(target, 'utf8'), body);
  }
});

test('directory junctions and hard-linked records are refused without touching the target', async t => {
  const { root, store, directory } = await fixture(t);
  const elsewhere = path.join(root, 'elsewhere'); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(root, '.qianmu-service'), 'junction');
  await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_path' });
  assert.deepEqual(await fs.readdir(elsewhere), []);
  await fs.unlink(path.join(root, '.qianmu-service'));
  const safe = createImageServiceStore({ dataRoot: root }); t.after(() => safe.close());
  await safe.transaction(key, () => ({ state: metadata() }));
  await fs.link(path.join(directory, `${key}.json`), path.join(elsewhere, 'same-data.json'));
  await assert.rejects(safe.transaction(key, never), { code: 'image_service_storage_record' });
});

test('reducer failure and failed atomic rename retain the old record with no orphan temporary file', async t => {
  const { root, store, directory } = await fixture(t);
  await store.transaction(key, () => ({ state: metadata() }));
  const before = await fs.readFile(path.join(directory, `${key}.json`), 'utf8');
  await assert.rejects(store.transaction(key, state => { state.entries = []; throw Error('sensitive path /test'); }), { code: 'image_service_storage_unavailable' });
  const broken = createImageServiceStore({ dataRoot: root, fileSystem: { ...fs, rename: async () => { throw Object.assign(Error('secret filename'), { code: 'EIO' }); } } });
  t.after(() => broken.close());
  await assert.rejects(broken.transaction(key, () => ({ state: metadata('new') })), cause => cause.code === 'image_service_storage_unavailable' && !cause.message.includes('secret'));
  assert.equal(await fs.readFile(path.join(directory, `${key}.json`), 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), [`${key}.json`]);
});

test('failure after atomic rename cannot grant authorization even if the new record reached disk', async t => {
  const { root, store } = await fixture(t);
  const faulty = createImageServiceStore({ dataRoot: root, fileSystem: { ...fs, rename: async (...input) => { await fs.rename(...input); throw Error('lost completion'); } } });
  t.after(() => faulty.close());
  const queue = createImageServiceQueue({ store: faulty }); t.after(() => queue.close());
  await assert.rejects(queue.run(args('ambiguous-save'), never), { code: 'image_service_storage_unavailable' });
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'reserved');
  const next = createImageServiceQueue({ store }); t.after(() => next.close());
  await assert.rejects(next.run(args('next'), never), { code: 'image_service_busy' });
});

test('channel and byte caps never evict historical records to admit more work', async t => {
  const { root, directory } = await fixture(t);
  const store = createImageServiceStore({ dataRoot: root, maxChannels: 1, maxRecordBytes: 1024 }); t.after(() => store.close());
  await store.transaction(key, () => ({ state: metadata() }));
  const second = imageServiceChannelKey('different');
  await assert.rejects(store.transaction(second, () => ({ state: normalizeImageServiceChannel(undefined, second) })), { code: 'image_service_storage_full' });
  await assert.rejects(store.transaction(key, state => { for (let n = 0; n < 10; n++) { const row = metadata(`more-${n}`).entries[0]; row.status = 'succeeded'; state.entries.push(row); } return { state }; }), { code: 'image_service_storage_full' });
  assert.equal((await store.inspectChannel(key)).entries.length, 1);
  assert.deepEqual(await fs.readdir(directory), [`${key}.json`]);
});

test('bounded waiting and closing reject unsent mutations without abandoning an active disk commit', async t => {
  const { root } = await fixture(t), gate = deferred(), entered = deferred();
  const store = createImageServiceStore({ dataRoot: root, maxPending: 2, fileSystem: { ...fs, rename: async (...input) => { entered.resolve(); await gate.promise; return fs.rename(...input); } } });
  const active = store.transaction(key, () => ({ state: metadata(), result: 'saved' })); await entered.promise;
  const waiting = store.transaction(key, never);
  await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_busy' });
  const closing = store.close(); gate.resolve();
  assert.equal(await active, 'saved'); await assert.rejects(waiting, { code: 'image_service_storage_closed' }); await closing;
  assert.equal(store.inspect().pending, 0);
});

test('new private metadata store remains outside live service routes and release until recovery is integrated', async () => {
  for (const file of ['../server-plugin.js', '../release-files.json']) assert.doesNotMatch(await fs.readFile(new URL(file, import.meta.url), 'utf8'), /qianmu-image-service-store/);
});
