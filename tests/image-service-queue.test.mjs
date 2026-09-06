import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createImageServiceQueue, imageServiceChannelKey, describeImageServiceRequest, imageServiceRequestDigest, normalizeImageServiceChannel } from '../qianmu-image-service-queue.js';
import { generateImage, sanitizeImageRequest } from '../qianmu-image-gateway.js';

const fixture = () => {
  const records = new Map(), tails = new Map(); let writes = 0;
  return {
    records, get writes() { return writes; }, beforeCommit: null,
    transaction(key, reduce) {
      const operation = (tails.get(key) || Promise.resolve()).then(async () => {
        const previous = structuredClone(records.get(key));
        const next = reduce(previous);
        await this.beforeCommit?.(next.state, key);
        records.set(key, structuredClone(next.state)); writes++;
        return structuredClone(next.result);
      });
      tails.set(key, operation.then(() => {}, () => {})); return operation;
    },
  };
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const request = { provider: 'novel', model: 'nai-diffusion-5-full', apiKey: 'mock-key', prompt: 'a quiet lake' };
const requestDescription = describeImageServiceRequest(sanitizeImageRequest(request));
const digest = requestDescription.requestDigest;
const args = (id, extra = {}) => ({ apiKey: 'mock-key', namespace: 'account-a', attemptId: id, ...requestDescription, automatic: true, ...extra });
const rows = store => store.records.get(imageServiceChannelKey('mock-key'))?.entries || [];
const never = () => assert.fail('must not submit');
const image = () => new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=' }] }), { headers: { 'Content-Type': 'application/json' } });
const dns = async () => [{ address: '8.8.8.8', family: 4 }];

test('service queue cannot activate without a durable atomic storage port', () => {
  assert.throws(() => createImageServiceQueue(), { code: 'image_service_storage' });
  const store = fixture(), queue = createImageServiceQueue({ store });
  assert.deepEqual(queue.inspect(), { closed: false, pending: 0, active: 0, pendingBytes: 0 });
  assert.equal(store.writes, 0); queue.close();
});

test('request identity is canonical, accounts for meaningful changes and excludes transport credentials', () => {
  assert.equal(imageServiceRequestDigest({ b: 2, a: 1, empty: undefined, apiKey: 'one' }), imageServiceRequestDigest({ apiKey: 'two', a: 1, b: 2 }));
  assert.notEqual(imageServiceRequestDigest({ a: 1 }), imageServiceRequestDigest({ a: 2 }));
  assert.notEqual(imageServiceRequestDigest({ parameters: { apiKey: 'user-field' } }), imageServiceRequestDigest({ parameters: {} }));
  assert.equal(imageServiceChannelKey(' mock-key '), imageServiceChannelKey('mock-key'));
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => imageServiceRequestDigest(sanitizeImageRequest(request)), 'absent optional parameters use JSON omission semantics');
});

test('digest rejects cyclic, deep, sparse and executable data without executing getters', () => {
  const cycle = {}; cycle.self = cycle;
  let deep = {}; for (let n = 0; n < 42; n++) deep = { value: deep };
  const getter = Object.defineProperty({}, 'danger', { enumerable: true, get: never });
  for (const value of [cycle, deep, getter, [undefined], Array(3), new Date(), { fn() {} }, { value: Infinity }]) assert.throws(() => imageServiceRequestDigest(value), { code: 'image_service_request' });
});

test('nine actual adapter jobs share a serial service queue across simulated devices and accounts', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store }); let active = 0, maximum = 0, posts = 0;
  const outputs = await Promise.all(Array.from({ length: 9 }, (_, n) => queue.run(args(`job-${n}`, { namespace: n % 2 ? 'account-a' : 'account-b' }), ticket => generateImage(request, {
    resolveHost: dns, beforeSubmit: ticket.beforeSubmit,
    fetchImpl: async () => {
      assert.equal(rows(store).filter(row => row.status === 'submitting').length, 1);
      posts++; maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return image();
    },
  }))));
  assert.equal(maximum, 1); assert.equal(posts, 9); assert.equal(outputs.length, 9);
  assert.ok(rows(store).every(row => row.status === 'succeeded')); queue.close();
});

