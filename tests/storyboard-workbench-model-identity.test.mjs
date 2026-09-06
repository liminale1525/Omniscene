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
    storyboardTargetFloor: () => -1, storyboardCredentialRevision: 0, getCharacterDescription: () => '', getPersonaDescription: () => '',
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
  const names = ['storyboardConnectionState', 'storyboardProviderProfile', 'renderStoryboardModelPicker', 'storyboardApplyModelBinding',
    'storyboardCompilerProfileOptions', 'renderStoryboardModelCard', 'storyboardPromptDefaultsKey',
    'storyboardProviderPromptDefaults', 'storyboardPromptLayerForArtist', 'storyboardRememberPromptLayer',
    'storyboardPromptsForArtist', 'storyboardJoinPrompt', 'storyboardParameterPresets',
    'renderStoryboardParameterPresets', 'renderStoryboardParameterVibes', 'renderStoryboardCreate',
    'storyboardProfileSnapshot', 'storyboardCaptureWorkbench', 'storyboardGenerationPayload',
    'storyboardCreatePreparationGuard', 'storyboardResolveRoutingProfile', 'storyboardRoutingTargetOptions', 'storyboardCreateJob', 'storyboardGatewayRequest', 'storyboardLoadLogToWorkbench', 'storyboardSafeShotSpecFromPrompt', 'storyboardAdaptShotForModel'];
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
  assert.match(html, /value="vendor\/&lt;alias&gt;"/);
  assert.doesNotMatch(html, /value="nai-diffusion-5-full" selected/);
  assert.doesNotMatch(html, /<alias>/);
});

