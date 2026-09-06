import { normalizeOpenAICompatibleHeaders, normalizeOpenAIImageCompatibility } from './qianmu-openai-image-compat.js';
import { resolveImageProtocolBinding, IMAGE_NATIVE_PROTOCOLS, IMAGE_PROTOCOL_BINDING_VERSION } from './qianmu-image-models.js';
import { inspectComfyWorkflow } from './qianmu-comfy-workflow.js';

// 千幕·分镜数据契约。这里只描述数据与请求计划，不持有密钥，也不发起网络请求。
export const STORYBOARD_SCHEMA_VERSION = 24;
export const STORYBOARD_PRODUCTION_TRACK_LABELS = Object.freeze({ main_camera: '本段正文', second_camera: '世界背面' });
export const STORYBOARD_PIPELINE_LOG_LIMIT = 20;
export const STORYBOARD_MODEL_PROFILE_LIMIT = 80;
export const STORYBOARD_DIAGNOSTIC_TEXT_LIMIT = 256 * 1024;
// v3 起日志只按固定条数轮换，不再因为经过若干天而静默消失。保留导出名供旧调用兼容。
export const STORYBOARD_PIPELINE_LOG_RETENTION_MS = 0;

export const STORYBOARD_WORKFLOW_STATES = Object.freeze([
  'idle', 'screening', 'compiling', 'prompt_ready', 'queued', 'generating',
  'completed', 'skipped', 'failed', 'cancelled', 'stale', 'orphaned',
]);
export const STORYBOARD_MESSAGE_LINK_STATES = Object.freeze(['active', 'stale', 'inactive_swipe', 'orphaned', 'foreign']);
export const STORYBOARD_SHOT_GROUP_TEMPLATES = Object.freeze({
  smart: Object.freeze({ id: 'smart', label: '智能镜组', instruction: '按叙事价值自由选择 1-4 个不重复镜头；优先建立场景、推进动作、落到情绪或关键细节。' }),
  threeBeat: Object.freeze({ id: 'threeBeat', label: '三拍叙事', instruction: '优先采用建立关系的全景、推进人物或动作的近景、完成情绪落点的特写；没有价值的节拍可以省略。' }),
  dialogue: Object.freeze({ id: 'dialogue', label: '对话组', instruction: '围绕双人或多人关系组织同框、越肩或单人近景与反应镜头，避免只改变焦段而不推进信息。' }),
  action: Object.freeze({ id: 'action', label: '动作组', instruction: '组织环境与站位、关键动作、冲击或结果三个节拍，保持方向、人物和关键物件连续。' }),
  atmosphere: Object.freeze({ id: 'atmosphere', label: '氛围组', instruction: '用环境、人物状态和细节物件共同建立情绪，镜头必须承担不同信息。' }),
});

const BASE_CAPS = { prompt: true, negative: false, size: true, ratio: true, seed: false, steps: false, cfg: false, cfgRescale: false, sampler: false, scheduler: false, sm: false, smDyn: false, decrisper: false, varietyBoost: false, reference: false, multipleReferences: false, imageEdit: false, mask: false, vibe: false, preciseReference: false, multiCharacter: false, workflow: false, contentPolicy: 'filtered' };
const caps = (extra = {}) => Object.freeze({ ...BASE_CAPS, ...extra });
const model = (id, label, generation, extra = {}) => Object.freeze({
  id, label, generation,
  capabilities: caps({
    ...extra,
    contentPolicy: extra.contentPolicy || (id === 'comfy-workflow' ? 'custom' : (/^nai-diffusion-(?:3|.*-full)$/.test(id) ? 'full' : 'filtered')),
  }),
});

export const STORYBOARD_PROVIDER_REGISTRY = Object.freeze({
  novel: Object.freeze({ id: 'novel', label: 'NovelAI', protocol: 'novelai', defaultBaseUrl: 'https://image.novelai.net', customBaseUrl: true, customModelId: false, stSource: 'novel', secretKey: 'api_key_novel', defaultModel: 'nai-diffusion-5-full', capabilities: caps({ negative: true, seed: true, steps: true, cfg: true, sampler: true, scheduler: true, multiCharacter: true }) }),
  banana: Object.freeze({ id: 'banana', label: 'Banana', protocol: 'gemini-images', defaultBaseUrl: 'https://generativelanguage.googleapis.com', customBaseUrl: true, customModelId: false, stSource: 'google', secretKey: 'api_key_makersuite', defaultModel: 'gemini-3.1-flash-image', capabilities: caps({ negative: true, reference: true, multipleReferences: true, imageEdit: true }) }),
  openai: Object.freeze({ id: 'openai', label: 'GPT Image', protocol: 'openai-images', defaultBaseUrl: 'https://api.openai.com/v1', customBaseUrl: true, customModelId: true, stSource: 'openai', secretKey: 'api_key_openai', defaultModel: 'gpt-image-2', capabilities: caps({ reference: true, multipleReferences: true, imageEdit: true }) }),
  seedream: Object.freeze({ id: 'seedream', label: 'Doubao Seedream', protocol: 'ark-images', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', customBaseUrl: true, customModelId: false, stSource: '', secretKey: '', defaultModel: 'doubao-seedream-5-0-260128', capabilities: caps({ seed: true, reference: true, multipleReferences: true, imageEdit: true }) }),
  comfy: Object.freeze({ id: 'comfy', label: 'ComfyUI', protocol: 'comfy-workflow', defaultBaseUrl: '', customBaseUrl: true, customModelId: false, stSource: 'comfy', secretKey: '', defaultModel: 'comfy-workflow', capabilities: caps({ negative: true, seed: true, steps: true, cfg: true, sampler: true, scheduler: true, reference: true, multipleReferences: true, imageEdit: true, mask: true, workflow: true }) }),
});

export const STORYBOARD_MODEL_REGISTRY = Object.freeze({
  novel: Object.freeze([
    model('nai-diffusion-3', 'Anime V3 💕', 'V3', { negative: true, seed: true, steps: true, cfg: true, cfgRescale: true, sampler: true, scheduler: true, sm: true, smDyn: true, decrisper: true, vibe: true }),
    model('nai-diffusion-4-curated-preview', 'Anime Curated V4', 'V4', { negative: true, seed: true, steps: true, cfg: true, cfgRescale: true, sampler: true, scheduler: true, sm: true, smDyn: true, decrisper: true, varietyBoost: true, multipleReferences: true, vibe: true, preciseReference: false, multiCharacter: true }),
    model('nai-diffusion-4-full', 'Anime Full V4 💕', 'V4', { negative: true, seed: true, steps: true, cfg: true, cfgRescale: true, sampler: true, scheduler: true, sm: true, smDyn: true, decrisper: true, varietyBoost: true, multipleReferences: true, vibe: true, preciseReference: false, multiCharacter: true }),
    model('nai-diffusion-4-5-curated', 'Anime Curated V4.5', 'V4.5', { negative: true, seed: true, steps: true, cfg: true, cfgRescale: true, sampler: true, scheduler: true, sm: true, smDyn: true, decrisper: true, varietyBoost: true, multipleReferences: true, vibe: true, preciseReference: true, multiCharacter: true }),
    model('nai-diffusion-4-5-full', 'Anime Full V4.5 💕', 'V4.5', { negative: true, seed: true, steps: true, cfg: true, cfgRescale: true, sampler: true, scheduler: true, sm: true, smDyn: true, decrisper: true, varietyBoost: true, multipleReferences: true, vibe: true, preciseReference: true, multiCharacter: true }),
    // V5 首发不暴露 Vibe / Precise Reference；后续只需更新能力表，无需迁移用户数据。
    model('nai-diffusion-5-curated', 'Anime Curated V5', 'V5', { negative: true, seed: true, steps: true, cfg: true, cfgRescale: true, sampler: true, multiCharacter: true }),
    model('nai-diffusion-5-full', 'Anime Full V5 💕', 'V5', { negative: true, seed: true, steps: true, cfg: true, cfgRescale: true, sampler: true, multiCharacter: true }),
  ]),
  banana: Object.freeze([
    model('gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite', '3.1', { negative: true, reference: true, multipleReferences: true, imageEdit: true }),
    model('gemini-3.1-flash-image', 'Nano Banana 2', '3.1', { negative: true, reference: true, multipleReferences: true, imageEdit: true }),
    model('gemini-3-pro-image', 'Nano Banana Pro', '3', { negative: true, reference: true, multipleReferences: true, imageEdit: true }),
    model('gemini-2.5-flash-image', 'Nano Banana', '2.5', { negative: true, reference: true, multipleReferences: true, imageEdit: true }),
  ]),
  openai: Object.freeze([model('gpt-image-2', 'GPT Image 2', '2', { reference: true, multipleReferences: true, imageEdit: true })]),
  seedream: Object.freeze([
    model('doubao-seedream-5-0-260128', 'Seedream 5.0', '5.0', { seed: true, reference: true, multipleReferences: true, imageEdit: true }),
    model('doubao-seedream-4-5-251128', 'Seedream 4.5', '4.5', { seed: true, reference: true, multipleReferences: true, imageEdit: true }),
    model('doubao-seedream-4-0-250828', 'Seedream 4.0', '4.0', { seed: true, reference: true, multipleReferences: true, imageEdit: true }),
  ]),
  comfy: Object.freeze([model('comfy-workflow', '自定义工作流', 'workflow', { negative: true, seed: true, steps: true, cfg: true, sampler: true, scheduler: true, reference: true, multipleReferences: true, imageEdit: true, mask: true, workflow: true })]),
});

const naiSampler = (value, label) => Object.freeze({ value, label });
const NAI_LEGACY_SAMPLERS = Object.freeze([
  naiSampler('k_dpmpp_2m', 'DPM++ 2M'),
  naiSampler('k_euler_ancestral', 'Euler Ancestral'),
  naiSampler('k_euler', 'Euler'),
  naiSampler('k_dpm_2', 'DPM2'),
  naiSampler('k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'),
  naiSampler('k_dpmpp_sde', 'DPM++ SDE'),
  naiSampler('k_dpm_fast', 'DPM Fast'),
  naiSampler('ddim', 'DDIM'),
]);
const NAI_V5_SAMPLERS = Object.freeze([
  naiSampler('k_euler_ancestral', 'Euler Ancestral'),
  naiSampler('k_euler', 'Euler'),
  naiSampler('k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'),
  naiSampler('k_dpmpp_2m_sde', 'DPM++ 2M SDE'),
  naiSampler('k_dpmpp_2m', 'DPM++ 2M'),
  naiSampler('k_dpmpp_sde', 'DPM++ SDE'),
]);
const NAI_LEGACY_SCHEDULERS = Object.freeze([
  naiSampler('native', 'Native'),
  naiSampler('karras', 'Karras'),
  naiSampler('exponential', 'Exponential'),
  naiSampler('polyexponential', 'Polyexponential'),
]);

export const STORYBOARD_NAI_PARAMETER_SPECS = Object.freeze({
  V3: Object.freeze({ samplers: NAI_LEGACY_SAMPLERS, schedulers: NAI_LEGACY_SCHEDULERS, defaults: Object.freeze({ width: '832', height: '1216', ratio: '2:3', count: '1', steps: '28', cfg: '5', novelCfgRescale: '0', sampler: 'k_euler_ancestral', scheduler: 'karras' }) }),
  V4: Object.freeze({ samplers: NAI_LEGACY_SAMPLERS, schedulers: NAI_LEGACY_SCHEDULERS, defaults: Object.freeze({ width: '832', height: '1216', ratio: '2:3', count: '1', steps: '28', cfg: '5', novelCfgRescale: '0', sampler: 'k_euler_ancestral', scheduler: 'karras' }) }),
  'V4.5': Object.freeze({ samplers: NAI_LEGACY_SAMPLERS, schedulers: NAI_LEGACY_SCHEDULERS, defaults: Object.freeze({ width: '832', height: '1216', ratio: '2:3', count: '1', steps: '28', cfg: '5', novelCfgRescale: '0', sampler: 'k_euler_ancestral', scheduler: 'karras' }) }),
  V5: Object.freeze({ samplers: NAI_V5_SAMPLERS, schedulers: Object.freeze([]), defaults: Object.freeze({ width: '832', height: '1216', ratio: '2:3', count: '1', steps: '28', cfg: '8', novelCfgRescale: '0', sampler: 'k_euler_ancestral', scheduler: '' }) }),
});

export const STORYBOARD_NAI_BUILTIN_PRESETS = Object.freeze([
  Object.freeze({ id: 'builtin:nai-v5-official', name: '官方默认', generation: 'V5', readonly: true, profile: Object.freeze({ steps: '28', cfg: '8', novelCfgRescale: '0', sampler: 'k_euler_ancestral', scheduler: '' }) }),
  Object.freeze({ id: 'builtin:nai-v5-balanced', name: '千幕·均衡', generation: 'V5', readonly: true, experimental: true, profile: Object.freeze({ steps: '28', cfg: '6', novelCfgRescale: '0.3', sampler: 'k_euler_ancestral', scheduler: '' }) }),
  Object.freeze({ id: 'builtin:nai-v5-draft', name: '千幕·草图', generation: 'V5', readonly: true, experimental: true, profile: Object.freeze({ steps: '16', cfg: '5', novelCfgRescale: '0.3', sampler: 'k_euler_ancestral', scheduler: '' }) }),
  Object.freeze({ id: 'builtin:nai-v5-detail', name: '千幕·稳定细节', generation: 'V5', readonly: true, experimental: true, profile: Object.freeze({ steps: '28', cfg: '6', novelCfgRescale: '0.3', sampler: 'k_dpmpp_2m', scheduler: '' }) }),
]);

export function getStoryboardNovelParameterSpec(modelId = '') {
  const generation = getStoryboardModel('novel', modelId)?.generation || 'V5';
  return STORYBOARD_NAI_PARAMETER_SPECS[generation] || STORYBOARD_NAI_PARAMETER_SPECS.V5;
}

export function getStoryboardBuiltinParameterPresets(providerId, modelId = '') {
  if (providerId !== 'novel') return [];
  const generation = getStoryboardModel('novel', modelId)?.generation || '';
  return STORYBOARD_NAI_BUILTIN_PRESETS.filter((preset) => preset.generation === generation);
}

// v1.44 UI compatibility.
export const STORYBOARD_SOURCES = STORYBOARD_PROVIDER_REGISTRY;
export const STORYBOARD_CAPABILITIES = Object.freeze(Object.fromEntries(Object.entries(STORYBOARD_PROVIDER_REGISTRY).map(([id, p]) => [id, p.capabilities])));
export const STORYBOARD_RATIOS = Object.freeze([
  { id: '1:1', label: '1 : 1', value: 1 }, { id: '2:3', label: '2 : 3', value: 2 / 3 },
  { id: '3:2', label: '3 : 2', value: 3 / 2 }, { id: '3:4', label: '3 : 4', value: 3 / 4 }, { id: '4:3', label: '4 : 3', value: 4 / 3 },
  { id: '4:5', label: '4 : 5', value: 4 / 5 }, { id: '5:4', label: '5 : 4', value: 5 / 4 }, { id: '9:16', label: '9 : 16', value: 9 / 16 }, { id: '16:9', label: '16 : 9', value: 16 / 9 },
].map(Object.freeze));

export const STORYBOARD_PROMPT_MODES = Object.freeze({
  manual: Object.freeze({ id: 'manual', label: '手写', usesCompiler: false }),
  auto: Object.freeze({ id: 'auto', label: '自动取景', usesCompiler: true }),
  combined: Object.freeze({ id: 'combined', label: '手写 + 自动取景', usesCompiler: true }),
});
export const STORYBOARD_ENTITY_TYPES = Object.freeze(['char', 'user', 'cast']);
export const STORYBOARD_TAG_CATEGORIES = Object.freeze(['identity', 'appearance', 'wardrobe', 'state', 'action', 'expression', 'composition', 'camera', 'environment', 'props', 'lighting', 'color', 'style', 'quality', 'negative', 'custom']);
export const STORYBOARD_STATE_PRECEDENCE = Object.freeze(['explicit', 'targetParagraph', 'scene', 'timeline', 'archive', 'worldInfo', 'global']);
export const STORYBOARD_PLAN_SCHEMA = 'qianmu.storyboard.plan.v1';
export const STORYBOARD_COMPOSITION_RULE_ID = 'qianmu:composition-law';
export const STORYBOARD_COMPOSITION_RULE_VERSION = 2;
export const STORYBOARD_COMPOSITION_MODES = Object.freeze(['smart', 'fixed']);
export const STORYBOARD_GROUP_FRAME_STRATEGIES = Object.freeze(['single', 'main_secondary', 'montage']);
export const STORYBOARD_NARRATIVE_LAYERS = Object.freeze(['present', 'memory', 'fantasy', 'dream', 'imagined']);
export const STORYBOARD_SHOT_ROLES = Object.freeze(['establishing', 'relationship', 'action', 'reaction', 'detail', 'turn']);
export const STORYBOARD_SHOT_SCALES = Object.freeze([
  'extreme_close_up', 'close_up', 'medium_close_up', 'medium_shot', 'medium_full',
  'full_shot', 'wide_shot', 'extreme_wide_shot', 'insert',
]);
export const STORYBOARD_SPATIAL_REGIONS = Object.freeze([
  'far_left', 'left', 'center_left', 'center', 'center_right', 'right', 'far_right', 'background',
]);
export const STORYBOARD_CROPS = Object.freeze(['full', 'knees', 'waist', 'chest', 'shoulders', 'face', 'detail']);
export const STORYBOARD_CONTINUITY_FACT_CATEGORIES = Object.freeze(['outfit', 'injury', 'prop', 'action', 'scene', 'other']);
export const STORYBOARD_CONTINUITY_FACT_PERSISTENCE = Object.freeze(['momentary', 'persistent']);
export const STORYBOARD_CONTINUITY_FACT_STATES = Object.freeze(['active', 'superseded', 'expired']);
export const STORYBOARD_SCENE_FINGERPRINT_SCHEMA = 'qianmu.storyboard.scene-fingerprint.v1';
export const STORYBOARD_SHOT_PATTERNS = Object.freeze(['master', 'two_shot', 'over_shoulder', 'single_reaction', 'action', 'insert', 'atmosphere', 'montage']);
export const STORYBOARD_STATIC_SCENE_TYPES = Object.freeze(['dialogue', 'activity', 'atmosphere']);
export const STORYBOARD_VISUAL_DUTIES = Object.freeze(['space', 'relationship', 'action', 'reaction', 'detail', 'atmosphere', 'motif', 'transition']);
export const STORYBOARD_SUBJECT_KINDS = Object.freeze(['character', 'object', 'environment', 'symbolic', 'mixed']);
export const STORYBOARD_EVIDENCE_TYPES = Object.freeze(['explicit', 'inferred', 'symbolic']);

export const getStoryboardProvider = (id) => Object.hasOwn(STORYBOARD_PROVIDER_REGISTRY, id) ? STORYBOARD_PROVIDER_REGISTRY[id] : null;
export const getStoryboardModel = (providerId, modelId) => (Object.hasOwn(STORYBOARD_MODEL_REGISTRY, providerId) ? STORYBOARD_MODEL_REGISTRY[providerId] : []).find((item) => item.id === modelId) || null;
const storyboardCapabilityCache = new WeakMap(); // Only static registry objects, never remote model IDs or credentials.
export function getStoryboardCapabilities(providerId, modelId = '', workflow, connection = {}) {
  const base = getStoryboardModel(providerId, modelId)?.capabilities || getStoryboardProvider(providerId)?.capabilities || caps();
  if (connection.protocol && connection.protocol !== IMAGE_NATIVE_PROTOCOLS[providerId]) {
    let binding;
    try { binding = resolveStoryboardConnectionBinding(providerId, connection); }
    catch (error) { return Object.freeze({ ...caps({ size: false, ratio: false }), protocolIssue: error.message }); }
    const compatibility = normalizeOpenAIImageCompatibility(connection.compatibility);
    const allows = key => compatibility.allowedParameters.includes(key);
    return Object.freeze({ ...base, negative: false, seed: false, steps: false, cfg: false, sampler: false, scheduler: false,
      size: Boolean(base.size && allows('size')), ratio: Boolean(base.ratio && allows('size')), count: allows('n'),
      quality: allows('quality'), background: allows('background'), outputFormat: allows('output_format'),
      multipleReferences: Boolean(base.multipleReferences && compatibility.referenceField === 'image[]'),
      mask: false, vibe: false, preciseReference: false, multiCharacter: false,
      supportsNativeNegative: false, supportsExclusionText: true, supportsArtistSyntax: false, supportsVibe: false,
      referenceMode: base.reference ? 'image' : 'none', referenceExclusions: Object.freeze([]), protocol: binding.protocol,
    });
  }
  // A concrete workflow overrides catalog possibilities. Never cache mutable workflow contents.
  if (providerId === 'comfy' && workflow !== undefined) {
    const actual = inspectComfyWorkflow(workflow);
    return Object.freeze({ ...base, ...actual.capabilities, referenceExclusions: Object.freeze([]), workflowIssue: actual.message });
  }
  if (storyboardCapabilityCache.has(base)) return storyboardCapabilityCache.get(base);
  const naturalLanguage = ['banana', 'openai', 'seedream'].includes(providerId);
  const effective = Object.freeze({ ...base,
    supportsNativeNegative: Boolean(base.negative && !naturalLanguage),
    supportsExclusionText: naturalLanguage,
    supportsArtistSyntax: providerId === 'novel',
    supportsVibe: Boolean(base.vibe),
    referenceMode: base.workflow ? 'workflow' : base.preciseReference ? 'precise' : base.reference ? 'image' : 'none',
    referenceExclusions: Object.freeze(base.preciseReference ? ['vibe'] : []),
  });
  storyboardCapabilityCache.set(base, effective);
  return effective;
}
const resolveStoryboardModelId = (providerId, value = '') => {
  const provider = getStoryboardProvider(providerId);
  if (!provider) return '';
  const requested = str(value, 240);
  if (getStoryboardModel(providerId, requested) || (provider.customModelId && requested)) return requested;
  return provider.defaultModel;
};

export function resolveStoryboardModelBinding(providerId, input = {}) {
  const provider = getStoryboardProvider(providerId);
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (!provider) fail('invalid_model_family', '请选择有效的生图系列');
  const transport = resolveStoryboardConnectionBinding(provider.id, input);
  const id = (value) => {
    if (typeof value !== 'string') fail('invalid_model_id', '模型名称必须是文本');
    const result = value.trim();
    if (result.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_model_id', '模型名称过长或包含控制字符');
    return result;
  };
  const hasCapability = input.capabilityModelId != null && input.capabilityModelId !== '';
  const explicitCapability = hasCapability ? id(input.capabilityModelId) : '';
  if (hasCapability && !getStoryboardModel(providerId, explicitCapability)) fail('invalid_capability_model', '请选择当前系列有效的模型能力档');
  const explicitRemote = Object.hasOwn(input, 'remoteModelId');
  // Legacy inputs retain their established fallback; explicit bindings are never silently renamed.
  const requested = explicitRemote ? id(input.remoteModelId) : explicitCapability ? id(input.model || explicitCapability) : str(input.model || provider.defaultModel, 240);
  if ((explicitRemote || explicitCapability) && !requested) fail('missing_remote_model', '请填写实际发送的模型名称');
  const known = getStoryboardModel(providerId, requested);
  if (known && explicitCapability && known.id !== explicitCapability) fail('model_capability_conflict', '已知模型与所选能力档不一致');
  if (explicitRemote && !known && !explicitCapability && !provider.customModelId) fail('missing_capability_model', '第三方模型别名需要指定同系列能力档');
  const remoteModelId = explicitRemote || explicitCapability ? requested : resolveStoryboardModelId(providerId, requested);
  const capabilityModelId = explicitCapability || getStoryboardModel(providerId, remoteModelId)?.id || provider.defaultModel;
  return { ...transport, capabilityModelId, remoteModelId,
    connectionPresetId: cleanId(input.connectionPresetId), customModel: !getStoryboardModel(providerId, remoteModelId) };
}

export function resolveStoryboardConnectionBinding(providerId, connection = {}) {
  const binding = resolveImageProtocolBinding(providerId, connection, { allowCompatible: true });
  return { ...binding, ...(binding.protocol !== IMAGE_NATIVE_PROTOCOLS[providerId] ? { imageProtocolVersion: IMAGE_PROTOCOL_BINDING_VERSION } : {}) };
}

// Only project controls supported by the selected wire format. The saved model profile is untouched.
export function projectStoryboardProtocolParameters(providerId, parameters, connection = {}) {
  const binding = resolveStoryboardConnectionBinding(providerId, connection);
  if (binding.protocol === IMAGE_NATIVE_PROTOCOLS[providerId]) return parameters;
  const compatibility = normalizeOpenAIImageCompatibility(connection.compatibility);
  const allows = key => compatibility.allowedParameters.includes(key), p = obj(parameters) ? parameters : {};
  const result = { count: allows('n') ? (p.count === '' || p.count == null ? 1 : p.count) : 1, providerOptions: safeRecord(p.providerOptions, { reserved: true }) };
  if (allows('size')) for (const key of ['width', 'height', 'size']) if (p[key] !== '' && p[key] != null) result[key] = p[key];
  for (const [wire, keys] of [['quality', ['quality', 'openaiQuality']], ['background', ['background', 'openaiBackground']], ['output_format', ['outputFormat', 'openaiOutputFormat']]]) {
    if (!allows(wire)) continue;
    const key = keys.find(key => Object.hasOwn(p, key));
    if (key && p[key] !== '' && p[key] != null) result[keys[0]] = p[key];
  }
  return result;
}

export function resolveStoryboardProfileBinding(providerId, profile = {}) {
  return resolveStoryboardModelBinding(providerId, {
    remoteModelId: profile.model == null || profile.model === '' ? getStoryboardProvider(providerId)?.defaultModel : profile.model,
    capabilityModelId: profile.capabilityModelId,
  });
}

export function resolveStoryboardJobModelIdentity(job = {}) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const provider = getStoryboardProvider(job.source);
  if (!provider) fail('invalid_model_family', '任务缺少有效的生图系列，请载入镜头台确认');
  const model = job.profile?.model || (provider.id === 'comfy' ? provider.defaultModel : '');
  if (typeof model !== 'string' || !model.trim()) fail('missing_model_snapshot', '记录缺少模型快照，请载入镜头台确认');
  const presetId = cleanId(job.connection?.id);
  const connectionBinding = resolveStoryboardConnectionBinding(provider.id, job.connection || {});
  const saved = job.modelIdentity;
  let binding;
  if (saved != null) {
    if (!obj(saved) || saved.version !== 1
      || !['modelFamily', 'capabilityModelId', 'remoteModelId', 'protocol'].every((key) => typeof saved[key] === 'string' && saved[key].trim())
      || typeof saved.connectionPresetId !== 'string') fail('invalid_model_identity', '模型身份快照不完整或版本不支持，请载入镜头台确认');
    binding = resolveStoryboardModelBinding(provider.id, saved);
    if (model.trim() !== binding.remoteModelId) fail('model_snapshot_mismatch', '任务型号与原模型快照不一致，未发起生图');
    if (presetId !== binding.connectionPresetId) fail('connection_snapshot_mismatch', '任务连接与原模型快照不一致，未发起生图');
    if (connectionBinding.protocol !== binding.protocol) fail('connection_protocol_mismatch', '任务接口与原协议快照不一致，未发起生图');
  } else {
    // Use the historical request itself, never today's provider default for an unknown alias.
    binding = resolveStoryboardModelBinding(provider.id, {
      ...connectionBinding, remoteModelId: model, capabilityModelId: job.profile?.capabilityModelId || '', connectionPresetId: presetId,
    });
  }
  if (job.profile?.capabilityModelId && job.profile.capabilityModelId !== binding.capabilityModelId) fail('model_snapshot_mismatch', '任务能力档与原模型快照不一致，未发起生图');
  return Object.freeze({ version: 1, modelFamily: binding.modelFamily, capabilityModelId: binding.capabilityModelId,
    remoteModelId: binding.remoteModelId, protocol: binding.protocol, connectionPresetId: binding.connectionPresetId,
    ...(binding.imageProtocolVersion ? { imageProtocolVersion: binding.imageProtocolVersion } : {}) });
}

const legacyProfile = () => ({ loaded: false, model: '', sampler: '', scheduler: '', width: '', height: '', ratio: '1:1', count: '', steps: '', cfg: '', seed: '', comfyUrl: '', comfyWorkflow: '', comfyWorkflowNotice: '', openaiStyle: '', openaiQuality: '', openaiBackground: '', openaiOutputFormat: '', imageSize: '', watermark: false, seedreamGuidanceScale: '', seedreamSequential: false, googleEnhance: false, novelCfgRescale: '', novelSm: false, novelSmDyn: false, novelDecrisper: false, novelVarietyBoost: false });
const promptDraft = () => ({ compiled: '', negative: '', artistString: '', compiledAt: 0, compiledBy: '', userEditedCompiled: false, userEditedNegative: false, artistPositiveBaked: false, artistNegativeBaked: false, sourceSummary: [] });
const connection = (id) => ({
  providerId: id,
  activePresetId: '',
  presets: [],
  draft: {
    baseUrl: getStoryboardProvider(id).defaultBaseUrl,
    model: getStoryboardProvider(id).defaultModel,
    ...(id === 'openai' ? { compatibility: normalizeOpenAIImageCompatibility(), headers: {} } : {}),
  },
});
const routingDefaults = () => ({ enabled: false, mode: 'single', templateId: 'smart', frameStrategy: 'main_secondary', single: { providerId: 'novel', modelId: 'nai-diffusion-5-full', connectionPresetId: '', parameterPresetId: '' }, rules: [], confirmMultipleRequests: true });
export function normalizeStoryboardGenerationPolicy(value, legacyRouting, legacyComposition) {
  const r = obj(value) ? value : {};
  const legacy = obj(legacyRouting) ? legacyRouting : null;
  const maxImages = int(r.maxImages, 1, 4, legacy ? (legacy.enabled && legacyComposition?.groupStrategy !== 'single' ? int(legacy.maxShotsPerFloor, 1, 4, 3) : 1) : 3);
  return { version: 1, minImages: int(r.minImages, 1, maxImages, 1), maxImages,
    concurrency: int(r.concurrency, 1, 4, legacy ? int(legacy.providerConcurrency, 1, 4, 1) : 2) };
}
export function getStoryboardGenerationPolicy(state = {}) {
  return normalizeStoryboardGenerationPolicy(state.generationPolicy, state.routing, state.compositionPolicy);
}
const automationDefaults = () => ({ autoCapture: true, autoGenerate: true });
const directorBridgeDefaults = () => ({ worldSideShotsEnabled: false });
const compositionDefaults = () => ({
  schemaVersion: 1,
  systemRuleId: STORYBOARD_COMPOSITION_RULE_ID,
  systemRuleVersion: STORYBOARD_COMPOSITION_RULE_VERSION,
  mode: 'smart',
  fixedRatioId: '3:2',
  allowedRatioIds: STORYBOARD_RATIOS.map((item) => item.id),
  preferredRatioId: '3:2',
  groupStrategy: 'main_secondary',
  ruleOverride: '',
  userEdited: false,
});
const compilerTagRuleDefaults = () => ['think', 'thinking']
  .map((name) => ({ name, action: 'remove' }));

export function createStoryboardDefaults() {
  const ids = Object.keys(STORYBOARD_PROVIDER_REGISTRY);
  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION, enabled: false, automation: automationDefaults(), directorBridge: directorBridgeDefaults(), view: 'create', workspaceView: 'workbench', assetView: 'tags', assetSearch: '', logFilter: 'all', gallerySearch: '', gallerySource: 'all', galleryTrack: 'all', source: 'novel', initialized: false,
    target: 'latest', floor: '', inlineByDefault: true, promptMode: 'manual', prompt: '', negative: '', promptDefaults: {}, contentRating: 'sfw', paragraphMode: 'auto', manualParagraphIndex: null, pendingParagraphSelection: null, promptDraft: promptDraft(),
    promptCompiler: { enabled: true, apiProfileId: '', connectionPresetId: '', instructionPresetId: '', instruction: '', includeCurrentFloor: true, includeRecentFloors: 2, includeCharacterCards: true, includeUserPersona: true, includeActivatedWorldInfo: true, worldMode: 'selected', worldBookNames: [], worldBookView: '', worldBookInitializedNames: [], worldEntryIds: [], tagRules: compilerTagRuleDefaults(), excludedTags: 'think, thinking' },
    profiles: Object.fromEntries(ids.map((id) => [id, legacyProfile()])), modelProfiles: Object.fromEntries(ids.map((id) => [id, {}])), parameterPresets: [], parameterPresetSelection: Object.fromEntries(ids.map((id) => [id, ''])),
    connections: Object.fromEntries(ids.map((id) => [id, connection(id)])), generationPolicy: normalizeStoryboardGenerationPolicy(),
    promptPresets: [], editingPromptPresetId: '', editingPromptItemId: '', promptItemDraft: null,
    artistPresets: [], artistCollections: [], artistCollectionId: '', selectedArtistPresetId: '', artistSearch: '', editingArtistPresetId: '',
    artistPools: [], selectedArtistPoolId: '',
    tagLibrary: [], vibeLibrary: [], selectedVibeIds: [], compositionPolicy: compositionDefaults(), routing: routingDefaults(), shotPlans: [], taskStates: [], collapsedCards: { model: true, context: true, worldbook: true, prompt: true, params: true, composition: true, production: true, 'routing-rules': true }, logs: [], pipelineLogs: [],
  };
}

export function createStoryboardEntity(input = {}) {
  const type = STORYBOARD_ENTITY_TYPES.includes(input.type || input.subjectType) ? (input.type || input.subjectType) : 'cast';
  const id = cleanId(input.id || `${type}:${input.subjectKey || input.name || 'unknown'}`);
  const profiles = entityProfiles(input.profiles);
  const requestedProfileId = cleanId(input.activeProfileId);
  const activeProfileId = profiles.some((profile) => profile.id === requestedProfileId) ? requestedProfileId : (profiles[0]?.id || '');
  return { id, type, subjectKey: str(input.subjectKey || id, 512), name: str(input.name || input.subjectName, 80), avatarUrl: str(input.avatarUrl, 4096), activeProfileId, profiles, source: ['captured', 'detected', 'manual', 'migrated'].includes(input.source) ? input.source : 'manual', confirmed: input.confirmed !== false, createdAt: pos(input.createdAt), updatedAt: pos(input.updatedAt) };
}

export function sanitizeStoryboardWorkflow(value) {
  const empty = { ok: true, workflow: {}, serialized: '', removedFields: [], message: '' };
  if (value == null || value === '') return empty;
  let source = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return empty;
    if (text.length > 2 * 1024 * 1024) return { ...empty, ok: false, message: 'ComfyUI API Workflow 过大' };
    try { source = JSON.parse(text); }
    catch (_) { return { ...empty, ok: false, message: 'ComfyUI API Workflow 必须是有效的 JSON' }; }
  }
  if (!obj(source)) return { ...empty, ok: false, message: 'ComfyUI API Workflow 顶层必须是 JSON 对象' };
  const removedFields = [];
  const clean = (item, path = '$', depth = 0) => {
    if (depth > 64) throw new Error('ComfyUI API Workflow 嵌套过深');
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) return item;
    if (Array.isArray(item)) return item.map((entry, index) => clean(entry, `${path}[${index}]`, depth + 1));
    if (!obj(item)) return null;
    const output = {};
    for (const [rawKey, rawValue] of Object.entries(item)) {
      const key = str(rawKey, 240);
      if (!key || isUnsafeObjectKey(key)) continue;
      const fieldPath = `${path}.${key}`;
      if (isSensitiveField(key)) {
        if (removedFields.length < 80) removedFields.push(fieldPath);
        continue;
      }
      output[key] = clean(rawValue, fieldPath, depth + 1);
    }
    return output;
  };
  try {
    const workflow = clean(source);
    const serialized = JSON.stringify(workflow);
    if (serialized.length > 2 * 1024 * 1024) return { ...empty, ok: false, message: 'ComfyUI API Workflow 过大' };
    return { ok: true, workflow, serialized, removedFields: [...new Set(removedFields)], message: '' };
  } catch (error) {
    return { ...empty, ok: false, message: String(error?.message || 'ComfyUI API Workflow 无法读取') };
  }
}

