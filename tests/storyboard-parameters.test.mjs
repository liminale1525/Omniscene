import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildStoryboardProviderPlan,
  normalizeStoryboardState,
  summarizeStoryboardGenerationDemand,
} from '../qianmu-storyboard.js';

const browserSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const state = normalizeStoryboardState({
  schemaVersion: 2,
  source: 'openai',
  profiles: {
    novel: { model: 'nai-diffusion-4-5-full', count: '2', novelSm: true, novelSmDyn: true, novelDecrisper: true, novelVarietyBoost: true },
    openai: { model: 'gpt-image-2', count: '3', openaiQuality: 'high', openaiBackground: 'transparent', openaiOutputFormat: 'webp' },
    seedream: { model: 'doubao-seedream-5-0-260128', count: '4', seedreamGuidanceScale: '6.5', seedreamSequential: true, watermark: false },
  },
  connections: {
    novel: { activePresetId: 'nai-conn', presets: [{ id: 'nai-conn', providerId: 'novel', baseUrl: 'https://nai.example', model: 'nai-diffusion-4-5-full' }] },
    openai: { activePresetId: 'gpt-conn', presets: [{ id: 'gpt-conn', providerId: 'openai', baseUrl: 'https://gpt.example/v1', model: 'gpt-image-2' }] },
  },
  parameterPresets: [
    { id: 'nai-style', source: 'novel', profile: { model: 'nai-diffusion-4-5-full', count: '2', novelSm: true, novelSmDyn: true, novelDecrisper: true, novelVarietyBoost: true } },
    { id: 'gpt-style', source: 'openai', profile: { model: 'gpt-image-2', count: '3', openaiQuality: 'high', openaiBackground: 'transparent', openaiOutputFormat: 'webp' } },
    { id: 'seed-style', source: 'seedream', profile: { model: 'doubao-seedream-5-0-260128', count: '4', seedreamGuidanceScale: '6.5', seedreamSequential: true, watermark: false } },
  ],
  parameterPresetSelection: { novel: 'gpt-style', openai: 'gpt-style', seedream: 'seed-style' },
});

assert.equal(state.profiles.novel.novelSmDyn, true);
assert.equal(state.profiles.openai.openaiOutputFormat, 'webp');
assert.equal(state.profiles.seedream.seedreamGuidanceScale, '6.5');
assert.equal(state.profiles.seedream.watermark, false);
const naiStyle = state.parameterPresets.find((item) => item.id === 'nai-style').profile;
const gptStyle = state.parameterPresets.find((item) => item.id === 'gpt-style').profile;
const seedStyle = state.parameterPresets.find((item) => item.id === 'seed-style').profile;
assert.deepEqual([naiStyle.count, naiStyle.novelSm, naiStyle.novelSmDyn, naiStyle.novelDecrisper, naiStyle.novelVarietyBoost], ['2', true, true, true, true]);
assert.deepEqual([gptStyle.count, gptStyle.openaiQuality, gptStyle.openaiBackground, gptStyle.openaiOutputFormat], ['3', 'high', 'transparent', 'webp']);
assert.deepEqual([seedStyle.count, seedStyle.seedreamGuidanceScale, seedStyle.seedreamSequential, seedStyle.watermark], ['4', '6.5', true, false]);
assert.equal(state.parameterPresetSelection.novel, '', 'a style from another provider must never become active');
assert.equal(state.parameterPresetSelection.openai, 'gpt-style');
assert.equal(state.connections.novel.presets[0].baseUrl, 'https://nai.example');
assert.equal(state.connections.openai.presets[0].baseUrl, 'https://gpt.example/v1');
assert.equal(state.connections.novel.draft.model, 'nai-diffusion-4-5-full', 'an old active preset without a draft must seed an independent editable draft');
assert.notStrictEqual(state.connections.novel.draft, state.connections.novel.presets[0]);

const stringFlags = normalizeStoryboardState({
  schemaVersion: 2,
  profiles: { novel: { novelSm: 'false', novelSmDyn: '1' }, seedream: { seedreamSequential: 'false', watermark: 'true' } },
});
assert.equal(stringFlags.profiles.novel.novelSm, false);
assert.equal(stringFlags.profiles.novel.novelSmDyn, true);
assert.equal(stringFlags.profiles.seedream.seedreamSequential, false);
assert.equal(stringFlags.profiles.seedream.watermark, true);

const novel = buildStoryboardProviderPlan({
  providerId: 'novel', connection: { model: 'nai-diffusion-4-5-full' }, prompt: '1girl',
  params: { count: 9, novelSm: true, novelSmDyn: true, novelDecrisper: true, novelVarietyBoost: true },
});
assert.equal(novel.gatewayRequest.parameters.count, 4);
assert.deepEqual(novel.gatewayRequest.parameters.providerOptions, {
  sm: true, sm_dyn: true, dynamic_thresholding: true, variety_boost: true,
});

const openai = buildStoryboardProviderPlan({
  providerId: 'openai', connection: { model: 'gpt-image-2' }, prompt: 'portrait',
  params: { count: 3, openaiQuality: 'high', openaiBackground: 'transparent', openaiOutputFormat: 'WEBP' },
});
assert.deepEqual({
  count: openai.gatewayRequest.parameters.count,
  quality: openai.gatewayRequest.parameters.quality,
  background: openai.gatewayRequest.parameters.background,
  outputFormat: openai.gatewayRequest.parameters.outputFormat,
}, { count: 3, quality: 'high', background: 'transparent', outputFormat: 'webp' });