test('invalid bindings show a repairable model card instead of crashing the entire workbench', () => {
  const { state, context } = environment('', 'unknown-alias');
  const before = structuredClone(state.profiles.novel);
  const html = context.renderStoryboardCreate(state);
  assert.match(html, /请重新选择模型/);
  assert.match(html, /value="unknown-alias"/);
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

test('routing restores different capabilities for the same actual model name without editing workbench state', () => {
  const { state, context } = environment(V3);
  Object.assign(state.profiles.novel, { loaded: true, cfg: '1' });
  storyboard.rememberStoryboardModelProfile(state.modelProfiles, 'novel', { model: alias, capabilityModelId: V45, loaded: true, cfg: '9', sampler: 'k_euler' });
  const before = structuredClone(state);
  const profile = context.storyboardResolveRoutingProfile(state, { providerId: 'novel', modelId: alias, capabilityModelId: V45 });
  assert.equal(profile.cfg, '9');
  assert.equal(profile.capabilityModelId, V45);
  const job = context.storyboardCreateJob(state, state.profiles.novel, { modelId: alias, capabilityModelId: V45 });
  assert.equal(job.profile.cfg, '9');
  assert.equal(job.modelIdentity.capabilityModelId, V45);
  assert.deepEqual(state, before);
});

test('routing validates connection references and exact model/capability parameter references', () => {
  const { state, context } = environment(V3);
  state.parameterPresets = [{ id: 'params', source: 'novel', profile: { model: alias, capabilityModelId: V45, cfg: '0', steps: '17' } }];
  state.connections.novel.presets = [{ id: 'api', model: V5, baseUrl: 'https://route.example', credentialId: 'route-key' }];
  const route = { providerId: 'novel', modelId: alias, capabilityModelId: V45, connectionPresetId: 'api', parameterPresetId: 'params' };
  const profile = context.storyboardResolveRoutingProfile(state, route);
  assert.equal(profile.cfg, '0');
  assert.equal(profile.steps, '17');
  assert.equal(profile.model, alias);
  assert.throws(() => context.storyboardResolveRoutingProfile(state, { ...route, capabilityModelId: V3 }), { code: 'invalid_route_parameters' });
  assert.throws(() => context.storyboardResolveRoutingProfile(state, { ...route, parameterPresetId: 'missing' }), { code: 'invalid_route_parameters' });
  assert.throws(() => context.storyboardResolveRoutingProfile(state, { ...route, connectionPresetId: 'missing' }), { code: 'missing_route_connection' });
  assert.throws(() => context.storyboardCreateJob(state, state.profiles.novel, { connectionPresetId: 'missing' }), { code: 'missing_route_connection' });
  const builtin = context.storyboardResolveRoutingProfile(state, { providerId: 'novel', modelId: alias, capabilityModelId: V5, parameterPresetId: 'builtin:nai-v5-official' });
  assert.equal(builtin.model, alias);
  assert.equal(builtin.capabilityModelId, V5);
});

test('route rendering keeps bound aliases selected and exposes stale references without changing state', () => {
  const { state, context } = environment(V3);
  const route = { providerId: 'novel', modelId: 'vendor/<alias>', capabilityModelId: V45, connectionPresetId: 'missing-api', parameterPresetId: 'missing-style' };
  const before = structuredClone(state);
  const html = context.storyboardRoutingTargetOptions(state, 'novel', route);
  assert.match(html, /value="vendor\/&lt;alias&gt;"/);
  assert.match(html, /value="missing-api" selected/);
  assert.match(html, /value="missing-style" selected/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /<alias>/);
  assert.deepEqual(state, before);
});

function routeHandlers(context, state) {
  const start = source.indexOf("  root.querySelectorAll('[data-storyboard-route-rule]').forEach");
  const end = source.indexOf("  root.querySelector('.sd-storyboard-use-floor')", start);
  const callbacks = {};
  const row = { dataset: { storyboardRouteRule: 'r' }, querySelector: (selector) => ({ addEventListener: (name, callback) => { callbacks[`${selector}:${name}`] = callback; } }) };
  context.state = state;
  context.root = { querySelectorAll: () => [row] };
  vm.runInContext(source.slice(start, end), context);
  return callbacks;
}

test('actual routing model/provider handlers switch identities atomically and preserve channel connections on model changes', () => {
  const { state, context, notices } = environment(V3);
  const rule = { id: 'r', target: { providerId: 'novel', modelId: alias, capabilityModelId: V45, connectionPresetId: 'api', parameterPresetId: 'params' } };
  state.routing.rules = [rule];
  const callbacks = routeHandlers(context, state);
  const root = { isConnected: true };
  context.storyboardApplyModelBinding(root, state, 'novel', { remoteModelId: V3 }, rule);
  assert.equal(rule.target.modelId, V3);
  assert.equal(rule.target.capabilityModelId, V3);
  assert.equal(rule.target.connectionPresetId, 'api');
  assert.equal(rule.target.parameterPresetId, '');
  const before = structuredClone(rule.target);
  assert.throws(() => context.storyboardApplyModelBinding(root, state, 'novel', { remoteModelId: 'new-unbound-alias' }, rule), { code: 'missing_capability_model' });
  assert.deepEqual(rule.target, before);
  callbacks['.sd-storyboard-route-provider:change']({ target: { value: 'openai' } });
  assert.equal(rule.target.capabilityModelId, 'gpt-image-2');
  assert.equal(rule.target.connectionPresetId, '');
});

function generationEnvironment() {
  const env = environment(V3);
  const { state, context } = env, queued = [];
  Object.assign(context, {
    storyboardProductionContext: () => ({}), storyboardQueue: [], storyboardActiveJobs: new Map(), STORYBOARD_QUEUE_LIMIT: 100,
    storyboardQueueJob: (job) => { queued.push(job); return true; }, confirmDialog: async () => true,
  });
  vm.runInContext(section('storyboardGenerate'), context);
  state.source = 'openai';
  state.profiles.openai = { ...state.profiles.openai, model: 'gpt-image-2' };
  state.promptDraft.shots = [{ id: 'garden', prompt: 'quiet garden', shotType: 'environment',
    shotSpec: { evidence: { quote: 'quiet garden' }, visualDuty: 'establish the quiet location', narrativePurpose: 'establish the scene' } }];
  state.routing.enabled = true;
  state.connections.novel.presets = [{ id: 'api', baseUrl: 'https://route.example', credentialId: 'route-key', model: V5 }];
  state.parameterPresets = [{ id: 'style', source: 'novel', profile: { model: alias, capabilityModelId: V45, steps: '17', count: '2', cfg: '0' } }];
  state.routing.rules = [{ id: 'r', enabled: true, name: '人物分工', target: { providerId: 'novel', modelId: alias, capabilityModelId: V45, connectionPresetId: 'api', parameterPresetId: 'style' } }];
  return { ...env, queued };
}

test('actual generation routes across families and preserves applied style and per-request NAI count', async () => {
  const { context, queued } = generationEnvironment();
  assert.equal(await context.storyboardGenerate(null), true);
  assert.equal(queued.length, 2);
  for (const job of queued) {
    assert.equal(job.source, 'novel');
    assert.equal(job.profile.model, alias);
    assert.equal(job.profile.capabilityModelId, V45);
    assert.equal(job.profile.steps, '17');
    assert.equal(job.profile.cfg, '0');
    assert.equal(job.profile.count, '1');
    assert.equal(job.connection.id, 'api');
    assert.equal(job.connection.baseUrl, 'https://route.example');
    assert.equal(job.modelIdentity.capabilityModelId, V45);
    assert.equal(context.storyboardGatewayRequest(job, 'mock-key', { references: [], vibes: [] }).model, alias);
  }
});

test('broken active routes stop before extraction/queues, but disabled routing cannot block ordinary generation', async () => {
  const { state, context, queued, notices } = generationEnvironment();
  state.routing.rules[0].target.connectionPresetId = 'missing';
  state.prompt = '';
  context.storyboardCompilePrompt = async () => { throw new Error('must not call extraction'); };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.match(notices.at(-1), /人物分工.*API 预设已失效/);
  assert.equal(queued.length, 0);
  state.routing.enabled = false;
  state.prompt = 'quiet garden';
  assert.equal(await context.storyboardGenerate(null), true);
  assert.equal(queued[0].source, 'openai');
});

test('deleting a routed connection during safety preparation cannot queue a fallback request', async () => {
  const { state, context, queued, notices } = generationEnvironment();
  context.storyboardAdaptShotForModel = async (shot) => { state.connections.novel.presets = []; return shot; };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(queued.length, 0);
  assert.match(notices.at(-1), /生图设置已变化/);
});

test('changing drawing settings in the count confirmation prevents all queued requests', async () => {
  const { state, context, queued, notices } = generationEnvironment();
  context.confirmDialog = async () => { Object.assign(state.profiles.novel, { loaded: true, cfg: '8' }); return true; };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(queued.length, 0);
  assert.match(notices.at(-1), /生图设置已变化/);
});

test('a rejected or stale extraction result cannot be followed by generation of an older or fallback draft', async () => {
  const { state, context, queued } = generationEnvironment();
  state.prompt = '';
  context.storyboardCompilePrompt = async () => { state.prompt = 'manual review fallback'; return false; };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(queued.length, 0);
});

test('an archive load cannot continue preparing jobs after a channel change', async () => {
  const { state, context, queued } = generationEnvironment();
  const plan = { archiveRef: 'archive-a', status: 'prompt_ready' };
  context.storyboardReleasePlanArchive = async () => { state.source = 'banana'; };
  assert.equal(await context.storyboardGenerate(null, { plan }), false);
  assert.equal(queued.length, 0);
});

test('materializing visible parameter defaults on page navigation does not invalidate an unchanged effective model', () => {
  const { state, context } = environment(V3);
  const guard = context.storyboardCreatePreparationGuard(state);
  state.profiles.novel = { ...context.storyboardProviderProfile(state), loaded: true };
  state.view = 'assets';
  assert.equal(guard.isCurrent(), true);
  guard.dispose();
});

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
  const root = { ...rootWith(), isConnected: true };
  context.storyboardApplyModelBinding(root, state, 'novel', { remoteModelId: V45 });
  assert.equal(state.profiles.novel.model, V45);
  assert.equal(state.profiles.novel.capabilityModelId, V45);
  assert.equal(storyboard.getStoryboardRememberedProfile(state.modelProfiles, 'novel', alias, V3).cfg, '0');
  const before = structuredClone(state.profiles.novel);
  assert.throws(() => context.storyboardApplyModelBinding(root, state, 'novel', { remoteModelId: 'new-unbound-alias' }), { code: 'missing_capability_model' });
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
