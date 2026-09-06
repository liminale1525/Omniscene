import { Buffer } from 'node:buffer';
import { prepareComfyWorkflow } from './qianmu-comfy-workflow.js';
import { imageTransportProvider, prepareImageTransportRequest, resolveImageTransportBinding } from './qianmu-image-transport.js';
import { IMAGE_PROTOCOL_BINDING_VERSION, IMAGE_COMPATIBLE_PROTOCOLS } from './qianmu-image-models.js';
import { IMAGE_MODEL_BINDING_VERSION, NOVEL_STATIC_MODELS, finalizeModelList, collectImageModelPages, modelsFromComfyObjectInfo, novelModelCapabilities, novelReferenceIssue, novelPreciseReferenceParameters, isImageModelMetadataField } from './qianmu-image-models.js';
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import {
  filterOpenAIProviderOptions,
  normalizeOpenAICompatibleHeaders,
  normalizeOpenAIImageCompatibility,
  openAICompatibilityAllows,
} from './qianmu-openai-image-compat.js';

const MAX_PROMPT_LENGTH = 32_000;
const MAX_NEGATIVE_LENGTH = 16_000;
const MAX_UPSTREAM_BYTES = 48 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_PROVIDER_OPTIONS_BYTES = 64 * 1024;
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const ALLOWED_REFERENCE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_TIMEOUT_MS = 180_000;
const RESPONSE_GUARDS = new WeakMap();

export const IMAGE_GATEWAY_PROVIDERS = Object.freeze({
  novel: Object.freeze({
    id: 'novel', label: 'NovelAI', defaultBaseUrl: 'https://image.novelai.net', protocol: 'novelai', requiresKey: true,
  }),
  banana: Object.freeze({
    id: 'banana', label: 'Banana', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini', requiresKey: true,
  }),
  openai: Object.freeze({
    id: 'openai', label: '自定义（兼容 OpenAI）', defaultBaseUrl: 'https://api.openai.com/v1', protocol: 'openai-images', requiresKey: true,
  }),
  seedream: Object.freeze({
    id: 'seedream', label: 'Doubao Seedream', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'ark-images', requiresKey: true,
  }),
  comfy: Object.freeze({
    id: 'comfy', label: 'ComfyUI', defaultBaseUrl: '', protocol: 'comfyui', requiresKey: false,
  }),
});

export class ImageGatewayError extends Error {
  constructor(status, code, message, options = {}) {
    super(String(message || '图像请求失败'));
    this.name = 'ImageGatewayError';
    this.status = Number(status) || 500;
    this.code = String(code || 'image_gateway_error');
    this.retryable = Boolean(options.retryable);
    this.upstreamStatus = Number(options.upstreamStatus) || 0;
  }
}

export function imageGatewayCapabilities(serviceVersion = '') {
  return {
    ok: true, plugin: 'qianmu-tts', version: 3, serviceVersion: String(serviceVersion).slice(0, 80), modelListing: true,
    providers: Object.values(IMAGE_GATEWAY_PROVIDERS).map(({ id, label, protocol, requiresKey }) => ({ id, label, protocol, requiresKey, modelListing: true })),
    modelBinding: {
      version: IMAGE_MODEL_BINDING_VERSION,
      providers: { novel: { protocol: 'novelai', capabilityModelIds: NOVEL_STATIC_MODELS.map(([id]) => id) } },
    },
    protocolBinding: { version: IMAGE_PROTOCOL_BINDING_VERSION, providers: IMAGE_COMPATIBLE_PROTOCOLS },
  };
}

function asString(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function clampNumber(value, min, max, fallback = undefined, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  return integer ? Math.round(clamped) : clamped;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateGatewayProtocol(provider, input) {
  try { return resolveImageTransportBinding(provider, input); }
  catch (error) {
    if (error.code === 'invalid_model_family') throw new ImageGatewayError(400, 'unsupported_provider', '不支持的图像供应商');
    throw new ImageGatewayError(400, error.code, error.message);
  }
}

function serializedJson(value, maxBytes, code, message) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (_) { throw new ImageGatewayError(400, code, message); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new ImageGatewayError(400, code, message);
  try { return JSON.parse(serialized); }
  catch (_) { throw new ImageGatewayError(400, code, message); }
}

function safeProviderOptions(value) {
  const source = serializedJson(plainObject(value), MAX_PROVIDER_OPTIONS_BYTES, 'invalid_provider_options', '模型高级参数过大或格式无效');
  const sensitive = /^(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|token|secret|headers?)$/i;
  const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
  const reserved = new Set(['model', 'prompt', 'input', 'url', 'baseurl']);
  const clean = (item, depth = 0) => {
    if (depth > 10) throw new ImageGatewayError(400, 'invalid_provider_options', '模型高级参数嵌套过深');
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) return item;
    if (Array.isArray(item)) return item.slice(0, 64).map((entry) => clean(entry, depth + 1));
    if (!plainObject(item)) return undefined;
    const output = Object.create(null);
    for (const [rawKey, rawValue] of Object.entries(item).slice(0, 64)) {
      const key = asString(rawKey, 80);
      const lower = key.toLowerCase();
      if (!/^[a-zA-Z][\w.-]{0,79}$/.test(key) || sensitive.test(key) || dangerous.has(lower) || (depth === 0 && (reserved.has(lower) || isImageModelMetadataField(key)))) continue;
      const next = clean(rawValue, depth + 1);
      if (next !== undefined) output[key] = next;
    }
    return output;
  };
  return clean(source);
}

function normalizeBase64(value) {
  const text = String(value ?? '').trim();
  if (text.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 256) {
    throw new ImageGatewayError(400, 'invalid_reference_size', '单张参考图须小于 16 MB');
  }
  const match = text.match(/^data:([^;,]+);base64,(.+)$/s);
  const data = String(match?.[2] || text).replace(/\s+/g, '');
  if (!data || data.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(data) || /=/.test(data.slice(0, -2))) {
    throw new ImageGatewayError(400, 'invalid_reference', '参考图数据无效');
  }
  let bytes;
  try { bytes = Buffer.from(data, 'base64'); }
  catch (_) { throw new ImageGatewayError(400, 'invalid_reference', '参考图数据无效'); }
  if (bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) {
    throw new ImageGatewayError(400, 'invalid_reference', '参考图数据无效');
  }
  return { mime: match?.[1] || '', data: bytes.toString('base64'), bytes };
}

function normalizeReferences(value, budget) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).map((item, index) => {
    const source = plainObject(item);
    const normalized = normalizeBase64(source.data || source.base64 || '');
    let mime = asString(source.mime || normalized.mime || 'image/png', 80).toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!/^image\/(?:png|jpeg|jpg|webp)$/i.test(mime)) throw new ImageGatewayError(400, 'invalid_reference_type', '参考图只支持 PNG、JPEG 或 WebP');
    const bytes = normalized.bytes;
    if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw new ImageGatewayError(400, 'invalid_reference_size', '单张参考图须小于 16 MB');
    const detectedMime = imageMime(bytes, '');
    if (!ALLOWED_REFERENCE_MIMES.has(detectedMime)) throw new ImageGatewayError(400, 'invalid_reference', '参考图内容不是有效的 PNG、JPEG 或 WebP');
    mime = detectedMime;
    budget.used += bytes.length;
    if (budget.used > MAX_REFERENCE_TOTAL_BYTES) throw new ImageGatewayError(400, 'references_too_large', '参考图与 Vibe 总计须小于 48 MB');
    const requestedType = asString(source.referenceType || source.type || source.mode, 40).toLowerCase();
    return {
      data: normalized.data,
      mime,
      name: asString(source.name || `reference-${index + 1}.${mime.includes('jpeg') ? 'jpg' : mime.split('/')[1]}`, 160),
      strength: clampNumber(source.strength, 0, 2, 0.6),
      information: clampNumber(source.information, 0, 1, 1),
      fidelity: clampNumber(source.fidelity, 0, 1, 1),
      referenceType: ['character', 'style', 'character&style'].includes(requestedType) ? requestedType : 'character',
    };
  });
}

