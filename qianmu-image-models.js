// Shared model-catalog contract. No credentials, browser globals or generation requests.
export const IMAGE_MODEL_LIST_LIMIT = 4000;
export const IMAGE_MODEL_PAGE_LIMIT = 10;
export const IMAGE_MODEL_ID_LIMIT = 240;
export const IMAGE_MODEL_BINDING_VERSION = 1;
export const IMAGE_NATIVE_PROTOCOLS = Object.freeze({
  novel: 'novelai', banana: 'gemini-images', openai: 'openai-images', seedream: 'ark-images', comfy: 'comfy-workflow',
});

// Explicit transport declarations fail closed. Never infer a protocol from a URL or remote model name.
// Cross-family adapters will extend this contract only after their parameter mapping is supported.
export function resolveImageProtocolBinding(provider, input = {}) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (typeof provider !== 'string' || !Object.hasOwn(IMAGE_NATIVE_PROTOCOLS, provider)) fail('invalid_model_family', '请选择有效的生图系列');
  if (input.modelFamily !== undefined && input.modelFamily !== '' && input.modelFamily !== provider) fail('model_family_mismatch', '模型系列与连接不匹配，未发起请求');
  const native = IMAGE_NATIVE_PROTOCOLS[provider];
  let protocol = input.protocol;
  if (protocol === undefined || protocol === '') protocol = native;
  else {
    if (typeof protocol !== 'string' || !protocol.trim() || protocol.length > 40 || /[\u0000-\u001f\u007f]/.test(protocol)) fail('model_protocol_mismatch', '连接协议无效，未发起请求');
    protocol = protocol.trim();
    // Names used by the existing gateway's native capability declaration.
    if (protocol === 'gemini') protocol = 'gemini-images';
    if (protocol === 'comfyui') protocol = 'comfy-workflow';
    if (protocol !== native) fail('model_protocol_mismatch', '此系列尚不支持所选连接协议，未发起请求');
  }
  return Object.freeze({ modelFamily: provider, protocol });
}

export const NOVEL_STATIC_MODELS = Object.freeze([
  ['safe-diffusion', 'Anime Curated V1'],
  ['nai-diffusion', 'Anime Full V1'],
  ['nai-diffusion-furry', 'Furry V1'],
  ['nai-diffusion-2', 'Anime V2'],
  ['nai-diffusion-3', 'Anime V3'],
  ['nai-diffusion-furry-3', 'Furry V3'],
  ['nai-diffusion-4-curated-preview', 'Anime Curated V4'],
  ['nai-diffusion-4-full', 'Anime Full V4'],
  ['nai-diffusion-4-5-curated', 'Anime Curated V4.5'],
  ['nai-diffusion-4-5-full', 'Anime Full V4.5'],
  ['nai-diffusion-5-curated', 'Anime Curated V5'],
  ['nai-diffusion-5-full', 'Anime Full V5'],
].map(Object.freeze));

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const firstText = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';

export function isImageModelMetadataField(value) {
  return ['modelfamily', 'capabilitymodelid', 'remotemodelid', 'connectionpresetid', 'protocol', 'modelbindingversion'].includes(String(value).replace(/[-_]/g, '').toLowerCase());
}

export function novelModelCapabilities(model, capabilityModelId = '') {
  const explicit = capabilityModelId !== '' && capabilityModelId != null;
  const known = (id) => NOVEL_STATIC_MODELS.some(([modelId]) => modelId === id);
  const invalid = (code, message) => ({ ok: false, code, message });
  if (explicit && (typeof model !== 'string' || model.trim().length > IMAGE_MODEL_ID_LIMIT || /[\u0000-\u001f\u007f]/.test(model))) return invalid('invalid_model_id', '实际模型名称无效');
  if (explicit && (typeof capabilityModelId !== 'string' || !known(capabilityModelId))) return invalid('invalid_capability_model', '请选择有效的 NovelAI 模型能力档');
  const remote = typeof model === 'string' ? model.trim() : String(model || '');
  if (explicit && known(remote) && remote !== capabilityModelId) return invalid('model_capability_conflict', '已知模型与所选能力档不一致');
  // Preserve legacy direct calls. New aliases supply an explicit canonical capability ID.
  const effective = explicit ? capabilityModelId : remote;
  return { ok: true, capabilityModelId: effective, known: known(effective),
    isV5: /(?:^|[-_])v5(?:[-_]|$)|nai-diffusion-5(?:[-_]|$)/i.test(effective),
    isV4: /nai-diffusion-4(?:-|$)/i.test(effective), isV45: /nai-diffusion-4-5(?:-|$)/i.test(effective),
    isV3: /nai-diffusion-(?:furry-)?3(?:-|$)/i.test(effective) };
}

