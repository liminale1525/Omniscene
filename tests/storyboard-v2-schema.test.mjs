import assert from 'node:assert/strict';
import {
  STORYBOARD_ENTITY_TYPES,
  STORYBOARD_MODEL_REGISTRY,
  STORYBOARD_PROMPT_MODES,
  STORYBOARD_PROVIDER_REGISTRY,
  STORYBOARD_SCHEMA_VERSION,
  STORYBOARD_DIAGNOSTIC_TEXT_LIMIT,
  STORYBOARD_PIPELINE_LOG_LIMIT,
  STORYBOARD_PIPELINE_LOG_RETENTION_MS,
  buildImagineCommand,
  buildStoryboardProviderPlan,
  createStoryboardDefaults,
  createStoryboardEntity,
  createStoryboardParagraphAnchor,
  getStoryboardCapabilities,
  migrateStoryboardState,
  normalizeStoryboardParagraphAnchor,
  normalizeStoryboardState,
  pruneStoryboardPipelineLogs,
  resolveStoryboardVisualState,
  routeStoryboardShot,
  sanitizeStoryboardDiagnosticData,
  sanitizeStoryboardSnapshot,
  sanitizeStoryboardWorkflow,
  scoreStoryboardParagraphAnchor,
} from '../qianmu-storyboard.js';

assert.equal(STORYBOARD_SCHEMA_VERSION, 24);
assert.equal(STORYBOARD_PIPELINE_LOG_LIMIT, 20);
assert.equal(STORYBOARD_DIAGNOSTIC_TEXT_LIMIT, 256 * 1024);
assert.equal(STORYBOARD_PIPELINE_LOG_RETENTION_MS, 0);
assert.deepEqual(Object.keys(STORYBOARD_PROVIDER_REGISTRY), ['novel', 'banana', 'openai', 'seedream', 'comfy']);
assert.deepEqual(Object.keys(STORYBOARD_PROMPT_MODES), ['manual', 'auto', 'combined']);
assert.deepEqual(STORYBOARD_ENTITY_TYPES, ['char', 'user', 'cast']);

const novelGenerations = new Set(STORYBOARD_MODEL_REGISTRY.novel.map((item) => item.generation));
assert.deepEqual([...novelGenerations], ['V3', 'V4', 'V4.5', 'V5'], 'NovelAI must expose only V3 and later generations');
assert.ok(STORYBOARD_MODEL_REGISTRY.novel.filter((item) => item.id.includes('full') || item.generation === 'V3').every((item) => item.label.includes('💕')), 'unfiltered NovelAI models must be visibly marked');
assert.equal(STORYBOARD_PROVIDER_REGISTRY.openai.customModelId, true, 'the custom OpenAI-compatible channel must accept third-party model IDs');
assert.equal(STORYBOARD_PROVIDER_REGISTRY.openai.label, 'GPT Image');
assert.ok(Object.entries(STORYBOARD_PROVIDER_REGISTRY).filter(([id]) => id !== 'openai').every(([, provider]) => provider.customModelId === false), 'official channels keep curated model IDs');
assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-4-5-full').vibe, true);
assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-4-5-full').preciseReference, true);
assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-4-5-full').multipleReferences, true);
assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-5-full').vibe, false, 'V5 launch must gate Vibe');
assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-5-full').preciseReference, false, 'V5 launch must gate Precise Reference');

const defaults = createStoryboardDefaults();
assert.equal(defaults.schemaVersion, 24);
assert.equal(defaults.enabled, false);
assert.deepEqual(defaults.automation, { autoCapture: true, autoGenerate: true });
assert.equal(defaults.promptCompiler.enabled, true);
assert.equal(defaults.promptMode, 'manual');
assert.equal(defaults.promptDraft.userEditedCompiled, false);
assert.deepEqual(defaults.promptDefaults, {});
assert.equal(Object.hasOwn(defaults, 'selectedCharacters'), false);
assert.equal(Object.hasOwn(defaults, 'characters'), false);
assert.equal(Object.hasOwn(defaults, 'entities'), false);
assert.deepEqual(Object.keys(defaults.connections), Object.keys(STORYBOARD_PROVIDER_REGISTRY));
assert.notStrictEqual(defaults.connections.novel, defaults.connections.openai, 'provider connections must be isolated');