export function sanitizeImageRequest(input) {
  let source = plainObject(input);
  const binding = validateGatewayProtocol(asString(source.provider, 40).toLowerCase(), source);
  try { source = prepareImageTransportRequest(source); }
  catch (error) { throw new ImageGatewayError(400, error.code, error.message); }
  if (Object.hasOwn(source, 'modelBindingVersion')) {
    if (source.modelBindingVersion !== IMAGE_MODEL_BINDING_VERSION) throw new ImageGatewayError(409, 'model_binding_version_mismatch', '生图模型绑定协议不兼容，请同步更新千幕前端与增强服务并重启 ST');
    if (source.provider !== 'novel' || typeof source.capabilityModelId !== 'string' || !source.capabilityModelId.trim()) {
      throw new ImageGatewayError(400, 'invalid_model_binding_contract', '生图请求缺少受支持的模型能力绑定');
    }
  }
  const provider = asString(source.provider, 40).toLowerCase();
  const definition = IMAGE_GATEWAY_PROVIDERS[provider];
  if (!definition) throw new ImageGatewayError(400, 'unsupported_provider', '不支持的图像供应商');
  const prompt = asString(source.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) throw new ImageGatewayError(400, 'empty_prompt', '提示词不能为空');
  const model = asString(source.model, 240);
  if (!model && provider !== 'comfy') throw new ImageGatewayError(400, 'missing_model', '请选择生图模型');
  if (provider === 'novel') {
    const binding = novelModelCapabilities(source.model, source.capabilityModelId);
    if (!binding.ok) throw new ImageGatewayError(400, binding.code, binding.message);
  }
  const apiKey = asString(source.apiKey, 2048);
  if (definition.requiresKey && !apiKey) throw new ImageGatewayError(400, 'missing_api_key', '请先填写 API Key');
  const parameters = plainObject(source.parameters);
  const referenceBudget = { used: 0 };
  const references = normalizeReferences(source.referenceImages || source.references, referenceBudget);
  const vibes = normalizeReferences(source.vibes, referenceBudget);
  const workflow = plainObject(parameters.workflow || source.workflow);
  const compatibility = imageTransportProvider(provider, binding) === 'openai' ? normalizeOpenAIImageCompatibility(source.compatibility) : null;
  return {
    provider,
    ...(provider !== imageTransportProvider(provider, binding) ? { ...binding, imageProtocolVersion: IMAGE_PROTOCOL_BINDING_VERSION } : {}),
    apiKey,
    baseUrl: asString(source.baseUrl || definition.defaultBaseUrl, 2048),
    allowPrivateNetwork: provider === 'comfy' && source.allowPrivateNetwork === true,
    model,
    ...(source.capabilityModelId ? { capabilityModelId: asString(source.capabilityModelId, 240) } : {}),
    prompt,
    negativePrompt: asString(source.negativePrompt, MAX_NEGATIVE_LENGTH),
    references,
    vibes,
    ...(compatibility ? {
      compatibility,
      customHeaders: normalizeOpenAICompatibleHeaders(source.customHeaders, compatibility),
    } : {}),
    parameters: {
      width: clampNumber(parameters.width, 64, 8192, undefined, true),
      height: clampNumber(parameters.height, 64, 8192, undefined, true),
      size: asString(parameters.size, 40),
      aspectRatio: asString(parameters.aspectRatio, 20),
      imageSize: asString(parameters.imageSize, 20),
      quality: asString(parameters.quality, 40),
      background: asString(parameters.background, 40),
      outputFormat: asString(parameters.outputFormat, 20).toLowerCase(),
      // NovelAI 的批量数在镜头台入队前拆成独立任务。网关继续强制单张，
      // 防止旧前端或第三方调用重新把多张合并成一次不可恢复的请求。
      count: provider === 'novel' ? 1 : clampNumber(parameters.count, 1, 4, 1, true),
      seed: clampNumber(parameters.seed, -1, Number.MAX_SAFE_INTEGER, undefined, true),
      steps: clampNumber(parameters.steps, 1, 300, undefined, true),
      scale: clampNumber(parameters.scale ?? parameters.cfg, 0, 100, undefined),
      sampler: asString(parameters.sampler, 120),
      scheduler: asString(parameters.scheduler, 120),
      guidanceScale: clampNumber(parameters.guidanceScale, 0, 20, undefined),
      watermark: parameters.watermark === true,
      sequential: parameters.sequential === true,
      workflow: Object.keys(workflow).length
        ? serializedJson(workflow, MAX_WORKFLOW_BYTES, 'invalid_workflow', 'ComfyUI Workflow 过大或格式无效')
        : {},
      providerOptions: safeProviderOptions(parameters.providerOptions),
      timeoutMs: clampNumber(parameters.timeoutMs, 15_000, 300_000, DEFAULT_TIMEOUT_MS, true),
      pollIntervalMs: clampNumber(parameters.pollIntervalMs, 250, 3_000, 700, true),
    },
  };
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!value) return true;
  if (value === '::1' || value === '0.0.0.0' || value === '::') return true;
  if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
  if (isIP(value) === 6) return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9')
    || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff') || value.startsWith('2001:db8')
    || value.startsWith('2001:0:') || value.startsWith('2001:10') || value.startsWith('2001:2:')
    || value.startsWith('2002:') || value.startsWith('64:ff9b:');
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
    || (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2))
    || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
    || parts[0] >= 224;
}