export function sanitizeStoryboardDiagnosticData(value) {
  return redact(value, 0, STORYBOARD_DIAGNOSTIC_TEXT_LIMIT, 16);
}

export function sanitizeStoryboardSnapshot(value, fallback = {}) {
  return snapshot(value, fallback);
}

function entityProfiles(value) {
  const normalized = Array.isArray(value) ? value.filter(obj).map((p) => ({ id: cleanId(p.id), name: str(p.name || p.variantName || '默认档案', 80) || '默认档案', appearance: str(p.appearance || p.description, 12000), negative: str(p.negative, 6000), reference: reference(p.reference || { type: p.referenceUrl ? 'url' : 'none', value: p.referenceUrl }), tags: ids(p.tags, 300), permanentState: safeData(p.permanentState, 4) || {}, createdAt: pos(p.createdAt || p.updatedAt), updatedAt: pos(p.updatedAt) })).filter((p) => p.id) : [];
  return dedupeById(normalized).slice(0, 100);
}
function reference(value) { const r = obj(value) ? value : {}; return { type: ['none', 'avatar', 'gallery', 'url', 'asset'].includes(r.type) ? r.type : 'none', value: str(r.value, 4096), assetId: cleanId(r.assetId) }; }

export function normalizeStoryboardConnectionProfile(value, providerId) {
  const provider = getStoryboardProvider(providerId);
  if (!provider) throw new Error(`未知生图供应商：${providerId}`);
  const r = obj(value) ? value : {}, requestedModel = str(r.model || provider.defaultModel, 240);
  const knownModel = getStoryboardModel(providerId, requestedModel);
  const modelId = resolveStoryboardModelId(providerId, requestedModel);
  // Preserve invalid explicit declarations so later validation cannot turn them into native requests.
  const protocol = Object.hasOwn(r, 'protocol') ? (typeof r.protocol === 'string' && r.protocol.length <= 40 && !/[\u0000-\u001f\u007f]/.test(r.protocol) ? r.protocol : '[invalid-protocol]') : undefined;
  const protocolFields = { ...(protocol !== undefined ? { protocol } : {}),
    ...(Object.hasOwn(r, 'imageProtocolVersion') ? { imageProtocolVersion: r.imageProtocolVersion === IMAGE_PROTOCOL_BINDING_VERSION ? IMAGE_PROTOCOL_BINDING_VERSION : 0 } : {}),
    ...(r.modelFamily !== undefined ? { modelFamily: r.modelFamily === providerId ? providerId : '[invalid-family]' } : {}) };
  const compatibility = providerId === 'openai' || protocol === 'openai-images' || r.compatibility ? normalizeOpenAIImageCompatibility(r.compatibility) : null;
  return {
    id: cleanId(r.id), name: str(r.name || '默认连接', 80) || '默认连接', providerId, ...protocolFields,
    baseUrl: str(protocol && protocol !== provider.protocol ? (r.baseUrl || '') : (r.baseUrl || provider.defaultBaseUrl), 2048), model: modelId,
    customModel: Boolean(provider.customModelId && !knownModel), credentialId: cleanId(r.credentialId),
    headers: compatibility ? normalizeOpenAICompatibleHeaders(r.headers, compatibility) : {},
    ...(compatibility ? { compatibility } : {}), options: safeRecord(r.options),
    createdAt: pos(r.createdAt || r.updatedAt), updatedAt: pos(r.updatedAt),
  };
}

export function migrateStoryboardState(value) {
  const s = obj(value) ? clone(value) : {};
  s.generationPolicy = normalizeStoryboardGenerationPolicy(s.generationPolicy, obj(value) && Object.keys(value).length ? (value.routing || {}) : undefined, value?.compositionPolicy);
  const fromVersion = Number(s.schemaVersion) || 0;
  const defaults = createStoryboardDefaults();
  if (fromVersion < 2) {
    s.connections ||= defaults.connections;
    for (const [providerId, p] of Object.entries(s.profiles || {})) if (getStoryboardProvider(providerId) && (p?.model || p?.comfyUrl) && !s.connections[providerId]?.presets?.length) {
      const id = `migrated-${providerId}`, preset = normalizeStoryboardConnectionProfile({ id, name: '原有连接', model: p.model, baseUrl: p.comfyUrl, options: p }, providerId);
      s.connections[providerId] = { providerId, activePresetId: id, presets: [preset], draft: { baseUrl: preset.baseUrl, model: preset.model } };
    }
    s.promptMode ||= 'manual'; s.promptDraft ||= { ...promptDraft(), compiled: s.prompt || '', negative: s.negative || '' };
    s.promptPresets ||= []; s.tagLibrary ||= []; s.vibeLibrary ||= []; s.routing ||= routingDefaults(); s.shotPlans ||= []; s.collapsedCards ||= {}; s.pipelineLogs ||= legacyPipelineLogs(s.logs);
  }
  if (fromVersion < 3) {
    // 已经使用过分镜的用户升级后维持原行为；全新安装则由 defaults 保持关闭，避免意外请求与费用。
    if (s.enabled === undefined) s.enabled = true;
    s.automation ||= automationDefaults();
  }
  if (fromVersion < 4) {
    s.routing ||= routingDefaults();
    if (s.routing.enabled === undefined) s.routing.enabled = s.routing.mode === 'ensemble';
  }
  if (fromVersion < 7 && Array.isArray(s.routing?.rules)) {
    s.routing.rules = s.routing.rules.map((rule) => {
      if (!obj(rule)) return rule;
      const migratedRule = { ...rule };
      delete migratedRule.sensitive;
      return migratedRule;
    });
  }
  if (fromVersion < 8) {
    s.promptCompiler ||= {};
    s.promptCompiler.enabled = true;
    s.modelProfiles ||= {};
    delete s.selectedCharacters;
    delete s.castPickerOpen;
    delete s.consistencyModes;
  }
  if (fromVersion < 9) {
    s.promptCompiler ||= {};
    s.promptCompiler.includeCharacterCards = true;
    s.promptCompiler.includeUserPersona = true;
    s.promptCompiler.includeActivatedWorldInfo = true;
    s.promptCompiler.worldMode = 'selected';
    s.artistCollections ||= [];
    delete s.characters;
    delete s.entities;
    delete s.selectedCharacterId;
    delete s.characterView;
  }
  if (fromVersion < 10) {
    s.promptCompiler ||= {};
    const retiredDefaults = new Set(['analysis', 'reasoning', 'status', 'summary', 'script', 'style']);
    const existingRules = Array.isArray(s.promptCompiler.tagRules) ? s.promptCompiler.tagRules : [];
    const retainedRules = existingRules.filter((rule) => !retiredDefaults.has(str(rule?.name, 120).toLowerCase()));
    for (const name of ['think', 'thinking']) {
      if (!retainedRules.some((rule) => str(rule?.name, 120).toLowerCase() === name)) retainedRules.push({ name, action: 'remove' });
    }
    s.promptCompiler.tagRules = retainedRules;
    s.promptCompiler.excludedTags = retainedRules.filter((rule) => rule?.action !== 'extract').map((rule) => str(rule?.name, 120)).filter(Boolean).join(', ');
    const legacyBooks = uniqueStrings((s.promptCompiler.worldEntryIds || []).map((id) => str(id, 512).split('::')[0]), 100, 200);
    s.promptCompiler.worldBookNames ||= legacyBooks;
    s.promptCompiler.worldBookView ||= legacyBooks[0] || '';
    s.promptCompiler.worldBookInitializedNames ||= legacyBooks;
  }
  if (fromVersion < 11) {
    s.artistPresets = (Array.isArray(s.artistPresets) ? s.artistPresets : []).map((preset) => ({
      ...preset,
      collectionIds: Array.isArray(preset?.collectionIds)
        ? preset.collectionIds
        : (preset?.collectionId ? [preset.collectionId] : []),
    }));
  }
  if (fromVersion < 12) {
    s.compositionPolicy ||= compositionDefaults();
    s.routing ||= routingDefaults();
    s.routing.frameStrategy ||= s.compositionPolicy.groupStrategy || 'main_secondary';
    s.pendingParagraphSelection ||= null;
  }
  if (fromVersion < 24) s.directorBridge = directorBridgeDefaults();
  s.schemaVersion = STORYBOARD_SCHEMA_VERSION;
  return s;
}

