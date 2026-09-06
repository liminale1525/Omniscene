import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { generateDirectImage, isDirectImageTransportError } from '../qianmu-image-direct.js';
import { createImageAdmission, createImageAdmissionIdentity, createImageHistorySeeds, resolveImageAccountNamespace } from '../qianmu-image-admission.js';
import { beginImageAttempt, continueImageAttempt, claimImageAttempt, importImageAttempts, settleImageAttempt, imageAttemptScopeKey, summarizeImageAttempts, IMAGE_RESERVATION_TTL_MS } from '../qianmu-image-attempts.js';

const NOW = 1_780_000_000_000;
const job = (extra = {}) => ({ id: 'job-a', chatKey: 'chat-a', messageRef: { messageKey: 'floor-a', revisionId: 'rev-a' },
  prompt: 'garden', target: 'floor', automatic: true, profile: { count: '1' }, shotType: 'environment',
  paragraphAnchor: { paragraphIndex: 1 }, ...extra });
function storage(rows = new Map()) {
  let time = NOW, closed = false;
  const run = (scope, fn) => {
    if (closed) throw new Error('closed store');
    const key = imageAttemptScopeKey(scope), result = fn(rows.get(key));
    rows.set(key, structuredClone(result.ledger)); return result;
  };
  return {
    rows, advance: ms => { time += ms; }, close: () => { closed = true; },
    claim: async (scope, input, seeds = []) => run(scope, value => claimImageAttempt(importImageAttempts(value, scope, seeds, time), scope, input, time)),
    begin: async (scope, input) => run(scope, value => beginImageAttempt(value, scope, input, time)),
    continue: async (scope, input) => run(scope, value => continueImageAttempt(value, scope, input, time)),
    settle: async (scope, input) => run(scope, value => settleImageAttempt(value, scope, input, time)),
    inspect: scope => summarizeImageAttempts(rows.get(imageAttemptScopeKey(scope)), scope, time),
  };
}
const setup = (options = {}) => {
  const store = options.store || storage();
  return { store, runtime: createImageAdmission({ store, account: async () => 'account-a', ownerId: 'page-a', ...options }) };
};
const admit = (runtime, value, extra = {}) => runtime.admit(value, { maxAutomatic: 3, ...extra });
const scopeOf = value => ({ namespace: 'account-a', chatKey: value.chatKey, messageKey: value.messageRef.messageKey, revisionId: value.messageRef.revisionId });

test('account scope uses the real ST account, not an unresolved helper fallback or persona', async () => {
  const resolve = (module, fetchImpl = () => assert.fail('unnecessary account network')) => resolveImageAccountNamespace({ loadUser: async () => module, fetchImpl });
  assert.equal(await resolve({ currentUser: { handle: 'alice' }, accountsEnabled: true }), 'st-user:alice');
  assert.equal(await resolve({ currentUser: null, accountsEnabled: false }, async () => new Response(JSON.stringify({ handle: 'default-user' }))), 'st-user:default-user');
  let calls = 0;
  const namespace = await resolve({ accountsEnabled: true, getCurrentUserHandle: () => 'default-user' }, async (url, init) => {
    calls++; assert.equal(url, '/api/users/me'); assert.equal(init.cache, 'no-store');
    return new Response(JSON.stringify({ handle: 'bob' }));
  });
  assert.equal(namespace, 'st-user:bob'); assert.equal(calls, 1);
});

test('missing or unauthorized account identity blocks instead of sharing a default budget', async () => {
  for (const response of [new Response('{}', { status: 401 }), new Response('{}'), new Response('{')]) {
    await assert.rejects(resolveImageAccountNamespace({ loadUser: async () => { throw new Error('older ST'); }, fetchImpl: async () => response }), { code: 'image_attempt_account' });
  }
});

