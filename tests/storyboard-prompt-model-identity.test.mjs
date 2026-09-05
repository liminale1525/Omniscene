import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  compileStoryboardPrompt, normalizeStoryboardShotSpec, createStoryboardDefaults,
  resolveStoryboardModelBinding, resolveStoryboardJobModelIdentity,
  getStoryboardCapabilities, synchronizeStoryboardCaptionBase,
} from '../qianmu-storyboard.js';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage } from '../qianmu-image-gateway.js';

const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full', V5 = 'nai-diffusion-5-full';
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const shot = normalizeStoryboardShotSpec({
  id: 'duet', scene: 'rainy platform', shotRole: 'relationship',
  characters: [
    { id: 'alice', name: 'Alice', identity: ['red hair'], action: ['holding an umbrella'], spatial: { center: [0.2, 0.5] } },
    { id: 'bob', name: 'Bob', identity: ['blue hair'], action: ['reading a map'], spatial: { center: [0.8, 0.5] } },
  ],
});
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index);
  const next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function runtime(state = createStoryboardDefaults(), extra = {}, names = []) {
  const dependencies = {
    structuredClone, clone: structuredClone, Date,
    uniqueClean: (items) => [...new Set(items.filter(Boolean))],
    storyboardState: () => state,
    storyboardSelectedArtistPreset: () => state.artistPresets.find((item) => item.id === state.selectedArtistPresetId) || null,
    compileStoryboardPrompt, normalizeStoryboardShotSpec, resolveStoryboardModelBinding,
    resolveStoryboardJobModelIdentity, getStoryboardCapabilities, synchronizeStoryboardCaptionBase,
    STORYBOARD_GENERIC_PROMPT_DEFAULTS: { positive: 'generic quality', negative: 'generic exclusions' },
    STORYBOARD_NAI_QUALITY_DEFAULTS: { [V3]: 'quality v3', [V45]: 'quality v45', [V5]: 'quality v5' },
    STORYBOARD_NAI_NEGATIVE_DEFAULTS: { [V3]: 'negative v3', [V45]: 'negative v45', [V5]: 'negative v5' },
    ...extra,
  };
  const context = vm.createContext(dependencies);
  const functions = [
    'storyboardPromptDefaultsKey', 'storyboardProviderPromptDefaults', 'storyboardPromptLayerForArtist',
    'storyboardJoinPrompt', 'storyboardPromptsForArtist', 'storyboardRemovePromptLayer',
    'storyboardBasePromptsForArtistRedraw', 'storyboardGenerationPayload', ...names,
  ];
  vm.runInContext(functions.map(section).join('\n'), context);
  return context;
}
function compiled(capabilityModelId = V45, remoteModelId = 'relay/NAI-alias') {
  return compileStoryboardPrompt({ providerId: 'novel', capabilityModelId, remoteModelId, shot,
    artistString: 'old artist', artistPositive: 'old quality', artistNegative: 'old exclusions' });
}
function snapshot() {
  const result = compiled();
  const snap = {
    source: 'novel', profile: { model: 'relay/NAI-alias', capabilityModelId: V45 },
    connection: { id: 'original', credentialId: 'key-ref', baseUrl: 'https://relay.example' },
    payload: { prompt: result.prompt, negative: result.negative, parameters: { providerOptions: result.providerOptions } },
    prompt: result.prompt, negative: result.negative,
  };
  snap.modelIdentity = resolveStoryboardJobModelIdentity(snap);
  return snap;
}

test('V3 aliases do not acquire native character captions from a name or family default', () => {
  const result = compiled(V3, 'relay/nai-diffusion-5-custom');
  assert.equal(result.modelBinding.remoteModelId, 'relay/nai-diffusion-5-custom');
  assert.equal(result.modelBinding.capabilityModelId, V3);
  assert.equal(result.degradation.mode, 'named_character_blocks');
  assert.deepEqual(result.providerOptions, {});
  assert.match(result.prompt, /Alice, red hair[\s\S]*Bob, blue hair/);
});

test('V4.5 aliases use native character isolation, preserving positions and source data', () => {
  const before = structuredClone(shot);
  const result = compiled(V45, 'relay/nai-diffusion-3-custom');
  assert.equal(result.degradation, null);
  assert.equal(result.modelBinding.capabilityModelId, V45);
  assert.doesNotMatch(result.prompt, /red hair|blue hair/);
  const captions = result.providerOptions.v4_prompt.caption.char_captions;
  assert.match(captions[0].char_caption, /Alice, red hair[\s\S]*umbrella/);
  assert.doesNotMatch(captions[0].char_caption, /Bob|blue hair|map/);
  assert.match(captions[1].char_caption, /Bob, blue hair[\s\S]*map/);
  assert.deepEqual(captions.map((item) => item.centers[0]), [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]);
  assert.deepEqual(shot, before);
});

