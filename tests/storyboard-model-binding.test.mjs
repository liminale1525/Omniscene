import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORYBOARD_PROVIDER_REGISTRY, STORYBOARD_MODEL_REGISTRY,
  getStoryboardProvider, getStoryboardModel, getStoryboardCapabilities,
  resolveStoryboardModelBinding, buildStoryboardProviderPlan,
} from '../qianmu-storyboard.js';
import { novelModelCapabilities, isImageModelMetadataField } from '../qianmu-image-models.js';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage, sanitizeImageRequest } from '../qianmu-image-gateway.js';

const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full', V5 = 'nai-diffusion-5-full';
const input = (extra = {}) => ({ providerId: 'novel', prompt: 'quiet garden', ...extra });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const reference = { data: png.toString('base64'), mime: 'image/png', strength: 0.4, information: 0.5 };
const request = (extra = {}) => ({ provider: 'novel', apiKey: 'mock-key', baseUrl: 'https://relay.example', model: 'relay/custom', capabilityModelId: V45, prompt: 'quiet garden', ...extra });
const transports = { direct: generateDirectImage, gateway: generateImage };
const transportOptions = (fetchImpl) => ({ fetchImpl, resolveHost: async () => [{ address: '93.184.216.34', family: 4 }], waitImpl: async () => {} });
const imageResponse = () => new Response(png, { headers: { 'content-type': 'image/png' } });

test('all registered models retain their native protocol, name and capabilities', () => {
  for (const [family, models] of Object.entries(STORYBOARD_MODEL_REGISTRY)) {
    for (const model of models) {
      const plan = buildStoryboardProviderPlan(input({ providerId: family, model: model.id }));
      assert.equal(plan.model, model.id);
      assert.equal(plan.remoteModelId, model.id);
      assert.equal(plan.capabilityModelId, model.id);
      assert.equal(plan.protocol, STORYBOARD_PROVIDER_REGISTRY[family].protocol);
      assert.deepEqual(plan.capabilities, model.capabilities);
      assert.equal(plan.customModel, false);
      assert.equal(plan.gatewayRequest.capabilityModelId, model.id);
    }
  }
});

test('legacy unknown models keep the old family fallback and OpenAI custom names', () => {
  for (const family of Object.keys(STORYBOARD_PROVIDER_REGISTRY)) {
    const binding = resolveStoryboardModelBinding(family, { model: 'vendor/legacy-name' });
    assert.equal(binding.remoteModelId, family === 'openai' ? 'vendor/legacy-name' : STORYBOARD_PROVIDER_REGISTRY[family].defaultModel);
    assert.equal(binding.capabilityModelId, STORYBOARD_PROVIDER_REGISTRY[family].defaultModel);
  }
});

test('explicit aliases preserve prefixes and use only the specified family capability', () => {
  for (const family of Object.keys(STORYBOARD_PROVIDER_REGISTRY)) {
    const capability = STORYBOARD_MODEL_REGISTRY[family][0].id;
    const alias = `vendor/${family}/model-v5:preview`;
    const plan = buildStoryboardProviderPlan(input({ providerId: family, remoteModelId: alias, capabilityModelId: capability, connection: { id: 'connection-a' } }));
    assert.equal(plan.modelFamily, family);
    assert.equal(plan.model, alias);
    assert.equal(plan.gatewayRequest.model, alias);
    assert.equal(plan.capabilityModelId, capability);
    assert.equal(plan.connectionPresetId, 'connection-a');
    assert.equal(plan.customModel, true);
    assert.deepEqual(plan.capabilities, getStoryboardCapabilities(family, capability));
  }
});

test('a capability-only plan selects its canonical model, not the old connection default', () => {
  const plan = buildStoryboardProviderPlan(input({ capabilityModelId: V3 }));
  assert.equal(plan.model, V3);
  assert.equal(plan.capabilityModelId, V3);
  const alias = buildStoryboardProviderPlan(input({ model: 'relay/alias', capabilityModelId: V3 }));
  assert.equal(alias.model, 'relay/alias');
});

test('unknown aliases require a capability, except the legacy OpenAI-compatible family', () => {
  for (const family of ['novel', 'banana', 'seedream', 'comfy']) {
    assert.throws(() => resolveStoryboardModelBinding(family, { remoteModelId: 'relay/alias' }), { code: 'missing_capability_model' });
  }
  assert.equal(resolveStoryboardModelBinding('openai', { remoteModelId: 'relay/alias' }).remoteModelId, 'relay/alias');
});

