import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createComfyRecoveryClient } from '../qianmu-comfy-recovery-client.js';
import { normalizeComfyDelivery, createComfyDeliveryStore } from '../qianmu-comfy-delivery-store.js';
import { comfyArchiveFilename } from '../qianmu-comfy-submission.js';
import { sanitizeStoryboardSnapshot, getStoryboardComfyTransport } from '../qianmu-storyboard.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const origin = 'https://st.test', receipt = 'a'.repeat(64);
const job = (extra = {}) => ({ id: 'attempt-a', source: 'comfy', logId: 'log-a', chatKey: 'chat-a', automatic: true, profile: { model: 'workflow' },
  connection: { baseUrl: 'https://comfy.test/api', credentialId: 'original-key', allowPrivateNetwork: false, options: { comfyTransport: 'gateway' } },
  imageAdmission: { version: 1, namespace: 'st-user:alice', attemptId: 'attempt-a' }, ...extra });
const result = (count = 2) => ({ ok: true, status: 'ready', images: Array.from({ length: count }, () => ({ data: 'aW1hZ2U=', mime: 'image/png' })), comfyTask: { version: 1, attemptId: 'attempt-a', resultStored: true, receipt } });
const json = body => new Response(JSON.stringify(body));
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
function setup(options = {}) {
  const rows = new Map(), calls = []; let namespace = 'st-user:alice', held = false;
  const store = { get: async (ns, id) => structuredClone(rows.get(`${ns}/${id}`) || null), put: async row => { rows.set(`${row.namespace}/${row.attemptId}`, structuredClone(row)); }, close() {} };
  const locks = { request: async (_key, _opts, work) => { if (held) return work(null); held = true; try { return await work({}); } finally { held = false; } } };
  const configuration = { origin, store, locks, account: async () => namespace, headers: () => ({ 'Content-Type': 'application/json' }),
    fetchImpl: async (url, init) => { const action = url.split('/').at(-1), body = JSON.parse(init.body); calls.push({ action, body, init });
      assert.ok(['query','result','acknowledge'].includes(action));
      return options.respond ? options.respond(action, body) : json(action === 'query' ? { ok: true, task: { resultStored: true, live: false } } : action === 'result' ? result() : { ok: true }); }, ...options.configuration };
  return { rows, calls, configuration, client: createComfyRecoveryClient(configuration), switchAccount: value => { namespace = value; } };
}
const callback = async (data, files, checkpoint, guard) => { await guard(); await checkpoint(data.images.map((_, index) => ({ url: files[index]?.url || `/user/images/${index}.png`, prompt: 'must not persist' }))); return true; };