test('uninitialized account flags and stalled module loading cannot invent a shared account or block forever', async () => {
  await assert.rejects(resolveImageAccountNamespace({ loadUser: async () => ({ accountsEnabled: false }), fetchImpl: async () => new Response('{}', { status: 403 }) }), { code: 'image_attempt_account' });
  await assert.rejects(resolveImageAccountNamespace({ timeoutMs: 100, loadUser: () => new Promise(() => {}), fetchImpl: () => assert.fail('expired import must not continue') }), { code: 'image_attempt_account' });
});

test('logical shots ignore model, artist and seed but separate source paragraphs and explicit variants', async () => {
  const original = await createImageAdmissionIdentity(job(), 'account-a');
  const restyled = await createImageAdmissionIdentity(job({ source: 'other', artistString: 'another artist', profile: { seed: '25' } }), 'account-a');
  assert.deepEqual(original, restyled);
  for (const patch of [{ paragraphAnchor: { paragraphIndex: 2 } }, { requestIndex: 2 }, { shotType: 'closeup' }]) {
    assert.notEqual((await createImageAdmissionIdentity(job(patch), 'account-a')).logicalShotId, original.logicalShotId);
  }
  await assert.rejects(createImageAdmissionIdentity(job({ target: 'gallery', messageRef: null }), 'account-a'), { code: 'image_attempt_identity' });
  assert.equal((await createImageAdmissionIdentity(job({ target: 'gallery', messageRef: null, automatic: false }), 'account-a')).scope.messageKey, 'gallery-only');
});