const oneSidedPromptDefault = normalizeStoryboardState({ promptDefaults: { 'novel:nai-diffusion-5-full': { positive: '' } } });
assert.equal(Object.hasOwn(oneSidedPromptDefault.promptDefaults['novel:nai-diffusion-5-full'], 'positive'), true, 'an explicitly cleared side must stay cleared');
assert.equal(Object.hasOwn(oneSidedPromptDefault.promptDefaults['novel:nai-diffusion-5-full'], 'negative'), false, 'editing one prompt side must not suppress the other side fallback');

const rememberedModels = normalizeStoryboardState({
  source: 'novel',
  profiles: { novel: { model: 'nai-diffusion-5-full', steps: '31', cfg: '6.2' } },
  modelProfiles: { novel: { 'nai-diffusion-4-5-full': { model: 'nai-diffusion-4-5-full', steps: '24', cfg: '5.5' } } },
});
assert.equal(rememberedModels.modelProfiles.novel['nai-diffusion-4-5-full'].steps, '24');
assert.equal(rememberedModels.modelProfiles.novel['nai-diffusion-5-full'].steps, '31', '当前模型参数必须进入逐模型记忆');

const takePresets = normalizeStoryboardState({
  promptPresets: [
    { id: 'legacy-take', name: '旧方案', instruction: '保留原顺序' },
    { id: 'ordered-take', name: '镜头语言', items: [
      { id: 'first', name: '先定主体', instruction: '确定主体与动作' },
      { id: 'second', name: '再定镜头', instruction: '选择景别与构图' },
    ] },
  ],
});
assert.equal(takePresets.promptPresets[0].items[0].name, '基础指令', '旧单段指令必须无损迁移为一个条目');
assert.deepEqual(takePresets.promptPresets[1].items.map((item) => item.id), ['first', 'second'], '取景预设条目顺序必须稳定');

const workflowWithCredentials = {
  '1': {
    class_type: 'TextNode',
    inputs: {
      prompt: 'ordinary prompt text mentioning api_key=fictional must stay intact',
      text: 'Authorization is part of this fictional caption',
      api_key: 'secret-api-key',
      headers: 'Authorization: Bearer header-secret',
      nested: { authorization: 'Bearer secret-token', strength: 0.75 },
    },
  },
};
const cleanWorkflow = sanitizeStoryboardWorkflow(workflowWithCredentials);
assert.equal(cleanWorkflow.ok, true);
assert.equal(cleanWorkflow.workflow['1'].inputs.api_key, undefined);
assert.equal(cleanWorkflow.workflow['1'].inputs.headers, undefined);
assert.equal(cleanWorkflow.workflow['1'].inputs.nested.authorization, undefined);
assert.equal(cleanWorkflow.workflow['1'].inputs.nested.strength, 0.75);
assert.equal(cleanWorkflow.workflow['1'].inputs.prompt, workflowWithCredentials['1'].inputs.prompt, 'prompt text must not be inspected as credential syntax');
assert.equal(cleanWorkflow.workflow['1'].inputs.text, workflowWithCredentials['1'].inputs.text, 'ordinary text nodes must remain byte-for-byte stable');
assert.ok(cleanWorkflow.removedFields.some((path) => path.endsWith('.api_key')));
assert.equal(sanitizeStoryboardWorkflow('{not-json').ok, false);