export async function validateGatewayBaseUrl(rawUrl, { allowPrivateNetwork = false, resolveHost = dnsLookup } = {}) {
  let url;
  try { url = new URL(asString(rawUrl, 2048)); }
  catch (_) { throw new ImageGatewayError(400, 'invalid_base_url', 'API 地址无效'); }
  if (url.username || url.password || url.hash || url.search) throw new ImageGatewayError(400, 'invalid_base_url', 'API 地址不能包含账号、密码、查询参数或锚点');
  if (!['https:', ...(allowPrivateNetwork ? ['http:'] : [])].includes(url.protocol)) {
    throw new ImageGatewayError(400, 'unsafe_base_url', allowPrivateNetwork ? '接口地址只支持 HTTP 或 HTTPS' : '远程接口地址必须使用 HTTPS');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const localName = hostname === 'localhost' || hostname.endsWith('.localhost');
  if (!allowPrivateNetwork && localName) throw new ImageGatewayError(400, 'private_network_blocked', '远程接口不能指向本机或私有网络');
  if (!allowPrivateNetwork) {
    let addresses;
    try { addresses = await resolveHost(hostname, { all: true, verbatim: true }); }
    catch (_) { throw new ImageGatewayError(400, 'base_url_unreachable', '无法解析 API 地址'); }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (!list.length || list.some((item) => isPrivateAddress(item?.address || item))) {
      throw new ImageGatewayError(400, 'private_network_blocked', '远程接口不能指向本机或私有网络');
    }
  }
  return url;
}

function endpoint(base, suffix) {
  const url = new URL(base.toString());
  const cleanSuffix = `/${String(suffix || '').replace(/^\/+/, '')}`;
  const current = url.pathname.replace(/\/+$/, '');
  if (!current.endsWith(cleanSuffix)) url.pathname = `${current}${cleanSuffix}`.replace(/\/{2,}/g, '/');
  return url;
}

function normalizeProviderBase(base, provider) {
  const url = new URL(base.toString());
  if (provider === 'banana' && url.hostname.toLowerCase() === 'generativelanguage.googleapis.com' && /^\/?$/.test(url.pathname)) {
    url.pathname = '/v1beta';
  }
  return url;
}


function combinedPrompt(request) {
  if (!request.negativePrompt) return request.prompt;
  return `${request.prompt}\n\nExclude from the image: ${request.negativePrompt}`.slice(0, MAX_PROMPT_LENGTH);
}

function authHeaders(request, extras = {}) {
  return { Authorization: `Bearer ${request.apiKey}`, ...extras };
}

function requestSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

async function readLimited(response, limit = MAX_UPSTREAM_BYTES) {
  const guard = RESPONSE_GUARDS.get(response);
  const tooLarge = () => new ImageGatewayError(502, 'upstream_too_large', '生图服务返回的数据过大');
  try {
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (Number.isFinite(declared) && declared > limit) throw tooLarge();
    if (!response.body?.getReader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > limit) throw tooLarge();
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        length += chunk.length;
        if (length > limit) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof ImageGatewayError) throw error;
    if (error?.name === 'AbortError') throw new ImageGatewayError(504, 'upstream_timeout', '生图请求超时；为避免重复计费，千幕没有自动重发');
    throw new ImageGatewayError(502, 'upstream_read_error', `读取生图返回失败：${redactText(error?.message || error, [guard?.apiKey])}`);
  } finally {
    guard?.stop?.();
    RESPONSE_GUARDS.delete(response);
  }
}