test('two pages cannot reserve the same scene through different UI entry points', async () => {
  const rows = new Map(), a = setup({ store: storage(rows) }), b = setup({ store: storage(rows), ownerId: 'page-b' });
  const results = await Promise.allSettled([admit(a.runtime, job()), admit(b.runtime, job({ id: 'job-b', automatic: false, attempt: 2 }))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'image_attempt_busy');
});

test('duplicate clicks on the same in-memory job fail while account resolution is still pending', async () => {
  let ready; const { runtime } = setup({ account: () => new Promise(resolve => { ready = resolve; }) });
  const value = job(), pending = admit(runtime, value);
  await assert.rejects(admit(runtime, value), { code: 'image_attempt_busy' });
  ready('account-a'); assert.equal(await pending, true);
});

test('success and uncertain outcomes persist across refreshed runtimes and exhaust automatic slots', async () => {
  const { runtime, store } = setup();
  const a = job(); await admit(runtime, a, { maxAutomatic: 1 }); await runtime.beforeSubmit(a); await runtime.settle(a, 'unknown');
  const refreshed = setup({ store: storage(store.rows), ownerId: 'new-page' });
  await assert.rejects(admit(refreshed.runtime, job({ id: 'next', prompt: 'different garden' }), { maxAutomatic: 1 }), { code: 'image_attempt_budget_exhausted' });
  await assert.rejects(admit(refreshed.runtime, job({ id: 'same' })), { code: 'image_attempt_confirmation_required' });
});

test('expired dispatch is uncertain, not permanently busy and not free after a crash', async () => {
  const { runtime, store } = setup(), original = job();
  await admit(runtime, original); await runtime.beforeSubmit(original); store.advance(IMAGE_RESERVATION_TTL_MS + 1);
  const copied = storage(store.rows); copied.advance(IMAGE_RESERVATION_TTL_MS + 1);
  let confirmations = 0;
  const next = setup({ store: copied, ownerId: 'new-page', confirm: async () => { confirmations++; return true; } });
  await admit(next.runtime, job({ id: 'retry', automatic: false, imageAdmission: original.imageAdmission }));
  assert.equal(confirmations, 1); assert.equal(copied.inspect(scopeOf(original)).automaticUsed, 1);
});

test('all manual entry types share uncertain-result confirmation; declining sends nothing', async () => {
  for (const kind of ['log', 'inline', 'gallery']) {
    let confirmations = 0; const { runtime } = setup({ confirm: async () => { confirmations++; return false; } });
    const original = job(); await admit(runtime, original); await runtime.beforeSubmit(original); await runtime.settle(original, 'unknown');
    await assert.rejects(admit(runtime, job({ id: `retry-${kind}`, automatic: false, imageAdmission: original.imageAdmission })), { code: 'image_attempt_confirmation_required' });
    assert.equal(confirmations, 1);
  }
});

test('a confirmation becomes invalid if a previously unseen uncertain attempt appears', async () => {
  const store = storage(), original = job(); let confirmations = 0;
  const { runtime } = setup({ store, confirm: async () => {
    confirmations++;
    const ledger = store.rows.get(imageAttemptScopeKey(scopeOf(original)));
    ledger.entries.push({ ...ledger.entries[0], attemptId: 'other-uncertain' });
    return true;
  } });
  await admit(runtime, original); await runtime.beforeSubmit(original); await runtime.settle(original, 'unknown');
  await assert.rejects(admit(runtime, job({ id: 'retry', automatic: false, imageAdmission: original.imageAdmission })), { code: 'image_attempt_confirmation_required' });
  assert.equal(confirmations, 1);
});

test('a known upstream rejection releases a slot while manual redraw stays in the existing automatic group', async () => {
  const { runtime, store } = setup(), original = job();
  await admit(runtime, original, { maxAutomatic: 1 }); await runtime.beforeSubmit(original); await runtime.settle(original, 'rejected');
  const replacement = job({ id: 'replacement' }); await admit(runtime, replacement, { maxAutomatic: 1 });
  await runtime.beforeSubmit(replacement); await runtime.settle(replacement, 'succeeded');
  const redraw = job({ id: 'redraw', automatic: false, imageAdmission: replacement.imageAdmission });
  await admit(runtime, redraw, { maxAutomatic: 1 });
  assert.equal(store.inspect(scopeOf(original)).automaticUsed, 1);
  await admit(runtime, job({ id: 'supplement', automatic: false, manualSupplement: true, paragraphAnchor: { paragraphIndex: 3 } }), { maxAutomatic: 1 });
  assert.equal(store.inspect(scopeOf(original)).automaticUsed, 1);
});

test('only a live receipt can continue a known 429 retry; clearing its ledger stops further POSTs', async () => {
  const { runtime, store } = setup(), original = job(); await admit(runtime, original);
  await runtime.beforeSubmit(original); await runtime.beforeSubmit(original);
  assert.equal(store.inspect(scopeOf(original)).attempts, 1);
  store.rows.clear();
  await assert.rejects(runtime.beforeSubmit(original), { code: 'image_attempt_missing_dispatch' });
  const refreshed = setup({ store: storage(store.rows) });
  await assert.rejects(refreshed.runtime.beforeSubmit(original), { code: 'image_attempt_missing_reservation' });
});

test('changed account and disabled authorization stop a reserved job before dispatch', async () => {
  let account = 'account-a'; const { runtime, store } = setup({ account: async () => account }), original = job();
  await admit(runtime, original); account = 'account-b';
  await assert.rejects(runtime.beforeSubmit(original), { code: 'image_attempt_account_changed' });
  account = 'account-a'; await assert.rejects(runtime.beforeSubmit(original, () => false), { code: 'image_attempt_cancelled' });
  await runtime.settle(original, 'not_submitted'); assert.equal(store.inspect(scopeOf(original)).automaticUsed, 0);
});

test('late admission after a context change releases its reservation and never enters dispatch', async () => {
  const store = storage(), claim = store.claim; let valid = true;
  store.claim = async (...args) => { const result = await claim(...args); valid = false; return result; };
  const { runtime } = setup({ store }), original = job();
  await assert.rejects(admit(runtime, original, { valid: () => valid }), { code: 'image_attempt_cancelled' });
  assert.equal(store.inspect(scopeOf(original)).automaticUsed, 0); assert.equal(original.imageAdmission, undefined);
});

test('legacy results are conservatively imported without carrying prompts, keys or media', async () => {
  const { runtime } = setup(), original = job(), identity = await createImageAdmissionIdentity(original, 'account-a');
  const rows = [{ id: 'old-log', status: 'success', snapshot: { ...original, connection: { apiKey: 'secret' } } },
    { id: 'old-image', logId: 'old-log', url: 'data:image/png;base64,large', ...original }];
  const seeds = await createImageHistorySeeds(rows, identity);
  assert.equal(seeds.length, 1); assert.equal(seeds[0].automaticSlot, true);
  assert.doesNotMatch(JSON.stringify(seeds), /secret|garden|base64|connection/);
  await assert.rejects(admit(runtime, job({ id: 'next', prompt: 'other' }), { history: rows, maxAutomatic: 1 }), { code: 'image_attempt_budget_exhausted' });
});

test('legacy uncertain requests prompt once through common admission, not only the log button', async () => {
  let confirmations = 0; const { runtime } = setup({ confirm: async () => { confirmations++; return true; } });
  const original = job();
  await admit(runtime, job({ id: 'retry', automatic: false, attempt: 2 }), { history: [{ id: 'old', status: 'failed', submissionState: 'unknown', snapshot: original }] });
  assert.equal(confirmations, 1);
});

test('legacy log and its gallery images count once; a compact manual archive keeps its explicit budget provenance', async () => {
  const original = job(), identity = await createImageAdmissionIdentity(original, 'account-a');
  const seeds = await createImageHistorySeeds([
    { id: 'old-log', status: 'success', recordIds: ['image-a', 'image-b'], snapshot: original },
    { ...original, id: 'image-a', url: 'a.png', groupId: 'old-job' },
    { ...original, id: 'image-b', url: 'b.png', groupId: 'old-job' },
  ], identity);
  assert.equal(seeds.length, 1);
  const { runtime } = setup(), manual = job({ automatic: false }); await admit(runtime, manual);
  const compact = { ...manual, id: 'compact-image', url: 'c.png', snapshotRef: 'local-only', snapshot: undefined };
  const restored = await createImageHistorySeeds([compact], identity);
  assert.equal(restored[0].attemptId, manual.id); assert.equal(restored[0].automaticSlot, false);
});

test('legacy interrupted requests with a start time are uncertain even without newer submission-state fields', async () => {
  const original = job(), identity = await createImageAdmissionIdentity(original, 'account-a');
  const seeds = await createImageHistorySeeds([
    { id: 'cancelled-after-start', status: 'cancelled', startedAt: 123, snapshot: original },
    { id: 'never-started', status: 'cancelled', startedAt: 0, snapshot: original },
  ], identity);
  assert.equal(seeds.length, 1); assert.equal(seeds[0].status, 'unknown');
});

test('closing the plugin releases waiting requests, retains submitted uncertainty and blocks new work', async () => {
  const rows = new Map(), { runtime } = setup({ store: storage(rows) }), first = job(), second = job({ id: 'second', prompt: 'lake' });
  await admit(runtime, first); await admit(runtime, second); await runtime.beforeSubmit(first); await runtime.close();
  const summary = storage(rows).inspect(scopeOf(first));
  assert.equal(summary.automaticUsed, 1); assert.equal(summary.uncertain, 1); assert.equal(summary.pending, 0);
  await assert.rejects(admit(runtime, job({ id: 'later' })), { code: 'image_attempt_cancelled' });
});

test('storage refusal never creates a usable in-memory receipt', async () => {
  const { runtime } = setup({ store: { claim: async () => { throw Object.assign(new Error('full disk'), { code: 'image_attempt_storage' }); } } });
  const original = job(); await assert.rejects(admit(runtime, original), { code: 'image_attempt_storage' });
  await assert.rejects(runtime.beforeSubmit(original), { code: 'image_attempt_missing_reservation' });
});

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const found = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(found, name); const tail = source.slice(found.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function liveHarness({ failure = '', confirm = async () => true } = {}) {
  const { store, runtime } = setup({ confirm }), state = { enabled: true, logs: [], automation: { autoCapture: true, autoGenerate: true } };
  const gallery = [], waiting = [], notices = [], writes = [];
  const context = vm.createContext({
    clone: structuredClone, storyboardAdmission: runtime, storyboardImageAdmissionRuntime: async () => runtime, storyboardState: () => state,
    getChatKey: () => 'chat-a', storyboardValidatedAnchor: () => ({ valid: true, floor: 0 }),
    STORYBOARD_QUEUE_LIMIT: 8, storyboardQueue: waiting, storyboardActiveJobs: new Map(),
    getStoryboardGenerationPolicy: () => ({ maxImages: 1 }), storyboardGalleryRecords: () => gallery,
    resolveStoryboardJobModelIdentity: () => ({ modelFamily: 'openai' }),
    storyboardStartLog: value => { const log = { id: `log-${state.logs.length}`, status: 'queued', snapshot: structuredClone(value) }; state.logs.push(log); return log; },
    storyboardSetPlanStatus: () => {}, storyboardPlanForJob: () => null, storyboardPumpQueue: () => {},
    saveSettings: () => {}, renderModal: () => {}, MODULE_NAME: 'isolated-test', console: { error: () => {}, warn: () => {} },
    storyboardMarkLogGenerating: value => { value.status = 'generating'; }, storyboardPipelineStage: () => {}, storyboardPipelineForLog: () => null,
    storyboardPrepareGatewayAssets: async () => ({}), storyboardResolveApiKey: async () => 'mock',
    storyboardGatewayRequest: value => ({ provider: 'openai', model: 'gpt-image-1', baseUrl: 'https://images.invalid', apiKey: 'mock', prompt: value.prompt, parameters: { count: 1 } }),
    directImageRuntime: async () => ({ isDirectImageTransportError, generateDirectImage: (input, options) => generateDirectImage(input, {
      ...options, fetchImpl: async (_url, init) => {
        if (init.method === 'GET') return new Response('{}');
        writes.push(init.method);
        if (failure === 'unknown') throw new TypeError('response lost');
        if (failure === 'rejected') return new Response('denied', { status: 401 });
        return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }));
      },
    }) }),
    storyboardConfirmGatewayModelBinding: () => assert.fail('post failures must not fall back'),
    storyboardPersistGatewayImage: async () => 'https://images.invalid/result.png',
    storyboardCreateRecord: (value, log, url) => ({ id: 'record', logId: log.id, snapshot: log.snapshot, url }),
    saveMetadata: async () => {}, storyboardArchiveGallerySnapshots: async () => {},
    storyboardFinishLog: (log, status, detail) => Object.assign(log, { status }, detail),
    toast: message => { notices.push(message); return false; },
  });
  vm.runInContext(['storyboardSettleImageAdmission', 'storyboardQueueJob', 'storyboardDeliverGatewayResult', 'storyboardRunJob', 'storyboardClearWaitingQueue', 'storyboardRetryLog'].map(section).join('\n'), context);
  return { context, state, gallery, waiting, notices, writes, store, runtime };
}
const liveJob = extra => job({ source: 'openai', profile: { count: '1', model: 'gpt-image-1' },
  payload: { prompt: 'garden', parameters: { count: 1 } }, connection: { baseUrl: 'https://images.invalid', credentialId: 'mock' }, ...extra });

