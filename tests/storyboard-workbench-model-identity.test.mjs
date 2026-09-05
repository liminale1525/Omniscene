import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full', V5 = 'nai-diffusion-5-full';
const alias = 'vendor/shared-NAI';
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function environment(capability = V3, model = alias, extra = {}) {
  const state = storyboard.createStoryboardDefaults();
  Object.assign(state, { enabled: true, target: 'gallery', prompt: 'quiet garden' });
  state.profiles.novel = { ...state.profiles.novel, model, capabilityModelId: capability };
  state.connections.novel.draft = { id: 'draft-a', credentialId: 'key-ref', baseUrl: 'https://relay.example', model: V5 };
  const notices = [], saved = [];
  const context = vm.createContext({
    ...storyboard, clone: structuredClone,
    settings: { apiProfiles: [] }, storyboardState: () => state, getChatKey: () => 'chat-a', ctx: () => ({ chat: [] }),
    storyboardSelectedArtistPreset: () => null, storyboardGalleryRecords: () => [],
    uniqueClean: (items) => [...new Set(items.filter(Boolean))],
    htmlEscape: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    storyboardSafeUrl: (url) => String(url || ''),
    STORYBOARD_NAI_QUALITY_DEFAULTS: { [V3]: 'quality v3', [V45]: 'quality v45', [V5]: 'quality v5' },
    STORYBOARD_NAI_NEGATIVE_DEFAULTS: { [V3]: 'negative v3', [V45]: 'negative v45', [V5]: 'negative v5' },
    STORYBOARD_GENERIC_PROMPT_DEFAULTS: { positive: 'quality', negative: 'exclusions' },
    storyboardConnectionStatus: new Map(), storyboardDraftApiKeys: new Map(),
    storyboardProductionDeliveryPolicy: (_shot, policy) => policy,
    storyboardAnchorForMessage: () => null, storyboardCredentialId: () => 'key-ref',
    sanitizeStoryboardDiagnosticData: (value) => value,
    uid: () => 'generated-id', saveSettings: () => saved.push(true), renderModal: () => {},
    toast: (message) => { notices.push(message); return false; },
    ...extra,
  });
  const names = ['storyboardConnectionState', 'storyboardProviderProfile', 'storyboardModelOptions',
    'storyboardCompilerProfileOptions', 'renderStoryboardModelCard', 'storyboardPromptDefaultsKey',
    'storyboardProviderPromptDefaults', 'storyboardPromptLayerForArtist', 'storyboardRememberPromptLayer',
    'storyboardPromptsForArtist', 'storyboardJoinPrompt', 'storyboardParameterPresets',
    'renderStoryboardParameterPresets', 'renderStoryboardParameterVibes', 'renderStoryboardCreate',
    'storyboardProfileSnapshot', 'storyboardCaptureWorkbench', 'storyboardGenerationPayload',
    'storyboardCreateJob', 'storyboardGatewayRequest', 'storyboardLoadLogToWorkbench', 'storyboardSafeShotSpecFromPrompt', 'storyboardAdaptShotForModel'];
  for (const call of section('renderStoryboardCreate').matchAll(/\b(renderStoryboard\w+)\(/g)) {
    if (!names.includes(call[1])) context[call[1]] = () => '';
  }
  vm.runInContext(names.map(section).join('\n'), context);
  return { state, context, notices, saved };
}

test('workbench profile binding is strict about aliases but accepts new-install empty selection', () => {
  assert.equal(storyboard.resolveStoryboardProfileBinding('novel', {}).remoteModelId, V5);
  assert.equal(storyboard.resolveStoryboardProfileBinding('novel', { model: alias, capabilityModelId: V3 }).remoteModelId, alias);
  assert.throws(() => storyboard.resolveStoryboardProfileBinding('novel', { model: alias }), { code: 'missing_capability_model' });
  assert.throws(() => storyboard.resolveStoryboardProfileBinding('novel', { model: V3, capabilityModelId: V45 }), { code: 'model_capability_conflict' });
  assert.equal(storyboard.resolveStoryboardProfileBinding('openai', { model: 'vendor/custom' }).remoteModelId, 'vendor/custom');
});

test('actual provider profile uses its passed state and capability defaults, not a connection model or another state', () => {
  const env = environment();
  const different = storyboard.createStoryboardDefaults();
  different.profiles.novel = { ...different.profiles.novel, model: 'other/alias', capabilityModelId: V45 };
  const before = structuredClone(different);
  const profile = env.context.storyboardProviderProfile(different);
  assert.equal(profile.model, 'other/alias');
  assert.equal(profile.capabilityModelId, V45);
  assert.equal(profile.sampler, storyboard.getStoryboardNovelParameterSpec(V45).defaults.sampler);
  assert.deepEqual(different, before, 'render reads do not migrate or mutate state');
  const current = env.context.storyboardProviderProfile(env.state);
  assert.equal(current.model, alias);
  assert.equal(current.capabilityModelId, V3);
  assert.equal(current.baseUrl, 'https://relay.example');
});

test('loaded parameters preserve legal zero/false while missing fields receive the correct defaults', () => {
  const { state, context } = environment();
  Object.assign(state.profiles.novel, { loaded: true, cfg: '0', seed: '0', novelSm: false, sampler: '' });
  const profile = context.storyboardProviderProfile(state);
  assert.equal(profile.cfg, '0');
  assert.equal(profile.seed, '0');
  assert.equal(profile.novelSm, false);
  assert.equal(profile.sampler, storyboard.getStoryboardNovelParameterSpec(V3).defaults.sampler);
});

test('a current bound alias remains selected and escaped in the actual model control', () => {
  const { state, context } = environment(V45, 'vendor/<alias>');
  const html = context.renderStoryboardModelCard(state);
  assert.match(html, /value="vendor\/&lt;alias&gt;" selected/);
  assert.doesNotMatch(html, /value="nai-diffusion-5-full" selected/);
  assert.doesNotMatch(html, /<alias>/);
});

test('invalid bindings show a repairable model card instead of crashing the entire workbench', () => {
  const { state, context } = environment('', 'unknown-alias');
  const before = structuredClone(state.profiles.novel);
  const html = context.renderStoryboardCreate(state);
  assert.match(html, /请重新选择模型/);
  assert.match(html, /value="unknown-alias" selected/);
  assert.doesNotMatch(html, /sd-storyboard-params/);
  assert.deepEqual(state.profiles.novel, before);
});

test('actual workbench rendering chooses NAI sampler and Vibe controls from capability', () => {
  for (const capability of [V3, V45, V5]) {
    const { state, context } = environment(capability);
    state.vibeLibrary = [{ id: 'vibe-a', name: 'test vibe', modelIds: [V3] }];
    const html = context.renderStoryboardCreate(state);
    assert.ok(html.includes('sd-storyboard-params'));
    assert.equal(html.includes('data-storyboard-field="scheduler"'), capability !== V5);
    const vibe = /<button[^>]*data-storyboard-param-vibe="vibe-a"[^>]*>/.exec(html)?.[0];
    assert.ok(vibe);
    assert.equal(vibe.includes('disabled'), capability !== V3);
    assert.ok(html.includes(capability === V3 ? 'quality v3' : capability === V45 ? 'quality v45' : 'quality v5'));
  }
});

test('built-in parameter styles keep the real alias and user styles match both name and capability', () => {
  const { state, context } = environment(V5);
  state.parameterPresets = [
    { id: 'v5', source: 'novel', profile: { model: alias, capabilityModelId: V5, cfg: '0' } },
    { id: 'v45', source: 'novel', profile: { model: alias, capabilityModelId: V45, cfg: '7' } },
    { id: 'other', source: 'novel', profile: { model: 'other/alias', capabilityModelId: V3 } },
  ];
  const presets = context.storyboardParameterPresets('novel');
  assert.ok(presets.some((item) => item.builtin));
  for (const preset of presets.filter((item) => item.builtin)) {
    assert.equal(preset.profile.model, alias);
    assert.equal(preset.profile.capabilityModelId, V5);
  }
  assert.equal(presets.some((item) => item.id === 'v5'), true);
  assert.equal(presets.some((item) => item.id === 'v45' || item.id === 'other'), false);
  const routed = context.storyboardParameterPresets('novel', V5);
  assert.ok(routed.some((item) => item.builtin));
  assert.ok(routed.filter((item) => item.builtin).every((item) => item.profile.model === V5 && item.profile.capabilityModelId === V5));
  assert.equal(context.storyboardParameterPresets('novel', V3).some((item) => item.builtin), false);
});

function rootWith(fields = {}) {
  return { querySelector: (selector) => fields[selector] || null, querySelectorAll: () => [] };
}

test('capture keeps the old identity when the DOM already shows the next selection', () => {
  const { state, context } = environment();
  const root = rootWith({ '.sd-storyboard-model-select': { value: V45 } });
  context.storyboardCaptureWorkbench(root, 'novel', { rememberModel: false });
  assert.equal(state.profiles.novel.model, alias);
  assert.equal(state.profiles.novel.capabilityModelId, V3);
  assert.equal(state.modelProfiles.bindings, undefined);
});

test('first prompt edit is remembered under the visible default model, not an empty model key', () => {
  const { state, context } = environment();
  state.profiles.novel = { ...storyboard.createStoryboardDefaults().profiles.novel };
  context.storyboardCaptureWorkbench(rootWith({ '.sd-storyboard-prompt': { value: 'my quality layer' } }));
  assert.equal(state.promptDefaults[`novel:${V5}`].positive, 'my quality layer');
  assert.equal(Object.hasOwn(state.promptDefaults, 'novel:'), false);
  assert.equal(state.profiles.novel.model, V5);
  assert.equal(state.profiles.novel.capabilityModelId, V5);
});

test('real selection callback with real capture replaces identity atomically and preserves previous alias memory', () => {
  const { state, context } = environment();
  state.profiles.novel.cfg = '0';
  let handler;
  const modelControl = { value: V45, addEventListener: (_type, callback) => { handler = callback; } };
  context.root = rootWith({ '.sd-storyboard-model-select': modelControl });
  context.state = state;
  const begin = source.indexOf("  root.querySelector('.sd-storyboard-model-select')?.addEventListener('change', (event) => {");
  const end = source.indexOf("  root.querySelector('.sd-storyboard-compiler-api')", begin);
  vm.runInContext(source.slice(begin, end), context);
  handler({ target: modelControl });
  assert.equal(state.profiles.novel.model, V45);
  assert.equal(state.profiles.novel.capabilityModelId, V45);
  assert.equal(storyboard.getStoryboardRememberedProfile(state.modelProfiles, 'novel', alias, V3).cfg, '0');
  modelControl.value = 'new-unbound-alias';
  const before = structuredClone(state.profiles.novel);
  handler({ target: modelControl });
  assert.deepEqual(structuredClone(state.profiles.novel), before);
});

test('actual task creation and request preserve alias/capability/defaults independently of the connection model', () => {
  const { state, context } = environment();
  const job = context.storyboardCreateJob(state, state.profiles.novel);
  assert.equal(job.profile.model, alias);
  assert.equal(job.profile.capabilityModelId, V3);
  assert.equal(job.profile.sampler, storyboard.getStoryboardNovelParameterSpec(V3).defaults.sampler);
  assert.equal(job.modelIdentity.remoteModelId, alias);
  assert.equal(job.modelIdentity.capabilityModelId, V3);
  const request = context.storyboardGatewayRequest(job, 'test-key', { references: [], vibes: [] });
  assert.equal(request.model, alias);
  assert.equal(request.capabilityModelId, V3);
  assert.equal(job.compiledPrompt.modelBinding.capabilityModelId, V3);
});

test('an explicit canonical task route replaces the prior alias capability, while unknown routes fail', () => {
  const { state, context } = environment();
  const job = context.storyboardCreateJob(state, state.profiles.novel, { modelId: V45 });
  assert.equal(job.modelIdentity.remoteModelId, V45);
  assert.equal(job.modelIdentity.capabilityModelId, V45);
  assert.throws(() => context.storyboardCreateJob(state, state.profiles.novel, { modelId: 'unbound-route' }), { code: 'missing_capability_model' });
});

test('routing to another known model cannot inherit the previous model sampler or parameter edits', () => {
  const { state, context } = environment();
  Object.assign(state.profiles.novel, { loaded: true, sampler: 'k_dpm_2', cfg: '1' });
  const defaults = context.storyboardCreateJob(state, state.profiles.novel, { modelId: V5 });
  assert.equal(defaults.profile.sampler, storyboard.getStoryboardNovelParameterSpec(V5).defaults.sampler);
  assert.notEqual(defaults.profile.cfg, '1');
  storyboard.rememberStoryboardModelProfile(state.modelProfiles, 'novel', { model: V5, loaded: true, cfg: '9', sampler: 'k_euler_a' });
  const remembered = context.storyboardCreateJob(state, state.profiles.novel, { modelId: V5 });
  assert.equal(remembered.profile.cfg, '9');
  assert.equal(remembered.profile.sampler, 'k_euler_a');
  assert.equal(state.profiles.novel.cfg, '1');
});

test('actual log loading clears previous capability and sampler fields rather than merging stale settings', () => {
  const { state, context } = environment();
  state.profiles.novel.sampler = 'old sampler';
  context.storyboardLoadLogToWorkbench({ source: 'novel', snapshot: { source: 'novel', profile: { model: V45, cfg: '0' }, target: 'gallery' } });
  assert.equal(state.profiles.novel.capabilityModelId, undefined);
  assert.equal(state.profiles.novel.sampler, '');
  assert.equal(context.storyboardProviderProfile(state).capabilityModelId, V45);
  const original = { source: 'novel', profile: { model: alias, capabilityModelId: V3 }, connection: { id: 'original' } };
  const identity = storyboard.resolveStoryboardJobModelIdentity(original);
  context.storyboardLoadLogToWorkbench({ source: 'novel', snapshot: { ...original, profile: { model: alias }, modelIdentity: identity } });
  assert.equal(state.profiles.novel.capabilityModelId, V3);
  assert.equal(state.profiles.novel.model, alias);
});

test('safety adaptation uses the capability content policy, not misleading remote naming', async () => {
  const { state, context } = environment();
  const shot = { prompt: 'original dramatic scene', sensitive: true, safePrompt: 'quiet aftermath' };
  const full = await context.storyboardAdaptShotForModel(shot, 'novel', 'vendor/curated-looking', state, { capabilityModelId: V3 });
  assert.equal(full.safetyAdapted, false);
  const filtered = await context.storyboardAdaptShotForModel(shot, 'novel', 'vendor/full-looking', state, { capabilityModelId: 'nai-diffusion-5-curated' });
  assert.equal(filtered.safetyAdapted, true);
  assert.equal(filtered.prompt, 'quiet aftermath');
});

test('loading a saved image edit into the workbench takes priority over its original generation log', async () => {
  const { state, context } = environment();
  state.logs = [{ recordId: 'image-a', source: 'novel', snapshot: { source: 'novel', profile: { model: V5 }, prompt: 'old scene' } }];
  context.storyboardReadSnapshotForRecord = async () => ({ source: 'novel', profile: { model: alias, capabilityModelId: V45 }, prompt: 'edited scene', target: 'gallery' });
  vm.runInContext(section('storyboardLoadRecordToWorkbench'), context);
  await context.storyboardLoadRecordToWorkbench({ id: 'image-a', source: 'novel' });
  assert.equal(state.prompt, 'edited scene');
  assert.equal(state.profiles.novel.model, alias);
  assert.equal(state.profiles.novel.capabilityModelId, V45);
  assert.equal(state.logs[0].snapshot.prompt, 'old scene');
});

test('a late image-setting load cannot overwrite the workbench after changing chats', async () => {
  const { state, context } = environment();
  const before = JSON.stringify(state);
  context.storyboardReadSnapshotForRecord = async () => {
    context.getChatKey = () => 'chat-b';
    return { source: 'novel', profile: { model: V5 }, prompt: 'old-chat scene' };
  };
  vm.runInContext(section('storyboardLoadRecordToWorkbench'), context);
  assert.equal(await context.storyboardLoadRecordToWorkbench({ id: 'image-a', source: 'novel' }), false);
  assert.equal(JSON.stringify(state), before);
});

test('invalid profiles stop both compiler and generation before any external work', async () => {
  const { state, context, notices } = environment('', 'invalid-unbound');
  context.storyboardCompilerBusy = false;
  context.storyboardCaptureWorkbench = () => ({ state, profile: state.profiles.novel, workflowResult: { ok: true, removedFields: [] } });
  context.featureRuntime = { load: () => assert.fail('external work must not begin') };
  vm.runInContext(section('storyboardCompilePrompt') + section('storyboardGenerate'), context);
  assert.equal(await context.storyboardCompilePrompt(null), false);
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(notices.length, 2);
});