const normalizedWorkflowSecrets = normalizeStoryboardState({
  schemaVersion: 2,
  profiles: { comfy: { comfyWorkflow: JSON.stringify(workflowWithCredentials) } },
  parameterPresets: [{ id: 'unsafe-comfy-style', source: 'comfy', profile: { comfyWorkflow: JSON.stringify(workflowWithCredentials) } }],
  logs: [{
    id: 'unsafe-comfy-log', source: 'comfy', status: 'failed', queuedAt: Date.now(),
    snapshot: { source: 'comfy', profile: { comfyWorkflow: JSON.stringify(workflowWithCredentials) }, payload: { parameters: { workflow: JSON.stringify(workflowWithCredentials) } } },
  }],
  pipelineLogs: [{
    id: 'unsafe-comfy-pipeline', providerId: 'comfy', status: 'failed', finishedAt: Date.now(),
    stages: [{ id: 'provider', type: 'provider_request', status: 'failed', input: { parameters: { workflow: JSON.stringify(workflowWithCredentials) } } }],
  }],
});
for (const serialized of [
  normalizedWorkflowSecrets.profiles.comfy.comfyWorkflow,
  normalizedWorkflowSecrets.parameterPresets[0].profile.comfyWorkflow,
  JSON.stringify(normalizedWorkflowSecrets.logs[0].snapshot),
  JSON.stringify(normalizedWorkflowSecrets.pipelineLogs[0]),
]) {
  assert.doesNotMatch(serialized, /secret-api-key|secret-token/, 'workflow credentials must never survive persisted state normalization');
}
assert.match(normalizedWorkflowSecrets.profiles.comfy.comfyWorkflowNotice, /已移除凭据字段/);
assert.equal(JSON.parse(normalizedWorkflowSecrets.profiles.comfy.comfyWorkflow)['1'].inputs.prompt, workflowWithCredentials['1'].inputs.prompt);
const invalidWorkflowState = normalizeStoryboardState({ schemaVersion: 2, profiles: { comfy: { comfyWorkflow: '{not-json' } } });
assert.equal(invalidWorkflowState.profiles.comfy.comfyWorkflow, '', 'invalid workflow drafts must not enter persisted settings');
assert.match(invalidWorkflowState.profiles.comfy.comfyWorkflowNotice, /有效的 JSON/);

const safeDiagnostic = sanitizeStoryboardDiagnosticData({ parameters: { workflow: JSON.stringify(workflowWithCredentials) } });
assert.equal(safeDiagnostic.parameters.workflow['1'].inputs.api_key, undefined);
assert.equal(safeDiagnostic.parameters.workflow['1'].inputs.prompt, workflowWithCredentials['1'].inputs.prompt);
const longDiagnosticText = '镜'.repeat(100_000);
const completeDiagnostic = sanitizeStoryboardDiagnosticData({ messages: [{ content: longDiagnosticText }] });
assert.equal(completeDiagnostic.messages[0].content.length, longDiagnosticText.length, 'contract-sized diagnostic text must not be clipped');
const deepSecret = sanitizeStoryboardDiagnosticData({
  a: { b: { c: { d: { e: { f: { g: { apiKey: 'must-not-survive' } } } } } } },
});
assert.doesNotMatch(JSON.stringify(deepSecret), /must-not-survive/);
const normalizedDetailedLog = pruneStoryboardPipelineLogs([{
  id: 'pipeline-complete', taskId: 'task-complete', status: 'success', providerId: 'novel',
  stages: [{ id: 'compiler', type: 'prompt_compiler', status: 'success', input: { messages: [{ content: longDiagnosticText }] }, output: {} }],
}]);
assert.equal(normalizedDetailedLog[0].stages[0].input.messages[0].content.length, longDiagnosticText.length, 'archived diagnostics must retain full contract-sized text');
const safeSnapshot = sanitizeStoryboardSnapshot({ source: 'comfy', payload: { parameters: { workflow: JSON.stringify(workflowWithCredentials) } } });
assert.doesNotMatch(JSON.stringify(safeSnapshot), /secret-api-key|secret-token/);
assert.match(safeSnapshot.profile.comfyWorkflowNotice, /已移除凭据字段/);

const now = Date.now();
const migrated = normalizeStoryboardState({
  selectedCharacterId: 'look-1',
  prompt: 'old prompt',
  profiles: { openai: { model: 'gpt-image-1', openaiQuality: 'high', openaiBackground: 'transparent', openaiOutputFormat: 'webp', count: '2' }, seedream: { seedreamGuidanceScale: '4.5', seedreamSequential: true } },
  characters: [{ id: 'look-1', subjectType: 'char', subjectKey: 'card:a', subjectName: 'Alice', variantName: 'Winter', appearance: 'red coat' }],
  logs: [{ id: 'old-log', source: 'openai', status: 'success', prompt: 'old prompt', startedAt: now - 100, finishedAt: now }],
});
assert.equal(migrated.schemaVersion, 24);
assert.equal(migrated.enabled, true, 'existing storyboard users must keep their pre-upgrade behavior');
assert.equal(migrated.promptDraft.compiled, 'old prompt');
assert.equal(Object.hasOwn(migrated, 'characters'), false, 'v9 must remove untested character archive data');
assert.equal(Object.hasOwn(migrated, 'entities'), false, 'v9 must remove untested character entity data');
assert.equal(Object.hasOwn(migrated, 'selectedCharacters'), false);
assert.equal(migrated.connections.openai.presets[0].model, 'gpt-image-1', 'existing OpenAI-compatible model IDs must survive migration');
assert.equal(migrated.profiles.openai.openaiBackground, 'transparent');
assert.equal(migrated.profiles.openai.openaiOutputFormat, 'webp');
assert.equal(migrated.profiles.openai.count, '2');
assert.equal(migrated.profiles.seedream.seedreamGuidanceScale, '4.5');
assert.equal(migrated.profiles.seedream.seedreamSequential, true);
assert.equal(migrated.pipelineLogs[0].stages[0].type, 'generation');