test('unrelated credentials do not wait for each other', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store }), gate = deferred(), a = deferred(), b = deferred();
  const first = queue.run(args('a'), async ticket => { await ticket.beforeSubmit(); a.resolve(); await gate.promise; });
  const second = queue.run(args('b', { apiKey: 'mock-other' }), async ticket => { await ticket.beforeSubmit(); b.resolve(); await gate.promise; });
  await Promise.all([a.promise, b.promise]); assert.equal(queue.inspect().active, 2);
  gate.resolve(); await Promise.all([first, second]); queue.close();
});

test('global concurrency bounds large output memory and gives waiting connections a turn', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store, maxActive: 1 }), gate = deferred(), entered = deferred(), order = [];
  const first = queue.run(args('first'), async () => { order.push('first'); entered.resolve(); await gate.promise; });
  await entered.promise;
  const same = queue.run(args('same'), async () => { order.push('same'); });
  const other = queue.run(args('other', { apiKey: 'mock-other' }), async () => { order.push('other'); });
  assert.equal(queue.inspect().active, 1); assert.equal(queue.inspect().pending, 3);
  gate.resolve(); await Promise.all([first, same, other]);
  assert.deepEqual(order, ['first', 'other', 'same']); queue.close();
});

test('aggregate request bytes are bounded and released when queued work is cancelled', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store, maxPendingBytes: 100 }), gate = deferred(), begun = deferred(), abort = new AbortController();
  const active = queue.run(args('held', { requestBytes: 60 }), async ticket => { await ticket.beforeSubmit(); begun.resolve(); await gate.promise; });
  await begun.promise;
  const waiting = queue.run(args('waiting', { requestBytes: 40, signal: abort.signal }), never);
  assert.equal(queue.inspect().pendingBytes, 100);
  await assert.rejects(queue.run(args('overflow', { requestBytes: 1 }), never), { code: 'image_service_queue_size' });
  abort.abort(); await assert.rejects(waiting, { code: 'image_service_cancelled' });
  assert.equal(queue.inspect().pendingBytes, 60);
  for (const requestBytes of [undefined, 0, Infinity, 80 * 1024 * 1024 + 1]) await assert.rejects(queue.run(args('bad', { requestBytes }), never), { code: 'image_service_request' });
  gate.resolve(); await active; queue.close();
});

test('persistent request identity rejects replays and changed payloads, including after constructing a new queue', async () => {
  const store = fixture(), one = createImageServiceQueue({ store });
  await one.run(args('once'), async ticket => { await ticket.beforeSubmit(); return 'image'; }); one.close();
  const two = createImageServiceQueue({ store });
  await assert.rejects(two.run(args('once'), never), { code: 'image_service_already_finished' });
  await assert.rejects(two.run(args('once', { requestDigest: imageServiceRequestDigest({ different: true }) }), never), { code: 'image_service_conflict' });
  assert.equal(rows(store).length, 1); two.close();
});

test('a shared store will not grant two independent service sessions the same credential', async () => {
  const store = fixture(), one = createImageServiceQueue({ store, ownerId: 'service-a' }), two = createImageServiceQueue({ store, ownerId: 'service-b' });
  const begun = deferred(), gate = deferred();
  const first = one.run(args('first'), async ticket => { await ticket.beforeSubmit(); begun.resolve(); await gate.promise; });
  await begun.promise;
  await assert.rejects(two.run(args('second'), never), { code: 'image_service_busy' });
  gate.resolve(); await first; one.close(); two.close();
});

test('unknown upstream outcome pauses automatic requests and requires a current manual confirmation token', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store });
  await assert.rejects(queue.run(args('unknown'), ticket => generateImage(request, { resolveHost: dns, beforeSubmit: ticket.beforeSubmit, fetchImpl: async () => { throw TypeError('lost reply'); } })), { submissionState: 'unknown' });
  let confirmation;
  await assert.rejects(queue.run(args('auto-next'), never), error => { confirmation = error.confirmation; return error.code === 'image_service_confirmation_required'; });
  assert.match(confirmation, /^[a-f0-9]{64}$/);
  await assert.rejects(queue.run(args('auto-with-token', { confirmation }), never), { code: 'image_service_confirmation_required' });
  await assert.rejects(queue.run(args('manual-stale', { automatic: false, confirmation: '0'.repeat(64) }), never), { code: 'image_service_confirmation_required' });
  await queue.run(args('manual-new', { automatic: false, confirmation }), async ticket => { await ticket.beforeSubmit(); return 'image'; });
  assert.equal(rows(store)[0].status, 'acknowledged', 'prior unknown status is acknowledged, not falsely refunded or succeeded');
  assert.equal(rows(store)[1].status, 'succeeded'); queue.close();
});