export function normalizeStoryboardState(value) {
  const migrated = migrateStoryboardState(value), defaults = createStoryboardDefaults(), state = obj(value) ? value : {};
  Object.assign(state, migrated); for (const [key, val] of Object.entries(defaults)) if (state[key] === undefined) state[key] = clone(val);
  state.schemaVersion = STORYBOARD_SCHEMA_VERSION; state.enabled = Boolean(state.enabled); state.automation = normalizeStoryboardAutomation(state.automation); state.directorBridge = { worldSideShotsEnabled: Boolean(state.directorBridge?.worldSideShotsEnabled) }; state.view = ['create', 'assets', 'artists', 'presets', 'gallery', 'logs'].includes(state.view) ? state.view : 'create'; state.workspaceView = ['workbench', 'assets', 'artists', 'presets', 'gallery', 'logs'].includes(state.workspaceView) ? state.workspaceView : 'workbench'; state.logFilter = ['all', 'success', 'failed'].includes(state.logFilter) ? state.logFilter : 'all';
  state.assetView = ['tags', 'vibes', 'routing'].includes(state.assetView) ? state.assetView : 'tags'; state.assetSearch = str(state.assetSearch, 120); state.artistSearch = str(state.artistSearch, 120); state.editingArtistPresetId = state.editingArtistPresetId === 'new' ? 'new' : cleanId(state.editingArtistPresetId); state.editingPromptPresetId = cleanId(state.editingPromptPresetId); state.editingPromptItemId = state.editingPromptItemId === 'new' ? 'new' : cleanId(state.editingPromptItemId); state.promptItemDraft = obj(state.promptItemDraft) ? { name: str(state.promptItemDraft.name, 80), instruction: str(state.promptItemDraft.instruction, 12000) } : null; state.artistCollectionId = cleanId(state.artistCollectionId); state.gallerySearch = str(state.gallerySearch, 120); state.gallerySource = state.gallerySource === 'all' || getStoryboardProvider(state.gallerySource) ? state.gallerySource : 'all'; state.galleryTrack = ['all', 'main_camera', 'second_camera'].includes(state.galleryTrack) ? state.galleryTrack : 'all'; state.source = getStoryboardProvider(state.source) ? state.source : 'novel'; state.target = ['latest', 'floor', 'gallery'].includes(state.target) ? state.target : 'latest'; state.inlineByDefault = state.inlineByDefault !== false; state.promptMode = STORYBOARD_PROMPT_MODES[state.promptMode] ? state.promptMode : 'manual'; state.prompt = str(state.prompt, 24000); state.negative = str(state.negative, 12000); state.contentRating = state.contentRating === 'nsfw' ? 'nsfw' : 'sfw'; state.paragraphMode = state.paragraphMode === 'manual' ? 'manual' : 'auto'; state.manualParagraphIndex = Number.isInteger(Number(state.manualParagraphIndex)) && Number(state.manualParagraphIndex) >= 0 ? Number(state.manualParagraphIndex) : null; state.pendingParagraphSelection = state.pendingParagraphSelection ? normalizeStoryboardParagraphSelection(state.pendingParagraphSelection) : null;
  state.promptDefaults = Object.fromEntries(Object.entries(obj(state.promptDefaults) ? state.promptDefaults : {}).slice(0, 200).map(([key, value]) => [str(key, 500), {
    ...(obj(value) && Object.hasOwn(value, 'positive') ? { positive: str(value.positive, 12000) } : {}),
    ...(obj(value) && Object.hasOwn(value, 'negative') ? { negative: str(value.negative, 12000) } : {}),
  }]).filter(([key]) => key));
  const d = obj(state.promptDraft) ? state.promptDraft : {}, safeDraft = safeData(d, 5);
  if (obj(safeDraft)) { delete safeDraft.manual; delete safeDraft.autoInstruction; }
  state.promptDraft = { ...(obj(safeDraft) ? safeDraft : {}), compiled: str(d.compiled ?? state.prompt, 24000), negative: str(d.negative ?? state.negative, 12000), artistString: str(d.artistString, 6000), compiledAt: pos(d.compiledAt), compiledBy: str(d.compiledBy, 160), userEditedCompiled: Boolean(d.userEditedCompiled), userEditedNegative: Boolean(d.userEditedNegative), artistPositiveBaked: Boolean(d.artistPositiveBaked), artistNegativeBaked: Boolean(d.artistNegativeBaked), sourceSummary: Array.isArray(d.sourceSummary) ? d.sourceSummary.slice(0, 40).map((x) => str(x, 240)).filter(Boolean) : [] };
  const c = obj(state.promptCompiler) ? state.promptCompiler : {}, safeCompiler = safeData(c, 5);
  const legacyCompilerTags = str(c.excludedTags, 2000).split(/[,，\s]+/).map((name) => ({ name, action: 'remove' }));
  const compilerTagRules = (Array.isArray(c.tagRules) ? c.tagRules : (legacyCompilerTags.some((item) => item.name) ? legacyCompilerTags : compilerTagRuleDefaults()))
    .filter(obj).map((rule) => ({ name: str(rule.name, 120).replace(/^<|>$/g, ''), action: rule.action === 'extract' ? 'extract' : 'remove' }))
    .filter((rule) => rule.name).slice(0, 80);
  state.promptCompiler = { ...(obj(safeCompiler) ? safeCompiler : {}), enabled: true, apiProfileId: cleanId(c.apiProfileId), connectionPresetId: cleanId(c.connectionPresetId), instructionPresetId: cleanId(c.instructionPresetId), instruction: str(c.instruction, 12000), includeCurrentFloor: true, includeRecentFloors: int(c.includeRecentFloors, 0, 20, 2), includeCharacterCards: true, includeUserPersona: true, includeActivatedWorldInfo: true, worldMode: 'selected', worldBookNames: uniqueStrings(c.worldBookNames, 100, 200), worldBookView: str(c.worldBookView, 200), worldBookInitializedNames: uniqueStrings(c.worldBookInitializedNames, 100, 200), worldEntryIds: ids(c.worldEntryIds, 1000), tagRules: compilerTagRules, excludedTags: compilerTagRules.filter((rule) => rule.action === 'remove').map((rule) => rule.name).join(', ') };
  state.profiles = legacyProfiles(state.profiles); state.modelProfiles = modelProfileMemory(state.modelProfiles, state.profiles); state.parameterPresets = parameterPresets(state.parameterPresets); state.parameterPresetSelection = Object.fromEntries(Object.keys(STORYBOARD_PROVIDER_REGISTRY).map((id) => { const selected = cleanId(state.parameterPresetSelection?.[id]); const modelId = state.profiles[id]?.model || STORYBOARD_PROVIDER_REGISTRY[id].defaultModel; const builtin = getStoryboardBuiltinParameterPresets(id, modelId).some((preset) => preset.id === selected); return [id, builtin || state.parameterPresets.some((p) => p.id === selected && p.source === id) ? selected : '']; }));
  state.connections = connections(state.connections);
  delete state.characters; delete state.entities; delete state.selectedCharacterId; delete state.characterView;
  delete state.selectedCharacters; delete state.castPickerOpen; delete state.consistencyModes;
  state.promptPresets = promptPresets(state.promptPresets); state.artistCollections = artistCollections(state.artistCollections); state.artistPresets = artistPresets(state.artistPresets); const knownArtistCollections = new Set(state.artistCollections.map((item) => item.id)); for (const artist of state.artistPresets) { artist.collectionIds = artist.collectionIds.filter((id) => knownArtistCollections.has(id)); artist.collectionId = artist.collectionIds[0] || ''; } if (!knownArtistCollections.has(state.artistCollectionId)) state.artistCollectionId = ''; state.selectedArtistPresetId = state.artistPresets.some((item) => item.id === state.selectedArtistPresetId) ? cleanId(state.selectedArtistPresetId) : ''; if (state.editingArtistPresetId !== 'new' && !state.artistPresets.some((item) => item.id === state.editingArtistPresetId)) state.editingArtistPresetId = ''; const knownArtistIds = new Set(state.artistPresets.map((item) => item.id)); state.artistPools = artistPools(state.artistPools, knownArtistIds); state.selectedArtistPoolId = state.artistPools.some((item) => item.id === state.selectedArtistPoolId) ? cleanId(state.selectedArtistPoolId) : ''; state.tagLibrary = tags(state.tagLibrary); state.vibeLibrary = vibes(state.vibeLibrary);
  const knownTagIds = new Set(state.tagLibrary.map((tag) => tag.id));
  for (const preset of state.promptPresets) preset.tagIds = preset.tagIds.filter((id) => knownTagIds.has(id));
  for (const vibe of state.vibeLibrary) vibe.tags = vibe.tags.filter((id) => knownTagIds.has(id));
  const knownVibeIds = new Set(state.vibeLibrary.map((vibe) => vibe.id)); state.selectedVibeIds = ids(state.selectedVibeIds, 16).filter((id) => knownVibeIds.has(id));
  if (!state.promptPresets.some((preset) => preset.id === state.promptCompiler.instructionPresetId)) state.promptCompiler.instructionPresetId = '';
  if (!state.promptPresets.some((preset) => preset.id === state.editingPromptPresetId)) { state.editingPromptPresetId = ''; state.editingPromptItemId = ''; state.promptItemDraft = null; }
  state.compositionPolicy = normalizeStoryboardCompositionPolicy(state.compositionPolicy); state.routing = normalizeRouting(state.routing); state.shotPlans = shotPlans(state.shotPlans, state); state.taskStates = taskStates(state.taskStates); const collapsedInput = obj(state.collapsedCards) ? state.collapsedCards : {}; state.collapsedCards = Object.fromEntries(Object.entries(collapsedInput).slice(0, 200).map(([k, v]) => [str(k, 120), Boolean(v)]).filter(([k]) => k)); if (!Object.hasOwn(collapsedInput, 'production')) state.collapsedCards.production = true; if (!Object.hasOwn(collapsedInput, 'worldbook')) state.collapsedCards.worldbook = true; state.logs = legacyLogs(state.logs); state.pipelineLogs = pipelineLogs(state.pipelineLogs);
  const visiblePipelineIds = new Set(state.logs.map((log) => log.pipelineId).filter(Boolean));
  // v1/v2 日志没有 pipelineId；旧数据先按相同上限保留，只有新契约完整时才做一一配对裁剪。
  if (visiblePipelineIds.size) state.pipelineLogs = state.pipelineLogs.filter((log) => visiblePipelineIds.has(log.id));
  const knownStateKeys = new Set(Object.keys(defaults));
  for (const key of Object.keys(state)) {
    if (isSensitiveField(key)) { delete state[key]; continue; }
    if (knownStateKeys.has(key) || key === 'schemaVersion') continue;
    const normalized = safeData(state[key], 12);
    if (normalized === undefined) delete state[key]; else state[key] = normalized;
  }
  return state;
}

function connections(value) {
  const raw = obj(value) ? value : {}, out = {};
  for (const providerId of Object.keys(STORYBOARD_PROVIDER_REGISTRY)) {
    const c = obj(raw[providerId]) ? raw[providerId] : {};
    const presets = dedupeById((Array.isArray(c.presets) ? c.presets : []).filter(obj).map((p) => normalizeStoryboardConnectionProfile(p, providerId)).filter((p) => p.id)).slice(0, 60);
    const activePresetId = cleanId(c.activePresetId);
    const active = presets.find((p) => p.id === activePresetId) || null;
    const draftSource = obj(c.draft) ? c.draft : (active || {});
    out[providerId] = { providerId, activePresetId: active?.id || '', presets, draft: normalizeStoryboardConnectionProfile({ ...draftSource, id: '', name: '当前编辑' }, providerId) };
  }
  return out;
}

function promptPresets(value) {
  const normalized = (Array.isArray(value) ? value : []).filter(obj).map((preset) => {
    const presetId = cleanId(preset.id);
    const sourceItems = Array.isArray(preset.items) ? preset.items : (str(preset.instruction, 24000) ? [{ id: `${presetId}-legacy`, name: '基础指令', instruction: preset.instruction }] : []);
    const items = dedupeById(sourceItems.filter(obj).map((item, index) => ({ id: cleanId(item.id || `${presetId}-item-${index + 1}`), name: str(item.name || `条目 ${index + 1}`, 80) || `条目 ${index + 1}`, instruction: str(item.instruction || item.content, 12000) })).filter((item) => item.id && item.instruction)).slice(0, 50);
    return { id: presetId, name: str(preset.name || '未命名方案', 80) || '未命名方案', mode: STORYBOARD_PROMPT_MODES[preset.mode] ? preset.mode : 'combined', items, instruction: items.map((item) => item.instruction).join('\n\n').slice(0, 24000), positiveTemplate: str(preset.positiveTemplate, 24000), negativeTemplate: str(preset.negativeTemplate, 12000), providerIds: providers(preset.providerIds), tagIds: ids(preset.tagIds, 300), createdAt: pos(preset.createdAt || preset.updatedAt), updatedAt: pos(preset.updatedAt) };
  }).filter((preset) => preset.id);
  return dedupeById(normalized).slice(0, 200);
}

function artistPresets(value) {
  const normalized = (Array.isArray(value) ? value : []).filter(obj).map((preset) => {
    const collectionIds = ids(Array.isArray(preset.collectionIds) ? preset.collectionIds : [preset.collectionId], 30);
    return { id: cleanId(preset.id), name: str(preset.name || '未命名画师串', 80), value: str(preset.value, 6000), positivePrompt: str(preset.positivePrompt, 12000), negativePrompt: str(preset.negativePrompt, 12000), previewUrl: str(preset.previewUrl, 2_500_000), note: str(preset.note, 1000), tags: uniqueStrings(preset.tags, 30, 80), collectionIds, collectionId: collectionIds[0] || '', createdAt: pos(preset.createdAt || preset.updatedAt), updatedAt: pos(preset.updatedAt) };
  }).filter((preset) => preset.id && preset.value);
  return dedupeById(normalized).slice(0, 200);
}

function artistCollections(value) {
  const normalized = (Array.isArray(value) ? value : []).filter(obj).map((collection) => ({
    id: cleanId(collection.id), name: str(collection.name || '未命名合集', 80),
    createdAt: pos(collection.createdAt || collection.updatedAt), updatedAt: pos(collection.updatedAt),
  })).filter((collection) => collection.id);
  return dedupeById(normalized).slice(0, 100);
}

export function normalizeStoryboardArtistPool(value = {}, knownArtistIds = null) {
  const known = knownArtistIds instanceof Set ? knownArtistIds : new Set(Array.isArray(knownArtistIds) ? knownArtistIds.map(cleanId) : []);
  const accepts = (id) => id && (!known.size || known.has(id));
  const members = dedupeById((Array.isArray(value.members) ? value.members : []).filter(obj).map((member) => ({
    id: cleanId(member.id || member.artistId), artistId: cleanId(member.artistId || member.id),
    weight: num(member.weight, 0.1, 100, 1),
    shotRoles: uniqueStrings(member.shotRoles, 30, 80),
  })).filter((member) => accepts(member.artistId)).map((member) => ({ ...member, id: member.artistId }))).slice(0, 100);
  const roleAssignments = Object.fromEntries(Object.entries(obj(value.roleAssignments) ? value.roleAssignments : {})
    .slice(0, 80).map(([role, artistId]) => [str(role, 80), cleanId(artistId)])
    .filter(([role, artistId]) => role && accepts(artistId)));
  return {
    id: cleanId(value.id), name: str(value.name || '未命名画师方案', 80), enabled: value.enabled !== false,
    mode: ['weighted_random', 'sequential', 'shuffle_bag'].includes(value.mode) ? value.mode : 'shuffle_bag',
    members, roleAssignments, createdAt: pos(value.createdAt || value.updatedAt), updatedAt: pos(value.updatedAt),
  };
}

function artistPools(value, knownArtistIds) {
  return dedupeById((Array.isArray(value) ? value : []).filter(obj)
    .map((pool) => normalizeStoryboardArtistPool(pool, knownArtistIds))
    .filter((pool) => pool.id && pool.members.length)).slice(0, 100);
}