function redactText(value, secrets = []) {
  let text = String(value || '')
    .replace(/(authorization|api[-_ ]?key|access[-_ ]?token|token|secret)\s*["']?\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[已隐藏]')
    .replace(/(["']?(?:b64_json|base64|data)["']?\s*:\s*["'])[^"']{128,}(["'])/gi, '$1[图片数据]$2');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[已隐藏]');
  return text
    .replace(/data:image\/[\w.+-]+;base64,[a-z0-9+/=]+/gi, '[图片数据]')
    .replace(/(?:[a-z0-9+/]{256,}={0,2})/gi, '[长数据已隐藏]')
    .slice(0, 1600);
}

async function upstreamError(response, request) {
  let detail = '';
  try {
    const buffer = await readLimited(response, 64 * 1024);
    const text = buffer.toString('utf8');
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '') || `上游返回 ${response.status}`;
    } catch (_) { detail = text; }
  } catch (error) {
    if (error?.code === 'upstream_timeout') return error;
  }
  const status = Number(response.status) || 502;
  const retryable = [429, 502, 503, 504].includes(status);
  const gatewayStatus = status === 401 || status === 403 || status === 429 ? status : status >= 400 && status < 500 ? 400 : 502;
  return new ImageGatewayError(gatewayStatus, `upstream_${status}`, redactText(detail || `上游返回 ${status}`, [request.apiKey]), { retryable, upstreamStatus: status });
}

async function fetchUpstream(url, init, request, fetchImpl) {
  const timeout = requestSignal(request.parameters.timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: timeout.signal, redirect: 'error' });
    RESPONSE_GUARDS.set(response, { stop: timeout.stop, apiKey: request.apiKey });
    if (!response.ok) throw await upstreamError(response, request);
    return response;
  } catch (error) {
    timeout.stop();
    if (error instanceof ImageGatewayError) throw error;
    if (error?.name === 'AbortError') throw new ImageGatewayError(504, 'upstream_timeout', '生图请求超时；为避免重复计费，千幕没有自动重发');
    throw new ImageGatewayError(502, 'upstream_network_error', `生图网络请求失败：${redactText(error?.message || error, [request.apiKey])}`);
  }
}

function parseUpstreamJson(buffer) {
  try { return JSON.parse(Buffer.from(buffer).toString('utf8')); }
  catch (_) { throw new ImageGatewayError(502, 'upstream_invalid_json', '生图服务返回了无法识别的数据'); }
}

function safeRemoteImageUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(asString(value, 4096)); }
  catch (_) { throw new ImageGatewayError(502, 'upstream_invalid_image_url', '生图服务返回了无效的图片地址'); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || hostname === 'localhost' || hostname.endsWith('.localhost')
    || (isIP(hostname) && isPrivateAddress(hostname))) {
    throw new ImageGatewayError(502, 'upstream_invalid_image_url', '生图服务返回了不安全的图片地址');
  }
  url.hash = '';
  return url.toString();
}

function normalizeImageData(items, { maxTotalBytes = MAX_UPSTREAM_BYTES } = {}) {
  const images = [];
  let totalBytes = 0;
  for (const [index, rawItem] of items.filter(Boolean).slice(0, 8).entries()) {
    const item = plainObject(rawItem);
    let data = '';
    let mime = asString(item.mime || '', 80).toLowerCase();
    if (item.data) {
      const raw = String(item.data ?? '').trim();
      if (raw.length > Math.ceil(MAX_UPSTREAM_BYTES / 3) * 4 + 256) throw new ImageGatewayError(502, 'upstream_too_large', '生图服务返回的数据过大');
      const match = raw.match(/^data:([^;,]+);base64,(.+)$/s);
      const encoded = String(match?.[2] || raw).replace(/\s+/g, '');
      if (!encoded || encoded.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(encoded) || /=/.test(encoded.slice(0, -2))) {
        throw new ImageGatewayError(502, 'upstream_invalid_image', '生图服务返回了无法识别的图片数据');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
        throw new ImageGatewayError(502, 'upstream_invalid_image', '生图服务返回了无法识别的图片数据');
      }
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes) throw new ImageGatewayError(502, 'upstream_too_large', '生图服务返回的数据过大');
      const detected = imageMime(bytes, '');
      if (!detected) throw new ImageGatewayError(502, 'upstream_invalid_image', '生图服务返回了无法识别的图片数据');
      data = bytes.toString('base64');
      mime = detected;
    }
    const url = data ? '' : safeRemoteImageUrl(item.url);
    if (!data && !url) continue;
    images.push({
      id: asString(item.id || `image-${index + 1}`, 160),
      mime: mime || 'image/png',
      data,
      url,
      width: clampNumber(item.width, 1, 16_384, undefined, true),
      height: clampNumber(item.height, 1, 16_384, undefined, true),
    });
  }
  return images;
}

function imageMime(buffer, fallback = 'image/png') {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  return /^image\/(?:png|jpeg|webp|gif)$/i.test(fallback) ? fallback.toLowerCase() : '';
}

export function extractZipImages(buffer) {
  const data = Buffer.from(buffer);
  const results = [];
  let extractedBytes = 0;
  for (let cursor = 0; cursor <= data.length - 46 && results.length < 8; cursor++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) continue;
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > data.length) break;
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 45 + nameLength + extraLength + commentLength;
    if (!/\.(?:png|jpe?g|webp)$/i.test(name) || localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    const remaining = MAX_UPSTREAM_BYTES - extractedBytes;
    if (end > data.length || !remaining || uncompressedSize > remaining) continue;
    const compressed = data.subarray(start, end);
    let image;
    try { image = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: remaining }) : null; }
    catch (_) { image = null; }
    const mime = image && imageMime(image, '');
    if (!image || !mime || image.length > remaining) continue;
    extractedBytes += image.length;
    results.push({ id: name, mime, data: image.toString('base64') });
  }
  return results;
}