test('Comfy preparation is lazy, bounded to an identity and strips all recipe and credentials', async () => {
  const s = setup(); assert.equal(s.rows.size, 0); assert.equal(s.calls.length, 0);
  const binding = await s.client.prepare({ ...job(), workflow: 'large-workflow', apiKey: 'test-secret', prompt: 'garden' });
  assert.match(binding.expectedAccount, /^st-user:[a-f0-9]{64}$/); assert.equal(s.calls.length, 0);
  const row = [...s.rows.values()][0]; assert.equal(row.status, 'prepared'); assert.ok(JSON.stringify(row).length < 1024);
  for (const field of ['workflow','prompt','apiKey','profile','imageAdmission']) assert.equal(row[field], undefined);
});
test('normal delivery and repeated manual recovery share file checkpoints and never regenerate', async () => {
  const s = setup(); await s.client.prepare(job());
  assert.equal((await s.client.deliver(job(), result(), callback)).archived, true);
  assert.equal([...s.rows.values()][0].status, 'confirmed');
  assert.equal((await s.client.retrieve(job(), { deliver: () => assert.fail('already archived') })).archived, true);
  assert.deepEqual(s.calls.map(call => call.action), ['acknowledge']);
  const row = [...s.rows.values()][0]; assert.equal(row.files.length, 2); assert.equal(row.files[0].prompt, undefined);
});
test('interruption after one file resumes that checkpoint without uploading it again', async () => {
  const s = setup(); await s.client.prepare(job());
  await assert.rejects(s.client.deliver(job(), result(), async (_data, _files, checkpoint) => { await checkpoint([{ url: '/user/images/0.png' }]); throw Error('second file failed'); }), /second file/);
  assert.equal(s.calls.length, 0);
  const restarted = createComfyRecoveryClient(s.configuration);
  const received = await restarted.retrieve({ ...job(), automatic: false }, { apiKey: 'not-needed-cached-secret', deliver: async (data, files, checkpoint, guard) => {
    assert.deepEqual(files, [{ imageIndex: 0, url: '/user/images/0.png' }]); return callback(data, files, checkpoint, guard);
  } });
  assert.equal(received.archived, true); assert.deepEqual(s.calls.map(call => call.action), ['query','result','acknowledge']);
  assert.ok(!JSON.stringify(s.calls).includes('not-needed-cached-secret'));
});
test('lost acknowledgement retries only acknowledgement, not downloads or archival', async () => {
  let acks = 0;
  const s = setup({ respond: action => { assert.equal(action, 'acknowledge'); if (++acks === 1) throw Error('connection lost'); return json({ ok: true }); } });
  assert.ok((await s.client.deliver(job(), result(), callback)).warning);
  assert.equal([...s.rows.values()][0].status, 'archived');
  assert.equal((await s.client.retrieve(job(), { deliver: () => assert.fail('duplicate') })).archived, true);
  assert.equal([...s.rows.values()][0].status, 'confirmed'); assert.equal(acks, 2);
});
test('two clients cannot archive simultaneously and unsupported locks block before generation', async () => {
  const s = setup(), entered = deferred(), release = deferred();
  const running = s.client.deliver(job(), result(), async (...args) => { entered.resolve(); await release.promise; return callback(...args); });
  await entered.promise;
  const other = createComfyRecoveryClient(s.configuration);
  await assert.rejects(other.retrieve(job(), { deliver: callback }), { code: 'comfy_delivery_busy' });
  release.resolve(); await running;
  await assert.rejects(createComfyRecoveryClient({ ...s.configuration, locks: null }).prepare(job()), { code: 'comfy_delivery_lock', submissionState: 'not_submitted' });
});
test('account changes, connection replacement and hot teardown never authorize cleanup', async () => {
  for (const mode of ['account', 'close']) {
    const s = setup();
    await assert.rejects(s.client.deliver(job(), result(), async (_data, _files, checkpoint, guard) => {
      await checkpoint([{ url: '/user/images/0.png' }]); mode === 'account' ? s.switchAccount('st-user:bob') : s.client.close(); await guard(); return true;
    })); assert.equal(s.calls.length, 0);
  }
  const s = setup(); await s.client.prepare(job());
  await assert.rejects(s.client.retrieve(job({ connection: { ...job().connection, baseUrl: 'https://different.test' } }), { deliver: callback }), { code: 'comfy_delivery_identity' });
  assert.equal(s.calls.length, 0);
});
test('queued/running/missing history are status reports, not generation or cache cleanup', async () => {
  for (const status of ['queued','running','collecting','unavailable']) {
    const s = setup({ respond: action => json(action === 'query' ? { ok: true, task: { live: false, resultStored: false } } : { ok: true, status }) });
    const received = await s.client.retrieve(job(), { apiKey: 'original-test-secret', deliver: () => assert.fail('no image') });
    assert.equal(received.archived, false); assert.ok(received.warning);
    assert.deepEqual(s.calls.map(call => call.action), ['query','result']); assert.equal(s.calls[0].body.apiKey, undefined); assert.equal(s.calls[1].body.apiKey, 'original-test-secret');
  }
});
test('incomplete saves, foreign files and changed result identities retain server originals', async () => {
  const s = setup(); assert.equal((await s.client.deliver(job(), result(), async () => false)).archived, false);
  await assert.rejects(s.client.deliver(job(), result(), async (_data, _files, checkpoint) => { await checkpoint([{ url: 'https://elsewhere.test/x.png' }]); return true; }));
  await assert.rejects(s.client.deliver(job(), { ...result(), comfyTask: { ...result().comfyTask, receipt: 'b'.repeat(64) } }, callback), { code: 'comfy_delivery_identity' });
  await assert.rejects(s.client.deliver(job(), result(), async () => true), /检查点未完成/);
  assert.equal(s.calls.length, 0);
});
test('journal validates bounded metadata and requires actual browser persistence', async () => {
  const s = setup(); await s.client.prepare(job()); const row = [...s.rows.values()][0];
  const projected = normalizeComfyDelivery({ ...row, workflow: {}, apiKey: 'secret' }, origin); assert.equal(projected.apiKey, undefined);
  for (const change of [{ version: 2 }, { baseUrl: 'https://user:secret@test/' }, { imageCount: 9 }, { status: 'confirmed' }, { chatKey: 'a'.repeat(4097) }]) assert.throws(() => normalizeComfyDelivery({ ...row, ...change }, origin));
  const missing = createComfyDeliveryStore({ indexedDB: undefined, origin }); await assert.rejects(missing.put(row), /无法保存/); missing.close(); await assert.rejects(missing.get(row.namespace, row.attemptId), /会话已结束/);
});
test('archive filenames are stable per original account and attempt, independent of current character and time', async () => {
  const first = await comfyArchiveFilename(job(), 0);
  assert.equal(await comfyArchiveFilename(job(), 0), first); assert.match(first, /^qianmu_comfy_[a-f0-9]{64}_1$/);
  assert.notEqual(await comfyArchiveFilename(job(), 1), first);
  assert.notEqual(await comfyArchiveFilename(job({ imageAdmission: { ...job().imageAdmission, namespace: 'st-user:bob' } }), 0), first);
});
test('production log gate distinguishes gateway, legacy gateway evidence, browser-only and unrelated providers', () => {
  const context = vm.createContext({ getStoryboardComfyTransport }); vm.runInContext(storyboardFunctionSource('storyboardCanReceiveComfyLog'), context);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job() }), true);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job({ connection: { options: { comfyTransport: 'browser' } } }) }), false);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job({ connection: {}, comfyServiceTask: { version: 1 } }) }), true);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job({ source: 'novel' }) }), false);
  assert.equal(sanitizeStoryboardSnapshot({ ...job(), comfyServiceTask: { version: 1, attemptId: job().id } }).comfyServiceTask.attemptId, job().id);
});
test('production normal and manual UI are wired to the same client and preserve original credentials', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /sd-storyboard-receive-comfy/); assert.match(source, /storyboardComfyRecovery\?\.close\(\)/);
  const receive = storyboardFunctionSource('storyboardReceiveComfyImage');
  assert.match(storyboardFunctionSource('storyboardResolveComfyRecoveryKey'), /exact: true/); assert.match(receive, /archiveFiles, checkpoint,/); assert.doesNotMatch(receive, /storyboardRetryLog|generateImage/);
});