test('explicit invalid compiler bindings fail instead of producing a default-model prompt', () => {
  for (const [fields, code] of [
    [{ remoteModelId: 'relay/unknown' }, 'missing_capability_model'],
    [{ remoteModelId: V3, capabilityModelId: V45 }, 'model_capability_conflict'],
    [{ remoteModelId: 'relay/unknown', capabilityModelId: 'gpt-image-2' }, 'invalid_capability_model'],
    [{ remoteModelId: 'x'.repeat(241), capabilityModelId: V3 }, 'invalid_model_id'],
  ]) assert.throws(() => compileStoryboardPrompt({ providerId: 'novel', shot, ...fields }), { code });
});

test('canonical compiler calls and existing OpenAI-compatible names remain supported', () => {
  for (const modelId of [V3, V45, V5]) {
    const legacy = compileStoryboardPrompt({ providerId: 'novel', modelId, shot });
    const explicit = compileStoryboardPrompt({ providerId: 'novel', remoteModelId: modelId, capabilityModelId: modelId, shot });
    assert.deepEqual(legacy, explicit);
  }
  const result = compileStoryboardPrompt({ providerId: 'openai', modelId: 'vendor/custom-image', shot });
  assert.equal(result.modelBinding.remoteModelId, 'vendor/custom-image');
  assert.equal(result.degradation.mode, 'named_character_blocks');
});

test('workbench payload uses the same capability for captions, parameters, Vibe and default words', () => {
  const state = createStoryboardDefaults();
  state.selectedVibeIds = ['vibe-a'];
  const context = runtime(state);
  for (const capabilityModelId of [V3, V45, V5]) {
    const profile = { ...state.profiles.novel, model: 'relay/same-alias', capabilityModelId,
      novelSm: true, scheduler: 'karras', novelCfgRescale: '0' };
    const payload = context.storyboardGenerationPayload(state, profile, { shot: { shotSpec: shot } });
    assert.equal(payload.compiledPrompt.modelBinding.capabilityModelId, capabilityModelId);
    assert.equal(Boolean(payload.parameters.providerOptions.v4_prompt), capabilityModelId !== V3);
    assert.equal(payload.parameters.providerOptions.sm, capabilityModelId === V5 ? undefined : true);
    assert.equal(payload.parameters.scheduler, capabilityModelId === V5 ? '' : 'karras');
    assert.equal(payload.parameters.providerOptions.cfg_rescale, 0);
    assert.equal(payload.selectedVibeIds.length, capabilityModelId === V5 ? 0 : 1);
    assert.ok(payload.prompt.includes(capabilityModelId === V3 ? 'quality v3' : capabilityModelId === V45 ? 'quality v45' : 'quality v5'));
  }
});

test('user-locked workbench text is not recompiled or automatically partitioned', () => {
  const state = createStoryboardDefaults();
  Object.assign(state.promptDraft, { userEditedCompiled: true, artistPositiveBaked: true, artistNegativeBaked: true });
  const context = runtime(state);
  const payload = context.storyboardGenerationPayload(state,
    { ...state.profiles.novel, model: 'relay/locked', capabilityModelId: V45 },
    { prompt: 'my exact scene', negative: 'my exclusions', shot: { shotSpec: shot } });
  assert.equal(payload.prompt, 'my exact scene');
  assert.equal(payload.negative, 'my exclusions');
  assert.equal(payload.parameters.providerOptions.v4_prompt, undefined);
  assert.equal(payload.compiledPrompt.modelBinding.remoteModelId, 'relay/locked');
});

test('defaults use capability but retain explicit user overrides under the original remote name', () => {
  const state = createStoryboardDefaults(), context = runtime(state);
  state.promptDefaults['novel:relay/a'] = { positive: '', negative: 'custom negative' };
  const saved = context.storyboardProviderPromptDefaults('novel', 'relay/a', state, V3);
  assert.equal(saved.positive, '');
  assert.equal(saved.negative, 'custom negative');
  assert.equal(context.storyboardProviderPromptDefaults('novel', 'relay/b', state, V3).positive, 'quality v3');
  assert.equal(Object.hasOwn(state.promptDefaults, 'novel:relay/b'), false);
});