test('real queue and runner reserve before POST, persist success and reject automatic duplicate after logs are cleared', async () => {
  const h = liveHarness(), original = liveJob();
  assert.equal(await h.context.storyboardQueueJob(original), true);
  assert.equal(h.store.inspect(scopeOf(original)).pending, 1); assert.equal(h.writes.length, 0);
  await h.context.storyboardRunJob(original, h.state.logs[0]);
  assert.equal(h.writes.length, 1); assert.equal(h.state.logs[0].status, 'success'); assert.equal(h.gallery.length, 1);
  assert.equal(h.store.inspect(scopeOf(original)).ledger.entries[0].status, 'succeeded');
  h.state.logs = []; h.gallery.length = 0;
  assert.equal(await h.context.storyboardQueueJob(liveJob({ id: 'duplicate' })), false);
  assert.equal(h.writes.length, 1);
});

test('real runner keeps an unknown POST occupied and a log retry uses the same confirmation layer', async () => {
  let confirmations = 0;
  const h = liveHarness({ failure: 'unknown', confirm: async () => { confirmations++; return false; } }), original = liveJob();
  await h.context.storyboardQueueJob(original); await h.context.storyboardRunJob(original, h.state.logs[0]);
  assert.equal(h.writes.length, 1); assert.equal(h.state.logs[0].submissionState, 'unknown');
  h.context.storyboardJobFromLog = log => ({ ...structuredClone(log.snapshot), id: 'retry', automatic: false, attempt: 2 });
  assert.equal(await h.context.storyboardRetryLog(h.state.logs[0]), false);
  assert.equal(confirmations, 1); assert.equal(h.writes.length, 1); assert.equal(h.store.inspect(scopeOf(original)).automaticUsed, 1);
});