const partiallyMigrated = normalizeStoryboardState({
  characters: [
    { id: 'legacy-winter', subjectType: 'char', subjectKey: 'card:a', subjectName: 'Alice', variantName: 'Winter', appearance: 'red coat' },
    { id: 'legacy-summer', subjectType: 'char', subjectKey: 'card:a', subjectName: 'Alice', variantName: 'Summer', appearance: 'linen dress' },
  ],
  entities: {
    char: [{ id: 'char:alice', type: 'char', subjectKey: 'card:a', name: 'Alice', activeProfileId: 'existing', profiles: [{ id: 'existing', name: 'Existing', appearance: 'black coat' }] }],
    candidates: [{ id: 'cast:maybe', name: 'Maybe', evidence: 'mentioned nearby' }],
  },
});
assert.equal(Object.hasOwn(partiallyMigrated, 'characters'), false);
assert.equal(Object.hasOwn(partiallyMigrated, 'entities'), false);

const entity = createStoryboardEntity({ id: 'cast:2', type: 'cast', name: '路人', profiles: [{ id: 'look-2', appearance: 'grey hair' }] });
const normalized = normalizeStoryboardState({
  schemaVersion: 2,
  source: 'novel',
  connections: { novel: { draft: { model: 'nai-diffusion-5-full' } } },
  entities: { cast: [entity] },
  selectedCharacters: [{ entityId: 'cast:2', profileId: 'look-2', consistency: 'hybrid', referenceStrategy: 'vibe' }],
});
assert.equal(Object.hasOwn(normalized, 'entities'), false, 'removed character archives must not survive normalization');
assert.equal(Object.hasOwn(normalized, 'selectedCharacters'), false, '旧出镜选择必须在 v8 直接切割');

const selectionFallback = normalizeStoryboardState({
  schemaVersion: 2,
  source: 'openai',
  view: 'assets',
  characterView: 'folder',
  entities: { char: [{ id: 'char:a', activeProfileId: 'look-a', profiles: [{ id: 'look-a' }] }] },
  selectedCharacters: [
    { entityId: 'char:a', profileId: 'profile-from-another-character', referenceStrategy: 'avatar' },
    { entityId: 'char:a', profileId: 'look-a' },
    { entityId: 'missing', profileId: 'missing' },
  ],
  promptDraft: { manual: 'keep', compilerMeta: { requestId: 'compiler-1' } },
  runtimeExtension: { safe: 'kept', apiKey: 'must-drop' },
  apiKey: 'must-drop',
});
assert.equal(selectionFallback.view, 'assets');
assert.equal(Object.hasOwn(selectionFallback, 'characterView'), false);
assert.equal(Object.hasOwn(selectionFallback, 'entities'), false);
assert.equal(Object.hasOwn(selectionFallback, 'selectedCharacters'), false);
assert.equal(Object.hasOwn(selectionFallback.promptDraft, 'manual'), false, 'removed screen-intent fields must not survive normalization');
assert.equal(selectionFallback.promptDraft.compilerMeta.requestId, 'compiler-1', 'safe compiler metadata must survive normalization');
assert.deepEqual(selectionFallback.runtimeExtension, { safe: 'kept' });
assert.equal(selectionFallback.apiKey, undefined);