function artistRouteHash(value) {
  let hash = 2166136261;
  const source = String(value || 'qianmu');
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function artistRoutePick(members, mode, seed) {
  if (!members.length) return null;
  const hash = artistRouteHash(seed);
  if (mode === 'sequential') return members[hash % members.length];
  const total = members.reduce((sum, member) => sum + Math.max(0.1, Number(member.weight) || 1), 0);
  let cursor = (hash / 0x100000000) * total;
  for (const member of members) {
    cursor -= Math.max(0.1, Number(member.weight) || 1);
    if (cursor <= 0) return member;
  }
  return members.at(-1);
}

export function resolveStoryboardArtistAssignment({
  artistPresets: presets = [], artistPools: pools = [], selectedArtistPresetId = '', selectedArtistPoolId = '',
  shot = {}, seed = '', recentArtistIds = [], excludedArtistIds = [], reroll = false,
} = {}) {
  const artists = new Map((Array.isArray(presets) ? presets : []).filter((item) => cleanId(item?.id)).map((item) => [cleanId(item.id), item]));
  const requestedArtistId = cleanId(shot.artistPresetId || shot.artistId);
  if (!reroll && artists.has(requestedArtistId)) return { artistId: requestedArtistId, artist: artists.get(requestedArtistId), poolId: '', source: 'shot_override', seed: String(seed || '') };
  const pool = (Array.isArray(pools) ? pools : []).map((item) => normalizeStoryboardArtistPool(item, new Set(artists.keys())))
    .find((item) => item.id === cleanId(selectedArtistPoolId) && item.enabled) || null;
  const role = str(shot.shotRole || shot.role || shot.shotType, 80);
  const assignedId = cleanId(pool?.roleAssignments?.[role]);
  if (!reroll && artists.has(assignedId)) return { artistId: assignedId, artist: artists.get(assignedId), poolId: pool.id, source: 'shot_role', seed: String(seed || '') };
  if (pool) {
    const roleMembers = role ? pool.members.filter((member) => member.shotRoles.includes(role)) : [];
    const candidates = roleMembers.length ? roleMembers : pool.members;
    const excluded = new Set(ids(excludedArtistIds, 100));
    let alternatives = candidates.filter((member) => !excluded.has(member.artistId));
    let relaxedRoleForReroll = false;
    if (reroll && !alternatives.length) {
      const poolAlternatives = pool.members.filter((member) => !excluded.has(member.artistId));
      if (poolAlternatives.length) { alternatives = poolAlternatives; relaxedRoleForReroll = true; }
    }
    const eligible = alternatives.length ? alternatives : candidates;
    const recent = new Set(ids(recentArtistIds, 100));
    const fresh = pool.mode === 'shuffle_bag' ? eligible.filter((member) => !recent.has(member.artistId)) : eligible;
    const picked = artistRoutePick(fresh.length ? fresh : eligible, pool.mode, `${pool.id}:${seed}:${role}`);
    if (picked && artists.has(picked.artistId)) return {
      artistId: picked.artistId,
      artist: artists.get(picked.artistId),
      poolId: pool.id,
      source: reroll ? (roleMembers.length && !relaxedRoleForReroll ? 'pool_reroll_role' : 'pool_reroll') : (roleMembers.length ? 'pool_role' : 'pool'),
      seed: String(seed || ''),
    };
  }
  const selectedId = cleanId(selectedArtistPresetId);
  if (artists.has(selectedId)) return { artistId: selectedId, artist: artists.get(selectedId), poolId: '', source: 'selected', seed: String(seed || '') };
  return { artistId: '', artist: null, poolId: pool?.id || '', source: 'default', seed: String(seed || '') };
}

function tags(value) {
  const normalized = dedupeById((Array.isArray(value) ? value : []).filter(obj).map((tag) => ({ id: cleanId(tag.id), name: str(tag.name, 100), category: STORYBOARD_TAG_CATEGORIES.includes(tag.category) ? tag.category : 'custom', customCategory: str(tag.customCategory, 80), aliases: uniqueStrings(tag.aliases, 30, 100), positive: tag.positive !== false, scope: ['global', 'character', 'chat', 'shot'].includes(tag.scope) ? tag.scope : 'global', scopeId: cleanId(tag.scopeId), renderings: providerStrings(tag.renderings, 6000), naturalLanguage: str(tag.naturalLanguage || tag.description, 2000), weight: num(tag.weight, -10, 10, 1), conflictIds: ids(tag.conflictIds, 100), favorite: Boolean(tag.favorite), usageCount: int(tag.usageCount, 0, Number.MAX_SAFE_INTEGER, 0), createdAt: pos(tag.createdAt || tag.updatedAt), updatedAt: pos(tag.updatedAt) })).filter((tag) => tag.id && tag.name)).slice(0, 2000);
  const known = new Set(normalized.map((tag) => tag.id));
  for (const tag of normalized) {
    if (tag.scope === 'global') tag.scopeId = '';
    tag.conflictIds = tag.conflictIds.filter((id) => id !== tag.id && known.has(id));
  }
  return normalized;
}

function vibes(value) {
  const normalized = (Array.isArray(value) ? value : []).filter(obj).map((vibe) => ({ id: cleanId(vibe.id), name: str(vibe.name || '未命名 Vibe', 100), assetId: cleanId(vibe.assetId), previewUrl: str(vibe.previewUrl, 4096), providerIds: providers(vibe.providerIds).filter((providerId) => providerSupports(providerId, 'vibe')), modelIds: uniqueStrings(vibe.modelIds, 100, 240).filter((modelId) => Object.values(STORYBOARD_MODEL_REGISTRY).flat().some((model) => model.id === modelId && model.capabilities.vibe)), strength: num(vibe.strength, 0, 1, 0.6), informationExtracted: num(vibe.informationExtracted, 0, 1, 1), tags: ids(vibe.tags, 100), notes: str(vibe.notes, 4000), createdAt: pos(vibe.createdAt || vibe.updatedAt), updatedAt: pos(vibe.updatedAt) })).filter((vibe) => vibe.id);
  return dedupeById(normalized).slice(0, 500);
}

export function normalizeStoryboardCompositionPolicy(value) {
  const raw = obj(value) ? value : {}, defaults = compositionDefaults();
  const allowedRatioIds = ids(raw.allowedRatioIds, STORYBOARD_RATIOS.length).filter((id) => STORYBOARD_RATIOS.some((ratio) => ratio.id === id));
  const safeAllowed = allowedRatioIds.length ? allowedRatioIds : [...defaults.allowedRatioIds];
  const fixedRatioId = STORYBOARD_RATIOS.some((ratio) => ratio.id === raw.fixedRatioId) ? raw.fixedRatioId : defaults.fixedRatioId;
  const preferredRatioId = safeAllowed.includes(raw.preferredRatioId) ? raw.preferredRatioId : (safeAllowed.includes(defaults.preferredRatioId) ? defaults.preferredRatioId : safeAllowed[0]);
  return {
    schemaVersion: 1,
    systemRuleId: STORYBOARD_COMPOSITION_RULE_ID,
    systemRuleVersion: STORYBOARD_COMPOSITION_RULE_VERSION,
    mode: STORYBOARD_COMPOSITION_MODES.includes(raw.mode) ? raw.mode : defaults.mode,
    fixedRatioId,
    allowedRatioIds: safeAllowed,
    preferredRatioId,
    groupStrategy: STORYBOARD_GROUP_FRAME_STRATEGIES.includes(raw.groupStrategy) ? raw.groupStrategy : defaults.groupStrategy,
    ruleOverride: str(raw.ruleOverride, 12000),
    userEdited: Boolean(raw.userEdited && str(raw.ruleOverride, 12000)),
  };
}

export function restoreStoryboardCompositionPolicy(value = {}) {
  const current = normalizeStoryboardCompositionPolicy(value);
  return { ...current, ruleOverride: '', userEdited: false, systemRuleVersion: STORYBOARD_COMPOSITION_RULE_VERSION };
}

export function normalizeStoryboardParagraphSelection(value) {
  const raw = obj(value) ? value : {};
  const indexes = [...new Set((Array.isArray(raw.indexes) ? raw.indexes : []).map((item) => int(item, 0, Number.MAX_SAFE_INTEGER, -1)).filter((item) => item >= 0))].sort((a, b) => a - b).slice(0, 80);
  const paragraphIds = indexes.map((index) => `p${index + 1}`);
  return {
    version: 1,
    mode: raw.mode === 'manual_supplement' ? 'manual_supplement' : 'automatic',
    indexes,
    paragraphIds,
    insertAfterIndex: indexes.length ? indexes[indexes.length - 1] : int(raw.insertAfterIndex, 0, Number.MAX_SAFE_INTEGER, 0),
    createdAt: pos(raw.createdAt) || Date.now(),
  };
}

const shotStringList = (value, max = 40, length = 500) => uniqueStrings(Array.isArray(value) ? value : (str(value, length) ? [value] : []), max, length);
const normalizeSpatial = (value, index = 0) => {
  const raw = obj(value) ? value : {};
  const fallbackRegion = ['left', 'right', 'center_left', 'center_right', 'center'][index] || 'center';
  const region = STORYBOARD_SPATIAL_REGIONS.includes(raw.region) ? raw.region : fallbackRegion;
  const centerMap = { far_left: [0.08, 0.5], left: [0.22, 0.5], center_left: [0.36, 0.5], center: [0.5, 0.5], center_right: [0.64, 0.5], right: [0.78, 0.5], far_right: [0.92, 0.5], background: [0.5, 0.28] };
  const rawCenter = Array.isArray(raw.center) ? raw.center : centerMap[region];
  return {
    order: int(raw.order, 0, 99, index),
    region,
    center: [num(rawCenter?.[0], 0.02, 0.98, centerMap[region][0]), num(rawCenter?.[1], 0.02, 0.98, centerMap[region][1])],
    crop: STORYBOARD_CROPS.includes(raw.crop) ? raw.crop : 'full',
  };
};

export function normalizeStoryboardCharacterVisualState(value, index = 0) {
  const raw = obj(value) ? value : {};
  const id = cleanId(raw.id || raw.characterId || raw.name || `character-${index + 1}`);
  return {
    id,
    name: str(raw.name || raw.label || id, 120),
    identity: shotStringList(raw.identity || raw.appearance, 30, 500),
    outfit: shotStringList(raw.outfit || raw.wardrobe, 20, 500),
    temporaryState: shotStringList(raw.temporaryState || raw.state, 20, 500),
    expression: shotStringList(raw.expression, 12, 300),
    pose: shotStringList(raw.pose, 12, 500),
    action: shotStringList(raw.action, 12, 500),
    gaze: shotStringList(raw.gaze, 8, 300),
    props: shotStringList(raw.props, 20, 300),
    spatial: normalizeSpatial(raw.spatial, index),
  };
}

function normalizePromptAtoms(value) {
  const raw = obj(value) ? value : {};
  return {
    global: shotStringList(raw.global, 40, 800),
    camera: shotStringList(raw.camera, 20, 500),
    environment: shotStringList(raw.environment, 40, 800),
    quality: shotStringList(raw.quality, 20, 500),
    negative: shotStringList(raw.negative, 40, 500),
  };
}

function sceneSignal(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function castOverlap(left, right) {
  const a = new Set(left || []), b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

export function normalizeStoryboardSceneFingerprint(value = {}, fallback = {}) {
  const raw = obj(value) ? value : {}, base = obj(fallback) ? fallback : {};
  const sceneId = cleanId(raw.sceneId || raw.scene_id || base.sceneId || base.scene_id);
  const location = str(raw.location || base.location, 1000);
  const sceneText = str(raw.sceneText || raw.scene_text || raw.scene || base.sceneText || base.scene_text || base.scene, 2000);
  const time = str(raw.time || base.time, 240);
  const weather = str(raw.weather || base.weather, 240);
  const narrativeLayer = STORYBOARD_NARRATIVE_LAYERS.includes(raw.narrativeLayer || raw.narrative_layer || base.narrativeLayer || base.narrative_layer)
    ? (raw.narrativeLayer || raw.narrative_layer || base.narrativeLayer || base.narrative_layer)
    : 'present';
  const fallbackCast = Array.isArray(base.characters) ? base.characters.map((item) => item?.id || item?.name) : [];
  const castIds = ids(raw.castIds || raw.cast_ids || base.castIds || base.cast_ids || fallbackCast, 24).sort();
  const anchors = ids(raw.anchors || raw.anchorIds || raw.anchor_ids || base.anchors, 40).sort();
  const signature = [sceneId, sceneSignal(location), sceneSignal(time), sceneSignal(weather), narrativeLayer, castIds.join(','), anchors.join(','), sceneSignal(sceneText)].join('|');
  return {
    schema: STORYBOARD_SCENE_FINGERPRINT_SCHEMA,
    id: sceneId ? `scene:${sceneId}` : `scene-${hash(signature)}`,
    sceneId,
    location,
    sceneText,
    time,
    weather,
    narrativeLayer,
    castIds,
    anchors,
    explicit: Boolean(sceneId),
  };
}

export function compareStoryboardSceneFingerprints(left, right) {
  const a = normalizeStoryboardSceneFingerprint(left), b = normalizeStoryboardSceneFingerprint(right);
  const reasons = [];
  if (a.explicit && b.explicit) {
    const sameScene = a.sceneId === b.sceneId;
    return { sameScene, score: sameScene ? 1 : 0, reasons: [sameScene ? 'explicit_scene_id' : 'scene_id_changed'], left: a, right: b };
  }
  if (a.narrativeLayer !== b.narrativeLayer) return { sameScene: false, score: 0, reasons: ['narrative_layer_changed'], left: a, right: b };
  const locationScore = a.location && b.location ? similarity(sceneSignal(a.location), sceneSignal(b.location)) : 0;
  const sceneTextScore = a.sceneText && b.sceneText ? similarity(sceneSignal(a.sceneText), sceneSignal(b.sceneText)) : 0;
  const castScore = castOverlap(a.castIds, b.castIds);
  const timeScore = a.time && b.time ? similarity(sceneSignal(a.time), sceneSignal(b.time)) : 0;
  const weatherScore = a.weather && b.weather ? similarity(sceneSignal(a.weather), sceneSignal(b.weather)) : 0;
  if (a.location && b.location && locationScore < .34) return { sameScene: false, score: 0, reasons: ['location_changed'], left: a, right: b };
  const hasSceneEvidence = Boolean((a.location && b.location) || (a.sceneText && b.sceneText) || (a.anchors.length && b.anchors.length));
  const anchorScore = castOverlap(a.anchors, b.anchors);
  const score = locationScore * .38 + sceneTextScore * .25 + anchorScore * .14 + timeScore * .08 + weatherScore * .05 + castScore * .10;
  if (locationScore >= .55) reasons.push('location_match');
  if (sceneTextScore >= .58) reasons.push('scene_match');
  if (anchorScore > 0) reasons.push('anchor_match');
  if (castScore > 0) reasons.push('cast_overlap');
  const sameScene = hasSceneEvidence && score >= .46 && (locationScore >= .55 || sceneTextScore >= .58 || anchorScore >= .5);
  if (!sameScene && castScore > 0 && !hasSceneEvidence) reasons.push('cast_only_is_insufficient');
  if (!sameScene && !reasons.length) reasons.push('insufficient_scene_evidence');
  return { sameScene, score: Math.round(score * 1000) / 1000, reasons, left: a, right: b };
}

function continuityFactSlot(fact) {
  return [fact.category, fact.subject, fact.key].map((item) => String(item || '').trim().toLowerCase()).join(':');
}

export function normalizeStoryboardContinuityFact(value, index = 0) {
  const raw = obj(value) ? value : {};
  const category = STORYBOARD_CONTINUITY_FACT_CATEGORIES.includes(raw.category || raw.domain)
    ? (raw.category || raw.domain)
    : 'other';
  const subject = str(raw.subject || raw.entity || raw.character || raw.owner, 160);
  const key = str(raw.key || raw.attribute || raw.slot || category, 120);
  const factValue = str(raw.value ?? raw.state ?? raw.description, 1000);
  const sourceParagraphIds = ids(raw.sourceParagraphIds || raw.source_paragraph_ids, 80);
  const persistence = STORYBOARD_CONTINUITY_FACT_PERSISTENCE.includes(raw.persistence)
    ? raw.persistence
    : (raw.momentary || raw.transient ? 'momentary' : 'persistent');
  const status = STORYBOARD_CONTINUITY_FACT_STATES.includes(raw.status) ? raw.status : 'active';
  const fallbackId = `fact-${hash([category, subject, key, factValue, sourceParagraphIds.join(',')].join('|'))}`;
  return {
    id: cleanId(raw.id) || fallbackId,
    category,
    subject,
    key,
    value: factValue,
    persistence,
    status,
    sourceParagraphIds,
    sourceFloor: Number.isInteger(raw.sourceFloor ?? raw.source_floor) ? Math.max(0, Number(raw.sourceFloor ?? raw.source_floor)) : null,
    evidence: str(raw.evidence, 1000),
    supersedes: ids(raw.supersedes || raw.replaces, 20),
    replacedBy: cleanId(raw.replacedBy || raw.replaced_by),
    order: int(raw.order, 0, 1000000, index),
  };
}

function normalizeContinuityFacts(value) {
  const list = Array.isArray(value) ? value : [];
  return dedupeById(list.slice(0, 240).map(normalizeStoryboardContinuityFact).filter((fact) => fact.id && fact.value));
}

function expireMomentaryContinuityFacts(value) {
  return normalizeContinuityFacts(value).map((fact) => fact.status === 'active' && fact.persistence === 'momentary'
    ? { ...fact, status: 'expired' }
    : fact);
}

function mergeContinuityFacts(previous, updates) {
  const merged = normalizeContinuityFacts(previous);
  const positions = new Map(merged.map((fact, index) => [fact.id, index]));
  for (const incoming of normalizeContinuityFacts(updates)) {
    const existingIndex = positions.get(incoming.id);
    if (existingIndex !== undefined) {
      merged[existingIndex] = incoming;
    } else {
      positions.set(incoming.id, merged.length);
      merged.push(incoming);
    }
    if (incoming.status === 'active') {
      const slot = continuityFactSlot(incoming);
      for (let index = 0; index < merged.length; index += 1) {
        const current = merged[index];
        if (current.id === incoming.id) continue;
        if (current.status !== 'active' || continuityFactSlot(current) !== slot) continue;
        merged[index] = { ...current, status: 'superseded', replacedBy: incoming.id };
        if (!incoming.supersedes.includes(current.id)) incoming.supersedes.push(current.id);
      }
      for (const replacedId of incoming.supersedes) {
        const replacedIndex = positions.get(replacedId);
        if (replacedIndex === undefined) continue;
        const replaced = merged[replacedIndex];
        if (replaced.status === 'active') merged[replacedIndex] = { ...replaced, status: 'superseded', replacedBy: incoming.id };
      }
    }
  }
  return merged.slice(-240);
}

export function normalizeStoryboardContinuityLedger(value) {
  const raw = obj(value) ? value : {};
  return {
    axis: str(raw.axis, 240), leftRight: str(raw.leftRight || raw.left_right, 500), gaze: str(raw.gaze, 500),
    time: str(raw.time, 240), weather: str(raw.weather, 240), light: str(raw.light, 500), color: str(raw.color, 500),
    outfit: safeRecord(raw.outfit), injuries: safeRecord(raw.injuries), props: safeRecord(raw.props), actionState: safeRecord(raw.actionState || raw.action_state),
    facts: normalizeContinuityFacts(raw.facts || raw.continuityFacts || raw.continuity_facts),
    mainRatioId: STORYBOARD_RATIOS.some((ratio) => ratio.id === raw.mainRatioId) ? raw.mainRatioId : '',
    emphasisRatioId: STORYBOARD_RATIOS.some((ratio) => ratio.id === raw.emphasisRatioId) ? raw.emphasisRatioId : '',
  };
}

const normalizeContinuity = normalizeStoryboardContinuityLedger;

function normalizeStoryboardDirectorDecisionSnapshot(value) {
  if (!obj(value)) return null;
  const raw = value, source = obj(raw.source) ? raw.source : {}, approval = obj(raw.approval) ? raw.approval : {};
  const outputs = obj(raw.outputs) ? raw.outputs : {}, lanes = obj(raw.lanes) ? raw.lanes : {};
  const visual = obj(lanes.visual) ? lanes.visual : {}, scene = obj(visual.scene) ? visual.scene : {};
  const decisionId = cleanId(raw.decisionId || raw.decision_id);
  if (!decisionId) return null;
  return {
    schema: 'qianmu.director-decision.v1',
    decisionId,
    owner: { chatKey: str(raw.owner?.chatKey || raw.owner?.chat_key, 512) },
    status: raw.status === 'approved' ? 'approved' : 'revoked',
    truthMode: raw.truthMode === 'canon' ? 'canon' : 'speculative',
    source: {
      candidateId: cleanId(source.candidateId || source.candidate_id),
      ledgerEntryId: cleanId(source.ledgerEntryId || source.ledger_entry_id),
      packetId: cleanId(source.packetId || source.packet_id),
      eventId: cleanId(source.eventId || source.event_id),
      track: ['main_camera', 'second_camera'].includes(source.track) ? source.track : '',
      canonLevel: ['canon', 'director', 'draft'].includes(source.canonLevel || source.canon_level) ? (source.canonLevel || source.canon_level) : '',
    },
    approval: {
      mode: approval.mode === 'explicit' ? 'explicit' : 'none',
      approvedAt: pos(approval.approvedAt || approval.approved_at),
      revokedAt: pos(approval.revokedAt || approval.revoked_at),
      revision: int(approval.revision, 1, 1000, 1),
    },
    outputs: Object.fromEntries(['storyboard', 'voice', 'subtitle', 'film'].map((consumer) => [consumer, outputs[consumer] === true])),
    lanes: {
      visual: {
        duty: str(visual.duty, 80), shotPattern: str(visual.shotPattern || visual.shot_pattern, 80),
        subject: str(visual.subject, 1000), description: str(visual.description, 4000),
        characters: (Array.isArray(visual.characters) ? visual.characters : []).filter(obj).slice(0, 24).map((character, index) => {
          const id = str(character.id || character.name || `character-${index + 1}`, 160);
          return { id, name: str(character.name || id, 160), state: str(character.state, 1000) };
        }).filter((character) => character.id),
        scene: {
          location: str(scene.location, 1000), time: str(scene.time, 240), weather: str(scene.weather, 240),
          environment: uniqueStrings(scene.environment, 40, 240), props: uniqueStrings(scene.props, 40, 240),
        },
        evidenceRefs: ids(visual.evidenceRefs || visual.evidence_refs, 80),
      },
      dialogue: uniqueStrings(lanes.dialogue, 40, 1000),
      ambience: uniqueStrings(lanes.ambience, 40, 1000),
      caption: str(lanes.caption, 1200),
    },
  };
}

export function normalizeStoryboardShotSpec(value = {}) {
  const raw = obj(value) ? value : {}, composition = obj(raw.composition) ? raw.composition : {};
  const characters = (Array.isArray(raw.characters) ? raw.characters : []).filter(obj).slice(0, 12).map(normalizeStoryboardCharacterVisualState).filter((item) => item.id);
  const narrativeLayer = STORYBOARD_NARRATIVE_LAYERS.includes(raw.narrativeLayer || raw.narrative_layer) ? (raw.narrativeLayer || raw.narrative_layer) : 'present';
  const scene = str(raw.scene, 4000);
  const continuityUpdates = normalizeContinuity(raw.continuityUpdates || raw.continuity_updates);
  const sceneFingerprint = normalizeStoryboardSceneFingerprint(raw.sceneFingerprint || raw.scene_fingerprint, {
    sceneId: raw.sceneId || raw.scene_id,
    location: raw.location || raw.sceneLocation || raw.scene_location,
    scene,
    narrativeLayer,
    characters,
    time: continuityUpdates.time,
    weather: continuityUpdates.weather,
    anchors: raw.sourceParagraphIds || raw.source_paragraph_ids,
  });
  const inferredPattern = raw.shotRole === 'detail' || raw.shot_role === 'detail' || raw.shotScale === 'insert' || raw.shot_scale === 'insert'
    ? 'insert'
    : raw.shotRole === 'reaction' || raw.shot_role === 'reaction'
      ? 'single_reaction'
      : raw.shotRole === 'relationship' || raw.shot_role === 'relationship'
        ? 'two_shot'
        : raw.shotRole === 'establishing' || raw.shot_role === 'establishing'
          ? 'master'
          : 'action';
  const shotPattern = STORYBOARD_SHOT_PATTERNS.includes(raw.shotPattern || raw.shot_pattern) ? (raw.shotPattern || raw.shot_pattern) : inferredPattern;
  const inferredDuty = ({
    master: 'space', two_shot: 'relationship', over_shoulder: 'relationship', single_reaction: 'reaction',
    action: 'action', insert: 'detail', atmosphere: 'atmosphere',
  })[shotPattern] || 'action';
  const visualDuty = STORYBOARD_VISUAL_DUTIES.includes(raw.visualDuty || raw.visual_duty) ? (raw.visualDuty || raw.visual_duty) : inferredDuty;
  const inferredSubjectKind = characters.length
    ? (shotPattern === 'insert' ? 'mixed' : 'character')
    : shotPattern === 'insert'
      ? 'object'
      : shotPattern === 'atmosphere' || shotPattern === 'master'
        ? 'environment'
        : narrativeLayer === 'imagined' || narrativeLayer === 'dream'
          ? 'symbolic'
          : 'mixed';
  const subjectKind = STORYBOARD_SUBJECT_KINDS.includes(raw.subjectKind || raw.subject_kind) ? (raw.subjectKind || raw.subject_kind) : inferredSubjectKind;
  const evidenceRaw = obj(raw.evidence) ? raw.evidence : {};
  const evidenceParagraphIds = ids(evidenceRaw.paragraphIds || evidenceRaw.paragraph_ids || raw.sourceParagraphIds || raw.source_paragraph_ids, 80);
  const evidenceType = STORYBOARD_EVIDENCE_TYPES.includes(evidenceRaw.type || evidenceRaw.claimType || evidenceRaw.claim_type)
    ? (evidenceRaw.type || evidenceRaw.claimType || evidenceRaw.claim_type)
    : 'explicit';
  const productionRaw = obj(raw.productionContext || raw.production_context) ? (raw.productionContext || raw.production_context) : {};
  return {
    schema: STORYBOARD_PLAN_SCHEMA,
    id: cleanId(raw.id),
    sourceParagraphIds: evidenceParagraphIds,
    insertAfter: cleanId(raw.insertAfter || raw.insert_after),
    narrativeLayer,
    narrativePurpose: str(raw.narrativePurpose || raw.narrative_purpose || raw.purpose, 800),
    shotPattern,
    visualDuty,
    subjectKind,
    shotRole: STORYBOARD_SHOT_ROLES.includes(raw.shotRole || raw.shot_role || raw.role) ? (raw.shotRole || raw.shot_role || raw.role) : 'action',
    shotScale: STORYBOARD_SHOT_SCALES.includes(raw.shotScale || raw.shot_scale || raw.shotType) ? (raw.shotScale || raw.shot_scale || raw.shotType) : 'medium_shot',
    subject: str(raw.subject, 1000), scene, sceneId: sceneFingerprint.sceneId, sceneFingerprint, characters,
    sharedRelations: shotStringList(raw.sharedRelations || raw.shared_relations, 30, 800),
    composition: {
      ratioId: STORYBOARD_RATIOS.some((ratio) => ratio.id === composition.ratioId || ratio.id === composition.ratio_id) ? (composition.ratioId || composition.ratio_id) : '',
      ratioLocked: Boolean(composition.ratioLocked || composition.ratio_locked),
      framing: shotStringList(composition.framing, 20, 500),
      cameraSide: str(composition.cameraSide || composition.camera_side, 120),
      angle: str(composition.angle, 120),
      focus: str(composition.focus || composition.compositionFocus || composition.composition_focus, 300),
      negativeSpace: str(composition.negativeSpace || composition.negative_space, 500),
      rationale: str(composition.rationale, 1000),
    },
    promptAtoms: normalizePromptAtoms(raw.promptAtoms || raw.prompt_atoms),
    sensitive: Boolean(raw.sensitive), safetyNotes: shotStringList(raw.safetyNotes || raw.safety_notes, 20, 500),
    evidence: {
      type: evidenceType,
      paragraphIds: evidenceParagraphIds,
      quote: str(evidenceRaw.quote || evidenceRaw.text, 2000),
      floor: Number.isInteger(evidenceRaw.floor) ? Math.max(0, Number(evidenceRaw.floor)) : null,
      rationale: str(evidenceRaw.rationale || raw.visualRationale || raw.visual_rationale, 1000),
    },
    productionContext: {
      packetId: cleanId(productionRaw.packetId || productionRaw.packet_id),
      eventId: cleanId(productionRaw.eventId || productionRaw.event_id),
      track: ['main_camera', 'second_camera'].includes(productionRaw.track) ? productionRaw.track : '',
      canonLevel: ['canon', 'director', 'draft'].includes(productionRaw.canonLevel || productionRaw.canon_level) ? (productionRaw.canonLevel || productionRaw.canon_level) : '',
      autoInsert: productionRaw.autoInsert === true,
      decisionId: cleanId(productionRaw.decisionId || productionRaw.decision_id),
      decisionStatus: productionRaw.decisionStatus === 'approved' ? 'approved' : productionRaw.decisionStatus === 'revoked' ? 'revoked' : '',
      truthMode: productionRaw.truthMode === 'canon' ? 'canon' : productionRaw.truthMode === 'speculative' ? 'speculative' : '',
    },
    directorDecision: normalizeStoryboardDirectorDecisionSnapshot(raw.directorDecision || raw.director_decision),
    continuityUpdates,
    decisions: shotStringList(raw.decisions, 40, 1000),
  };
}

export function adaptProductionPacketToStoryboardShotSpec(value = {}, overrides = {}) {
  const packet = obj(value) ? value : {}, visual = obj(packet.visualIntent) ? packet.visualIntent : {}, sceneState = obj(packet.sceneState) ? packet.sceneState : {};
  const pattern = STORYBOARD_SHOT_PATTERNS.includes(visual.shotPattern) ? visual.shotPattern : 'action';
  const duty = STORYBOARD_VISUAL_DUTIES.includes(visual.duty) ? visual.duty : 'action';
  const role = ({ space: 'establishing', relationship: 'relationship', action: 'action', reaction: 'reaction', detail: 'detail', atmosphere: 'establishing', motif: 'detail', transition: 'turn' })[duty] || 'action';
  const scale = ({ master: 'wide_shot', two_shot: 'medium_shot', over_shoulder: 'medium_close_up', single_reaction: 'close_up', action: 'medium_full', insert: 'insert', atmosphere: 'extreme_wide_shot', montage: 'wide_shot' })[pattern] || 'medium_shot';
  const characters = (Array.isArray(packet.characterState) ? packet.characterState : []).slice(0, 12).map((character, index) => ({
    id: character?.id || character?.name || `character-${index + 1}`,
    name: character?.name || character?.id || '',
    temporaryState: [character?.state].filter(Boolean),
  }));
  const evidenceRefs = ids(visual.evidenceRefs, 80);
  const environment = [sceneState.location, sceneState.time, sceneState.weather, ...(Array.isArray(sceneState.environment) ? sceneState.environment : [])].filter(Boolean);
  return normalizeStoryboardShotSpec({
    id: packet.packetId || packet.eventId,
    sourceParagraphIds: evidenceRefs,
    narrativeLayer: visual.narrativeLayer || 'present',
    narrativePurpose: visual.description || visual.subject || '',
    shotPattern: pattern,
    visualDuty: duty,
    shotRole: role,
    shotScale: scale,
    subject: visual.subject || '',
    subjectKind: characters.length ? 'character' : (['atmosphere', 'space'].includes(duty) ? 'environment' : duty === 'motif' ? 'symbolic' : 'mixed'),
    sceneId: packet.sceneId || '',
    location: sceneState.location || '',
    scene: environment.join(', '),
    characters,
    composition: { cameraSide: visual.cameraSide || '', angle: visual.angle || '', focus: visual.focus || '', framing: visual.framing || [] },
    promptAtoms: { global: [visual.description, visual.subject].filter(Boolean), environment },
    continuityUpdates: { time: sceneState.time, weather: sceneState.weather, props: Object.fromEntries((Array.isArray(sceneState.props) ? sceneState.props : []).map((prop) => [String(prop), true])) },
    evidence: { type: 'inferred', paragraphIds: evidenceRefs, quote: visual.evidenceQuote || '', rationale: visual.rationale || '由制片包映射，需在镜头详情确认后提交。' },
    productionContext: { packetId: packet.packetId, eventId: packet.eventId, track: packet.track, canonLevel: packet.canonLevel, autoInsert: false, decisionId: '', decisionStatus: '', truthMode: '' },
    decisions: [`制片包来源：${packet.sourceRef?.field || 'unknown'}`],
    ...overrides,
  });
}

export function storyboardProductionContext(value = {}) {
  const source = obj(value) ? value : {};
  const candidates = [
    source.packetId || source.packet_id || source.track ? source : null,
    source.productionContext,
    source.production_context,
    source.shotSpec?.productionContext,
    source.shotSpec?.production_context,
    source.compiledPrompt?.productionContext,
    source.snapshot?.productionContext,
    source.snapshot?.shotSpec?.productionContext,
    source.snapshot?.compiledPrompt?.productionContext,
  ];
  const raw = candidates.find(obj) || {};
  const track = ['main_camera', 'second_camera'].includes(raw.track) ? raw.track : 'main_camera';
  const canonLevel = ['canon', 'director', 'draft'].includes(raw.canonLevel || raw.canon_level)
    ? (raw.canonLevel || raw.canon_level)
    : '';
  return {
    packetId: cleanId(raw.packetId || raw.packet_id),
    eventId: cleanId(raw.eventId || raw.event_id),
    track,
    canonLevel,
    autoInsert: raw.autoInsert === true,
    decisionId: cleanId(raw.decisionId || raw.decision_id),
    decisionStatus: raw.decisionStatus === 'approved' ? 'approved' : raw.decisionStatus === 'revoked' ? 'revoked' : '',
    truthMode: raw.truthMode === 'canon' ? 'canon' : raw.truthMode === 'speculative' ? 'speculative' : '',
  };
}

export function storyboardDirectorDecisionSnapshot(value = {}) {
  const source = obj(value) ? value : {};
  const candidates = [
    source.directorDecision, source.director_decision,
    source.shotSpec?.directorDecision, source.shotSpec?.director_decision,
    source.compiledPrompt?.validation?.shot?.directorDecision,
    source.snapshot?.shotSpec?.directorDecision,
    source.snapshot?.compiledPrompt?.validation?.shot?.directorDecision,
  ];
  return normalizeStoryboardDirectorDecisionSnapshot(candidates.find(obj));
}

export function storyboardProductionDeliveryPolicy(value = {}, requested = {}) {
  const productionContext = storyboardProductionContext(value);
  const fromProductionPacket = Boolean(productionContext.packetId || productionContext.eventId);
  const requiresExplicitInsert = fromProductionPacket && productionContext.autoInsert !== true;
  const requestedTarget = ['latest', 'floor', 'gallery'].includes(requested.target) ? requested.target : 'latest';
  return {
    productionContext,
    track: productionContext.track,
    sourceLabel: STORYBOARD_PRODUCTION_TRACK_LABELS[productionContext.track],
    target: requiresExplicitInsert ? 'gallery' : requestedTarget,
    inlineByDefault: requiresExplicitInsert ? false : requested.inlineByDefault !== false,
    requiresExplicitInsert,
  };
}

export function validateStoryboardShotGrounding(value = {}, options = {}) {
  const shot = normalizeStoryboardShotSpec(value);
  const errors = [], warnings = [];
  const hasEvidence = shot.evidence.paragraphIds.length > 0 || Boolean(shot.evidence.quote);
  if (!hasEvidence) errors.push('镜头缺少正文段落或原文证据');
  if (!shot.narrativePurpose) errors.push('镜头缺少叙事目的');
  if (!shot.visualDuty) errors.push('镜头缺少画面职责');
  if (['environment', 'symbolic'].includes(shot.subjectKind) && !shot.narrativePurpose) errors.push('空镜或意象镜头必须说明服务的空间、情绪或母题');
  if (['inferred', 'symbolic'].includes(shot.evidence.type) && !shot.evidence.rationale) {
    const message = '推断或意象镜头必须说明与正文证据的连接';
    if (options.strict) errors.push(message); else warnings.push(message);
  }
  return { valid: errors.length === 0, shot, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

const STATIC_SCENE_PATTERN_ORDER = Object.freeze({
  dialogue: Object.freeze(['master', 'two_shot', 'over_shoulder', 'single_reaction', 'insert', 'atmosphere']),
  activity: Object.freeze(['master', 'action', 'insert', 'single_reaction', 'over_shoulder', 'atmosphere']),
  atmosphere: Object.freeze(['master', 'atmosphere', 'insert', 'single_reaction', 'two_shot', 'over_shoulder']),
});

const STATIC_PATTERN_SPECS = Object.freeze({
  master: Object.freeze({ shotRole: 'establishing', shotScale: 'wide_shot', cameraSide: 'neutral', angle: 'eye_level', narrativeDuty: '建立空间、人物站位与行动关系' }),
  two_shot: Object.freeze({ shotRole: 'relationship', shotScale: 'medium_shot', cameraSide: 'axis_side_a', angle: 'eye_level', narrativeDuty: '呈现人物之间的距离与交流关系' }),
  over_shoulder: Object.freeze({ shotRole: 'relationship', shotScale: 'medium_close_up', cameraSide: 'axis_side_a', angle: 'eye_level', narrativeDuty: '把信息重心交给当前说话或行动者' }),
  single_reaction: Object.freeze({ shotRole: 'reaction', shotScale: 'close_up', cameraSide: 'axis_side_a', angle: 'eye_level', narrativeDuty: '捕捉另一人物对叙事信息的反应' }),
  action: Object.freeze({ shotRole: 'action', shotScale: 'medium_full', cameraSide: 'axis_side_a', angle: 'eye_level', narrativeDuty: '推进一个可见且有结果的动作' }),
  insert: Object.freeze({ shotRole: 'detail', shotScale: 'insert', cameraSide: 'neutral', angle: 'detail_driven', narrativeDuty: '用手部、器物或局部细节提供叙事证据' }),
  atmosphere: Object.freeze({ shotRole: 'establishing', shotScale: 'extreme_wide_shot', cameraSide: 'neutral', angle: 'environment_driven', narrativeDuty: '用环境空镜承接空间、情绪或母题' }),
});

export function planStoryboardStaticSceneRhythm(value = {}) {
  const raw = obj(value) ? value : {};
  const sceneType = STORYBOARD_STATIC_SCENE_TYPES.includes(raw.sceneType || raw.scene_type) ? (raw.sceneType || raw.scene_type) : 'dialogue';
  const castIds = ids(raw.castIds || raw.cast_ids, 12);
  const axis = str(raw.axis, 240);
  const maxShots = int(raw.maxShots, 1, 6, 4);
  let order = [...STATIC_SCENE_PATTERN_ORDER[sceneType]];
  const lastPattern = STORYBOARD_SHOT_PATTERNS.includes(raw.lastPattern || raw.last_pattern) ? (raw.lastPattern || raw.last_pattern) : '';
  if (raw.sceneContinuation && lastPattern && order[0] === lastPattern) order = [...order.slice(1), order[0]];
  const beats = order.slice(0, maxShots).map((pattern, index) => {
    const spec = STATIC_PATTERN_SPECS[pattern];
    const subjectIds = pattern === 'master' || pattern === 'two_shot'
      ? castIds.slice(0, Math.max(1, Math.min(3, castIds.length)))
      : pattern === 'over_shoulder'
        ? castIds.slice(0, 2).reverse().slice(0, 1)
        : pattern === 'single_reaction'
          ? castIds.slice(index % Math.max(1, castIds.length), (index % Math.max(1, castIds.length)) + 1)
          : [];
    return {
      id: `beat-${index + 1}`,
      pattern,
      ...spec,
      subjectIds,
      foregroundIds: pattern === 'over_shoulder' ? castIds.slice(0, 1) : [],
      axisRule: ['master', 'insert', 'atmosphere'].includes(pattern) ? 'neutral_reset_allowed' : 'preserve',
    };
  });
  return {
    sceneType,
    castIds,
    axis,
    beats,
    guidance: { sightlineContinuity: true, axisContinuity: true, thirtyDegreeRule: 'heuristic' },
  };
}

export function evaluateStoryboardShotRhythm(value = []) {
  const shots = (Array.isArray(value) ? value : []).map(normalizeStoryboardShotSpec);
  const violations = [];
  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1], shot = shots[index];
    if (previous.shotPattern === shot.shotPattern) violations.push({ index, code: 'repeated_pattern', pattern: shot.shotPattern });
    const previousAxis = previous.continuityUpdates.axis;
    const currentAxis = shot.continuityUpdates.axis;
    if (previousAxis && currentAxis && previousAxis !== currentAxis && !['master', 'insert', 'atmosphere'].includes(shot.shotPattern)) {
      violations.push({ index, code: 'axis_change_without_neutral_reset', from: previousAxis, to: currentAxis });
    }
  }
  const patterns = shots.map((shot) => shot.shotPattern);
  return {
    valid: violations.length === 0,
    patterns,
    violations,
    coverage: {
      spatial: patterns.some((pattern) => pattern === 'master'),
      relationship: patterns.some((pattern) => ['two_shot', 'over_shoulder'].includes(pattern)),
      reaction: patterns.some((pattern) => pattern === 'single_reaction'),
      detail: patterns.some((pattern) => pattern === 'insert'),
      atmosphere: patterns.some((pattern) => pattern === 'atmosphere'),
    },
  };
}

function storyboardShotDifference(previous, shot) {
  const comparison = previous ? compareStoryboardSceneFingerprints(previous.sceneFingerprint, shot.sceneFingerprint) : null;
  const transition = !previous || !comparison.sameScene;
  const visualChanges = [];
  if (previous) {
    if (previous.shotRole !== shot.shotRole) visualChanges.push('role');
    if (previous.shotScale !== shot.shotScale) visualChanges.push('scale');
    if (sceneSignal(previous.subject) !== sceneSignal(shot.subject)) visualChanges.push('subject');
    if (previous.composition.cameraSide !== shot.composition.cameraSide) visualChanges.push('camera_side');
    if (previous.composition.angle !== shot.composition.angle) visualChanges.push('angle');
    if (previous.composition.focus !== shot.composition.focus) visualChanges.push('focus');
    if (previous.composition.framing.join('|') !== shot.composition.framing.join('|')) visualChanges.push('framing');
  }
  const informationChanged = !previous
    || previous.sourceParagraphIds.join('|') !== shot.sourceParagraphIds.join('|')
    || similarity(previous.narrativePurpose, shot.narrativePurpose) < .9;
  const effectiveVisualChanges = visualChanges.filter((change) => change !== 'role');
  const issues = [];
  if (previous && !transition) {
    if (!informationChanged) issues.push('no_narrative_increment');
    if (!effectiveVisualChanges.length) issues.push('no_visual_variation');
    else if (effectiveVisualChanges.length < 2) issues.push('insufficient_visual_variation');
  }
  return {
    comparison,
    transition,
    informationChanged,
    visualChanges,
    effectiveVisualChanges,
    acceptable: transition || !issues.length,
    issues,
  };
}

export function evaluateStoryboardShotDifference(previousValue, shotValue) {
  const previous = previousValue ? normalizeStoryboardShotSpec(previousValue) : null;
  const shot = normalizeStoryboardShotSpec(shotValue);
  return storyboardShotDifference(previous, shot);
}

export function buildStoryboardSceneCoverageMap(value = []) {
  const shots = (Array.isArray(value) ? value : []).map(normalizeStoryboardShotSpec);
  let previous = null, group = 0;
  return shots.map((shot, index) => {
    const difference = storyboardShotDifference(previous, shot);
    if (difference.transition) group += 1;
    const entry = {
      shotId: shot.id || `shot-${index + 1}`,
      sceneGroupId: `scene-group-${group}`,
      sceneFingerprint: shot.sceneFingerprint,
      transition: difference.transition,
      transitionReasons: difference.comparison?.reasons || ['first_shot'],
      informationChanged: difference.informationChanged,
      visualChanges: difference.visualChanges,
      effectiveVisualChanges: difference.effectiveVisualChanges,
      acceptable: difference.acceptable,
      issues: difference.issues,
      duplicateCoverage: Boolean(previous && !difference.transition && !difference.informationChanged && !difference.visualChanges.length),
    };
    previous = shot;
    return entry;
  });
}

export function resolveStoryboardComposition(value = {}) {
  const policy = normalizeStoryboardCompositionPolicy(value.policy), shot = normalizeStoryboardShotSpec(value.shot);
  if (value.connection?.protocol && value.connection.protocol !== IMAGE_NATIVE_PROTOCOLS[value.providerId]
    && !getStoryboardCapabilities(value.providerId, value.capabilityModelId, undefined, value.connection).ratio) {
    return { ratioId: '', ratioLocked: true, source: 'protocol', dimensions: { width: 0, height: 0, size: '', aspectRatio: '' },
      rationale: '画幅由当前接口决定', policyVersion: policy.systemRuleVersion };
  }
  if (value.providerId === 'comfy' && value.workflow !== undefined) {
    const actual = getStoryboardCapabilities('comfy', '', value.workflow);
    if (!actual.ratio) return { ratioId: '', ratioLocked: true, source: 'workflow',
      dimensions: { width: actual.width ? numeric(value.width) : 0, height: actual.height ? numeric(value.height) : 0, size: '', aspectRatio: '' },
      rationale: '画幅由工作流决定', policyVersion: policy.systemRuleVersion };
  }
  const requested = shot.composition.ratioId;
  let ratioId = policy.preferredRatioId, source = 'preferred';
  if (shot.composition.ratioLocked && requested) { ratioId = requested; source = 'manual_locked'; }
  else if (policy.mode === 'fixed') { ratioId = policy.fixedRatioId; source = 'fixed'; }
  else if (requested && policy.allowedRatioIds.includes(requested)) { ratioId = requested; source = 'director'; }
  else if (!policy.allowedRatioIds.includes(ratioId)) { ratioId = policy.allowedRatioIds[0]; source = 'allowed_fallback'; }
  const dimensions = storyboardProviderRatioDimensions(value.providerId, ratioId, value.width, value.height);
  return { ratioId, ratioLocked: shot.composition.ratioLocked, source, dimensions, rationale: shot.composition.rationale, policyVersion: policy.systemRuleVersion };
}

export function storyboardProviderRatioDimensions(providerId, ratioId, currentWidth, currentHeight) {
  const ratio = STORYBOARD_RATIOS.find((item) => item.id === ratioId);
  if (!ratio) return { width: numeric(currentWidth), height: numeric(currentHeight), size: '', aspectRatio: '' };
  if (providerId === 'openai') {
    const size = ratio.value > 1.08 ? '1536x1024' : ratio.value < 0.92 ? '1024x1536' : '1024x1024';
    const [width, height] = size.split('x').map(Number);
    return { width, height, size, aspectRatio: ratioId };
  }
  const { width, height } = storyboardRatioDimensions(ratioId, currentWidth, currentHeight);
  return { width, height, size: '', aspectRatio: ratioId };
}

const promptPart = (value) => shotStringList(value, 80, 1000).join(', ');
const characterPrompt = (character) => [character.name, ...character.identity, ...character.outfit, ...character.temporaryState, ...character.expression, ...character.pose, ...character.action, ...character.gaze, ...character.props, character.spatial.region, character.spatial.crop].filter(Boolean).join(', ');

export function validateStoryboardShotSpec(value = {}, options = {}) {
  const shot = normalizeStoryboardShotSpec(value), errors = [], warnings = [];
  const centers = new Set(), traitOwners = new Map();
  for (const character of shot.characters) {
    const center = character.spatial.center.map((item) => item.toFixed(2)).join(':');
    if (centers.has(center)) errors.push(`角色 ${character.name || character.id} 与其他角色占用了同一空间中心`);
    centers.add(center);
    for (const trait of [...character.identity, ...character.outfit, ...character.props]) {
      const key = trait.toLowerCase();
      if (key.length < 3) continue;
      if (!traitOwners.has(key)) traitOwners.set(key, []);
      traitOwners.get(key).push(character.name || character.id);
    }
  }
  for (const [trait, owners] of traitOwners) if (new Set(owners).size > 1) warnings.push(`角色专属特征未保持唯一：${trait}（${[...new Set(owners)].join('、')}）`);
  const publicText = shot.promptAtoms.global.join(' ').toLowerCase();
  for (const character of shot.characters) {
    for (const trait of [...character.identity, ...character.outfit, ...character.action, ...character.props]) {
      if (trait.length >= 3 && publicText.includes(trait.toLowerCase())) warnings.push(`公共层包含角色专属内容：${trait}`);
    }
    for (const action of character.action) {
      const foreignNames = shot.characters.filter((item) => item.id !== character.id && item.name).map((item) => item.name).filter((name) => action.toLowerCase().includes(name.toLowerCase()));
      if (foreignNames.length && !action.toLowerCase().includes((character.name || character.id).toLowerCase())) warnings.push(`动作主语可能错绑：${character.name || character.id} 的动作提及 ${foreignNames.join('、')}`);
    }
  }
  const capabilities = getStoryboardCapabilities(options.providerId, options.modelId);
  if (shot.characters.length > 1 && !capabilities.multiCharacter) warnings.push('当前渠道不支持原生角色分区，将使用命名角色块降级编译');
  return { valid: errors.length === 0, shot, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function compileStoryboardPrompt(input = {}) {
  const modelBinding = resolveStoryboardModelBinding(input.providerId, {
    ...resolveStoryboardConnectionBinding(input.providerId, input.connection || {}),
    model: input.modelId,
    capabilityModelId: input.capabilityModelId,
    ...(Object.hasOwn(input, 'remoteModelId') ? { remoteModelId: input.remoteModelId } : {}),
  });
  const shotInput = input.productionPacket ? adaptProductionPacketToStoryboardShotSpec(input.productionPacket, input.shotOverrides) : input.shot;
  const validation = validateStoryboardShotSpec(shotInput, { providerId: input.providerId, modelId: modelBinding.capabilityModelId });
  const capability = getStoryboardCapabilities(input.providerId, modelBinding.capabilityModelId, input.workflow, input.connection);
  const shot = validation.shot, common = [
    capability.supportsArtistSyntax ? str(input.artistString, 6000) : '',
    capability.supportsArtistSyntax ? str(input.artistPositive, 12000) : '', str(input.modelPositive, 12000),
    promptPart(shot.promptAtoms.global), shot.scene,
    promptPart(shot.promptAtoms.camera), shot.shotScale, promptPart(shot.composition.framing),
    capability.ratio ? shot.composition.ratioId : '', shot.composition.negativeSpace, promptPart(shot.sharedRelations),
  ].filter(Boolean).join(', ');
  const characterBlocks = shot.characters.map(characterPrompt).filter(Boolean);
  const environment = promptPart(shot.promptAtoms.environment), quality = promptPart(shot.promptAtoms.quality);
  const useNativeCharacters = input.providerId === 'novel' && capability.multiCharacter && characterBlocks.length > 0;
  const prompt = [common, ...(useNativeCharacters ? [] : characterBlocks), environment, quality].filter(Boolean).join(', ');
  const antiMix = shot.characters.length > 1 ? 'mixed identities, merged bodies, swapped character traits, swapped character actions' : '';
  const negative = capability.supportsNativeNegative || capability.supportsExclusionText
    ? [capability.supportsArtistSyntax ? str(input.artistNegative, 12000) : '', str(input.modelNegative, 12000), promptPart(shot.promptAtoms.negative), antiMix].filter(Boolean).join(', ') : '';
  const providerOptions = {};
  if (useNativeCharacters) {
    providerOptions.v4_prompt = {
      caption: {
        base_caption: [common, environment, quality].filter(Boolean).join(', '),
        char_captions: shot.characters.map((character) => ({ char_caption: characterPrompt(character), centers: [{ x: character.spatial.center[0], y: character.spatial.center[1] }] })),
      },
      use_coords: true,
      use_order: true,
    };
    providerOptions.v4_negative_prompt = { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false };
  }
  return {
    prompt, negative, providerOptions, characterBlocks, validation, modelBinding,
    productionContext: shot.productionContext,
    degradation: shot.characters.length > 1 && !useNativeCharacters ? { mode: 'named_character_blocks', reason: capability.multiCharacter ? 'provider_adapter_unavailable' : 'capability_unavailable' } : null,
  };
}

// Native NAI captions are the actual request text, not a second copy of the editor.
// Updating only payload.prompt leaves old artist/negative text active on redraw.
export function synchronizeStoryboardCaptionBase(payload) {
  const options = payload?.parameters?.providerOptions;
  for (const [key, field] of [['v4_prompt', 'prompt'], ['v4_negative_prompt', 'negative']]) {
    const caption = options?.[key]?.caption;
    if (obj(caption) && typeof payload[field] === 'string') caption.base_caption = payload[field];
  }
  return payload;
}

export function prepareStoryboardShotGroup(value = {}) {
  const policy = normalizeStoryboardCompositionPolicy(value.policy), manual = Boolean(value.manual);
  const source = (Array.isArray(value.shots) ? value.shots : []).map(normalizeStoryboardShotSpec);
  const kept = [], skipped = [], seen = new Set(), limit = int(value.maxShots, 1, 12, 4);
  let continuityLedger = normalizeContinuity(value.continuityLedger);
  const alternateRatio = (shot) => {
    if (continuityLedger.emphasisRatioId && policy.allowedRatioIds.includes(continuityLedger.emphasisRatioId)) return continuityLedger.emphasisRatioId;
    const portraitPreferred = ['reaction', 'detail'].includes(shot.shotRole);
    const candidates = policy.allowedRatioIds.filter((id) => id !== policy.preferredRatioId);
    return candidates.find((id) => portraitPreferred ? STORYBOARD_RATIOS.find((ratio) => ratio.id === id)?.value < 1 : STORYBOARD_RATIOS.find((ratio) => ratio.id === id)?.value > 1) || candidates[0] || policy.preferredRatioId;
  };
  const mergeContinuity = (update) => {
    const next = normalizeContinuity(update);
    continuityLedger = {
      ...continuityLedger,
      ...Object.fromEntries(['axis', 'leftRight', 'gaze', 'time', 'weather', 'light', 'color', 'mainRatioId', 'emphasisRatioId'].map((key) => [key, next[key] || continuityLedger[key]])),
      outfit: { ...continuityLedger.outfit, ...next.outfit }, injuries: { ...continuityLedger.injuries, ...next.injuries },
      props: { ...continuityLedger.props, ...next.props }, actionState: { ...continuityLedger.actionState, ...next.actionState },
      facts: mergeContinuityFacts(continuityLedger.facts, next.facts),
    };
  };
  for (const shot of source) {
    const grounding = validateStoryboardShotGrounding(shot, { strict: true });
    if (!manual && !grounding.valid) {
      skipped.push({ shot, reason: 'ungrounded_shot', issues: grounding.errors, requiresReplan: true });
      continue;
    }
    const signature = [shot.sceneFingerprint.id, shot.shotRole, shot.shotScale, shot.subject.toLowerCase(), shot.narrativePurpose.toLowerCase(), shot.composition.cameraSide, shot.composition.angle, shot.composition.focus, shot.composition.framing.join('|')].join('|');
    if (!manual && seen.has(signature)) { skipped.push({ shot, reason: 'duplicate_coverage' }); continue; }
    if (!manual && kept.length >= limit) { skipped.push({ shot, reason: 'coverage_budget' }); continue; }
    // A shared frame fixes composition, never the number of narrative shots.
    const difference = kept.length ? storyboardShotDifference(kept[kept.length - 1], shot) : null;
    if (!manual && difference && !difference.acceptable) {
      skipped.push({ shot, reason: 'difference_budget', issues: difference.issues, requiresReplan: true });
      continue;
    }
    continuityLedger.facts = expireMomentaryContinuityFacts(continuityLedger.facts);
    const order = kept.length;
    if (!shot.composition.ratioId) {
      shot.composition.ratioId = policy.groupStrategy === 'main_secondary' && order > 0 ? alternateRatio(shot) : (continuityLedger.mainRatioId || policy.preferredRatioId);
      shot.composition.rationale ||= order === 0 ? '镜组主画幅' : policy.groupStrategy === 'main_secondary' ? '镜组强调画幅' : '镜组画幅连续性';
    }
    if (order === 0 && !continuityLedger.mainRatioId) continuityLedger.mainRatioId = shot.composition.ratioId;
    if (order > 0 && policy.groupStrategy === 'main_secondary' && !continuityLedger.emphasisRatioId) continuityLedger.emphasisRatioId = shot.composition.ratioId;
    seen.add(signature); kept.push(shot); mergeContinuity(shot.continuityUpdates);
  }
  const coverageMap = buildStoryboardSceneCoverageMap(kept);
  const sceneGroups = [];
  for (const entry of coverageMap) {
    const active = sceneGroups[sceneGroups.length - 1];
    if (!active || active.id !== entry.sceneGroupId) sceneGroups.push({ id: entry.sceneGroupId, sceneFingerprint: entry.sceneFingerprint, shotIds: [entry.shotId] });
    else active.shotIds.push(entry.shotId);
  }
  return { shots: kept, skipped, strategy: policy.groupStrategy, manualOverride: manual, continuityLedger, coverageMap, sceneGroups, rhythm: evaluateStoryboardShotRhythm(kept) };
}

function normalizeRouting(value) {
  const r = obj(value) ? value : {};
  const target = (input = {}, fallbackProviderId = 'novel') => {
    input = obj(input) ? input : {};
    const providerId = getStoryboardProvider(input.providerId) ? input.providerId : fallbackProviderId;
    if (!providerId) return { providerId: '', modelId: '', connectionPresetId: '', parameterPresetId: '' };
    // Keep broken references repairable. Clearing them would silently use today's draft connection/parameters.
    const connectionPresetId = cleanId(input.connectionPresetId), parameterPresetId = cleanId(input.parameterPresetId);
    try {
      const binding = resolveStoryboardProfileBinding(providerId, { model: input.modelId, capabilityModelId: input.capabilityModelId });
      return { providerId, modelId: binding.remoteModelId, capabilityModelId: binding.capabilityModelId, connectionPresetId, parameterPresetId };
    } catch {
      const safeId = (value, fallback) => typeof value === 'string' && value.trim().length <= 240 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : fallback;
      const modelId = safeId(input.modelId, '') || '[invalid-model]';
      return { providerId, modelId,
        capabilityModelId: modelId === '[invalid-model]' ? '[invalid-capability]' : input.capabilityModelId == null || input.capabilityModelId === '' ? '' : safeId(input.capabilityModelId, '[invalid-capability]') || '[invalid-capability]',
        connectionPresetId, parameterPresetId };
    }
  };
  const rules = dedupeById((Array.isArray(r.rules) ? r.rules : []).filter(obj).map((rule) => ({ id: cleanId(rule.id), name: str(rule.name || '未命名分工', 80), shotTypes: uniqueStrings(rule.shotTypes, 30, 60), target: target(rule.target, ''), enabled: rule.enabled !== false, priority: int(rule.priority, -1000, 1000, 0) })).filter((rule) => rule.id && rule.target.providerId)).slice(0, 50).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const enabled = r.enabled === undefined ? r.mode === 'ensemble' : Boolean(r.enabled);
  const templateId = STORYBOARD_SHOT_GROUP_TEMPLATES[r.templateId] ? r.templateId : 'smart';
  const frameStrategy = STORYBOARD_GROUP_FRAME_STRATEGIES.includes(r.frameStrategy) ? r.frameStrategy : 'main_secondary';
  return { enabled, mode: enabled ? 'ensemble' : 'single', templateId, frameStrategy, single: target(r.single), rules, confirmMultipleRequests: r.confirmMultipleRequests !== false };
}

export function normalizeStoryboardAutomation(value) {
  const raw = obj(value) ? value : {};
  const autoCapture = raw.autoCapture === undefined ? true : Boolean(raw.autoCapture);
  const autoGenerate = raw.autoGenerate === undefined ? true : Boolean(raw.autoGenerate);
  return { autoCapture, autoGenerate: autoCapture && autoGenerate };
}

function workflowState(value, fallback = 'idle') {
  const aliases = { draft: 'idle', ready: 'prompt_ready', running: 'generating', success: 'completed', complete: 'completed', partial: 'completed' };
  const normalized = aliases[value] || value;
  return STORYBOARD_WORKFLOW_STATES.includes(normalized) ? normalized : fallback;
}

const STORYBOARD_TASK_STAGES = Object.freeze([
  'screening', 'compiler', 'queue', 'provider', 'persistence', 'delivery_pending', 'attachment', 'complete', 'failed', 'cancelled',
]);
const STORYBOARD_TASK_DELIVERY_STATES = Object.freeze(['none', 'pending_chat', 'delivered', 'gallery_fallback', 'volatile_pending']);

function taskStage(value, statusValue = 'idle') {
  const stage = str(value, 40);
  if (STORYBOARD_TASK_STAGES.includes(stage)) return stage;
  if (statusValue === 'screening') return 'screening';
  if (['compiling', 'prompt_ready'].includes(statusValue)) return 'compiler';
  if (statusValue === 'queued') return 'queue';
  if (statusValue === 'generating') return 'provider';
  if (statusValue === 'completed') return 'complete';
  if (statusValue === 'failed') return 'failed';
  if (statusValue === 'cancelled') return 'cancelled';
  return 'queue';
}

function taskProgress(value, statusValue = 'idle', stage = '') {
  const defaults = {
    idle: 0, screening: 0.05, compiling: 0.12, prompt_ready: 0.18, queued: 0.2,
    generating: stage === 'persistence' ? 0.8 : (stage === 'attachment' ? 0.92 : 0.35),
    completed: 1, skipped: 1, failed: 1, cancelled: 1, stale: 1, orphaned: 1,
  };
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : defaults[statusValue] ?? 0;
}

export function normalizeStoryboardTaskState(value) {
  const raw = obj(value) ? value : {};
  const statusValue = workflowState(raw.status, 'queued');
  const stage = taskStage(raw.stage, statusValue);
  const hasFloor = raw.floor !== null && raw.floor !== undefined && raw.floor !== '';
  const floor = hasFloor && Number.isInteger(Number(raw.floor)) && Number(raw.floor) >= 0 ? Number(raw.floor) : null;
  return {
    id: cleanId(raw.id), planId: cleanId(raw.planId), shotId: cleanId(raw.shotId), logId: cleanId(raw.logId),
    chatKey: str(raw.chatKey || raw.messageRef?.chatKey, 512), floor,
    messageRef: raw.messageRef ? normalizeStoryboardMessageReference(raw.messageRef) : null,
    paragraphAnchor: raw.paragraphAnchor ? normalizeStoryboardParagraphAnchor(raw.paragraphAnchor) : null,
    paragraphSelection: raw.paragraphSelection ? normalizeStoryboardParagraphSelection(raw.paragraphSelection) : null,
    status: statusValue, stage, progress: taskProgress(raw.progress, statusValue, stage),
    deliveryState: STORYBOARD_TASK_DELIVERY_STATES.includes(raw.deliveryState) ? raw.deliveryState : 'none',
    linkState: STORYBOARD_MESSAGE_LINK_STATES.includes(raw.linkState) ? raw.linkState : '',
    resultIds: ids(raw.resultIds, 20), error: str(raw.error, 4000), uiVisible: Boolean(raw.uiVisible),
    requestedAt: pos(raw.requestedAt || raw.createdAt), startedAt: pos(raw.startedAt), finishedAt: pos(raw.finishedAt), updatedAt: pos(raw.updatedAt || raw.finishedAt || raw.startedAt || raw.requestedAt || raw.createdAt),
  };
}

export function createStoryboardTaskState(input = {}) {
  const now = pos(input.now) || Date.now();
  return normalizeStoryboardTaskState({
    ...input, status: input.status || 'queued', requestedAt: input.requestedAt || now,
    updatedAt: input.updatedAt || now,
  });
}

export function transitionStoryboardTaskState(value, nextStatus, details = {}) {
  const current = normalizeStoryboardTaskState(value);
  const now = pos(details.now) || Date.now();
  const statusValue = workflowState(nextStatus, current.status || 'queued');
  const terminal = ['completed', 'skipped', 'failed', 'cancelled', 'stale', 'orphaned'].includes(statusValue);
  return normalizeStoryboardTaskState({
    ...current, ...details, id: current.id || cleanId(details.id), status: statusValue,
    stage: details.stage || taskStage('', statusValue),
    progress: details.progress ?? taskProgress(undefined, statusValue, details.stage || ''),
    error: Object.hasOwn(details, 'error') ? details.error : (['queued', 'generating', 'completed'].includes(statusValue) ? '' : current.error),
    resultIds: Array.isArray(details.resultIds) ? details.resultIds : current.resultIds,
    startedAt: current.startedAt || (statusValue === 'generating' ? now : 0),
    finishedAt: terminal ? (current.finishedAt || now) : 0,
    updatedAt: now,
  });
}

function taskStates(value) {
  return dedupeById((Array.isArray(value) ? value : [])
    .filter(obj).map(normalizeStoryboardTaskState).filter((task) => task.id))
    .sort((left, right) => Number(right.updatedAt || right.requestedAt) - Number(left.updatedAt || left.requestedAt))
    .slice(0, 300);
}

function shotPlans(value, state = {}) {
  const normalized = (Array.isArray(value) ? value : []).filter(obj).map((plan) => {
    const archiveRef = str(plan.archiveRef, 900);
    const archivedSummary = Boolean(archiveRef);
    const shots = dedupeById((Array.isArray(plan.shots) ? plan.shots : []).filter(obj).map((shot) => {
      const providerId = getStoryboardProvider(shot.providerId) ? shot.providerId : '';
      const requestedConnection = cleanId(shot.connectionPresetId), requestedParameters = cleanId(shot.parameterPresetId);
      const connectionPresetId = providerId && state.connections?.[providerId]?.presets?.some((preset) => preset.id === requestedConnection) ? requestedConnection : '';
      const parameterPresetId = providerId && state.parameterPresets?.some((preset) => preset.id === requestedParameters && preset.source === providerId) ? requestedParameters : '';
      const shotSpec = !archivedSummary || obj(shot.shotSpec) ? normalizeStoryboardShotSpec(shot.shotSpec || shot) : null;
      const hasPrompt = Boolean(shot.hasPrompt || str(shot.prompt, 24000).trim() || str(shot.safePrompt, 24000).trim());
      return {
        id: cleanId(shot.id), shotType: str(shot.shotType || shotSpec?.shotScale || 'custom', 60), role: str(shot.role || shotSpec?.shotRole, 60),
        title: str(shot.title, 120), purpose: str(shot.purpose || shotSpec?.narrativePurpose, 500), prompt: str(shot.prompt, 24000), safePrompt: str(shot.safePrompt, 24000), negative: str(shot.negative, 12000), hasPrompt,
        providerId, connectionPresetId, parameterPresetId, routeRuleId: cleanId(shot.routeRuleId), status: workflowState(shot.status), resultIds: ids(shot.resultIds, 20),
        error: str(shot.error, 4000), partialFailureCount: int(shot.partialFailureCount, 0, 20, 0), attempt: int(shot.attempt, 0, 20, 0),
        paragraphAnchor: shot.paragraphAnchor ? normalizeStoryboardParagraphAnchor(shot.paragraphAnchor) : null,
        paragraphSelection: shot.paragraphSelection ? normalizeStoryboardParagraphSelection(shot.paragraphSelection) : null,
        shotSpec, compiledPrompt: safeData(shot.compiledPrompt, 10) || null, compositionDecision: safeData(shot.compositionDecision, 6) || null,
        sensitive: Boolean(shot.sensitive || shotSpec?.sensitive), safetyAdapted: Boolean(shot.safetyAdapted), userEdited: Boolean(shot.userEdited),
        promptLocked: Boolean(shot.promptLocked || shot.userEdited), requiresManualConfirmation: Boolean(shot.requiresManualConfirmation),
      };
    }).filter((shot) => shot.id)).slice(0, 20);
    const messageRef = plan.messageRef ? normalizeStoryboardMessageReference(plan.messageRef) : null;
    const continuityInput = obj(plan.continuityLedger) ? plan.continuityLedger : null;
    return {
      id: cleanId(plan.id), chatKey: str(plan.chatKey || messageRef?.chatKey, 512),
      floor: Number.isInteger(plan.floor) ? plan.floor : (Number.isInteger(messageRef?.lastKnownFloor) ? messageRef.lastKnownFloor : null),
      swipeId: int(plan.swipeId ?? messageRef?.swipeId, 0, Number.MAX_SAFE_INTEGER, 0), messageRef,
      revisionId: str(plan.revisionId || messageRef?.revisionId, 80), idempotencyKey: str(plan.idempotencyKey, 80),
      origin: ['manual', 'automatic', 'manual_supplement'].includes(plan.origin) ? plan.origin : 'manual',
      paragraphSelection: plan.paragraphSelection ? normalizeStoryboardParagraphSelection(plan.paragraphSelection) : null,
      continuityLedger: archivedSummary && !continuityInput ? null : normalizeContinuity(continuityInput),
      hasContinuityLedger: Boolean(plan.hasContinuityLedger || continuityInput),
      autoGenerate: Boolean(plan.autoGenerate), promptLocked: Boolean(plan.promptLocked),
      manualReviewRequired: Boolean(plan.manualReviewRequired || shots.some((shot) => shot.requiresManualConfirmation)),
      status: workflowState(plan.status), linkState: str(plan.linkState, 40), shots,
      archiveRef, archiveVersion: archiveRef ? int(plan.archiveVersion, 1, 100, 1) : 0, archivedAt: archiveRef ? pos(plan.archivedAt) : 0,
      createdAt: pos(plan.createdAt || plan.updatedAt), updatedAt: pos(plan.updatedAt),
    };
  }).filter((plan) => plan.id);
  return dedupeById(normalized).slice(0, 300);
}

function pipelineLogs(value) { return pruneStoryboardPipelineLogs(value); }

export function pruneStoryboardPipelineLogs(value, options = {}) {
  const limit = int(options.limit, 1, 2000, STORYBOARD_PIPELINE_LOG_LIMIT);
  const normalized = dedupeById((Array.isArray(value) ? value : []).filter(obj).map(normalizePipelineLog).filter((log) => log.id));
  return normalized.map((log, index) => ({ log, index, active: ['queued', 'running'].includes(log.status), activityAt: log.finishedAt || log.startedAt })).sort((a, b) => Number(b.active) - Number(a.active) || b.activityAt - a.activityAt || a.index - b.index).slice(0, limit).map(({ log }) => log);
}

function normalizePipelineLog(log) {
  const stages = dedupeById((Array.isArray(log.stages) ? log.stages : []).filter(obj).map((stage) => ({ id: cleanId(stage.id), type: str(stage.type, 80), status: status(stage.status), startedAt: pos(stage.startedAt), finishedAt: pos(stage.finishedAt), input: redact(stage.input, 0, STORYBOARD_DIAGNOSTIC_TEXT_LIMIT, 16), output: redact(stage.output, 0, STORYBOARD_DIAGNOSTIC_TEXT_LIMIT, 16), decisions: uniqueStrings(stage.decisions, 100, 1000), error: redactString(stage.error).slice(0, 4000) })).filter((stage) => stage.id)).slice(0, 30);
  return { id: cleanId(log.id), taskId: cleanId(log.taskId || log.id), status: status(log.status), providerId: getStoryboardProvider(log.providerId) ? log.providerId : '', model: str(log.model, 240), startedAt: pos(log.startedAt), finishedAt: pos(log.finishedAt), durationMs: pos(log.durationMs), stages, migrated: Boolean(log.migrated) };
}
function legacyPipelineLogs(value) {
  const migrated = (Array.isArray(value) ? value : []).filter(obj).map((log) => ({ id: cleanId(log.id), taskId: cleanId(log.id), status: status(log.status), providerId: getStoryboardProvider(log.source) ? log.source : 'novel', model: str(log.model, 240), startedAt: pos(log.startedAt || log.queuedAt), finishedAt: pos(log.finishedAt), durationMs: pos(log.durationMs), stages: [{ id: 'legacy-generation', type: 'generation', status: status(log.status), startedAt: pos(log.startedAt || log.queuedAt), finishedAt: pos(log.finishedAt), input: { prompt: str(log.effectivePrompt || log.prompt, 24000), negative: str(log.effectiveNegative || log.negative, 12000) }, output: { ...(log.recordId ? { recordId: cleanId(log.recordId) } : {}), ...(ids(log.recordIds, 20).length ? { recordIds: ids(log.recordIds, 20) } : {}) }, error: redactString(log.error).slice(0, 4000) }], migrated: true })).filter((log) => log.id);
  return pruneStoryboardPipelineLogs(migrated);
}

export function buildStoryboardProviderPlan(input = {}) {
  const provider = getStoryboardProvider(input.providerId); if (!provider) throw new Error('请选择有效的生图模型');
  const connectionBinding = resolveStoryboardConnectionBinding(provider.id, input.connection || {});
  if (input.modelFamily !== undefined && input.modelFamily !== '' && input.modelFamily !== provider.id) {
    const error = new Error('模型系列与连接不匹配'); error.code = 'model_family_mismatch'; throw error;
  }
  if (input.protocol !== undefined || input.imageProtocolVersion !== undefined) {
    const declared = resolveStoryboardConnectionBinding(provider.id, input);
    if (declared.protocol !== connectionBinding.protocol) { const error = new Error('计划接口与连接声明不一致'); error.code = 'connection_protocol_mismatch'; throw error; }
  }
  const conn = normalizeStoryboardConnectionProfile(input.connection || {}, provider.id);
  const binding = resolveStoryboardModelBinding(provider.id, { ...input, ...connectionBinding, model: input.model || input.capabilityModelId || conn.model || provider.defaultModel, connectionPresetId: conn.id });
  const modelId = binding.remoteModelId, capability = getStoryboardCapabilities(provider.id, binding.capabilityModelId, provider.id === 'comfy' ? (input.params?.workflow || '') : undefined, conn), prompt = str(input.prompt, 24000);
  if (!prompt) throw new Error('提示词不能为空');
  const p = obj(input.params) ? input.params : {}, request = { prompt }, dropped = [];
  const own = (...keys) => { for (const key of keys) if (Object.hasOwn(p, key)) return p[key]; return undefined; };
  const providerValue = (providerId, key, value) => { if (value === '' || value == null) return; if (provider.id === providerId) request[key] = value; else dropped.push(key); };
  const providerFlag = (providerId, key, value) => { if (value === undefined) return; if (provider.id === providerId) request[key] = flag(value); else if (flag(value)) dropped.push(key); };
  const negative = str(input.negative ?? p.negative, 12000);
  if (negative) {
    if (capability.supportsNativeNegative || capability.supportsExclusionText) request.negative = negative;
    else dropped.push('negative');
  }
  accept(request, dropped, capability, 'seed', bounded(p.seed, -1, Number.MAX_SAFE_INTEGER, true)); accept(request, dropped, capability, 'steps', bounded(p.steps, 1, 300, true)); accept(request, dropped, capability, 'cfg', bounded(p.cfg ?? p.scale, 0, 100));
  const requestedSampler = str(p.sampler, 120), requestedScheduler = str(p.scheduler, 120);
  if (provider.id === 'novel') {
    const spec = getStoryboardNovelParameterSpec(binding.capabilityModelId);
    if (requestedSampler && spec.samplers.some((item) => item.value === requestedSampler)) request.sampler = requestedSampler;
    else if (requestedSampler) dropped.push('sampler');
    if (requestedScheduler && capability.scheduler && spec.schedulers.some((item) => item.value === requestedScheduler)) request.scheduler = requestedScheduler;
    else if (requestedScheduler) dropped.push('scheduler');
  } else {
    accept(request, dropped, capability, 'sampler', requestedSampler);
    accept(request, dropped, capability, 'scheduler', requestedScheduler);
  }
  const width = bounded(p.width, 64, 8192, true), height = bounded(p.height, 64, 8192, true);
  accept(request, dropped, capability, provider.id === 'comfy' ? 'width' : 'size', width === '' ? '' : width, 'width'); accept(request, dropped, capability, provider.id === 'comfy' ? 'height' : 'size', height === '' ? '' : height, 'height');
  const requestedRatio = p.ratio || p.aspectRatio;
  if (requestedRatio) {
    const ratio = STORYBOARD_RATIOS.some((item) => item.id === requestedRatio && item.id) ? requestedRatio : '';
    if (!ratio || !capability.ratio) dropped.push('ratio'); else request.ratio = ratio;
  }
  const allReferences = Array.isArray(input.references) ? input.references.filter(obj).map(reference).filter((item) => item.type !== 'none') : [], referenceSupported = capability.reference || capability.preciseReference;
  const referenceLimit = capability.multipleReferences ? 16 : 1, references = allReferences.slice(0, referenceLimit);
  if (binding.imageProtocolVersion && allReferences.length > referenceLimit) {
    const error = new Error('当前兼容接口的参考图数量不匹配'); error.code = 'image_protocol_references'; throw error;
  }
  if (allReferences.length > referenceLimit && referenceSupported) dropped.push('extraReferences');
  if (allReferences.length && !referenceSupported) dropped.push('references');
  request.references = referenceSupported ? references : [];
  const allVibes = Array.isArray(input.vibes) ? input.vibes.filter(obj).map((vibe) => ({ id: cleanId(vibe.id), assetId: cleanId(vibe.assetId), strength: num(vibe.strength, 0, 1, 0.6), informationExtracted: num(vibe.informationExtracted ?? vibe.information, 0, 1, 1) })).filter((vibe) => vibe.id || vibe.assetId) : [];
  if (allVibes.length && !capability.vibe) dropped.push('vibes');
  request.vibes = capability.vibe ? allVibes.slice(0, 16) : [];
  request.providerOptions = safeRecord(p.providerOptions, { reserved: true });
  const count = bounded(p.count, 1, 4, true);
  if (provider.id === 'comfy' && !capability.count) { request.count = 1; if (Number(count) > 1) dropped.push('count'); }
  else if (count !== '') request.count = count;
  const explicitSize = str(p.size, 40); if (explicitSize) request.size = explicitSize;
  providerValue('banana', 'imageSize', str(p.imageSize, 20));
  providerValue('openai', 'quality', str(own('quality', 'openaiQuality'), 40));
  providerValue('openai', 'background', str(own('background', 'openaiBackground'), 40));
  providerValue('openai', 'outputFormat', str(own('outputFormat', 'openaiOutputFormat'), 20).toLowerCase());
  providerValue('seedream', 'guidanceScale', bounded(own('guidanceScale', 'seedreamGuidanceScale'), 0, 20));
  providerFlag('seedream', 'sequential', own('sequential', 'seedreamSequential'));
  providerFlag('seedream', 'watermark', own('watermark'));
  const novelOptions = [
    ['cfg_rescale', 'cfgRescale', own('cfg_rescale', 'cfgRescale', 'novelCfgRescale'), 'number'],
    ['sm', 'sm', own('sm', 'novelSm'), 'flag'],
    ['sm_dyn', 'smDyn', own('sm_dyn', 'smDyn', 'novelSmDyn'), 'flag'],
    ['dynamic_thresholding', 'decrisper', own('dynamic_thresholding', 'decrisper', 'novelDecrisper'), 'flag'],
    ['variety_boost', 'varietyBoost', own('variety_boost', 'varietyBoost', 'novelVarietyBoost'), 'flag'],
  ];
  if (provider.id === 'novel') {
    const controlledNovelKeys = new Set(novelOptions.map(([key]) => key));
    for (const key of controlledNovelKeys) delete request.providerOptions[key];
    for (const [key, capabilityKey, value, kind] of novelOptions) {
      if (value === undefined || value === '') continue;
      if (!capability[capabilityKey]) {
        if (kind !== 'flag' || flag(value)) dropped.push(key);
        continue;
      }
      request.providerOptions[key] = kind === 'number' ? bounded(value, 0, 1) : flag(value);
    }
  } else {
    for (const [key, , value, kind] of novelOptions) {
      if ((kind === 'flag' && flag(value)) || (kind === 'number' && value !== undefined && value !== '')) dropped.push(key);
    }
  }
  if (p.workflow !== undefined) { if (capability.workflow && obj(p.workflow)) request.workflow = safeData(p.workflow, 12); else dropped.push('workflow'); }
  if (input.mask !== undefined) { if (capability.mask) request.mask = reference(input.mask); else dropped.push('mask'); }
  const gatewayParameters = {
    width: request.width, height: request.height, size: request.size, aspectRatio: request.ratio, imageSize: request.imageSize,
    quality: request.quality, background: request.background, outputFormat: request.outputFormat, count: request.count,
    seed: request.seed, steps: request.steps, cfg: request.cfg, sampler: request.sampler, scheduler: request.scheduler,
    guidanceScale: request.guidanceScale, sequential: request.sequential, watermark: request.watermark,
    workflow: request.workflow, providerOptions: request.providerOptions,
  };
  for (const key of Object.keys(gatewayParameters)) if (gatewayParameters[key] === undefined || gatewayParameters[key] === '') delete gatewayParameters[key];
  const projected = projectStoryboardProtocolParameters(provider.id, { ...p, ...gatewayParameters }, conn);
  if (binding.imageProtocolVersion) {
    for (const [key, value] of Object.entries(gatewayParameters)) if (value !== '' && value != null && !Object.hasOwn(projected, key)) dropped.push(key);
  }
  const gatewayRequest = { provider: provider.id, ...connectionBinding, baseUrl: conn.baseUrl, model: modelId, capabilityModelId: binding.capabilityModelId, prompt, negativePrompt: request.negative || '', references: request.references, vibes: request.vibes,
    parameters: binding.imageProtocolVersion ? projected : gatewayParameters,
    ...(binding.imageProtocolVersion ? { compatibility: clone(conn.compatibility), customHeaders: clone(conn.headers) } : {}) };
  return { version: 1, providerId: provider.id, ...binding, baseUrl: conn.baseUrl, credentialId: conn.credentialId, model: modelId, capabilities: capability, request, gatewayRequest, droppedParameters: [...new Set(dropped)] };
}

export function resolveStoryboardVisualState(facts) {
  const rank = new Map(STORYBOARD_STATE_PRECEDENCE.map((source, index) => [source, index]));
  const ordered = (Array.isArray(facts) ? facts : []).filter(obj).map((fact, index) => ({ key: str(fact.key, 120), value: fact.value, source: rank.has(fact.source) ? fact.source : 'global', evidence: str(fact.evidence, 1000), index })).filter((fact) => fact.key).sort((a, b) => rank.get(a.source) - rank.get(b.source) || b.index - a.index), accepted = new Map(), decisions = [];
  for (const fact of ordered) if (!accepted.has(fact.key)) { accepted.set(fact.key, fact); decisions.push({ key: fact.key, action: 'accepted', source: fact.source, value: fact.value, evidence: fact.evidence }); } else decisions.push({ key: fact.key, action: 'suppressed', source: fact.source, value: fact.value, winner: accepted.get(fact.key).source, evidence: fact.evidence });
  return { values: Object.fromEntries([...accepted].map(([key, fact]) => [key, fact.value])), sources: Object.fromEntries([...accepted].map(([key, fact]) => [key, fact.source])), decisions };
}

export function routeStoryboardShot(shot, routing) { const r = normalizeRouting(routing); if (!r.enabled) return { ...r.single, ruleId: '' }; const type = str(shot?.shotType || 'custom', 60), rule = r.rules.find((x) => x.enabled && (!x.shotTypes.length || x.shotTypes.includes(type))); return rule ? { ...rule.target, ruleId: rule.id } : { ...r.single, ruleId: '' }; }

export function summarizeStoryboardGenerationDemand(jobs) {
  const requests = (Array.isArray(jobs) ? jobs : []).filter(obj);
  const outputsByRequest = requests.map((job) => int(job.payload?.parameters?.count, 1, 4, 1));
  return {
    requestCount: requests.length,
    imageCount: outputsByRequest.reduce((total, count) => total + count, 0),
    hasMultiImageRequest: outputsByRequest.some((count) => count > 1),
  };
}

// NovelAI 对并发与单次多图更敏感。把“生成 N 张”在进入运行队列前拆成
// N 个可独立落盘、独立失败与独立重试的请求；其他渠道仍保留原生多图请求。
export function planStoryboardProviderRequests(providerId, requestedCount) {
  const imageCount = int(requestedCount, 1, 4, 1);
  const requestCount = providerId === 'novel' ? imageCount : 1;
  return Array.from({ length: requestCount }, (_, index) => ({
    requestIndex: index + 1,
    requestTotal: requestCount,
    imageCount: providerId === 'novel' ? 1 : imageCount,
  }));
}

export function aggregateStoryboardShotTasks(value, fallbackStatus = 'queued') {
  const tasks = (Array.isArray(value) ? value : []).filter(obj).map(normalizeStoryboardTaskState);
  const statuses = tasks.map((task) => task.status);
  let status = workflowState(fallbackStatus, 'queued');
  if (statuses.includes('generating')) status = 'generating';
  else if (statuses.includes('queued')) status = 'queued';
  else if (statuses.includes('compiling')) status = 'compiling';
  else if (statuses.includes('prompt_ready')) status = 'prompt_ready';
  else if (statuses.includes('completed')) status = 'completed';
  const resultIds = ids(tasks.flatMap((task) => task.resultIds || []), 20);
  const failedTasks = tasks.filter((task) => ['failed', 'cancelled', 'stale', 'orphaned'].includes(task.status));
  const matchingError = [...tasks].reverse().find((task) => task.status === status && task.error)?.error
    || [...failedTasks].reverse().find((task) => task.error)?.error
    || '';
  return {
    status,
    resultIds,
    error: str(matchingError, 4000),
    partialFailureCount: status === 'completed' ? failedTasks.length : 0,
  };
}

export function createStoryboardParagraphAnchor(input = {}) {
  const messageText = anchorText(input.messageText), paragraphText = anchorText(input.paragraphText), previousText = anchorText(input.previousText), nextText = anchorText(input.nextText);
  return normalizeStoryboardParagraphAnchor({ version: 1, chatKey: input.chatKey, floor: Number.isInteger(input.floor) ? input.floor : null, swipeId: Number.isInteger(input.swipeId) ? input.swipeId : 0, messageHash: messageText ? hash(messageText) : '', paragraphIndex: Number.isInteger(input.paragraphIndex) ? input.paragraphIndex : 0, paragraphHash: paragraphText ? hash(paragraphText) : '', paragraphText: paragraphText.slice(0, 1200), previousHash: previousText ? hash(previousText) : '', nextHash: nextText ? hash(nextText) : '', createdAt: pos(input.createdAt || Date.now()) });
}
export function scoreStoryboardParagraphAnchor(anchor, candidate, index, previousText = '', nextText = '') {
  const a = normalizeStoryboardParagraphAnchor(anchor), text = anchorText(candidate);
  if (!text || !a.paragraphText || !a.paragraphHash) return 0;
  let score = hash(text) === a.paragraphHash ? 70 : Math.round(similarity(a.paragraphText, text) * 55);
  if (Number.isInteger(index) && index === a.paragraphIndex) score += 15;
  if (a.previousHash && hash(anchorText(previousText)) === a.previousHash) score += 8;
  if (a.nextHash && hash(anchorText(nextText)) === a.nextHash) score += 7;
  return Math.min(100, score);
}
export function normalizeStoryboardParagraphAnchor(value) { const anchor = obj(value) ? value : {}; return { version: 1, chatKey: str(anchor.chatKey, 512), floor: Number.isInteger(anchor.floor) ? anchor.floor : null, swipeId: int(anchor.swipeId, 0, Number.MAX_SAFE_INTEGER, 0), messageHash: str(anchor.messageHash, 32), paragraphIndex: int(anchor.paragraphIndex, 0, Number.MAX_SAFE_INTEGER, 0), paragraphHash: str(anchor.paragraphHash, 32), paragraphText: str(anchor.paragraphText, 1200), previousHash: str(anchor.previousHash, 32), nextHash: str(anchor.nextHash, 32), createdAt: pos(anchor.createdAt) }; }

function messageRole(message) { return message?.is_system ? 'system' : message?.is_user ? 'user' : 'assistant'; }
function timestamp(value) { return value instanceof Date ? value.toISOString() : str(value, 160); }

/**
 * Build a non-invasive identity for a SillyTavern message. It deliberately does
 * not write an id into chat[].extra: the first swipe's timestamp/generation id
 * identifies the message family, while the active swipe + text hash identifies
 * one revision inside that family.
 */
export function createStoryboardMessageReference(input = {}) {
  const message = obj(input.message) ? input.message : input;
  const firstSwipeInfo = Array.isArray(message.swipe_info) && obj(message.swipe_info[0]) ? message.swipe_info[0] : {};
  const activeSwipe = int(message.swipe_id, 0, Number.MAX_SAFE_INTEGER, 0);
  const activeSwipeInfo = Array.isArray(message.swipe_info) && obj(message.swipe_info[activeSwipe]) ? message.swipe_info[activeSwipe] : {};
  const role = messageRole(message), name = str(message.name, 120);
  const baseSendDate = timestamp(firstSwipeInfo.send_date ?? message.send_date ?? message.gen_started);
  const baseGenerationId = str(firstSwipeInfo.extra?.gen_id ?? message.extra?.gen_id, 120);
  const activeSendDate = timestamp(activeSwipeInfo.send_date ?? message.send_date);
  const activeGenerationId = str(activeSwipeInfo.extra?.gen_id ?? message.extra?.gen_id, 120);
  const baseText = Array.isArray(message.swipes) && message.swipes.length ? String(message.swipes[0] || '') : String(message.mes || '');
  const revisionHash = hash(String(message.mes || ''));
  const fallbackIdentity = !baseSendDate && !baseGenerationId ? hash(baseText) : '';
  const messageKey = hash([role, name, baseSendDate, baseGenerationId, fallbackIdentity].join('\u241f'));
  const revisionId = hash([messageKey, activeSwipe, activeSendDate, activeGenerationId, revisionHash].join('\u241f'));
  const now = pos(input.now) || Date.now();
  return normalizeStoryboardMessageReference({
    version: 1, chatKey: input.chatKey, messageKey, role, name,
    baseSendDate, baseGenerationId, swipeId: activeSwipe, revisionHash, revisionId,
    lastKnownFloor: Number.isInteger(input.floor) ? input.floor : null,
    createdAt: input.createdAt || now, updatedAt: now,
  });
}

export function normalizeStoryboardMessageReference(value) {
  const ref = obj(value) ? value : {};
  return {
    version: 1, chatKey: str(ref.chatKey, 512), messageKey: str(ref.messageKey, 80),
    role: ['system', 'user', 'assistant'].includes(ref.role) ? ref.role : 'assistant', name: str(ref.name, 120),
    baseSendDate: timestamp(ref.baseSendDate), baseGenerationId: str(ref.baseGenerationId, 120),
    swipeId: int(ref.swipeId, 0, Number.MAX_SAFE_INTEGER, 0), revisionHash: str(ref.revisionHash, 32), revisionId: str(ref.revisionId, 80),
    lastKnownFloor: Number.isInteger(ref.lastKnownFloor) ? ref.lastKnownFloor : null,
    createdAt: pos(ref.createdAt), updatedAt: pos(ref.updatedAt),
  };
}

export function resolveStoryboardMessageReference(value, chat, options = {}) {
  const reference = normalizeStoryboardMessageReference(value);
  const currentChatKey = str(options.chatKey, 512);
  if (reference.chatKey && currentChatKey && reference.chatKey !== currentChatKey) {
    return { state: 'foreign', floor: null, message: null, reference, relocated: false };
  }
  const messages = Array.isArray(chat) ? chat : [];
  const candidates = [];
  messages.forEach((message, floor) => {
    if (!obj(message)) return;
    const current = createStoryboardMessageReference({ message, chatKey: currentChatKey || reference.chatKey, floor, now: reference.updatedAt || Date.now() });
    if (reference.messageKey && current.messageKey === reference.messageKey) candidates.push({ message, floor, current, strength: 3 });
    else if (reference.baseSendDate && current.baseSendDate === reference.baseSendDate && current.role === reference.role && current.name === reference.name) candidates.push({ message, floor, current, strength: 2 });
    else if (reference.revisionHash && current.revisionHash === reference.revisionHash && current.role === reference.role && current.name === reference.name) candidates.push({ message, floor, current, strength: 1 });
  });
  if (!candidates.length) return { state: 'orphaned', floor: null, message: null, reference, relocated: false };
  const origin = Number.isInteger(reference.lastKnownFloor) ? reference.lastKnownFloor : 0;
  candidates.sort((a, b) => b.strength - a.strength || Math.abs(a.floor - origin) - Math.abs(b.floor - origin));
  const match = candidates[0];
  let state = 'active';
  if (match.current.swipeId !== reference.swipeId) state = 'inactive_swipe';
  else if (reference.revisionHash && match.current.revisionHash !== reference.revisionHash) state = 'stale';
  return { state, floor: match.floor, message: match.message, current: match.current, reference, relocated: Number.isInteger(reference.lastKnownFloor) && reference.lastKnownFloor !== match.floor };
}

export function createStoryboardWorkflowTicket(input = {}) {
  const messageRef = normalizeStoryboardMessageReference(input.messageRef);
  const origin = ['automatic', 'manual_supplement'].includes(input.origin) ? input.origin : 'manual';
  const compilerSignature = str(input.compilerSignature, 240);
  const paragraphSelection = input.paragraphSelection ? normalizeStoryboardParagraphSelection(input.paragraphSelection) : null;
  return {
    id: cleanId(input.id) || `story-${messageRef.revisionId || hash(String(input.createdAt || Date.now()))}`,
    chatKey: str(input.chatKey || messageRef.chatKey, 512), floor: Number.isInteger(input.floor) ? input.floor : messageRef.lastKnownFloor,
    swipeId: messageRef.swipeId, messageRef, revisionId: messageRef.revisionId,
    idempotencyKey: hash([input.chatKey || messageRef.chatKey, messageRef.messageKey, messageRef.revisionId, compilerSignature, paragraphSelection?.paragraphIds?.join(',') || '', input.id || ''].join('\u241f')),
    origin, autoGenerate: origin === 'automatic' && Boolean(input.autoGenerate), promptLocked: Boolean(input.promptLocked),
    paragraphSelection, continuityLedger: normalizeContinuity(input.continuityLedger), status: workflowState(input.status), shots: Array.isArray(input.shots) ? input.shots : [],
    createdAt: pos(input.createdAt) || Date.now(), updatedAt: pos(input.updatedAt) || Date.now(),
  };
}

export function storyboardRatioDimensions(ratioId, currentWidth, currentHeight) { const ratio = STORYBOARD_RATIOS.find((x) => x.id === ratioId && x.value); if (!ratio) return { width: numeric(currentWidth), height: numeric(currentHeight) }; const w = Number(currentWidth), h = Number(currentHeight), area = Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? w * h : 1024 ** 2, rawH = Math.sqrt(area / ratio.value); return { width: clamp64(rawH * ratio.value), height: clamp64(rawH) }; }

// Kept for v1.44 migration/tests.
export function buildImagineCommand({ prompt, negative = '', width = '', height = '', steps = '', cfg = '', seed = '' }) { const clean = slash(prompt, 24000); if (!clean) throw new Error('画面描述不能为空'); const parts = ['/imagine', 'quiet=true', 'gallery=false']; if (String(negative || '').trim()) parts.push(`negative="${slash(negative, 12000)}"`); add(parts, 'width', width, 64, 4096, true); add(parts, 'height', height, 64, 4096, true); add(parts, 'steps', steps, 1, 300, true); add(parts, 'cfg', cfg, 0, 100, false); add(parts, 'seed', seed, -1, Number.MAX_SAFE_INTEGER, true); parts.push(`"${clean}"`); return parts.join(' '); }

export function normalizeStoryboardParameterProfile(value, providerId) {
  if (!getStoryboardProvider(providerId)) throw new Error('请选择有效的生图系列');
  const base = legacyProfile(), p = obj(value) ? value : {};
  for (const [key, fallback] of Object.entries(base)) {
    const value = Object.hasOwn(p, key) ? p[key] : undefined;
    base[key] = value === undefined ? fallback : (typeof fallback === 'boolean' ? flag(value) : str(value, key === 'comfyWorkflow' ? 2 * 1024 * 1024 : 2048));
  }
  // Optional metadata: old profiles retain their shape. Never turn a malformed
  // explicit binding into an unbound profile that could select another model.
  if (Object.hasOwn(p, 'capabilityModelId') && p.capabilityModelId != null && p.capabilityModelId !== '') {
    const capability = p.capabilityModelId;
    const validId = (id) => typeof id === 'string' && id.trim().length > 0 && id.trim().length <= 240 && !/[\u0000-\u001f\u007f]/.test(id);
    base.capabilityModelId = validId(capability) && Object.hasOwn(p, 'model') && validId(p.model) ? capability.trim() : '[invalid-capability]';
  }
  if (providerId === 'comfy') {
    const rawWorkflow = Object.hasOwn(p, 'comfyWorkflow') ? p.comfyWorkflow : '';
    const result = sanitizeStoryboardWorkflow(rawWorkflow);
    base.comfyWorkflow = result.ok ? result.serialized : '';
    if (result.removedFields.length) base.comfyWorkflowNotice = `已移除凭据字段：${result.removedFields.join('、')}`.slice(0, 2048);
    else if (!result.ok && String(rawWorkflow || '').trim()) base.comfyWorkflowNotice = result.message;
  }
  if (!STORYBOARD_RATIOS.some((item) => item.id === base.ratio)) base.ratio = '1:1';
  return base;
}

function legacyProfiles(value) {
  const r = obj(value) ? value : {};
  return Object.fromEntries(Object.keys(STORYBOARD_PROVIDER_REGISTRY).map((id) => [id, normalizeStoryboardParameterProfile(Object.hasOwn(r, id) ? r[id] : {}, id)]));
}

function rememberedModelBinding(providerId, modelId, capabilityModelId = '') {
  try {
    return resolveStoryboardModelBinding(providerId, { remoteModelId: modelId, capabilityModelId });
  } catch (_) { return null; }
}

function usesLegacyModelMemory(binding) {
  const provider = getStoryboardProvider(binding.modelFamily);
  return Boolean(getStoryboardModel(provider.id, binding.remoteModelId))
    || (provider.customModelId && binding.capabilityModelId === provider.defaultModel);
}

function boundModelProfiles(memory, providerId) {
  const bindings = obj(memory) && Object.hasOwn(memory, 'bindings') && obj(memory.bindings) ? memory.bindings : null;
  return bindings && Object.hasOwn(bindings, providerId) && Array.isArray(bindings[providerId]) ? bindings[providerId] : [];
}

function sameModelBinding(profile, binding) {
  return obj(profile) && Object.hasOwn(profile, 'model') && Object.hasOwn(profile, 'capabilityModelId')
    && profile.model === binding.remoteModelId && profile.capabilityModelId === binding.capabilityModelId;
}

function findRememberedModelProfile(memory, providerId, modelId, capabilityModelId = '') {
  const binding = rememberedModelBinding(providerId, modelId, capabilityModelId);
  if (!binding) return null;
  const id = binding.remoteModelId;
  const bucket = obj(memory) && Object.hasOwn(memory, providerId) ? memory[providerId] : null;
  const cached = usesLegacyModelMemory(binding)
    ? (obj(bucket) && Object.hasOwn(bucket, id) && obj(bucket[id]) ? bucket[id] : null)
    : boundModelProfiles(memory, providerId).find((profile) => sameModelBinding(profile, binding));
  if (!cached) return null;
  const savedBinding = rememberedModelBinding(providerId, id, Object.hasOwn(cached, 'capabilityModelId') ? cached.capabilityModelId : '');
  if (!savedBinding || savedBinding.capabilityModelId !== binding.capabilityModelId) return null;
  return { cached, id };
}

export function getStoryboardRememberedProfile(memory, providerId, modelId, capabilityModelId = '') {
  const found = findRememberedModelProfile(memory, providerId, modelId, capabilityModelId);
  if (!found) return null;
  // Return a detached, whitelisted value. Reading never creates or reorders settings.
  return normalizeStoryboardParameterProfile({ ...found.cached, model: found.id }, providerId);
}

export function rememberStoryboardModelProfile(memory, providerId, profile) {
  const binding = obj(profile) && Object.hasOwn(profile, 'model') && rememberedModelBinding(providerId, profile.model,
    Object.hasOwn(profile, 'capabilityModelId') ? profile.capabilityModelId : '');
  if (!obj(memory) || !binding) return false;
  const id = binding.remoteModelId;
  const remembered = normalizeStoryboardParameterProfile({ ...profile, model: id }, providerId);
  let bucket = Object.hasOwn(memory, providerId) && obj(memory[providerId]) ? memory[providerId] : null;
  if (!bucket) {
    bucket = {};
    Object.defineProperty(memory, providerId, { value: bucket, configurable: true, enumerable: true, writable: true });
  }
  const legacy = usesLegacyModelMemory(binding);
  let bound = boundModelProfiles(memory, providerId);
  if (legacy) {
    // Define data properties even for __proto__; never invoke inherited setters.
    if (Object.hasOwn(bucket, id)) delete bucket[id];
    Object.defineProperty(bucket, id, { value: remembered, configurable: true, enumerable: true, writable: true });
  } else {
    let bindings = Object.hasOwn(memory, 'bindings') && obj(memory.bindings) ? memory.bindings : null;
    if (!bindings) {
      bindings = {};
      Object.defineProperty(memory, 'bindings', { value: bindings, configurable: true, enumerable: true, writable: true });
    }
    bound = bound.filter((entry) => !sameModelBinding(entry, binding));
    bound.push({ ...remembered, capabilityModelId: binding.capabilityModelId });
    Object.defineProperty(bindings, providerId, { value: bound, configurable: true, enumerable: true, writable: true });
  }
  // One combined budget, with deterministic legacy-first eviction; the edited
  // entry always survives. This is not a chronological LRU across namespaces.
  let overflow = Object.keys(bucket).length + bound.length - STORYBOARD_MODEL_PROFILE_LIMIT;
  for (const key of Object.keys(bucket)) {
    if (overflow <= 0) break;
    if (legacy && key === id) continue;
    delete bucket[key]; overflow--;
  }
  while (overflow > 0 && bound.length) {
    const index = bound.findIndex((entry) => legacy || !sameModelBinding(entry, binding));
    if (index < 0) break;
    bound.splice(index, 1); overflow--;
  }
  return true;
}

function modelProfileMemory(value, currentProfiles = {}) {
  const raw = obj(value) ? value : {};
  const memory = Object.fromEntries(Object.keys(STORYBOARD_PROVIDER_REGISTRY).map((id) => [id, {}]));
  for (const providerId of Object.keys(STORYBOARD_PROVIDER_REGISTRY)) {
    const source = Object.hasOwn(raw, providerId) && obj(raw[providerId]) ? raw[providerId] : {};
    for (const [modelId, profile] of Object.entries(source).slice(-STORYBOARD_MODEL_PROFILE_LIMIT)) {
      if (obj(profile)) rememberStoryboardModelProfile(memory, providerId, { ...profile, model: modelId });
    }
    for (const profile of boundModelProfiles(raw, providerId).slice(-STORYBOARD_MODEL_PROFILE_LIMIT)) {
      if (obj(profile)) rememberStoryboardModelProfile(memory, providerId, profile);
    }
    const current = Object.hasOwn(currentProfiles, providerId) && obj(currentProfiles[providerId]) ? currentProfiles[providerId] : {};
    if (!findRememberedModelProfile(memory, providerId, current.model, current.capabilityModelId)) rememberStoryboardModelProfile(memory, providerId, current);
  }
  return memory;
}
function parameterPresets(value) { return Array.isArray(value) ? value.slice(0, 200).filter(obj).map((p) => ({ id: cleanId(p.id), name: str(p.name || '未命名样式', 80), source: getStoryboardProvider(p.source) ? p.source : '', profile: getStoryboardProvider(p.source) ? normalizeStoryboardParameterProfile(p.profile, p.source) : {}, createdAt: pos(p.createdAt || p.updatedAt), updatedAt: pos(p.updatedAt) })).filter((p) => p.id && p.source) : []; }
function legacyLogs(value) {
  const normalized = dedupeById((Array.isArray(value) ? value : []).filter(obj).map((log) => ({ id: cleanId(log.id), status: ['queued', 'generating', 'success', 'failed', 'cancelled'].includes(log.status) ? log.status : 'failed', submissionState: ['not_submitted', 'rejected', 'unknown', 'accepted'].includes(log.submissionState) ? log.submissionState : '', source: getStoryboardProvider(log.source) ? log.source : 'novel', model: str(log.model, 240), prompt: str(log.prompt, 800), negative: str(log.negative, 400), effectivePrompt: str(log.effectivePrompt || log.prompt, 24000), effectiveNegative: str(log.effectiveNegative || log.negative, 12000), target: str(log.target, 40), floor: Number.isInteger(log.floor) ? log.floor : null, params: safeData(log.params, 5) || {}, error: redactString(log.error).slice(0, 1600), recordId: cleanId(log.recordId), recordIds: ids(log.recordIds, 20), pipelineId: cleanId(log.pipelineId), queuedAt: pos(log.queuedAt || log.startedAt), startedAt: pos(log.startedAt), finishedAt: pos(log.finishedAt), durationMs: pos(log.durationMs), attempt: int(log.attempt, 1, 20, 1), snapshot: snapshot(log.snapshot, log) })).filter((log) => log.id));
  return normalized.map((log, index) => ({ log, index, activityAt: log.finishedAt || log.startedAt || log.queuedAt })).sort((a, b) => b.activityAt - a.activityAt || a.index - b.index).slice(0, STORYBOARD_PIPELINE_LOG_LIMIT).map(({ log }) => log);
}
function snapshot(value, fallback = {}) {
  const raw = obj(value) ? value : {}, source = getStoryboardProvider(raw.source) ? raw.source : (getStoryboardProvider(fallback.source) ? fallback.source : 'novel'), safe = safeData(raw, 8);
  const profile = normalizeStoryboardParameterProfile(raw.profile, source);
  const payload = safeData(raw.payload, 12) || {};
  if (source === 'comfy' && raw.payload?.parameters?.workflow !== undefined) {
    const result = sanitizeStoryboardWorkflow(raw.payload.parameters.workflow);
    payload.parameters ||= {};
    if (result.ok && result.serialized) payload.parameters.workflow = result.workflow;
    else delete payload.parameters.workflow;
    if (result.removedFields.length && !profile.comfyWorkflowNotice) {
      profile.comfyWorkflowNotice = `已移除凭据字段：${result.removedFields.join('、')}`.slice(0, 2048);
    } else if (!result.ok && !profile.comfyWorkflowNotice) profile.comfyWorkflowNotice = result.message;
  }
  if (obj(safe)) {
    delete safe.selectedCharacterId;
    delete safe.selectedCharacters;
    delete safe.consistencyMode;
  }
  if (obj(payload)) delete payload.characters;
  return { ...(obj(safe) ? safe : {}), source, prompt: str(raw.prompt ?? fallback.prompt, 24000), negative: str(raw.negative ?? fallback.negative, 12000), target: ['latest', 'floor', 'gallery'].includes(raw.target) ? raw.target : (['latest', 'floor', 'gallery'].includes(fallback.target) ? fallback.target : 'gallery'), floor: Number.isInteger(raw.floor) ? raw.floor : (Number.isInteger(fallback.floor) ? fallback.floor : null), inlineByDefault: raw.inlineByDefault !== false, referenceUrl: str(raw.referenceUrl, 4096), chatKey: str(raw.chatKey, 512), messageRef: raw.messageRef ? normalizeStoryboardMessageReference(raw.messageRef) : null, messageHash: str(raw.messageHash, 160), swipeId: Number.isInteger(raw.swipeId) ? raw.swipeId : 0, paragraphAnchor: raw.paragraphAnchor ? normalizeStoryboardParagraphAnchor(raw.paragraphAnchor) : null, shotType: str(raw.shotType || 'custom', 60), profile, connection: snapshotConnection(raw.connection, source), payload };
}
function snapshotConnection(value, providerId) {
  const raw = obj(value) ? value : {}, safe = safeData(raw, 5);
  const explicitProtocol = raw.protocol && raw.protocol !== IMAGE_NATIVE_PROTOCOLS[providerId];
  // Restore only declared, non-credential routing headers after the generic secret scrub.
  // Authorization/Cookie/API keys remain excluded by the connection's public-header contract.
  const compatibility = providerId === 'openai' || raw.protocol === 'openai-images'
    ? normalizeOpenAIImageCompatibility(raw.compatibility) : null;
  const headers = compatibility ? normalizeOpenAICompatibleHeaders(raw.headers, compatibility) : {};
  return { ...(obj(safe) ? safe : {}), id: cleanId(raw.id), credentialId: cleanId(raw.credentialId),
    ...(compatibility ? { compatibility } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    baseUrl: str(explicitProtocol ? (raw.baseUrl || '') : (raw.baseUrl || getStoryboardProvider(providerId)?.defaultBaseUrl), 2048),
    model: str(raw.model, 240), allowPrivateNetwork: providerId === 'comfy' && Boolean(raw.allowPrivateNetwork) };
}

function providers(value) { return Array.isArray(value) ? [...new Set(value.filter(getStoryboardProvider))].slice(0, 10) : []; }
function providerSupports(providerId, capability) { return (STORYBOARD_MODEL_REGISTRY[providerId] || []).some((model) => Boolean(model.capabilities[capability])); }
function providerStrings(value, max) { const out = {}; if (obj(value)) for (const id of Object.keys(STORYBOARD_PROVIDER_REGISTRY)) if (value[id] !== undefined) out[id] = str(value[id], max); return out; }
function safeRecord(value, { reserved = false } = {}) {
  if (!obj(value)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 100)) {
    const key = str(rawKey, 120);
    if (!key || isUnsafeObjectKey(key) || isSensitiveField(key) || reserved && isReservedProviderField(key)) continue;
    const normalized = safeData(rawValue, 10);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}
function safeData(value, depth = 5) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return str(value, 24000);
  if (depth <= 0) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeData(item, depth - 1)).filter((item) => item !== undefined);
  if (!obj(value)) return undefined;
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 150)) {
    const key = str(rawKey, 120);
    if (!key || isUnsafeObjectKey(key) || isSensitiveField(key)) continue;
    if (isBinaryField(key) && (typeof rawValue !== 'string' || looksLikeBase64(rawValue))) continue;
    const normalized = safeData(rawValue, depth - 1);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}
function redact(value, depth = 0, maxString = 24000, maxDepth = 6) {
  if (value == null) return value ?? null;
  if (depth > maxDepth) return '[depth omitted]';
  if (typeof value === 'string') return redactString(value, maxString);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1, maxString, maxDepth));
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 150)) {
    const key = str(rawKey, 120);
    if (!key || isUnsafeObjectKey(key)) continue;
    if (key.toLowerCase() === 'workflow') {
      const result = sanitizeStoryboardWorkflow(rawValue);
      out[key] = result.ok ? result.workflow : '[invalid workflow omitted]';
    } else if (isSensitiveField(key)) out[key] = '[redacted]';
    else if (isBinaryField(key) && (typeof rawValue !== 'string' || looksLikeBase64(rawValue))) out[key] = '[image omitted]';
    else out[key] = redact(rawValue, depth + 1, maxString, maxDepth);
  }
  return out;
}
function redactString(value, max = 24000) {
  const text = str(value, max);
  if (/^data:image\/[^;]+;base64,/i.test(text) || looksLikeBase64(text)) return '[image omitted]';
  return text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/gi, '[image omitted]').replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').replace(/(["']?(?:api[-_ ]?key|access[-_ ]?token|authorization|password|secret)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]');
}
function isUnsafeObjectKey(value) { return ['__proto__', 'prototype', 'constructor'].includes(String(value || '').toLowerCase()); }
function isSensitiveField(value) {
  const key = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  if (/^(?:credential|secret)[-_.]?id$/.test(key)) return false;
  return key === 'key' || key === 'token' || /(^|[-_.])(api[-_.]?key|access[-_.]?key|secret[-_.]?key|access[-_.]?token|refresh[-_.]?token|bearer[-_.]?token|secret|authorization|auth|headers?|cookies?|password|passphrase|credential|credentials)(?:$|[-_.])/.test(key);
}
function isReservedProviderField(value) { return ['model', 'prompt', 'input', 'apikey', 'authorization', 'url', 'baseurl', 'modelfamily', 'capabilitymodelid', 'remotemodelid', 'connectionpresetid', 'protocol', 'modelbindingversion', 'imageprotocolversion'].includes(String(value || '').replace(/[-_]/g, '').toLowerCase()); }
function isBinaryField(value) { return /^(?:data|base64|b64|b64_json|imageData|image_data|bytes)$/i.test(String(value || '')); }
function looksLikeBase64(value) { const text = String(value || '').replace(/\s+/g, ''); return /^data:image\/[^;]+;base64,/i.test(text) || text.length >= 256 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text); }
function status(value) { if (value === 'generating') return 'running'; return ['queued', 'running', 'success', 'failed', 'cancelled', 'skipped'].includes(value) ? value : 'failed'; }
function accept(target, dropped, capability, key, value, outputKey = key) { if (value === '' || value == null) return; if (capability[key]) target[outputKey] = value; else dropped.push(outputKey); }
function add(parts, key, raw, min, max, integer) { if (raw === '' || raw == null) return; let value = Number(raw); if (!Number.isFinite(value)) return; value = Math.max(min, Math.min(max, value)); if (integer) value = Math.round(value); parts.push(`${key}=${value}`); }
function slash(value, max) { return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\|/g, '｜').replace(/\s{2,}/g, ' ').trim().slice(0, max); }
function obj(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function str(value, max) { return String(value ?? '').trim().slice(0, max); }
function cleanId(value) { return str(value, 200); }
function ids(value, max) { return Array.isArray(value) ? [...new Set(value.map(cleanId).filter(Boolean))].slice(0, max) : []; }
function uniqueStrings(value, max, length) { return Array.isArray(value) ? [...new Set(value.map((item) => str(item, length)).filter(Boolean))].slice(0, max) : []; }
function dedupeById(value) { const out = [], positions = new Map(); for (const item of value || []) { const id = cleanId(item?.id); if (!id) continue; if (positions.has(id)) out[positions.get(id)] = item; else { positions.set(id, out.length); out.push(item); } } return out; }
function pos(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; }
function int(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback; }
function num(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function flag(value) { return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1'; }
function bounded(value, min, max, integer = false) { const n = Number(value); if (value === '' || value == null || !Number.isFinite(n)) return ''; const clamped = Math.max(min, Math.min(max, n)); return integer ? Math.round(clamped) : clamped; }
function numeric(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(n) : ''; }
function clamp64(value) { return Math.max(64, Math.min(4096, Math.round(Number(value || 0) / 64) * 64)); }
function anchorText(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function hash(value) { let h = 2166136261; for (const ch of String(value || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); }
function similarity(left, right) { if (!left || !right) return 0; const a = String(left).toLowerCase(), b = String(right).toLowerCase(); if (a === b) return 1; const scores = [setSimilarity(words(a), words(b)), setSimilarity(ngrams(a, 2), ngrams(b, 2))]; if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(a + b)) scores.push(setSimilarity(ngrams(a, 1), ngrams(b, 1))); return Math.max(...scores); }
function words(value) { return new Set(String(value || '').match(/[\p{L}\p{N}]+/gu) || []); }
function ngrams(value, size) { const chars = [...String(value || '').replace(/[^\p{L}\p{N}]+/gu, '')], out = new Set(); if (chars.length < size) { if (chars.length) out.add(chars.join('')); return out; } for (let i = 0; i <= chars.length - size; i++) out.add(chars.slice(i, i + size).join('')); return out; }
function setSimilarity(left, right) { if (!left.size || !right.size) return 0; let same = 0; for (const token of left) if (right.has(token)) same++; return same / (left.size + right.size - same); }
function clone(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
