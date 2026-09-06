import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as serviceCapabilities from '../qianmu-service-capabilities.js';
import { imageGatewayCapabilities } from '../qianmu-image-gateway.js';
import {
  STORYBOARD_PROVIDER_REGISTRY, STORYBOARD_MODEL_REGISTRY, STORYBOARD_PIPELINE_LOG_LIMIT,
  createStoryboardDefaults, getStoryboardModel, resolveStoryboardJobModelIdentity,
  resolveStoryboardConnectionBinding,
  sanitizeStoryboardSnapshot, sanitizeStoryboardDiagnosticData, pruneStoryboardPipelineLogs,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full', V5 = 'nai-diffusion-5-full';
const makeJob = (extra = {}) => ({
  source: 'novel', profile: { model: V3, cfg: '5', steps: '28' }, target: 'gallery',
  connection: { id: 'conn-a', credentialId: 'key-ref-a', baseUrl: 'https://relay.example', model: V3 },
  payload: { prompt: 'original garden', negative: 'original negative', parameters: { scale: 5, steps: 28 } },
  prompt: 'original garden', negative: 'original negative', ...extra,
});
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const tail = source.slice(match.index);
  const next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function load(name, deps = {}) {
  return vm.runInNewContext(`${section('storyboardConfirmGatewayProtocolBinding')}\n${section(name)}\n${name}`, {
    clone: structuredClone, STORYBOARD_PROVIDER_REGISTRY, resolveStoryboardJobModelIdentity, resolveStoryboardConnectionBinding, ...deps,
  });
}

test('registered generation jobs freeze family, capability, remote name and connection reference', () => {
  for (const [family, models] of Object.entries(STORYBOARD_MODEL_REGISTRY)) {
    for (const model of models) {
      const job = makeJob({ source: family, profile: { model: model.id } });
      const before = structuredClone(job);
      const identity = resolveStoryboardJobModelIdentity(job);
      assert.equal(identity.version, 1);
      assert.equal(identity.modelFamily, family);
      assert.equal(identity.capabilityModelId, model.id);
      assert.equal(identity.remoteModelId, model.id);
      assert.equal(identity.protocol, STORYBOARD_PROVIDER_REGISTRY[family].protocol);
      assert.equal(identity.connectionPresetId, 'conn-a');
      assert.equal(Object.isFrozen(identity), true);
      assert.deepEqual(job, before);
      assert.equal(Object.hasOwn(identity, 'credentialId'), false);
    }
  }
});

test('old custom OpenAI names survive and unsupported native aliases are never defaulted', () => {
  const job = makeJob({ source: 'openai', profile: { model: 'vendor/custom-image-v1' } });
  assert.equal(resolveStoryboardJobModelIdentity(job).remoteModelId, 'vendor/custom-image-v1');
  assert.throws(() => resolveStoryboardJobModelIdentity(makeJob({ profile: { model: 'vendor/unknown-nai' } })), { code: 'missing_capability_model' });
  assert.throws(() => resolveStoryboardJobModelIdentity(makeJob({ profile: { model: '' } })), { code: 'missing_model_snapshot' });
  assert.throws(() => resolveStoryboardJobModelIdentity(makeJob({ source: 'constructor' })), { code: 'invalid_model_family' });
  assert.equal(resolveStoryboardJobModelIdentity(makeJob({ source: 'comfy', profile: {} })).remoteModelId, 'comfy-workflow');
});

test('explicit alias snapshots remain intact through archive sanitization and JSON reload', () => {
  const job = makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } });
  job.modelIdentity = resolveStoryboardJobModelIdentity(job);
  const restored = sanitizeStoryboardSnapshot(JSON.parse(JSON.stringify(job)));
  assert.equal(restored.modelIdentity.remoteModelId, 'vendor/NAI-alias');
  assert.equal(restored.modelIdentity.capabilityModelId, V45);
  assert.deepEqual(resolveStoryboardJobModelIdentity(restored), job.modelIdentity);
  assert.equal(restored.payload.prompt, 'original garden');
});