const customPlan = buildStoryboardProviderPlan({
  providerId: 'openai',
  connection: { id: 'mirror', baseUrl: 'https://mirror.example/v1', model: 'mirror-image-model', credentialId: 'secret:mirror' },
  prompt: 'quiet room',
  negative: 'watermark',
  params: { seed: 8, width: 1024, height: 1536, providerOptions: { quality: 'high', apiKey: 'must-not-persist' } },
  references: [{ type: 'gallery', assetId: 'asset-1' }],
  mask: { type: 'asset', assetId: 'mask-1' },
});
assert.equal(customPlan.customModel, true);
assert.equal(customPlan.model, 'mirror-image-model', 'a compatible mirror must keep its concrete model ID');
assert.equal(customPlan.baseUrl, 'https://mirror.example/v1');
assert.equal(customPlan.request.references.length, 1);
assert.equal(customPlan.droppedParameters.includes('negative'), false, 'natural-language exclusions remain available to the transport composer');
assert.ok(customPlan.droppedParameters.includes('seed'));
assert.ok(customPlan.droppedParameters.includes('mask'), 'capabilities must not advertise an unimplemented gateway feature');
assert.equal(customPlan.request.providerOptions.apiKey, undefined, 'request options must not persist credentials');
assert.equal(Object.getPrototypeOf(customPlan.request.providerOptions), Object.prototype);
assert.equal(customPlan.gatewayRequest.negativePrompt, 'watermark');

const v5Plan = buildStoryboardProviderPlan({
  providerId: 'novel', connection: { model: 'nai-diffusion-5-full' }, prompt: 'portrait', vibes: [{ id: 'vibe-1', strength: 0.8 }],
});
assert.deepEqual(v5Plan.request.vibes, []);
assert.ok(v5Plan.droppedParameters.includes('vibes'));

const limitedReferencePlan = buildStoryboardProviderPlan({
  providerId: 'novel', connection: { model: 'nai-diffusion-4-5-full' }, prompt: 'portrait',
  references: [{ type: 'gallery', assetId: 'a' }, { type: 'gallery', assetId: 'b' }],
  params: { ratio: '16:9', workflow: { node: 1 }, providerOptions: { model: 'override', nested: { apiKey: 'secret', value: 'kept' } } },
});
assert.equal(limitedReferencePlan.request.references.length, 2, 'NovelAI V4 precise references may contain multiple images');
assert.ok(!limitedReferencePlan.droppedParameters.includes('references'));
assert.ok(limitedReferencePlan.droppedParameters.includes('workflow'));
assert.equal(limitedReferencePlan.request.providerOptions.model, undefined, 'reserved provider options cannot override the plan');
assert.deepEqual(limitedReferencePlan.request.providerOptions.nested, { value: 'kept' });

const openAiReferences = buildStoryboardProviderPlan({
  providerId: 'openai', prompt: 'group portrait',
  references: Array.from({ length: 20 }, (_, index) => ({ type: 'gallery', assetId: `asset-${index}` })),
});
assert.equal(openAiReferences.request.references.length, 16);
assert.ok(openAiReferences.droppedParameters.includes('extraReferences'));