async function generateOpenAI(request, base, fetchImpl) {
  const hasReferences = request.references.length > 0;
  const compatibility = normalizeOpenAIImageCompatibility(request.compatibility);
  const url = endpoint(base, hasReferences ? compatibility.endpoints.edit : compatibility.endpoints.generation);
  let body;
  let headers;
  if (hasReferences) {
    body = new FormData();
    const providerOptions = filterOpenAIProviderOptions(request.parameters.providerOptions, compatibility);
    for (const [key, value] of Object.entries(providerOptions)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) body.append(key, String(value));
    }
    body.append('model', request.model);
    body.append('prompt', combinedPrompt(request));
    if (openAICompatibilityAllows(compatibility, 'n')) body.append('n', String(request.parameters.count));
    if (request.parameters.size && openAICompatibilityAllows(compatibility, 'size')) body.append('size', request.parameters.size);
    if (request.parameters.quality && openAICompatibilityAllows(compatibility, 'quality')) body.append('quality', request.parameters.quality);
    if (request.parameters.background && openAICompatibilityAllows(compatibility, 'background')) body.append('background', request.parameters.background);
    if (request.parameters.outputFormat && openAICompatibilityAllows(compatibility, 'output_format')) body.append('output_format', request.parameters.outputFormat);
    const acceptedReferences = compatibility.referenceField === 'image' ? request.references.slice(0, 1) : request.references;
    for (const reference of acceptedReferences) body.append(compatibility.referenceField, new Blob([Buffer.from(reference.data, 'base64')], { type: reference.mime }), reference.name);
    headers = authHeaders(request, normalizeOpenAICompatibleHeaders(request.customHeaders, compatibility));
  } else {
    const options = {
      ...filterOpenAIProviderOptions(request.parameters.providerOptions, compatibility),
      model: request.model, prompt: combinedPrompt(request),
      ...(openAICompatibilityAllows(compatibility, 'n') ? { n: request.parameters.count } : {}),
      ...(request.parameters.size && openAICompatibilityAllows(compatibility, 'size') ? { size: request.parameters.size } : {}),
      ...(request.parameters.quality && openAICompatibilityAllows(compatibility, 'quality') ? { quality: request.parameters.quality } : {}),
      ...(request.parameters.background && openAICompatibilityAllows(compatibility, 'background') ? { background: request.parameters.background } : {}),
      ...(request.parameters.outputFormat && openAICompatibilityAllows(compatibility, 'output_format') ? { output_format: request.parameters.outputFormat } : {}),
    };
    body = JSON.stringify(options);
    headers = authHeaders(request, { ...normalizeOpenAICompatibleHeaders(request.customHeaders, compatibility), 'Content-Type': 'application/json' });
  }
  const response = await fetchUpstream(url, { method: 'POST', headers, body }, request, fetchImpl);
  const json = parseUpstreamJson(await readLimited(response));
  const responseKinds = new Set(compatibility.responseKinds);
  const images = normalizeImageData((json.data || json.images || json.output || []).map((item) => ({
    data: (responseKinds.has('b64_json') && item.b64_json) || (responseKinds.has('base64') && (item.b64 || item.base64 || item.data)) || '',
    url: responseKinds.has('url') ? item.url || '' : '', mime: item.mime_type || `image/${request.parameters.outputFormat || 'png'}`,
  })));
  return { images, text: '', upstreamId: asString(json.id || response.headers.get('x-request-id'), 240) };
}