test('changed model, family, capability or connection cannot override frozen identity', () => {
  const job = makeJob();
  job.modelIdentity = resolveStoryboardJobModelIdentity(job);
  for (const [extra, code] of [
    [{ source: 'banana' }, 'model_family_mismatch'],
    [{ profile: { model: V45 } }, 'model_snapshot_mismatch'],
    [{ profile: { model: V3, capabilityModelId: V5 } }, 'model_snapshot_mismatch'],
    [{ connection: { ...job.connection, id: 'conn-b' } }, 'connection_snapshot_mismatch'],
  ]) assert.throws(() => resolveStoryboardJobModelIdentity({ ...job, ...extra }), { code });
  const unchanged = resolveStoryboardJobModelIdentity({ ...job, connection: { ...job.connection, model: V5 } });
  assert.equal(unchanged.remoteModelId, V3, 'legacy connection.model is not a model binding and cannot change the actual request');
});

test('malformed or unknown identity versions require explicit confirmation', () => {
  const job = makeJob(), identity = resolveStoryboardJobModelIdentity(job);
  for (const modelIdentity of [{}, [], 'wrong', { ...identity, version: 2 }, { ...identity, capabilityModelId: '' }, { ...identity, connectionPresetId: null }]) {
    assert.throws(() => resolveStoryboardJobModelIdentity({ ...job, modelIdentity }), { code: 'invalid_model_identity' });
  }
  assert.throws(() => resolveStoryboardJobModelIdentity({ ...job, modelIdentity: { ...identity, remoteModelId: 'x'.repeat(241) } }), { code: 'invalid_model_id' });
  assert.throws(() => resolveStoryboardJobModelIdentity({ ...job, modelIdentity: { ...identity, protocol: 'openai-images' } }), { code: 'model_protocol_mismatch' });
});

test('actual gateway request carries frozen remote ID and capability, not a new connection model', () => {
  const build = load('storyboardGatewayRequest');
  const job = makeJob({ profile: { model: 'vendor/custom-nai', capabilityModelId: V45 } });
  job.modelIdentity = resolveStoryboardJobModelIdentity(job);
  const before = structuredClone(job);
  const request = build(job, 'mock-key', { references: [], vibes: [] });
  assert.equal(request.model, 'vendor/custom-nai');
  assert.equal(request.capabilityModelId, V45);
  assert.equal(request.provider, 'novel');
  assert.equal(request.baseUrl, 'https://relay.example');
  assert.equal(request.parameters.scale, 5);
  assert.equal(request.prompt, 'original garden');
  request.parameters.scale = 99;
  assert.deepEqual(job, before);
  job.profile.model = V5;
  assert.throws(() => build(job, 'mock-key', { references: [], vibes: [] }), { code: 'model_snapshot_mismatch' });
});

test('actual history retry reads only saved payload and connection without compiling current settings', () => {
  const forbidden = () => { throw new Error('must not consult the current workbench'); };
  const restore = load('storyboardJobFromLog', {
    uid: () => 'retry-job', storyboardState: forbidden, storyboardGenerationPayload: forbidden,
    storyboardProviderProfile: forbidden, storyboardCreateJob: forbidden,
  });
  const snapshot = makeJob();
  snapshot.modelIdentity = resolveStoryboardJobModelIdentity(snapshot);
  const log = { snapshot, attempt: 2, effectivePrompt: 'current other prompt' };
  const job = restore(log);
  assert.equal(job.payload.prompt, 'original garden');
  assert.equal(job.connection.credentialId, 'key-ref-a');
  assert.equal(job.attempt, 3);
  assert.equal(job.modelIdentity.remoteModelId, V3);
  job.payload.prompt = 'edited';
  job.connection.baseUrl = 'https://new.example';
  assert.equal(log.snapshot.payload.prompt, 'original garden');
  assert.equal(log.snapshot.connection.baseUrl, 'https://relay.example');
  delete log.snapshot.modelIdentity;
  assert.equal(resolveStoryboardJobModelIdentity(restore(log)).remoteModelId, V3);
});