const materialState = normalizeStoryboardState({
  schemaVersion: 2,
  source: 'novel',
  connections: { novel: { draft: { model: 'nai-diffusion-4-5-full' }, presets: [{ id: 'nai', model: 'nai-diffusion-4-5-full' }] } },
  parameterPresets: [{ id: 'nai-params', source: 'novel' }],
  tagLibrary: [
    { id: 'tag-a', name: '柔光', conflictIds: ['tag-a', 'tag-b', 'missing'] },
    { id: 'tag-b', name: '冷调' },
    { id: 'tag-a', name: '柔光更新', aliases: ['soft', 'soft'] },
  ],
  promptPresets: [{ id: 'prompt-a', tagIds: ['tag-a', 'missing'] }],
  vibeLibrary: [
    { id: 'vibe-a', providerIds: ['novel', 'openai'], modelIds: ['nai-diffusion-4-5-full', 'nai-diffusion-5-full'], tags: ['tag-a', 'missing'] },
    { id: 'vibe-a', name: 'Vibe updated', providerIds: ['novel'], modelIds: ['nai-diffusion-4-5-full'] },
  ],
  selectedVibeIds: ['vibe-a', 'missing'],
  routing: {
    mode: 'ensemble',
    single: { providerId: 'novel', connectionPresetId: 'missing', parameterPresetId: 'nai-params' },
    rules: [
      { id: 'rule', priority: 1, target: { providerId: 'novel', connectionPresetId: 'nai', parameterPresetId: 'missing' } },
      { id: 'rule', priority: 2, target: { providerId: 'openai', connectionPresetId: 'wrong-provider' } },
    ],
  },
});
assert.equal(materialState.tagLibrary.length, 2);
assert.equal(materialState.tagLibrary.find((tag) => tag.id === 'tag-a').name, '柔光更新', 'latest duplicate entity must win');
assert.deepEqual(materialState.promptPresets[0].tagIds, ['tag-a']);
assert.equal(materialState.vibeLibrary.length, 1);
assert.deepEqual(materialState.vibeLibrary[0].providerIds, ['novel']);
assert.deepEqual(materialState.vibeLibrary[0].modelIds, ['nai-diffusion-4-5-full']);
assert.deepEqual(materialState.selectedVibeIds, ['vibe-a']);
assert.equal(materialState.routing.single.connectionPresetId, 'missing', 'broken explicit connections must not silently become the current draft');
assert.equal(materialState.routing.single.parameterPresetId, 'nai-params');
assert.equal(materialState.routing.rules.length, 1);
assert.equal(materialState.routing.rules[0].target.providerId, 'openai');
assert.equal(materialState.routing.rules[0].target.connectionPresetId, 'wrong-provider');
const invalidRoute = routeStoryboardShot({ shotType: 'portrait' }, { mode: 'ensemble', rules: [{ id: 'bad', target: { providerId: 'removed-provider' } }], single: { providerId: 'openai' } });
assert.equal(invalidRoute.providerId, 'openai', 'an obsolete routing rule must fall back, never silently reroute to another paid provider');

const v5MaterialState = normalizeStoryboardState({
  schemaVersion: 2, source: 'novel', connections: { novel: { draft: { model: 'nai-diffusion-5-full' } } },
  vibeLibrary: [{ id: 'vibe-a', providerIds: ['novel'], modelIds: ['nai-diffusion-4-5-full'] }], selectedVibeIds: ['vibe-a'],
});
assert.deepEqual(v5MaterialState.selectedVibeIds, ['vibe-a'], 'switching to V5 must disable, not erase, the user selection');

const state = resolveStoryboardVisualState([
  { key: 'age', value: 'young', source: 'archive' },
  { key: 'coat', value: 'red', source: 'archive' },
  { key: 'coat', value: 'black', source: 'targetParagraph' },
  { key: 'age', value: 'old', source: 'explicit' },
]);
assert.deepEqual(state.values, { age: 'old', coat: 'black' });
assert.equal(state.decisions.filter((item) => item.action === 'suppressed').length, 2);
const hostileState = resolveStoryboardVisualState([{ key: '__proto__', value: 'safe', source: 'explicit' }]);
assert.equal(Object.hasOwn(hostileState.values, '__proto__'), true);
assert.equal(hostileState.values.__proto__, 'safe');
assert.equal(Object.getPrototypeOf(hostileState.values), Object.prototype);

const route = routeStoryboardShot({ shotType: 'environment', sensitive: false }, {
  mode: 'ensemble', single: { providerId: 'novel' }, rules: [
    { id: 'general', shotTypes: [], target: { providerId: 'openai' }, priority: 1 },
    { id: 'landscape', shotTypes: ['environment'], target: { providerId: 'banana' }, priority: 10 },
  ],
});
assert.equal(route.providerId, 'banana');
assert.equal(route.ruleId, 'landscape');

const anchor = createStoryboardParagraphAnchor({ chatKey: 'chat-a', floor: 88, swipeId: 2, messageText: 'First\nSecond paragraph', paragraphIndex: 1, paragraphText: 'Second paragraph', previousText: 'First' });
assert.equal(scoreStoryboardParagraphAnchor(anchor, 'Second paragraph', 1, 'First'), 93);
assert.ok(scoreStoryboardParagraphAnchor(anchor, 'Second paragraph changed', 1, 'First') > 20);
assert.equal(anchor.floor, 88);
const chineseAnchor = createStoryboardParagraphAnchor({ messageText: '暮色落在旧城。\n她推开那扇门。', paragraphIndex: 1, paragraphText: '她推开那扇门。', previousText: '暮色落在旧城。' });
assert.ok(scoreStoryboardParagraphAnchor(chineseAnchor, '她慢慢推开了那扇旧门。', 4, '暮色落在旧城。') >= 20, 'CJK anchors need character n-gram similarity');
assert.equal(scoreStoryboardParagraphAnchor(normalizeStoryboardParagraphAnchor({ paragraphIndex: 1 }), 'anything', 1), 0, 'empty anchors must not match by index alone');