async function generateGemini(request, base, fetchImpl) {
  const model = encodeURIComponent(request.model);
  const url = endpoint(base, `models/${model}:generateContent`);
  const parts = [{ text: combinedPrompt(request) }, ...request.references.map((item) => ({ inlineData: { mimeType: item.mime, data: item.data } }))];
  const imageConfig = {
    ...(request.parameters.aspectRatio ? { aspectRatio: request.parameters.aspectRatio } : {}),
    ...(request.parameters.imageSize ? { imageSize: request.parameters.imageSize } : {}),
  };
  const providerOptions = { ...request.parameters.providerOptions };
  const extraGenerationConfig = plainObject(providerOptions.generationConfig);
  delete providerOptions.generationConfig;
  const body = {
    ...providerOptions,
    contents: [{ role: 'user', parts }],
    generationConfig: {
      ...extraGenerationConfig,
      responseModalities: ['TEXT', 'IMAGE'],
      ...(request.parameters.count > 1 ? { candidateCount: request.parameters.count } : {}),
      ...(Object.keys(imageConfig).length ? { imageConfig: { ...plainObject(extraGenerationConfig.imageConfig), ...imageConfig } } : {}),
    },
  };
  const response = await fetchUpstream(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': request.apiKey }, body: JSON.stringify(body) }, request, fetchImpl);
  const json = parseUpstreamJson(await readLimited(response));
  const outputParts = (json.candidates || []).flatMap((candidate) => candidate?.content?.parts || []);
  const images = normalizeImageData(outputParts.filter((item) => item.inlineData || item.inline_data).map((item) => {
    const data = item.inlineData || item.inline_data;
    return { data: data.data, mime: data.mimeType || data.mime_type || 'image/png' };
  }));
  const text = outputParts.map((item) => item.text || '').filter(Boolean).join('\n').slice(0, 8000);
  return { images, text, upstreamId: asString(response.headers.get('x-request-id'), 240) };
}

async function generateSeedream(request, base, fetchImpl) {
  const url = endpoint(base, 'images/generations');
  const body = {
    ...request.parameters.providerOptions,
    model: request.model,
    prompt: combinedPrompt(request),
    response_format: 'b64_json',
    ...(request.parameters.size ? { size: request.parameters.size } : {}),
    ...(request.parameters.seed !== undefined ? { seed: request.parameters.seed } : {}),
    ...(request.parameters.guidanceScale !== undefined ? { guidance_scale: request.parameters.guidanceScale } : {}),
    watermark: request.parameters.watermark,
    ...(request.parameters.sequential || request.parameters.count > 1 ? {
      sequential_image_generation: 'auto',
      sequential_image_generation_options: {
        ...plainObject(request.parameters.providerOptions.sequential_image_generation_options),
        max_images: request.parameters.count,
      },
    } : {}),
    ...(request.references.length ? {
      image: request.references.length === 1
        ? `data:${request.references[0].mime};base64,${request.references[0].data}`
        : request.references.map((item) => `data:${item.mime};base64,${item.data}`),
    } : {}),
  };
  const response = await fetchUpstream(url, { method: 'POST', headers: authHeaders(request, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) }, request, fetchImpl);
  const json = parseUpstreamJson(await readLimited(response));
  const images = normalizeImageData((json.data || json.images || []).map((item) => ({
    data: item.b64_json || item.b64 || item.base64 || '', url: item.url || '', mime: item.mime_type || 'image/png', width: item.width, height: item.height,
  })));
  return { images, text: '', upstreamId: asString(json.id || json.request_id || response.headers.get('x-request-id'), 240) };
}

async function generateNovel(request, base, fetchImpl) {
  const capabilities = novelModelCapabilities(request.model, request.capabilityModelId);
  const { isV5 } = capabilities;
  const referenceIssue = novelReferenceIssue(capabilities, request.references, request.vibes, request.parameters.providerOptions);
  if (referenceIssue) throw new ImageGatewayError(400, referenceIssue.code, referenceIssue.message);
  const url = endpoint(base, 'ai/generate-image');
  const width = request.parameters.width || 1024;
  const height = request.parameters.height || 1024;
  const providerOptions = { ...request.parameters.providerOptions };
  delete providerOptions.precise_reference;
  const parameters = {
    ...providerOptions,
    width, height,
    n_samples: 1,
    ...(request.parameters.steps !== undefined ? { steps: request.parameters.steps } : {}),
    ...(request.parameters.scale !== undefined ? { scale: request.parameters.scale } : {}),
    ...(request.parameters.seed !== undefined ? { seed: request.parameters.seed } : {}),
    ...(request.parameters.sampler ? { sampler: request.parameters.sampler } : {}),
    ...(request.parameters.scheduler ? { noise_schedule: request.parameters.scheduler } : {}),
    ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    ...(request.vibes.length ? {
      reference_image_multiple: request.vibes.map((item) => item.data),
      reference_strength_multiple: request.vibes.map((item) => item.strength),
      reference_information_extracted_multiple: request.vibes.map((item) => item.information),
    } : {}),
    ...novelPreciseReferenceParameters(request.references),
  };
  if (isV5) {
    delete parameters.reference_image_multiple;
    delete parameters.reference_strength_multiple;
    delete parameters.reference_information_extracted_multiple;
    delete parameters.director_reference_images;
    delete parameters.director_reference_descriptions;
    delete parameters.director_reference_information_extracted;
    delete parameters.director_reference_strength_values;
    delete parameters.director_reference_secondary_strength_values;
  }
  const body = { input: request.prompt, model: request.model, action: 'generate', parameters };
  const response = await fetchUpstream(url, { method: 'POST', headers: authHeaders(request, { 'Content-Type': 'application/json', Accept: 'application/zip,image/*,application/json' }), body: JSON.stringify(body) }, request, fetchImpl);
  const buffer = await readLimited(response);
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  let images = [];
  if (type.includes('zip') || (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50)) images = extractZipImages(buffer);
  else if (type.includes('json')) {
    const json = parseUpstreamJson(buffer);
    images = normalizeImageData((json.data || json.images || []).map((item) => ({ data: item.b64_json || item.base64 || '', url: item.url || '', mime: item.mime_type || 'image/png' })));
  } else images = normalizeImageData([{ data: buffer.toString('base64'), mime: imageMime(buffer, type.split(';')[0] || 'image/png') }]);
  return { images, text: '', upstreamId: asString(response.headers.get('x-request-id'), 240) };
}

async function uploadComfyReference(base, reference, index, request, fetchImpl) {
  const url = endpoint(base, 'upload/image');
  const body = new FormData();
  const extension = reference.mime.includes('jpeg') ? 'jpg' : reference.mime.includes('webp') ? 'webp' : 'png';
  const stem = asString(reference.name, 100).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || `reference-${index + 1}`;
  const uploadName = `qianmu-${randomUUID()}-${stem}.${extension}`;
  body.append('image', new Blob([Buffer.from(reference.data, 'base64')], { type: reference.mime }), uploadName);
  body.append('overwrite', 'false');
  const response = await fetchUpstream(url, { method: 'POST', headers: request.apiKey ? authHeaders(request) : {}, body }, request, fetchImpl);
  const json = parseUpstreamJson(await readLimited(response, 128 * 1024));
  const name = asString(json.name || uploadName, 240);
  const subfolder = asString(json.subfolder, 240).replace(/^\/+|\/+$/g, '');
  return subfolder ? `${subfolder}/${name}` : name;
}

function requestWithinDeadline(request, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ImageGatewayError(504, 'comfy_timeout', 'ComfyUI 工作流等待超时；任务可能仍在服务端运行');
  return { ...request, parameters: { ...request.parameters, timeoutMs: Math.max(1, Math.min(request.parameters.timeoutMs, remaining)) } };
}

async function generateComfy(request, base, fetchImpl, template) {
  const deadline = Date.now() + request.parameters.timeoutMs;
  const comfyClientId = randomUUID();
  const referenceNames = [];
  for (const [index, reference] of request.references.entries()) {
    referenceNames.push(await uploadComfyReference(base, reference, index, requestWithinDeadline(request, deadline), fetchImpl));
  }
  let workflow;
  try { workflow = template.bind(referenceNames); }
  catch (error) { throw new ImageGatewayError(400, error.code, error.message); }
  const promptResponse = await fetchUpstream(endpoint(base, 'prompt'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(request.apiKey ? authHeaders(request) : {}) }, body: JSON.stringify({ prompt: workflow, client_id: comfyClientId }),
  }, requestWithinDeadline(request, deadline), fetchImpl);
  const submitted = parseUpstreamJson(await readLimited(promptResponse, 256 * 1024));
  const promptId = asString(submitted.prompt_id || submitted.promptId, 240);
  if (!promptId) throw new ImageGatewayError(502, 'comfy_missing_prompt_id', 'ComfyUI 未返回任务编号');
  let history;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, request.parameters.pollIntervalMs));
    const pollRequest = requestWithinDeadline(request, deadline);
    const response = await fetchUpstream(endpoint(base, `history/${encodeURIComponent(promptId)}`), { method: 'GET', headers: request.apiKey ? authHeaders(request) : {} }, pollRequest, fetchImpl);
    const json = parseUpstreamJson(await readLimited(response, 4 * 1024 * 1024));
    history = json[promptId] || (json.prompt_id ? json : null);
    if (history?.status?.status_str === 'error') throw new ImageGatewayError(502, 'comfy_execution_failed', 'ComfyUI 工作流执行失败');
    if (history?.outputs && (history?.status?.completed === true || Object.keys(plainObject(history.outputs)).length > 0)) break;
  }
  if (!history?.outputs) throw new ImageGatewayError(504, 'comfy_timeout', 'ComfyUI 工作流等待超时；任务可能仍在服务端运行');
  const descriptors = Object.values(history.outputs).flatMap((output) => [...(output?.images || []), ...(output?.gifs || [])]).slice(0, 8);
  const images = [];
  let imageBytes = 0;
  for (const descriptor of descriptors) {
    const filename = asString(descriptor.filename, 500);
    if (!filename) continue;
    const url = endpoint(base, 'view');
    url.searchParams.set('filename', filename);
    if (descriptor.subfolder) url.searchParams.set('subfolder', asString(descriptor.subfolder, 500));
    if (descriptor.type) url.searchParams.set('type', asString(descriptor.type, 80));
    const response = await fetchUpstream(url, { method: 'GET', headers: request.apiKey ? authHeaders(request) : {} }, requestWithinDeadline(request, deadline), fetchImpl);
    const buffer = await readLimited(response, MAX_UPSTREAM_BYTES - imageBytes);
    const mime = imageMime(buffer, String(response.headers.get('content-type') || '').split(';')[0]);
    if (!mime) throw new ImageGatewayError(502, 'upstream_invalid_image', 'ComfyUI 返回了无法识别的图片数据');
    imageBytes += buffer.length;
    images.push({ id: filename, data: buffer.toString('base64'), mime });
  }
  return { images: normalizeImageData(images), text: '', upstreamId: promptId };
}