test('another uncertain request invalidates an earlier manual token', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store });
  const uncertain = async ticket => { await ticket.beforeSubmit(); throw Error('unknown'); };
  await assert.rejects(queue.run(args('first'), uncertain));
  let token;
  await assert.rejects(queue.run(args('inspect'), never), error => { token = error.confirmation; return true; });
  await assert.rejects(queue.run(args('second', { automatic: false, confirmation: token }), uncertain));
  await assert.rejects(queue.run(args('third', { automatic: false, confirmation: token }), never), { code: 'image_service_confirmation_required' });
  queue.close();
});

test('queued abort and deadline remove only unsent work', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store, waitTimeoutMs: 100 }), gate = deferred(), begun = deferred(), abort = new AbortController();
  const active = queue.run(args('active'), async ticket => { await ticket.beforeSubmit(); begun.resolve(); await gate.promise; });
  await begun.promise;
  const waiting = queue.run(args('abort', { signal: abort.signal }), never); abort.abort();
  await assert.rejects(waiting, { code: 'image_service_cancelled' });
  await assert.rejects(queue.run(args('deadline'), never), { code: 'image_service_cancelled' });
  assert.equal(rows(store).length, 1); assert.equal(rows(store)[0].status, 'submitting');
  gate.resolve(); await active; queue.close();
});

test('close does not release a running request and prevents any queued submit', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store }), gate = deferred(), begun = deferred();
  const active = queue.run(args('active'), async ticket => { await ticket.beforeSubmit(); begun.resolve(); await gate.promise; return 'delivered'; });
  await begun.promise;
  const waiting = queue.run(args('waiting'), never); queue.close();
  await assert.rejects(waiting, { code: 'image_service_cancelled' });
  await assert.rejects(queue.run(args('new'), never), { code: 'image_service_cancelled' });
  assert.equal(rows(store)[0].status, 'submitting'); gate.resolve(); assert.equal(await active, 'delivered');
  assert.equal(rows(store)[0].status, 'succeeded');
});

test('context changes during the reserve transaction release unsent work', async () => {
  const store = fixture(); let valid = true;
  store.beforeCommit = state => { if (state.entries.at(-1)?.status === 'reserved') valid = false; };
  const queue = createImageServiceQueue({ store });
  await assert.rejects(queue.run(args('changed', { valid: () => valid }), never), { code: 'image_service_cancelled' });
  assert.equal(rows(store)[0].status, 'released'); queue.close();
});

test('storage failure before a dispatch reaches no provider and rolls back the failed mutation', async () => {
  const store = fixture(); let posts = 0;
  store.beforeCommit = state => { if (state.entries.at(-1)?.status === 'submitting') throw Error('storage unavailable'); };
  const queue = createImageServiceQueue({ store });
  await assert.rejects(queue.run(args('write-fail'), ticket => generateImage(request, { resolveHost: dns, beforeSubmit: ticket.beforeSubmit, fetchImpl: async () => { posts++; return image(); } })), { code: 'image_submission_not_authorized', submissionState: 'not_submitted' });
  assert.equal(posts, 0); assert.equal(rows(store)[0].status, 'released'); queue.close();
});

test('late bookkeeping failure preserves the successful image and fences future requests', async () => {
  const store = fixture(); let warnings = 0;
  store.beforeCommit = state => { if (state.entries.at(-1)?.status === 'succeeded') throw Error('disk full'); };
  const queue = createImageServiceQueue({ store });
  const result = await queue.run(args('delivered', { onWarning: () => { warnings++; } }), async ticket => { await ticket.beforeSubmit(); return 'image'; });
  assert.equal(result, 'image'); assert.equal(warnings, 1); assert.equal(rows(store)[0].status, 'submitting');
  await assert.rejects(queue.run(args('next'), never), { code: 'image_service_busy' }); queue.close();
});

test('capacity limits do not evict uncertain or successful history to authorize more work', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store, maxEntries: 1 });
  await queue.run(args('one'), async ticket => { await ticket.beforeSubmit(); });
  await assert.rejects(queue.run(args('two'), never), { code: 'image_service_full' });
  assert.equal(rows(store).length, 1); queue.close();
  const crowded = createImageServiceQueue({ store: fixture(), maxPending: 1 }), gate = deferred();
  const task = crowded.run(args('held'), async ticket => { await ticket.beforeSubmit(); await gate.promise; });
  await assert.rejects(crowded.run(args('overflow'), never), { code: 'image_service_queue_full' });
  gate.resolve(); await task; crowded.close();
});