const logNow = 2_000_000_000_000;
const base64 = 'A'.repeat(512);
const retainedLogs = pruneStoryboardPipelineLogs([
  { id: 'old', status: 'success', finishedAt: logNow - 999_999_999 },
  { id: 'queued-old', status: 'queued', startedAt: logNow - 999_999_999 },
  { id: 'newer', status: 'success', finishedAt: logNow - 1, stages: [{ id: 'provider', status: 'success', input: { apiKey: 'secret', credentialId: 'credential:1', image: base64, nested: { authorization: 'Bearer secret' } }, decisions: ['used', 'used'], error: 'Authorization: Bearer sk-private' }] },
  { id: 'newest', status: 'failed', finishedAt: logNow },
], { now: logNow });
assert.deepEqual(retainedLogs.map((log) => log.id), ['queued-old', 'newest', 'newer', 'old']);
const sanitizedInput = retainedLogs.find((log) => log.id === 'newer').stages[0].input;
assert.equal(sanitizedInput.apiKey, '[redacted]');
assert.equal(sanitizedInput.credentialId, 'credential:1', 'opaque credential references are safe to retain');
assert.equal(sanitizedInput.image, '[image omitted]');
assert.equal(sanitizedInput.nested.authorization, '[redacted]');
assert.deepEqual(retainedLogs.find((log) => log.id === 'newer').stages[0].decisions, ['used']);
assert.doesNotMatch(retainedLogs.find((log) => log.id === 'newer').stages[0].error, /sk-private/);

const manyLogs = pruneStoryboardPipelineLogs(Array.from({ length: 350 }, (_, index) => ({ id: `log-${index}`, status: 'success', finishedAt: logNow - index })), { now: logNow });
assert.equal(manyLogs.length, STORYBOARD_PIPELINE_LOG_LIMIT);
assert.equal(manyLogs[0].id, 'log-0');
assert.equal(manyLogs.at(-1).id, 'log-19');

const snapshotState = normalizeStoryboardState({ schemaVersion: 2, logs: [{
  id: 'snapshot', status: 'success', source: 'openai', queuedAt: now, finishedAt: now,
  recordId: 'record-1', recordIds: ['record-1', 'record-2'], pipelineId: 'pipeline-1',
  snapshot: {
    source: 'openai', selectedCharacters: [{ entityId: 'char:a', profileId: 'look-a', name: 'Alice' }],
    paragraphAnchor: anchor, shotType: 'environment', connection: { id: 'conn', credentialId: 'cred:openai', apiKey: 'must-drop' },
    payload: { prompt: 'compiled', references: [{ data: base64 }] },
  },
}] });
assert.deepEqual(snapshotState.logs[0].recordIds, ['record-1', 'record-2']);
assert.equal(snapshotState.logs[0].pipelineId, 'pipeline-1');
assert.equal(Object.hasOwn(snapshotState.logs[0].snapshot, 'selectedCharacters'), false);
assert.equal(snapshotState.logs[0].snapshot.paragraphAnchor.paragraphHash, anchor.paragraphHash);
assert.equal(snapshotState.logs[0].snapshot.connection.credentialId, 'cred:openai');
assert.equal(snapshotState.logs[0].snapshot.connection.apiKey, undefined);
assert.equal(snapshotState.logs[0].snapshot.payload.references[0].data, undefined, 'binary request payloads must not persist in settings');

assert.match(buildImagineCommand({ prompt: 'legacy remains' }), /^\/imagine /, 'legacy command must remain available for migration');
assert.equal(migrateStoryboardState({ schemaVersion: 4, prompt: 'kept' }).prompt, 'kept', 'v4 migration must be idempotent');

console.log('Storyboard v8 schema contract OK');