const seedream = buildStoryboardProviderPlan({
  providerId: 'seedream', connection: { model: 'doubao-seedream-5-0-260128' }, prompt: 'city',
  params: { count: 2, seedreamGuidanceScale: 7.25, seedreamSequential: true, watermark: false },
});
assert.equal(seedream.gatewayRequest.parameters.count, 2);
assert.equal(seedream.gatewayRequest.parameters.guidanceScale, 7.25);
assert.equal(seedream.gatewayRequest.parameters.sequential, true);
assert.equal(seedream.gatewayRequest.parameters.watermark, false);

const isolated = buildStoryboardProviderPlan({
  providerId: 'openai', prompt: 'portrait',
  params: { seedreamGuidanceScale: 4, seedreamSequential: true, novelSm: true },
});
assert.equal(isolated.gatewayRequest.parameters.guidanceScale, undefined);
assert.equal(isolated.gatewayRequest.parameters.sequential, undefined);
assert.equal(isolated.gatewayRequest.parameters.providerOptions.sm, undefined);
assert.ok(isolated.droppedParameters.includes('guidanceScale'));
assert.ok(isolated.droppedParameters.includes('sequential'));
assert.ok(isolated.droppedParameters.includes('sm'));

assert.deepEqual(summarizeStoryboardGenerationDemand([
  { payload: { parameters: { count: 4 } } },
]), { requestCount: 1, imageCount: 4, hasMultiImageRequest: true }, 'one request asking for four images must trigger cost confirmation');
assert.deepEqual(summarizeStoryboardGenerationDemand([
  { payload: { parameters: { count: 1 } } },
  { payload: { parameters: { count: 4 } } },
  { payload: { parameters: { count: '3' } } },
]), { requestCount: 3, imageCount: 8, hasMultiImageRequest: true }, 'routed requests must report their aggregate image count');
assert.deepEqual(summarizeStoryboardGenerationDemand([
  { payload: { parameters: { count: 99 } } },
  { payload: { parameters: {} } },
]), { requestCount: 2, imageCount: 5, hasMultiImageRequest: true }, 'confirmation math must match the one-to-four image request contract');

assert.match(browserSource, /function storyboardConnectionState[\s\S]*draft: group\?\.draft \|\| active/, 'the UI must render the editable draft instead of the saved preset object');
assert.match(browserSource, /models: STORYBOARD_MODEL_REGISTRY\[providerId\]/, 'all families retain their capability catalog');
assert.match(browserSource, /role="combobox"[\s\S]*maxlength="240"/, 'all online families accept explicit third-party model IDs');
assert.match(browserSource, /resolveStoryboardProfileBinding\(providerId, legacy\)/, 'workbench IDs must pass through the shared explicit binding resolver');
assert.doesNotMatch(browserSource, /storyboardFetchedModels|showAllFetchedModels|__custom__/, 'legacy relay-discovery state must not leak back into the workbench');
assert.match(browserSource, /const connection = routedConnection \|\| connectionState\.draft \|\| connectionState\.active/, 'ordinary generation must use the current draft while an explicit ensemble route may use its saved preset');
assert.match(browserSource, /function storyboardParameterPresets[\s\S]*item\.profile\.model !== currentModel[\s\S]*capabilityModelId === binding\.capabilityModelId/, 'the style picker must isolate saved parameters by concrete model and capability');
const saveConnectionSource = browserSource.slice(browserSource.indexOf('async function storyboardSaveConnection'), browserSource.indexOf('async function storyboardSaveConnectionPreset'));
assert.doesNotMatch(saveConnectionSource, /active\.(?:baseUrl|model|options|updatedAt)\s*=/, 'saving or testing the current draft must not silently overwrite an existing preset');
assert.match(saveConnectionSource, /inheritedCredentialId[\s\S]*storyboardCredentialId\(sourceId, 'draft'\)/, 'writing a new draft key must not replace the credential stored by the selected preset');
assert.match(browserSource, /const sourceCredentialId = group\.draft\?\.credentialId \|\| current\?\.credentialId/, 'explicitly saving a preset must migrate the draft key when needed');
const loadConnectionSource = browserSource.slice(browserSource.indexOf('function storyboardLoadConnectionPreset'), browserSource.indexOf('async function storyboardDeleteConnectionPreset'));
assert.doesNotMatch(loadConnectionSource, /Object\.assign\([^\n]+preset\.options/, 'loading a connection must not restore drawing parameters hidden in legacy connection options');
const generateSource = browserSource.slice(browserSource.indexOf('async function storyboardGenerate'), browserSource.indexOf('function storyboardRetryLog'));
assert.match(generateSource, /summarizeStoryboardGenerationDemand\(jobs\)/, 'multi-image Count must be included in the preflight cost confirmation');
assert.match(generateSource, /confirmDialog\('确认生成数量'/, 'multiple requested images must require an explicit confirmation');
assert.match(generateSource, /jobs\.length > remainingSlots/, 'a multi-shot plan must not be partially enqueued when capacity is insufficient');

console.log('Storyboard parameter contract OK');