test('artist redraw takes the historical capability, not current workbench or stale negative summary', () => {
  const state = createStoryboardDefaults();
  state.source = 'openai';
  const context = runtime(state);
  const snap = snapshot();
  snap.payload.prompt = 'quality v45, garden';
  snap.payload.negative = '';
  const base = context.storyboardBasePromptsForArtistRedraw({ effectiveNegative: 'stale negative' }, snap);
  assert.equal(base.modelId, 'relay/NAI-alias');
  assert.equal(base.capabilityModelId, V45);
  assert.equal(base.prompt, 'garden');
  assert.equal(base.negative, '');
  assert.throws(() => context.storyboardBasePromptsForArtistRedraw({}, { source: 'novel', payload: {} }), { code: 'missing_model_snapshot' });
});

test('native caption synchronization updates both bases and preserves all character-specific fields', () => {
  const snap = snapshot();
  const captions = structuredClone(snap.payload.parameters.providerOptions.v4_prompt.caption.char_captions);
  snap.payload.parameters.providerOptions.v4_negative_prompt.caption.char_captions = [{ char_caption: 'character exclusion', centers: [{ x: 0.2, y: 0.5 }] }];
  const negativeCharacters = structuredClone(snap.payload.parameters.providerOptions.v4_negative_prompt.caption.char_captions);
  Object.assign(snap.payload, { prompt: 'new artist, new scene', negative: '' });
  assert.equal(synchronizeStoryboardCaptionBase(snap.payload), snap.payload);
  const options = snap.payload.parameters.providerOptions;
  assert.equal(options.v4_prompt.caption.base_caption, 'new artist, new scene');
  assert.equal(options.v4_negative_prompt.caption.base_caption, '');
  assert.deepEqual(options.v4_prompt.caption.char_captions, captions);
  assert.deepEqual(options.v4_negative_prompt.caption.char_captions, negativeCharacters);
  assert.equal(options.v4_prompt.use_coords, true);
  assert.equal(options.v4_prompt.use_order, true);
});

test('flat payloads and unrelated provider options do not acquire native NAI fields', () => {
  for (const payload of [undefined, null, {}, { prompt: 'flat' }, { prompt: 'flat', parameters: { providerOptions: { style: 'soft' } } }]) {
    const before = structuredClone(payload);
    synchronizeStoryboardCaptionBase(payload);
    assert.deepEqual(payload, before);
  }
});

function redrawRuntime(archive, { mutate = null, archived = true } = {}) {
  const state = createStoryboardDefaults();
  state.enabled = true;
  const original = snapshot();
  state.logs = [{ id: 'old-log', recordId: 'image-a', snapshot: original }];
  const chat = [{ mes: 'original story', swipe_id: 0 }];
  const queued = [], notices = [];
  let chatKey = 'chat-a';
  const context = runtime(state, {
    ctx: () => ({ chat }), getChatKey: () => chatKey, uid: () => 'job-a',
    storyboardReconcileGalleryLinks: () => {},
    storyboardLoadRecordToWorkbench: () => assert.fail('unexpected workbench fallback'),
    storyboardReadSnapshotForRecord: async () => { mutate?.({ chat, changeChat: () => { chatKey = 'chat-b'; } }); return archived ? archive : null; },
    storyboardRelinkRedrawSnapshot: () => {}, storyboardGalleryGroupId: () => 'root-a',
    storyboardAssignCollectionIds: () => {}, storyboardItemCollectionIds: () => [],
    storyboardQueueJob: (job) => { queued.push(job); return true; },
    toast: (message) => { notices.push(message); return false; },
  }, ['storyboardRedrawRecord', 'storyboardJobFromLog']);
  // Job restoration also validates provider ownership through the real registry.
  context.STORYBOARD_PROVIDER_REGISTRY = { novel: {} };
  const record = { id: 'image-a', floor: 0, source: 'novel', finalPrompt: 'edited scene', tags: [] };
  return { context, queued, notices, record, original, state };
}

test('actual inline redraw prefers saved image edits over the old log and leaves history untouched', async () => {
  const archive = snapshot();
  archive.payload.negative = 'edited exclusions';
  const before = structuredClone(archive);
  const env = redrawRuntime(archive);
  assert.equal(await env.context.storyboardRedrawRecord(env.record), true);
  const job = env.queued[0];
  assert.equal(job.payload.negative, 'edited exclusions');
  assert.equal(job.payload.parameters.providerOptions.v4_prompt.caption.base_caption, 'edited scene');
  assert.equal(job.payload.parameters.providerOptions.v4_negative_prompt.caption.base_caption, 'edited exclusions');
  assert.equal(job.modelIdentity.remoteModelId, 'relay/NAI-alias');
  assert.deepEqual(archive, before);
  assert.notEqual(env.original.payload.negative, 'edited exclusions');
});