test('malformed records and old pending requests cannot be reset by a new owner or elapsed time', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store, ownerId: 'old' });
  store.beforeCommit = state => { if (state.entries.at(-1)?.status === 'succeeded') throw Error('lost save'); };
  await queue.run(args('old'), async ticket => { await ticket.beforeSubmit(); }); queue.close(); store.beforeCommit = null;
  const fresh = createImageServiceQueue({ store, ownerId: 'new', now: () => Date.now() + 1e10 });
  await assert.rejects(fresh.run(args('new'), never), { code: 'image_service_busy' }); fresh.close();
  const key = imageServiceChannelKey('mock-key'), state = structuredClone(store.records.get(key));
  for (const invalid of [{ ...state, schema: 'future' }, { ...state, channelKey: 'f'.repeat(64) }, { ...state, entries: [...state.entries, state.entries[0]] }]) assert.throws(() => normalizeImageServiceChannel(invalid, key), { code: 'image_service_state' });
});

test('gateway invokes authorization only after validation and before every write, including Comfy uploads', async () => {
  let guards = 0, posts = 0;
  await assert.rejects(generateImage({ ...request, prompt: '' }, { beforeSubmit: async () => { guards++; }, fetchImpl: never }));
  assert.equal(guards, 0);
  await assert.rejects(generateImage({ provider: 'comfy', baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true, prompt: 'lake',
    parameters: { workflow: { '1': { class_type: 'LoadImage', inputs: { image: '%qianmu_reference%' } }, '2': { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } } } },
    referenceImages: [{ data: 'iVBORw0KGgppbWFnZQ==', mime: 'image/png' }],
  }, { beforeSubmit: async () => { if (++guards === 2) throw Error('authorization expired'); }, fetchImpl: async () => { posts++; return new Response(JSON.stringify({ name: 'test.png' })); } }), { code: 'image_submission_not_authorized', submissionState: 'accepted' });
  assert.equal(guards, 2); assert.equal(posts, 1, 'a successful upload is never mislabeled as never submitted');
});

test('coordinated service routes use the durable service and do not silently replace legacy generation', async () => {
  const source = await readFile(new URL('../server-plugin.js', import.meta.url), 'utf8');
  const release = await readFile(new URL('../release-files.json', import.meta.url), 'utf8');
  assert.match(source, /createImageService/);
  assert.match(source, /await generateImage\(req.body, \{ prepareComfyTransport:/);
  assert.match(release, /qianmu-image-service-queue/);
  assert.match(release, /qianmu-image-service-store/);
  assert.match(release, /qianmu-image-service-recovery/);
});

test('explicit provider rejection does not block the next request or leave stale capacity after settlement', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store });
  await assert.rejects(queue.run(args('rejected'), ticket => generateImage(request, { resolveHost: dns,
    beforeSubmit: ticket.beforeSubmit, fetchImpl: async () => new Response('{}', { status: 429 }),
  })), { submissionState: 'rejected' });
  assert.equal(rows(store)[0].status, 'rejected');
  assert.deepEqual(queue.inspect(), { closed: false, pending: 0, active: 0, pendingBytes: 0 });
  await queue.run(args('next'), async ticket => { await ticket.beforeSubmit(); });
  assert.equal(rows(store)[1].status, 'succeeded'); queue.close();
});

test('queued identity is captured and cannot be redirected by editing the input object', async () => {
  const store = fixture(), queue = createImageServiceQueue({ store }), gate = deferred(), begun = deferred();
  const held = queue.run(args('held'), async ticket => { await ticket.beforeSubmit(); begun.resolve(); await gate.promise; });
  await begun.promise;
  const input = args('captured'), waiting = queue.run(input, async ticket => { await ticket.beforeSubmit(); });
  input.apiKey = 'changed'; input.attemptId = 'different'; input.namespace = 'account-b';
  gate.resolve(); await Promise.all([held, waiting]);
  assert.equal(rows(store)[1].attemptId, 'captured'); assert.equal(rows(store)[1].namespace, 'account-a');
  assert.equal(store.records.size, 1); queue.close();
});