test('known remote IDs cannot be relabelled as another capability generation', () => {
  for (const remoteModelId of [V5, ` ${V5} `]) {
    assert.throws(() => resolveStoryboardModelBinding('novel', { remoteModelId, capabilityModelId: V3 }), { code: 'model_capability_conflict' });
    assert.equal(novelModelCapabilities(remoteModelId, V3).code, 'model_capability_conflict');
  }
});

test('model family and protocol mismatches fail rather than change transports', () => {
  assert.throws(() => resolveStoryboardModelBinding('novel', { modelFamily: 'banana' }), { code: 'model_family_mismatch' });
  assert.throws(() => resolveStoryboardModelBinding('novel', { protocol: 'openai-images' }), { code: 'model_protocol_mismatch' });
  assert.throws(() => resolveStoryboardModelBinding('novel', { capabilityModelId: 'gpt-image-2' }), { code: 'invalid_capability_model' });
  for (const family of ['constructor', '__proto__', 'toString', 'missing']) {
    assert.equal(getStoryboardProvider(family), null);
    assert.equal(getStoryboardModel(family, V3), null);
    assert.throws(() => resolveStoryboardModelBinding(family), { code: 'invalid_model_family' });
  }
});

test('explicit model IDs reject truncation, empty values and control characters', () => {
  for (const remoteModelId of ['x'.repeat(241), 'bad\nmodel', 'bad\u007fmodel', 123, null, false]) {
    assert.throws(() => resolveStoryboardModelBinding('novel', { remoteModelId, capabilityModelId: V3 }), { code: 'invalid_model_id' });
  }
  for (const remoteModelId of ['', '  ']) {
    assert.throws(() => resolveStoryboardModelBinding('novel', { remoteModelId, capabilityModelId: V3 }), { code: 'missing_remote_model' });
  }
  assert.throws(() => resolveStoryboardModelBinding('novel', { capabilityModelId: '  ' }), { code: 'invalid_capability_model' });
  assert.throws(() => resolveStoryboardModelBinding('novel', { capabilityModelId: 0 }), { code: 'invalid_model_id' });
  const longest = 'v'.repeat(240);
  assert.equal(resolveStoryboardModelBinding('novel', { remoteModelId: longest, capabilityModelId: V3 }).remoteModelId, longest);
});

test('NAI sampler, scheduler, Vibe and reference permissions follow capability IDs', () => {
  for (const capabilityModelId of [V3, V45, V5]) {
    const plan = buildStoryboardProviderPlan(input({ remoteModelId: 'relay/nai-diffusion-5-lookalike', capabilityModelId,
      params: { sampler: 'k_dpm_2', scheduler: 'karras', novelSm: true, novelCfgRescale: 0 },
      references: [{ type: 'url', url: 'https://images.example/ref.png' }], vibes: [{ id: 'vibe-a' }],
    }));
    const v5 = capabilityModelId === V5;
    assert.equal(plan.request.sampler, v5 ? undefined : 'k_dpm_2');
    assert.equal(plan.request.scheduler, v5 ? undefined : 'karras');
    assert.equal(plan.request.providerOptions.sm, v5 ? undefined : true);
    assert.equal(plan.request.providerOptions.cfg_rescale, 0);
    assert.equal(plan.request.vibes.length, v5 ? 0 : 1);
    assert.equal(plan.request.references.length, capabilityModelId === V45 ? 1 : 0);
    assert.equal(plan.droppedParameters.includes('vibes'), v5);
  }
});

test('model metadata never becomes a vendor advanced parameter, and plans do not mutate input', () => {
  const providerOptions = { capabilityModelId: V5, remote_model_id: 'wrong', MODEL_FAMILY: 'wrong', connectionPresetId: 'private', PROTOCOL: 'wrong', modelBindingVersion: 9, style: 'soft' };
  const original = input({ remoteModelId: 'relay/alias', capabilityModelId: V3, params: { providerOptions } });
  const before = structuredClone(original);
  const plan = buildStoryboardProviderPlan(original);
  assert.deepEqual(original, before);
  assert.deepEqual(plan.request.providerOptions, { style: 'soft' });
  assert.equal(Object.hasOwn(plan.request, 'remoteModelId'), false);
  assert.equal(isImageModelMetadataField('Capability_Model_Id'), true);
  const sanitized = sanitizeImageRequest(request({ parameters: { providerOptions } }));
  assert.equal(sanitized.capabilityModelId, V45);
  assert.deepEqual({ ...sanitized.parameters.providerOptions }, { style: 'soft' });
});