test('actual inline artist replacement updates native request text using the historical model', async () => {
  const env = redrawRuntime(snapshot());
  env.state.artistPresets = [{ id: 'old', value: 'old artist', positivePrompt: 'old quality', negativePrompt: 'old exclusions' }];
  Object.assign(env.record, { artistPresetId: 'old', artistString: 'old artist', finalPrompt: env.original.payload.prompt });
  assert.equal(await env.context.storyboardRedrawRecord(env.record, {
    artistPreset: { id: 'new', value: 'new artist', positivePrompt: 'new quality', negativePrompt: 'new exclusions' },
  }), true);
  const payload = env.queued[0].payload;
  assert.match(payload.parameters.providerOptions.v4_prompt.caption.base_caption, /^new artist, new quality/);
  assert.doesNotMatch(payload.prompt, /old artist|old quality/);
  assert.match(payload.parameters.providerOptions.v4_negative_prompt.caption.base_caption, /^new exclusions/);
  assert.doesNotMatch(payload.negative, /old exclusions/);
  assert.equal(payload.parameters.providerOptions.v4_prompt.caption.char_captions.length, 2);
});

test('a missing archive still permits a complete historical log without using current settings', async () => {
  const env = redrawRuntime(null, { archived: false });
  assert.equal(await env.context.storyboardRedrawRecord(env.record), true);
  assert.equal(env.queued[0].connection.id, 'original');
  assert.equal(env.queued[0].payload.negative, env.original.payload.negative);
});

test('late archive reads cannot redraw into a changed chat, edited message or different swipe', async () => {
  for (const mutate of [({ changeChat }) => changeChat(), ({ chat }) => { chat[0].mes = 'edited'; },
    ({ chat }) => { chat[0].swipe_id = 1; }, ({ chat }) => { chat[0] = { ...chat[0] }; }]) {
    const env = redrawRuntime(snapshot(), { mutate });
    assert.equal(await env.context.storyboardRedrawRecord(env.record), false);
    assert.equal(env.queued.length, 0);
    assert.match(env.notices[0], /正文已切换/);
  }
});

test('the real inline editor synchronizes captions on save without starting generation', async () => {
  const snap = snapshot(), state = createStoryboardDefaults();
  let saved = null, redraws = 0;
  const record = { id: 'image-a', finalPrompt: snap.payload.prompt, floor: 0 };
  const answers = ['edited positive', ''];
  const context = runtime(state, {
    storyboardReadSnapshotForRecord: async () => snap,
    ctx: () => ({}), promptInput: async () => answers.shift(), confirmDialog: async () => false,
    storyboardStoreSnapshotForRecord: async (_record, value) => { saved = value; },
    saveMetadata: async () => {}, storyboardRenderInlineImages: () => {},
    storyboardRedrawRecord: () => { redraws++; }, toast: () => assert.fail('unexpected toast'),
  }, ['storyboardEditPrompt']);
  assert.equal(await context.storyboardEditPrompt({ record }), true);
  assert.equal(saved.payload.parameters.providerOptions.v4_prompt.caption.base_caption, 'edited positive');
  assert.equal(saved.payload.parameters.providerOptions.v4_negative_prompt.caption.base_caption, '');
  assert.equal(redraws, 0);
});

for (const [name, generate] of Object.entries({ direct: generateDirectImage, gateway: generateImage })) {
  test(`${name} actually sends the edited native captions and original remote model name`, async () => {
    const snap = snapshot();
    Object.assign(snap.payload, { prompt: 'edited artist, garden', negative: 'edited exclusions' });
    synchronizeStoryboardCaptionBase(snap.payload);
    const calls = [];
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const fetchImpl = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    };
    await generate({ provider: 'novel', apiKey: 'mock-key', baseUrl: 'https://relay.example',
      model: snap.modelIdentity.remoteModelId, capabilityModelId: V45,
      prompt: snap.payload.prompt, negativePrompt: snap.payload.negative, parameters: snap.payload.parameters,
    }, { fetchImpl, resolveHost: async () => [{ address: '93.184.216.34', family: 4 }], waitImpl: async () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'relay/NAI-alias');
    assert.equal(calls[0].parameters.v4_prompt.caption.base_caption, 'edited artist, garden');
    assert.equal(calls[0].parameters.v4_negative_prompt.caption.base_caption, 'edited exclusions');
    assert.equal(calls[0].parameters.v4_prompt.caption.char_captions.length, 2);
  });
}