export async function generateImage(input, options = {}) {
  let submissionState = 'not_submitted', acceptedWrites = 0;
  const upstreamFetch = options.fetchImpl || fetch;
  const fetchImpl = async (url, init = {}) => {
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(String(init.method || 'GET').toUpperCase());
    if (writes) {
      // An installed service coordinator must durably authorize every write,
      // including provider-internal retries, before any upstream request starts.
      try { await options.beforeSubmit?.(); }
      catch (error) { throw new ImageGatewayError(409, 'image_submission_not_authorized', redactText(error?.message || '生图请求未获授权')); }
      submissionState = 'unknown';
    }
    const response = await upstreamFetch(url, init);
    if (writes) {
      if (response.ok) { acceptedWrites++; submissionState = 'accepted'; }
      else submissionState = [400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)
        ? (acceptedWrites ? 'accepted' : 'rejected') : 'unknown';
    }
    return response;
  };
  try {
    const request = sanitizeImageRequest(input);
    let comfyTemplate;
    if (request.provider === 'comfy') {
      try {
        const references = input.referenceImages || input.references || [];
        if (!Array.isArray(references) || references.length !== request.references.length) throw Object.assign(new Error('参考图数据不完整或数量超限'), { code: 'comfy_reference_count' });
        comfyTemplate = prepareComfyWorkflow(request.parameters.workflow, { ...request, referenceCount: request.references.length });
      } catch (error) { throw new ImageGatewayError(400, error.code, error.message); }
    }
    const validatedBase = await validateGatewayBaseUrl(request.baseUrl, { allowPrivateNetwork: request.allowPrivateNetwork, resolveHost: options.resolveHost || dnsLookup });
    const transportProvider = imageTransportProvider(request.provider, { protocol: request.protocol });
    const base = normalizeProviderBase(validatedBase, transportProvider);
    const startedAt = Date.now();
    let result;
    if (transportProvider === 'openai') result = await generateOpenAI(request, base, fetchImpl);
    else if (request.provider === 'banana') result = await generateGemini(request, base, fetchImpl);
    else if (request.provider === 'seedream') result = await generateSeedream(request, base, fetchImpl);
    else if (request.provider === 'novel') result = await generateNovel(request, base, fetchImpl);
    else result = await generateComfy(request, base, fetchImpl, comfyTemplate);
    if (!result.images?.length) throw new ImageGatewayError(502, 'empty_image_response', '生图服务没有返回可用图片');
    return {
      ok: true,
      provider: request.provider,
      model: request.model,
      images: result.images,
      text: asString(result.text, 8000),
      upstreamId: asString(result.upstreamId, 240),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    if (error && typeof error === 'object') error.submissionState = submissionState;
    throw error;
  }
}

export async function checkImageConnection(input, options = {}) {
  const source = plainObject(input);
  const provider = asString(source.provider, 40).toLowerCase();
  const transportProvider = imageTransportProvider(provider, validateGatewayProtocol(provider, source));
  const definition = IMAGE_GATEWAY_PROVIDERS[provider];
  if (!definition) throw new ImageGatewayError(400, 'unsupported_provider', '不支持的图像供应商');
  const apiKey = asString(source.apiKey, 2048);
  if (definition.requiresKey && !apiKey) throw new ImageGatewayError(400, 'missing_api_key', '请先填写 API Key');
  const allowPrivateNetwork = provider === 'comfy' && source.allowPrivateNetwork === true;
  const validatedBase = await validateGatewayBaseUrl(source.baseUrl || definition.defaultBaseUrl, { allowPrivateNetwork, resolveHost: options.resolveHost || dnsLookup });
  const base = normalizeProviderBase(validatedBase, transportProvider);
  const model = asString(source.model, 240);
  const compatibility = transportProvider === 'openai' ? normalizeOpenAIImageCompatibility(source.compatibility) : null;
  if (transportProvider === 'openai' && compatibility.modelDiscovery === 'off') {
    return { ok: true, provider, model, verified: false, transport: 'configured', message: '未执行连接探测，请以生图验证' };
  }
  let url;
  let headers = {};
  if (provider === 'comfy') url = endpoint(base, 'system_stats');
  else if (provider === 'novel') {
    url = base.hostname.toLowerCase() === 'image.novelai.net'
      ? new URL('https://api.novelai.net/user/subscription')
      : endpoint(base, 'models');
    headers = authHeaders({ apiKey });
  }
  else if (transportProvider === 'banana') {
    const isOfficialGemini = base.hostname.toLowerCase() === 'generativelanguage.googleapis.com';
    url = endpoint(base, isOfficialGemini && model ? `models/${encodeURIComponent(model)}` : 'models');
    headers = { 'x-goog-api-key': apiKey };
  }
  else {
    url = endpoint(base, compatibility?.endpoints.models || 'models');
    headers = authHeaders({ apiKey }, normalizeOpenAICompatibleHeaders(source.customHeaders, compatibility));
  }
  const request = { apiKey, parameters: { timeoutMs: 20_000 } };
  try {
    const response = await fetchUpstream(url, { method: 'GET', headers }, request, options.fetchImpl || fetch);
    await readLimited(response, 2 * 1024 * 1024);
    return { ok: true, provider, model, verified: true, message: '连接通过' };
  } catch (error) {
    // NAI 官方与部分兼容站会允许生图，却不开放订阅/模型探测接口。404 能证明地址可达，
    // 但不能证明令牌有效；与实际生图分开说明，避免把可用连接误判为失败。
    if (provider === 'novel' && Number(error?.upstreamStatus) === 404) {
      return { ok: true, provider, model, verified: false, message: '地址可达，请以生图验证' };
    }
    if (transportProvider === 'openai' && Number(error?.upstreamStatus) === 404 && compatibility.modelDiscovery !== 'required') {
      return { ok: true, provider, model, verified: false, message: '地址可达，请以生图验证' };
    }
    throw error;
  }
}

export async function listImageModels(input, options = {}) {
  const source = plainObject(input);
  const provider = asString(source.provider, 40).toLowerCase();
  const transportProvider = imageTransportProvider(provider, validateGatewayProtocol(provider, source));
  const definition = IMAGE_GATEWAY_PROVIDERS[provider];
  if (!definition) throw new ImageGatewayError(400, 'unsupported_provider', '不支持的图像供应商');
  const apiKey = asString(source.apiKey, 2048);
  if (definition.requiresKey && !apiKey) throw new ImageGatewayError(400, 'missing_api_key', '请先填写 API Key');
  const allowPrivateNetwork = provider === 'comfy' && source.allowPrivateNetwork === true;
  const validatedBase = await validateGatewayBaseUrl(source.baseUrl || definition.defaultBaseUrl, {
    allowPrivateNetwork,
    resolveHost: options.resolveHost || dnsLookup,
  });
  const base = normalizeProviderBase(validatedBase, transportProvider);
  const compatibility = transportProvider === 'openai' ? normalizeOpenAIImageCompatibility(source.compatibility) : null;
  if (transportProvider === 'openai' && compatibility.modelDiscovery === 'off') {
    return finalizeModelList(provider, [], { source: 'disabled' });
  }
  const request = { apiKey, parameters: { timeoutMs: 20_000 } };
  const fetchImpl = options.fetchImpl || fetch;

  if (provider === 'novel' && base.hostname.toLowerCase() === 'image.novelai.net') {
    return finalizeModelList(provider, NOVEL_STATIC_MODELS.map(([id, label]) => ({ id, label, imageCapable: true, kind: 'model' })), { source: 'builtin' });
  }

  if (provider === 'comfy') {
    const response = await fetchUpstream(endpoint(base, 'object_info'), {
      method: 'GET', headers: apiKey ? authHeaders({ apiKey }) : {},
    }, request, fetchImpl);
    const json = parseUpstreamJson(await readLimited(response, 24 * 1024 * 1024));
    return modelsFromComfyObjectInfo(json);
  }

  const headers = transportProvider === 'banana'
    ? { 'x-goog-api-key': apiKey }
    : authHeaders({ apiKey }, transportProvider === 'openai' ? normalizeOpenAICompatibleHeaders(source.customHeaders, compatibility) : {});
  return collectImageModelPages(provider, async (nextPageToken) => {
    const url = endpoint(base, transportProvider === 'openai' ? compatibility.endpoints.models : 'models');
    if (transportProvider === 'banana') {
      url.searchParams.set('pageSize', '1000');
      if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
    }
    const response = await fetchUpstream(url, { method: 'GET', headers }, request, fetchImpl);
    return parseUpstreamJson(await readLimited(response, 4 * 1024 * 1024));
  }, { transportProvider });
}

export function imageGatewayErrorPayload(error) {
  const source = error instanceof ImageGatewayError ? error : new ImageGatewayError(500, 'image_gateway_error', redactText(error?.message || error));
  const status = Number.isInteger(source.status) && source.status >= 400 && source.status <= 599 ? source.status : 500;
  return {
    status,
    body: {
      ok: false,
      code: asString(source.code, 120) || 'image_gateway_error',
      message: redactText(source.message),
      retryable: Boolean(source.retryable),
      upstreamStatus: source.upstreamStatus || undefined,
      ...(['not_submitted', 'rejected', 'unknown', 'accepted'].includes(error?.submissionState) ? { submissionState: error.submissionState } : {}),
    },
  };
}