export function novelReferenceIssue(capabilities, references = [], vibes = [], options = {}) {
  const hasOptions = Object.keys(options).some((key) => /^(?:reference|director_reference|precise_reference)/i.test(key));
  const hasPrecise = references.length > 0 || Boolean(options.director_reference_images?.length);
  const hasVibe = vibes.length > 0 || Boolean(options.reference_image_multiple?.length);
  const issue = (code, message) => ({ code, message });
  if (capabilities.isV5 && (hasPrecise || hasVibe || hasOptions)) return issue('novel_v5_reference_unsupported', '当前 NovelAI V5 不支持 Vibe 或 Precise Reference');
  if (capabilities.known && hasVibe && !capabilities.isV3 && !capabilities.isV4) return issue('novel_vibe_unsupported', '当前 NovelAI 模型不支持 Vibe，请选择 V3、V4 或 V4.5');
  if (capabilities.known && hasPrecise && !capabilities.isV45) return issue('novel_precise_reference_unsupported', 'Precise Reference 仅支持 NovelAI V4.5');
  if (hasPrecise && hasVibe) return issue('novel_reference_conflict', 'Precise Reference 与 Vibe 不能同时使用，请选择一种');
  if (hasPrecise && options.precise_reference === false) return issue('novel_reference_disabled', '已提供参考图，但 Precise Reference 被关闭，请确认参考设置');
  return null;
}

// Both transports use the same typed reference fields; callers validate image bytes independently.
export function novelPreciseReferenceParameters(references = []) {
  if (!references.length) return {};
  const amount = (value, max, fallback) => value === '' || value == null || !Number.isFinite(Number(value)) ? fallback : Math.max(0, Math.min(max, Number(value)));
  return {
    director_reference_images: references.map((item) => item.data),
    director_reference_descriptions: references.map((item) => {
      const type = firstText(item.referenceType, item.type, item.mode).toLowerCase();
      return { caption: { base_caption: ['character', 'style', 'character&style'].includes(type) ? type : 'character', char_captions: [] }, legacy_uc: false };
    }),
    director_reference_information_extracted: references.map((item) => amount(item.information, 1, 1)),
    director_reference_strength_values: references.map((item) => amount(item.strength, 2, 0.6)),
    director_reference_secondary_strength_values: references.map((item) => 1 - amount(item.fidelity, 1, 1)),
  };
}

function imageModelHeuristic(provider, id, source) {
  if (provider === 'novel' || provider === 'comfy') return true;
  const text = `${id} ${firstText(source.displayName, source.display_name, source.label, source.title, source.name)}`.toLowerCase();
  if (provider === 'banana') return /(?:image|imagen|banana)/.test(text);
  if (provider === 'seedream') return /(?:seedream|image|imagen|flux|sdxl|stable[-_ ]?diffusion|kolors)/.test(text);
  return /(?:gpt[-_. ]?image|dall[-_. ]?e|image[-_. ]?(?:gen|generation)|imagen|flux|sdxl|stable[-_ ]?diffusion|ideogram|recraft|seedream|kolors|playground)/.test(text);
}