test('incomplete legacy history does not borrow current models, credentials or prompts', () => {
  const restore = load('storyboardJobFromLog', { uid: () => 'retry-job' });
  for (const extra of [{ payload: null }, { payload: { prompt: 42 } }, { profile: null }, { profile: { model: '' } }, { connection: {} }, { connection: { baseUrl: 'https://old.example' } }, { source: 'constructor' }]) {
    assert.equal(restore({ snapshot: makeJob(extra) }), null);
  }
  const comfy = makeJob({ source: 'comfy', profile: { model: '' }, connection: { baseUrl: 'https://comfy.example' } });
  assert.ok(restore({ snapshot: comfy }), 'legacy Comfy workflows do not require an API credential');
});

test('queue freezes identity before logging and rejects conflicting jobs without submitting', async () => {
  const queued = [], logs = [], warnings = [];
  const state = { enabled: true, logs: [] };
  const queue = load('storyboardQueueJob', {
    storyboardState: () => state, getChatKey: () => 'chat', storyboardValidatedAnchor: () => ({ valid: true }),
    storyboardImageAdmissionRuntime: async () => ({ admit: async () => true }),
    getStoryboardGenerationPolicy: () => ({ maxImages: 3 }), storyboardGalleryRecords: () => [],
    toast: (message) => warnings.push(message), STORYBOARD_QUEUE_LIMIT: 20,
    storyboardQueue: queued, storyboardActiveJobs: new Map(),
    storyboardStartLog: (job) => { logs.push(structuredClone(job)); return { id: 'log-a' }; },
    storyboardPlanForJob: () => null, storyboardSetPlanStatus: () => {},
    saveSettings: () => {}, renderModal: () => {}, storyboardPumpQueue: () => {},
  });
  const job = makeJob();
  assert.equal(await queue(job), true);
  assert.equal(Object.isFrozen(job.modelIdentity), true);
  assert.equal(logs[0].modelIdentity.remoteModelId, V3);
  const wrong = makeJob({ modelIdentity: job.modelIdentity, profile: { model: V5 } });
  assert.equal(await queue(wrong), false);
  assert.equal(queued.length, 1);
  assert.equal(logs.length, 1);
  assert.match(warnings[0], /不一致/);
});