test('recovery credential cannot silently fall back to a draft key for a different host', async () => {
  let reads = 0;
  const state = { connections: { comfy: { draft: { credentialId: 'original-key', baseUrl: 'https://new.test' }, presets: [] } } };
  const context = vm.createContext({ URL, storyboardState: () => state, storyboardResolveApiKey: async (_provider, key, options) => { reads++; assert.equal(key, 'original-key'); assert.equal(options.exact, true); return 'original-secret'; } });
  vm.runInContext(storyboardFunctionSource('storyboardResolveComfyRecoveryKey'), context);
  assert.equal(await context.storyboardResolveComfyRecoveryKey(job().connection), ''); assert.equal(reads, 0);
  state.connections.comfy.presets.push(job().connection);
  assert.equal(await context.storyboardResolveComfyRecoveryKey(job().connection), ''); assert.equal(reads, 0, 'conflicting owners of the same credential are not proof');
  state.connections.comfy.draft = job().connection;
  assert.equal(await context.storyboardResolveComfyRecoveryKey(job().connection), 'original-secret'); assert.equal(reads, 1);
});

test('recovery timing never labels offline waiting days as GPU generation time', () => {
  const log = { startedAt: 1, queuedAt: 1 }, pipeline = {};
  const context = vm.createContext({ storyboardPipelineForLog: () => pipeline, saveSettings() {}, storyboardArchivePipelineLog: async () => {} });
  vm.runInContext(storyboardFunctionSource('storyboardFinishLog'), context);
  context.storyboardFinishLog(log, 'success', { durationMs: 0 });
  assert.equal(log.durationMs, 0); assert.equal(pipeline.durationMs, 0);
  assert.match(storyboardFunctionSource('storyboardDeliverGatewayResult'), /job.recoveringOriginal \? \{ durationMs:/);
});

test('client freezes only original identity while account/storage checks are in flight', async () => {
  const gate = deferred(), entered = deferred(); let first = true;
  const s = setup({ configuration: { account: async () => { if (first) { first = false; entered.resolve(); await gate.promise; } return 'st-user:alice'; } } });
  const original = job(), preparing = s.client.prepare(original); await entered.promise;
  original.connection.baseUrl = 'https://new.test'; original.chatKey = 'new-chat'; gate.resolve(); await preparing;
  const row = [...s.rows.values()][0]; assert.equal(row.baseUrl, 'https://comfy.test/api'); assert.equal(row.chatKey, 'chat-a');
});

test('actual manual receive controller preserves original log, guards chat switches and confirms local admission only after archive', async () => {
  for (const switchChat of [false, true]) {
    const log = { id: 'log-a', snapshot: job(), error: 'old failure', durationMs: 250 }, calls = [], notices = [];
    let chat = 'chat-a';
    const context = vm.createContext({ sanitizeStoryboardSnapshot, getStoryboardComfyTransport, getChatKey: () => chat,
      storyboardResolveComfyRecoveryKey: async () => 'original-test-key',
      storyboardComfyRecoveryRuntime: async () => ({ retrieve: async (frozen, options) => {
        assert.equal(frozen.id, 'attempt-a'); assert.equal(frozen.recoveringOriginal, true); assert.equal(options.apiKey, 'original-test-key');
        if (switchChat) chat = 'other-chat';
        const archived = await options.deliver(result(), [{ imageIndex: 0, url: '/user/images/0.png' }], async () => {}, async () => calls.push('account'));
        return { archived };
      } }),
      storyboardDeliverGatewayResult: async (_job, original, _data, options) => {
        assert.equal(original, log); assert.equal(options.service, true); assert.equal(options.archiveFiles.length, 1); await options.guard(); calls.push('archive'); return true;
      }, storyboardFinishLog: (original, status, details) => { assert.equal(original, log); assert.equal(status, 'success'); assert.equal(details.durationMs, 250); calls.push('finish'); },
      storyboardImageAdmissionRuntime: async () => ({ confirmResult: async admission => { assert.equal(admission.attemptId, 'attempt-a'); calls.push('admission'); } }),
      toast: message => notices.push(message), renderModal() {},
    });
    vm.runInContext(['storyboardCanReceiveComfyLog','storyboardReceiveComfyImage'].map(storyboardFunctionSource).join('\n'), context);
    await context.storyboardReceiveComfyImage(log);
    assert.deepEqual(calls, switchChat ? ['account'] : ['account','archive','finish','admission']);
    assert.match(notices[0], switchChat ? /聊天已切换/ : /已领取并归档/);
  }
});