export function normalizeModelEntry(raw, provider, kind = '') {
  const source = typeof raw === 'string' ? { id: raw } : object(raw);
  const explicitId = firstText(source.id, source.model, source.model_id, source.modelId, source.model_name, source.modelName, source.value);
  const rawId = firstText(source.rawId, explicitId, source.name);
  // Only Gemini's resource-name field has a protocol prefix. An explicit relay ID is opaque.
  const id = explicitId || (provider === 'banana' ? firstText(source.name).replace(/^models\//, '') : firstText(source.name));
  if (!id || id.length > IMAGE_MODEL_ID_LIMIT || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return {
    id, rawId: rawId.slice(0, 1024),
    label: firstText(source.displayName, source.display_name, source.label, source.title, id).slice(0, 300),
    imageCapable: imageModelHeuristic(provider, id, source),
    kind: firstText(kind, source.kind, 'model').slice(0, 80),
  };
}

export function finalizeModelList(provider, models, { source = 'remote', truncated = false } = {}) {
  const rows = Array.isArray(models) ? models : [];
  const unique = new Map();
  let invalidCount = 0;
  for (const raw of rows.slice(0, IMAGE_MODEL_LIST_LIMIT)) {
    const item = normalizeModelEntry(raw, provider);
    if (!item) { invalidCount++; continue; }
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  // This is only a browsing hint: never discard an unknown alias because its name lacks "image".
  const list = [...unique.values()].sort((a, b) => Number(b.imageCapable) - Number(a.imageCapable) || a.label.localeCompare(b.label));
  return { ok: true, provider, source, models: list, total: list.length,
    imageCapableCount: list.filter((item) => item.imageCapable).length, invalidCount,
    truncated: Boolean(truncated || rows.length > IMAGE_MODEL_LIST_LIMIT) };
}

export function modelArrayFromJson(json) {
  if (Array.isArray(json)) return json;
  for (const value of [json?.data, json?.models, json?.items, json?.list, json?.results,
    json?.data?.models, json?.data?.items, json?.data?.list,
    json?.result?.data, json?.result?.models, json?.result?.items, json?.result?.list, json?.result]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function modelsFromComfyObjectInfo(json) {
  const models = [];
  let truncated = false;
  loaders: for (const [loader, definition] of Object.entries(object(json))) {
    if (!/(?:checkpoint|ckpt|unet|diffusion.*model).*loader|loader.*(?:checkpoint|ckpt|unet|diffusion.*model)/i.test(loader)) continue;
    for (const [field, descriptor] of Object.entries(object(definition?.input?.required))) {
      if (!/(?:ckpt|unet|model).*name/i.test(field) || !Array.isArray(descriptor?.[0])) continue;
      for (const id of descriptor[0]) {
        if (models.length === IMAGE_MODEL_LIST_LIMIT) { truncated = true; break loaders; }
        models.push({ id, kind: /ckpt/i.test(field) ? 'checkpoint' : 'diffusion-model' });
      }
    }
  }
  return finalizeModelList('comfy', models, { truncated });
}

export async function collectImageModelPages(provider, fetchPage, { signal } = {}) {
  const models = [];
  const seenTokens = new Set();
  let nextPageToken = '', truncated = false;
  for (let page = 0; page < IMAGE_MODEL_PAGE_LIMIT; page++) {
    signal?.throwIfAborted();
    const json = await fetchPage(nextPageToken);
    signal?.throwIfAborted();
    const rows = modelArrayFromJson(json);
    const room = IMAGE_MODEL_LIST_LIMIT - models.length;
    models.push(...rows.slice(0, room));
    nextPageToken = provider === 'banana' ? firstText(json?.nextPageToken, json?.next_page_token) : '';
    if (rows.length > room || (models.length === IMAGE_MODEL_LIST_LIMIT && nextPageToken)) { truncated = true; break; }
    if (!nextPageToken) break;
    if (seenTokens.has(nextPageToken) || nextPageToken.length > 2000 || page + 1 === IMAGE_MODEL_PAGE_LIMIT) { truncated = true; break; }
    seenTokens.add(nextPageToken);
  }
  return finalizeModelList(provider, models, { truncated });
}