for (const [name, generate] of Object.entries(transports)) {
  test(`${name}: actual request uses the alias, retains cfg including zero, and excludes metadata`, async () => {
    for (const cfg of [0, 5.5]) {
      const plan = buildStoryboardProviderPlan(input({ remoteModelId: 'vendor/nai-artist:custom', capabilityModelId: V3, params: { cfg, scheduler: 'karras' } }));
      const payload = { ...plan.gatewayRequest, apiKey: 'mock-key', baseUrl: 'https://relay.example', modelBindingVersion: 1 };
      payload.parameters.providerOptions = { ...payload.parameters.providerOptions, capabilityModelId: V5, PROTOCOL: 'wrong', modelBindingVersion: 9, style: 'soft' };
      const before = structuredClone(payload);
      const bodies = [];
      const output = await generate(payload, transportOptions(async (_url, init) => { bodies.push(JSON.parse(init.body)); return imageResponse(); }));
      assert.equal(output.images.length, 1);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].model, 'vendor/nai-artist:custom');
      assert.equal(bodies[0].parameters.scale, cfg);
      assert.equal(bodies[0].parameters.noise_schedule, 'karras');
      assert.equal(bodies[0].parameters.style, 'soft');
      assert.equal(JSON.stringify(bodies).includes('capabilityModelId'), false);
      assert.equal(JSON.stringify(bodies).includes('PROTOCOL'), false);
      assert.equal(JSON.stringify(bodies).includes('modelBindingVersion'), false);
      assert.deepEqual(payload, before);
    }
  });

  test(`${name}: V5 aliases reject Vibe, precise references and reference options before generation`, async () => {
    let calls = 0;
    for (const extra of [{ vibes: [reference] }, { referenceImages: [reference] }, { references: [reference] }, { parameters: { providerOptions: { director_reference_images: [reference.data] } } }]) {
      await assert.rejects(() => generate(request({ capabilityModelId: V5, ...extra }), transportOptions(async () => { calls++; return imageResponse(); })), { code: 'novel_v5_reference_unsupported' });
    }
    assert.equal(calls, 0);
  });

  test(`${name}: a misleading alias does not override an explicit V3 capability`, async () => {
    let body;
    await generate(request({ model: 'relay/nai-diffusion-5-custom', capabilityModelId: V3, vibes: [reference] }), transportOptions(async (_url, init) => { body = JSON.parse(init.body); return imageResponse(); }));
    assert.equal(body.model, 'relay/nai-diffusion-5-custom');
    assert.deepEqual(body.parameters.reference_image_multiple, [reference.data]);
    assert.deepEqual(body.parameters.reference_strength_multiple, [0.4]);
  });

  test(`${name}: invalid and conflicting capability bindings fail before a paid request`, async () => {
    let calls = 0;
    const options = transportOptions(async () => { calls++; return imageResponse(); });
    for (const model of [V5, ` ${V5} `]) {
      await assert.rejects(() => generate(request({ model, capabilityModelId: V3 }), options), { code: 'model_capability_conflict' });
    }
    await assert.rejects(() => generate(request({ model: 'a'.repeat(241), capabilityModelId: V3 }), options), { code: 'invalid_model_id' });
    await assert.rejects(() => generate(request({ capabilityModelId: 'gemini-3-pro-image' }), options), { code: 'invalid_capability_model' });
    await assert.rejects(() => generate(request({ capabilityModelId: V3, references: [reference] }), options), { code: 'novel_precise_reference_unsupported' });
    assert.equal(calls, 0);
  });

  test(`${name}: older native requests still generate without capability metadata`, async () => {
    let body;
    const payload = request({ model: V3 });
    delete payload.capabilityModelId;
    await generate(payload, transportOptions(async (_url, init) => { body = JSON.parse(init.body); return imageResponse(); }));
    assert.equal(body.model, V3);
    assert.equal(Object.hasOwn(body, 'capabilityModelId'), false);
  });
}

test('direct NAI scale remains authoritative when a legacy scale and cfg both exist', async () => {
  let body;
  await generateDirectImage(request({ parameters: { scale: 0, cfg: 8 } }), transportOptions(async (_url, init) => { body = JSON.parse(init.body); return imageResponse(); }));
  assert.equal(body.parameters.scale, 0);
});