test('real runner releases known rejection and queued cancellation, but never manufactures a paid success', async () => {
  const h = liveHarness({ failure: 'rejected' }), original = liveJob();
  await h.context.storyboardQueueJob(original); await h.context.storyboardRunJob(original, h.state.logs[0]);
  assert.equal(h.state.logs[0].status, 'failed'); assert.equal(h.store.inspect(scopeOf(original)).automaticUsed, 0);
  h.context.storyboardQueue = []; h.waiting.length = 0;
  const next = liveJob({ id: 'waiting' }); await h.context.storyboardQueueJob(next);
  h.context.storyboardClearWaitingQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.store.inspect(scopeOf(original)).automaticUsed, 0); assert.equal(h.writes.length, 1); assert.equal(h.gallery.length, 0);
});

test('manual supplement provider retry uses the frozen log and never invokes LLM extraction again', async () => {
  let retried = 0;
  const plan = { id: 'supplement', origin: 'manual_supplement', floor: 0, status: 'failed' }, log = { id: 'log', snapshot: { planId: plan.id } };
  const context = vm.createContext({ storyboardState: () => ({ enabled: true, logs: [log] }), ctx: () => ({ chat: [{ mes: 'garden' }] }), getChatKey: () => 'chat',
    storyboardPlanRetries: new WeakSet(), storyboardRetryLog: async current => { assert.equal(current, log); retried++; return true; },
    storyboardCompilePrompt: () => assert.fail('must reuse provider snapshot'), toast: () => false,
  });
  vm.runInContext(section('storyboardRetryPlan'), context);
  assert.equal(await context.storyboardRetryPlan(plan), true); assert.equal(retried, 1);
});

test('supplement archive loading cannot overwrite another chat or start late LLM work', async () => {
  let chatKey = 'original', finish;
  const message = { mes: 'garden' }, state = { enabled: true, logs: [], target: 'unchanged' };
  const plan = { id: 'plan', floor: 0, origin: 'manual_supplement', status: 'failed', archiveRef: 'archive' };
  const context = vm.createContext({ storyboardState: () => state, ctx: () => ({ chat: [message] }), getChatKey: () => chatKey,
    storyboardPlanRetries: new WeakSet(), storyboardReleasePlanArchive: () => new Promise(resolve => { finish = resolve; }),
    storyboardCompilePrompt: () => assert.fail('stale archive must stop'), toast: () => false,
  });
  vm.runInContext(section('storyboardRetryPlan'), context);
  const pending = context.storyboardRetryPlan(plan); chatKey = 'another'; finish();
  assert.equal(await pending, false); assert.equal(state.target, 'unchanged');
});