test('actual log creation retains identity and archive snapshots retain the same identity', () => {
  const state = createStoryboardDefaults();
  let seq = 0;
  const start = load('storyboardStartLog', {
    storyboardState: () => state, uid: () => `id-${++seq}`, sanitizeStoryboardDiagnosticData,
    pruneStoryboardPipelineLogs, STORYBOARD_PIPELINE_LOG_LIMIT, saveSettings: () => {},
  });
  const job = makeJob({ id: 'job-a', attempt: 1 });
  job.modelIdentity = resolveStoryboardJobModelIdentity(job);
  const log = start(job);
  assert.deepEqual(log.snapshot.modelIdentity, job.modelIdentity);
  assert.deepEqual(sanitizeStoryboardSnapshot(log.snapshot).modelIdentity, job.modelIdentity);
  assert.match(section('storyboardCreateJob'), /modelIdentity: resolveStoryboardJobModelIdentity/);
  assert.match(section('storyboardCreateRecord'), /snapshot: sanitizeStoryboardSnapshot\(log\?\.snapshot/);
});

function runHarness(options = {}) {
  const stats = { assets: 0, keys: 0, fetches: 0, direct: 0, probes: 0, warnings: [], failures: [], gatewayRequests: [] };
  const confirmBinding = load('storyboardConfirmGatewayModelBinding', {
    getStoryboardModel, storyboardGatewayCapabilityPromise: null,
    storyboardRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    featureRuntime: { load: async () => ({ ...serviceCapabilities,
      probeQianmuImageCapabilities: async () => {
        stats.probes++;
        options.onProbe?.();
        return serviceCapabilities.probeQianmuImageCapabilities({ fetchImpl: async () => new Response(JSON.stringify(
          options.compatible ? imageGatewayCapabilities() : { ok: true, version: 2 },
        )) });
      },
    }) },
  });
  const run = load('storyboardRunJob', {
    storyboardImageChannelRuntime: async () => options.channel || ({ run: async (_identity, work) => work({ beforeSubmit: async () => {} }) }), confirmDialog: async () => true,
    storyboardAdmission: { beforeSubmit: async () => {} }, storyboardSettleImageAdmission: async () => {},
    MODULE_NAME: 'qianmu-test',
    storyboardPlanForJob: () => null, storyboardState: () => ({ enabled: true }),
    storyboardValidatedAnchor: () => ({ valid: true, floor: null }),
    storyboardMarkLogGenerating: () => {}, storyboardSetPlanStatus: () => {}, storyboardPipelineStage: () => {},
    storyboardPrepareGatewayAssets: async () => { stats.assets++; return { references: [], vibes: [] }; },
    storyboardResolveApiKey: async () => { stats.keys++; return 'mock-key'; },
    storyboardGatewayRequest: load('storyboardGatewayRequest'), getStoryboardModel,
    storyboardConfirmGatewayModelBinding: confirmBinding,
    directImageRuntime: async () => ({
      generateDirectImage: async (_request, control) => { stats.direct++; if (options.directImpl) return options.directImpl(control); if (options.directSuccess) return { ok: true, images: [] }; throw Object.assign(new Error('simulated read-only probe failure'), { submissionState: options.submissionUnknown ? 'unknown' : 'not_submitted' }); },
      isDirectImageTransportError: () => !options.directRejected,
    }),
    storyboardRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    fetch: async (_url, init) => { stats.fetches++; stats.gatewayRequests.push(JSON.parse(init.body)); throw new Error('simulated gateway network failure'); },
    storyboardPipelineForLog: () => null,
    storyboardFinishLog: (_log, status, detail) => stats.failures.push({ status, detail }),
    toast: (message) => stats.warnings.push(message), console: { error: () => {} }, saveSettings: () => {},
  });
  return { stats, run, confirmBinding };
}

test('request-time validation rejects changed identity before assets, keys or network', async () => {
  const { stats, run } = runHarness();
  const job = makeJob();
  job.modelIdentity = resolveStoryboardJobModelIdentity(job);
  job.profile.model = V5;
  await run(job, {});
  assert.equal(stats.assets, 0);
  assert.equal(stats.keys, 0);
  assert.equal(stats.direct, 0);
  assert.equal(stats.fetches, 0);
  assert.equal(stats.probes, 0);
  assert.equal(stats.failures[0].status, 'failed');
  assert.match(stats.failures[0].detail.error, /不一致/);
});

test('an NAI alias cannot fall back to a gateway with unknown capability-binding support', async () => {
  const { stats, run } = runHarness();
  const job = makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } });
  await run(job, {});
  assert.equal(stats.direct, 1);
  assert.equal(stats.probes, 1);
  assert.equal(stats.fetches, 0);
  assert.equal(stats.failures[0].status, 'failed');
  assert.match(stats.failures[0].detail.error, /尚未确认网关支持/);
});

test('existing canonical NAI and custom OpenAI jobs retain their same-origin fallback', async () => {
  for (const [source, model] of [['novel', V3], ['openai', 'vendor/old-compatible-model']]) {
    const { stats, run } = runHarness();
    await run(makeJob({ source, profile: { model } }), {});
    assert.equal(stats.direct, 1);
    assert.equal(stats.probes, 0);
    assert.equal(stats.fetches, 1);
    assert.equal(stats.gatewayRequests[0].provider, source);
    assert.equal(stats.gatewayRequests[0].model, model);
    assert.equal(stats.gatewayRequests[0].capabilityModelId, source === 'novel' ? V3 : 'gpt-image-2');
  }
});

test('NAI alias fallback performs one read-only handshake and submits its exact supported binding', async () => {
  const { stats, run } = runHarness({ compatible: true });
  const job = makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } });
  await run(job, {});
  assert.equal(stats.probes, 1);
  assert.equal(stats.fetches, 1);
  assert.equal(stats.gatewayRequests[0].model, 'vendor/NAI-alias');
  assert.equal(stats.gatewayRequests[0].capabilityModelId, V45);
  assert.equal(stats.gatewayRequests[0].modelBindingVersion, 1);
});

test('direct success and upstream rejection do not probe the optional gateway or generate twice', async () => {
  for (const options of [{ directSuccess: true }, { directRejected: true }, { submissionUnknown: true }]) {
    const { stats, run } = runHarness(options);
    await run(makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } }), {});
    assert.equal(stats.probes, 0);
    assert.equal(stats.fetches, 0);
  }
});

test('cancellation during capability inspection cannot submit a paid fallback request', async () => {
  const job = makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } });
  const { stats, run } = runHarness({ compatible: true, onProbe: () => { job.discardRequested = true; } });
  await run(job, {});
  assert.equal(stats.probes, 1);
  assert.equal(stats.fetches, 0);
  assert.equal(stats.failures[0].status, 'cancelled');
});

test('a real queued NAI job waits before loading reference assets or starting either transport', async () => {
  let unlock, acquired, ticketCalls = 0;
  const ready = new Promise(resolve => { acquired = resolve; }), held = new Promise(resolve => { unlock = resolve; });
  const { stats, run } = runHarness({ compatible: true, channel: { run: async (identity, work) => {
    assert.equal(identity.apiKey, 'mock-key'); acquired(); await held;
    return work({ beforeSubmit: async () => { ticketCalls++; } });
  } } });
  const task = run(makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } }), {});
  await ready;
  assert.equal(stats.assets, 0); assert.equal(stats.direct, 0); assert.equal(stats.fetches, 0);
  unlock(); await task;
  assert.equal(stats.assets, 1); assert.equal(stats.direct, 1); assert.equal(stats.fetches, 1); assert.equal(ticketCalls, 1);
});

test('actual direct dispatch cannot bypass a failed channel receipt or fall back after it', async () => {
  let ticketCalls = 0, attemptedPosts = 0;
  const { stats, run } = runHarness({ directRejected: true, channel: { run: async (_identity, work) => work({ beforeSubmit: async () => {
    ticketCalls++; throw Object.assign(new Error('channel storage unavailable'), { code: 'image_channel_storage', submissionState: 'not_submitted' });
  } }) }, directImpl: async control => { await control.beforeSubmit(); attemptedPosts++; } });
  await run(makeJob(), {});
  assert.equal(ticketCalls, 1); assert.equal(attemptedPosts, 0); assert.equal(stats.fetches, 0); assert.equal(stats.probes, 0);
  assert.match(stats.failures[0].detail.error, /channel storage unavailable/);
});

test('gateway capability inspection is shared only while in flight, never retained for subsequent jobs', async () => {
  const { stats, confirmBinding } = runHarness({ compatible: true });
  const job = makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } });
  const results = await Promise.all([confirmBinding(job), confirmBinding(job)]);
  assert.deepEqual(results, [1, 1]);
  assert.equal(stats.probes, 1);
  await confirmBinding(job);
  assert.equal(stats.probes, 2);
});

test('a failed compatibility probe does not poison a later request after updating the service', async () => {
  const options = { compatible: false };
  const { stats, confirmBinding } = runHarness(options);
  const job = makeJob({ profile: { model: 'vendor/NAI-alias', capabilityModelId: V45 } });
  await assert.rejects(confirmBinding(job), { code: 'image_binding_incompatible' });
  options.compatible = true;
  assert.equal(await confirmBinding(job), 1);
  assert.equal(stats.probes, 2);
});
