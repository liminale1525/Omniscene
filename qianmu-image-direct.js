// 千幕 · 浏览器生图直连适配层
// 只放置已确认允许浏览器跨域请求的渠道；统一网关仍作为 CORS/网络受限时的回退。

import {
  filterOpenAIProviderOptions,
  normalizeOpenAICompatibleHeaders,
  normalizeOpenAIImageCompatibility,
  openAICompatibilityAllows,
} from './qianmu-openai-image-compat.js';
import { NOVEL_STATIC_MODELS, finalizeModelList, collectImageModelPages, modelsFromComfyObjectInfo, novelModelCapabilities, novelReferenceIssue, novelPreciseReferenceParameters, isImageModelMetadataField } from './qianmu-image-models.js';
import { prepareComfyWorkflow } from './qianmu-comfy-workflow.js';
import { collectComfyStillResults, comfyTaskId, comfyStillMime, comfyReferenceStillMime, readComfyImageBytes } from './qianmu-comfy-results.js';
import { auditComfyWorkflow, requireComfyExecution } from './qianmu-comfy-audit.js';
export { inspectComfyImageExecution, requireComfyExecution } from './qianmu-comfy-audit.js';
import { imageTransportProvider, prepareImageTransportRequest, resolveImageTransportBinding } from './qianmu-image-transport.js';

const MAX_IMAGES = 8;
const NAI_IMAGE_RE = /\.(?:png|jpe?g|webp)$/i;

function validateDirectProtocol(provider, input) {
  try { return resolveImageTransportBinding(provider, input); }
  catch (error) { throw new DirectImageError(error.message, { code: error.code }); }
}

function text(value, max = 24000) {
  return String(value ?? '').trim().slice(0, max);
}

function number(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function mimeFromName(name = '') {
  const lower = String(name).toLowerCase();
  if (/\.jpe?g$/.test(lower)) return 'image/jpeg';
  if (/\.webp$/.test(lower)) return 'image/webp';
  return 'image/png';
}

function bytesToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function providerEndpoint(baseUrl, suffix, provider = '') {
  let url;
  try { url = new URL(text(baseUrl, 2048)); }
  catch (_) { throw new DirectImageError('API 地址无效', { code: 'invalid_base_url' }); }
  if (provider === 'banana' && url.hostname.toLowerCase() === 'generativelanguage.googleapis.com' && /^\/?$/.test(url.pathname)) url.pathname = '/v1beta';
  const cleanSuffix = `/${String(suffix || '').replace(/^\/+/, '')}`;
  const current = url.pathname.replace(/\/+$/, '');
  if (!current.endsWith(cleanSuffix)) url.pathname = `${current}${cleanSuffix}`.replace(/\/{2,}/g, '/');
  return url.toString();
}

function combinedPrompt(input) {
  const prompt = text(input.prompt, 48000), negative = text(input.negativePrompt, 24000);
  return negative ? `${prompt}\n\nExclude from the image: ${negative}`.slice(0, 48000) : prompt;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function directReferences(input) {
  const rows = Array.isArray(input.referenceImages) ? input.referenceImages : Array.isArray(input.references) ? input.references : [];
  return rows.slice(0, 16).map((item, index) => ({
    data: text(item?.data || item?.base64, 24 * 1024 * 1024),
    mime: text(item?.mime || 'image/png', 80),
    name: text(item?.name || `reference-${index + 1}.png`, 160),
  })).filter((item) => item.data);
}

function directParameters(input) {
  const source = plainObject(input.parameters);
  return {
    ...source,
    count: Math.round(number(source.count, 1, 4, 1)),
    providerOptions: Object.fromEntries(Object.entries(plainObject(source.providerOptions)).filter(([key]) => !isImageModelMetadataField(key))),
  };
}

export class DirectImageError extends Error {
  constructor(message, { status = 0, code = 'direct_error', retryable = false, retryAfterMs = 0, submissionState = '' } = {}) {
    super(message);
    this.name = 'DirectImageError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    if (submissionState) this.submissionState = submissionState;
  }
}

export function isDirectImageTransportError(error) {
  return error?.code === 'direct_transport' || error?.name === 'TypeError';
}

export function novelDirectEndpoint(baseUrl, path) {
  const base = text(baseUrl, 2048).replace(/\/+$/, '');
  if (!base) throw new DirectImageError('请先填写 NovelAI API 地址', { code: 'missing_base_url' });
  const segment = text(path, 160).replace(/^\/+/, '');
  if (!segment) return base;
  if (base.endsWith(`/ai/${segment}`) || base.endsWith(`/${segment}`)) return base;
  return `${base}/ai/${segment}`;
}

async function responseError(response, label) {
  const raw = await response.text().catch(() => '');
  let detail = raw.trim();
  try {
    const parsed = JSON.parse(detail);
    detail = text(parsed?.message || parsed?.error?.message || parsed?.error || detail, 500);
  } catch (_) {}
  const labels = {
    400: '请求参数不被生图服务接受',
    401: 'API Key 错误或已失效',
    402: '账户余额或订阅不可用',
    403: 'API Key 没有当前操作权限',
    429: '请求过于频繁，请稍后重试',
  };
  const message = labels[response.status] || `${label}（${response.status}）`;
  const retryAfter = String(response.headers?.get?.('retry-after') || '').trim();
  const retryAfterSeconds = Number(retryAfter);
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(0, retryAfterSeconds * 1000)
    : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 0;
  throw new DirectImageError(detail ? `${message}：${detail}` : message, {
    status: response.status,
    code: `upstream_${response.status}`,
    retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    retryAfterMs,
  });
}

async function directFetch(url, options, fetchImpl) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof DirectImageError || error?.code === 'storyboard_submission_cancelled') throw error;
    throw new DirectImageError(`浏览器直连失败：${error?.message || error}`, { code: 'direct_transport', retryable: true });
  }
}

async function readDirectModelJson(response, limit = 4 * 1024 * 1024) {
  const tooLarge = () => new DirectImageError('模型列表响应过大，请缩小接口返回范围', { code: 'model_list_too_large' });
  if (Number(response.headers?.get?.('content-length')) > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body?.getReader?.();
  let raw = '';
  if (reader) {
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) { await reader.cancel().catch(() => {}); throw tooLarge(); }
        parts.push(decoder.decode(value, { stream: true }));
      }
      raw = parts.join('') + decoder.decode();
    } finally { reader.releaseLock(); }
  } else {
    raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > limit) throw tooLarge();
  }
  try { return JSON.parse(raw); }
  catch (_) { throw new DirectImageError('模型列表未返回有效 JSON', { code: 'invalid_model_list' }); }
}

// Read-only catalog discovery. Choosing a family never guesses another protocol from its URL.
// The selector is connected only after ST2-02's remote-ID/capability binding is in place.
export async function listDirectImageModels(input = {}, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const provider = text(input.provider, 40).toLowerCase();
  if (!['novel', 'openai', 'banana', 'seedream', 'comfy'].includes(provider)) throw new DirectImageError('不支持的模型列表渠道', { code: 'direct_unsupported' });
  const transportProvider = imageTransportProvider(provider, validateDirectProtocol(provider, input));
  const base = new URL(providerEndpoint(input.baseUrl, '', transportProvider));
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new DirectImageError('API 地址需使用 HTTP(S)，且不能嵌入账号密码', { code: 'invalid_base_url' });
  if (input.signal?.aborted) throw new DOMException('已取消模型列表读取', 'AbortError');
  if (provider === 'novel' && base.hostname.toLowerCase() === 'image.novelai.net') {
    return finalizeModelList(provider, NOVEL_STATIC_MODELS.map(([id, label]) => ({ id, label })), { source: 'builtin' });
  }
  const compatibility = normalizeOpenAIImageCompatibility(input.compatibility);
  if (transportProvider === 'openai' && compatibility.modelDiscovery === 'off') return finalizeModelList(provider, [], { source: 'disabled' });
  const apiKey = text(input.apiKey, 2048);
  if (provider !== 'comfy' && !apiKey) throw new DirectImageError('请先填写 API Key', { code: 'missing_api_key' });
  const headers = transportProvider === 'banana' ? { 'x-goog-api-key': apiKey }
    : { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(transportProvider === 'openai' ? normalizeOpenAICompatibleHeaders(input.customHeaders, compatibility) : {}) };
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, number(timeoutMs, 100, 60_000, 20_000));
  const fetchJson = async (url, limit) => {
    const response = await directFetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error', credentials: 'omit' }, fetchImpl);
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      const unavailable = response.status === 404 || response.status === 405;
      const label = unavailable ? '此连接未提供模型列表；仍可手动填写模型名，列表不可用不代表生图失败'
        : response.status === 401 ? '模型列表无权访问，请检查 API Key'
          : response.status === 403 ? '此 Key 没有模型列表权限' : response.status === 429 ? '模型列表请求过于频繁，请稍后再试' : '模型列表读取失败';
      throw new DirectImageError(`${label}（${response.status}）`, { status: response.status, code: unavailable ? 'models_unavailable' : `upstream_${response.status}` });
    }
    return readDirectModelJson(response, limit);
  };
  try {
    if (provider === 'comfy') {
      const json = await fetchJson(providerEndpoint(input.baseUrl, 'object_info', provider), 24 * 1024 * 1024);
      controller.signal.throwIfAborted();
      return modelsFromComfyObjectInfo(json);
    }
    return await collectImageModelPages(provider, (nextPageToken) => {
      const url = new URL(providerEndpoint(input.baseUrl, transportProvider === 'openai' ? compatibility.endpoints.models : 'models', transportProvider));
      if (transportProvider === 'banana') {
        url.searchParams.set('pageSize', '1000');
        if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
      }
      return fetchJson(url.toString());
    }, { signal: controller.signal, transportProvider });
  } catch (error) {
    if (timedOut) throw new DirectImageError('模型列表读取超时，请稍后重试', { code: 'model_list_timeout' });
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
  }
}

export async function checkDirectImageConnection(input = {}, { fetchImpl = globalThis.fetch } = {}) {
  const provider = text(input.provider, 40).toLowerCase();
  if (!['novel', 'openai', 'banana', 'seedream', 'comfy'].includes(provider)) throw new DirectImageError('当前渠道尚未接入浏览器直连检查', { code: 'direct_unsupported' });
  const transportProvider = imageTransportProvider(provider, validateDirectProtocol(provider, input));
  const apiKey = text(input.apiKey, 2048);
  if (provider !== 'comfy' && !apiKey) throw new DirectImageError('请先填写 API Key', { code: 'missing_api_key' });
  let url, headers = {};
  if (provider === 'novel') { url = novelDirectEndpoint(input.baseUrl, 'user/subscription'); headers.Authorization = `Bearer ${apiKey}`; }
  else if (transportProvider === 'banana') { url = providerEndpoint(input.baseUrl, input.model ? `models/${encodeURIComponent(input.model)}` : 'models', provider); headers['x-goog-api-key'] = apiKey; }
  else if (provider === 'comfy') { url = providerEndpoint(input.baseUrl, 'system_stats', provider); if (apiKey) headers.Authorization = `Bearer ${apiKey}`; }
  else {
    const compatibility = normalizeOpenAIImageCompatibility(input.compatibility);
    if (compatibility.modelDiscovery === 'off') {
      providerEndpoint(input.baseUrl, compatibility.endpoints.generation, transportProvider);
      return { ok: true, verified: false, transport: 'configured', message: '未执行连接探测，请以生图验证' };
    }
    url = providerEndpoint(input.baseUrl, compatibility.endpoints.models, transportProvider);
    headers = { Authorization: `Bearer ${apiKey}`, ...normalizeOpenAICompatibleHeaders(input.customHeaders, compatibility) };
  }
  const response = await directFetch(url, { method: 'GET', headers, signal: input.signal }, fetchImpl);
  // 第三方兼容站常常只实现生图端点；探测端点 404 代表地址可达，不再误报成连接失败。
  if (provider === 'novel' && response.status === 404) return { ok: true, verified: false, transport: 'direct', message: '地址可达，请以生图验证' };
  if (transportProvider === 'openai' && response.status === 404 && normalizeOpenAIImageCompatibility(input.compatibility).modelDiscovery !== 'required') return { ok: true, verified: false, transport: 'direct', message: '地址可达，请以生图验证' };
  if (!response.ok) await responseError(response, `${provider} 连接失败`);
  if (provider !== 'novel') return { ok: true, verified: true, transport: 'direct', message: `连接通过 · ${input.model || provider}` };
  const data = await response.json().catch(() => ({}));
  const tier = data?.subscription?.tier ?? data?.tier;
  const active = data?.subscription?.active ?? data?.active;
  const names = ['Free', 'Tablet', 'Scroll', 'Opus'];
  const tierName = Number.isFinite(Number(tier)) ? (names[Number(tier)] || `Tier ${tier}`) : 'NovelAI';
  return { ok: true, verified: true, transport: 'direct', message: `连接通过 · ${tierName}${active === false ? '（订阅未激活）' : ''}` };
}

async function unzipNovelImages(buffer, unzipImpl) {
  if (typeof unzipImpl === 'function') return unzipImpl(buffer);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let cursor = Math.max(0, bytes.length - 65557); cursor <= bytes.length - 22; cursor++) {
    if (view.getUint32(cursor, true) === 0x06054b50) end = cursor;
  }
  if (end < 0) throw new DirectImageError('NovelAI 返回的不是有效 ZIP 图片包', { code: 'invalid_zip' });
  const count = Math.min(view.getUint16(end + 10, true), 128);
  let cursor = view.getUint32(end + 16, true);
  const entries = [];
  const decoder = new TextDecoder('utf-8');
  for (let index = 0; index < count && cursor + 46 <= bytes.length; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!NAI_IMAGE_RE.test(name) || entries.length >= MAX_IMAGES || uncompressedSize > 32 * 1024 * 1024) continue;
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > bytes.length || ![0, 8].includes(method)) continue;
    entries.push({ name, method, compressed: bytes.slice(start, start + compressedSize) });
  }
  const images = [];
  for (const entry of entries) {
    let imageBytes = entry.compressed;
    if (entry.method === 8) {
      if (typeof DecompressionStream !== 'function') throw new DirectImageError('当前浏览器不支持 NovelAI ZIP 解压', { code: 'zip_unavailable' });
      try {
        imageBytes = new Uint8Array(await new Response(new Blob([entry.compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      } catch (_) { throw new DirectImageError('NovelAI ZIP 图片解压失败', { code: 'invalid_zip' }); }
    }
    images.push({ id: entry.name, mime: mimeFromName(entry.name), data: bytesToBase64(imageBytes), url: '' });
  }
  return images;
}

function novelParameters(request) {
  const source = request.parameters && typeof request.parameters === 'object' ? request.parameters : {};
  const providerOptions = source.providerOptions && typeof source.providerOptions === 'object' ? source.providerOptions : {};
  const parameters = { ...providerOptions };
  delete parameters.precise_reference;
  for (const key of Object.keys(parameters)) if (isImageModelMetadataField(key)) delete parameters[key];
  const assign = (key, value) => { if (value !== '' && value !== undefined && value !== null && !Number.isNaN(value)) parameters[key] = value; };
  assign('width', number(source.width, 64, 8192, 1024));
  assign('height', number(source.height, 64, 8192, 1024));
  assign('n_samples', Math.round(number(source.count, 1, 4, 1)));
  assign('steps', source.steps === '' ? undefined : Math.round(number(source.steps, 1, 300, undefined)));
  const scale = source.scale ?? source.cfg;
  assign('scale', scale === '' ? undefined : number(scale, 0, 100, undefined));
  assign('seed', source.seed === '' ? undefined : Math.round(number(source.seed, -1, Number.MAX_SAFE_INTEGER, undefined)));
  assign('sampler', text(source.sampler, 120) || undefined);
  assign('noise_schedule', text(source.scheduler, 120) || undefined);
  assign('negative_prompt', text(request.negativePrompt, 24000) || undefined);
  const vibes = Array.isArray(request.vibes) ? request.vibes.slice(0, 8) : [];
  if (vibes.length) {
    parameters.reference_image_multiple = vibes.map((item) => text(item.data, 24 * 1024 * 1024));
    parameters.reference_strength_multiple = vibes.map((item) => number(item.strength, 0, 2, 0.6));
    parameters.reference_information_extracted_multiple = vibes.map((item) => number(item.information, 0, 1, 1));
  }
  const references = Array.isArray(request.referenceImages) ? request.referenceImages : Array.isArray(request.references) ? request.references : [];
  const prepared = references.slice(0, 16).map((item) => {
    const data = String(item?.data || item?.base64 || '').trim().replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
    if (!data || data.length > 24 * 1024 * 1024 || data.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(data)) throw new DirectImageError('参考图数据无效或过大', { code: 'invalid_reference' });
    return { ...item, data, strength: number(item?.strength, 0, 2, 0.6), information: number(item?.information, 0, 1, 1), fidelity: number(item?.fidelity, 0, 1, 1) };
  });
  Object.assign(parameters, novelPreciseReferenceParameters(prepared));
  return parameters;
}

function novelSingleRequest(input, index = 0) {
  const parameters = { ...plainObject(input.parameters), count: 1 };
  const seed = Number(parameters.seed);
  if (index > 0 && parameters.seed !== '' && parameters.seed !== undefined && Number.isFinite(seed)) {
    parameters.seed = Math.min(Number.MAX_SAFE_INTEGER, Math.max(-1, Math.round(seed) + index));
  }
  return { ...input, parameters };
}

function novelRetryDelay(error, attempt) {
  const requested = Number(error?.retryAfterMs) || 0;
  return Math.min(30000, Math.max(500, requested || 1500 * (2 ** attempt)));
}

async function generateNovelDirect(input, fetchImpl, unzipImpl, waitImpl) {
  const started = Date.now();
  const apiKey = text(input.apiKey, 2048), prompt = text(input.prompt, 48000), model = text(input.model, 240);
  const count = Math.round(number(input.parameters?.count, 1, 4, 1));
  const images = [];
  const requestIds = [];
  for (let index = 0; index < count; index++) {
    const singleInput = novelSingleRequest(input, index);
    let response = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await directFetch(novelDirectEndpoint(input.baseUrl, 'generate-image'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: prompt, model, action: 'generate', parameters: novelParameters(singleInput), use_new_shared_trial: true }),
        signal: input.signal,
      }, fetchImpl);
      if (response.ok) break;
      try { await responseError(response, 'NovelAI 生图失败'); }
      catch (error) {
        if (error?.status !== 429 || attempt >= 2) throw error;
        await waitImpl(novelRetryDelay(error, attempt));
      }
    }
    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
    let received = [];
    if (contentType.includes('json')) received = normalizeJsonImages(await response.json().catch(() => ({})));
    else {
      const buffer = await response.arrayBuffer();
      if (contentType.startsWith('image/')) received = [{ id: `novel-${Date.now()}-${index + 1}`, mime: contentType.split(';')[0], data: bytesToBase64(buffer), url: '' }];
      else received = await unzipNovelImages(buffer, unzipImpl);
    }
    if (!received.length) throw new DirectImageError(`NovelAI 第 ${index + 1} 张未返回可用图片`, { code: 'empty_images' });
    images.push(received[0]);
    const requestId = text(response?.headers?.get?.('x-request-id'), 240);
    if (requestId) requestIds.push(requestId);
  }
  return {
    ok: true, transport: 'direct', images, text: '',
    upstreamId: requestIds.join(',').slice(0, 240), durationMs: Date.now() - started,
    requestCount: count, sequential: true,
  };
}

function normalizeJsonImages(data, compatibility = {}) {
  const profile = normalizeOpenAIImageCompatibility(compatibility);
  const responseKinds = new Set(profile.responseKinds);
  const rows = Array.isArray(data?.images) ? data.images : Array.isArray(data?.data) ? data.data : Array.isArray(data?.output) ? data.output : [];
  return rows.slice(0, MAX_IMAGES).map((item, index) => ({
    id: text(item?.id || `image-${index + 1}`, 160),
    mime: text(item?.mime || item?.mime_type || 'image/png', 80),
    data: text((responseKinds.has('base64') && (item?.data || item?.base64)) || (responseKinds.has('b64_json') && item?.b64_json), 48 * 1024 * 1024),
    url: responseKinds.has('url') ? text(item?.url, 4096) : '',
    width: Number(item?.width) || undefined,
    height: Number(item?.height) || undefined,
  })).filter((item) => item.data || /^https?:\/\//i.test(item.url));
}

async function responseJson(response, label) {
  if (!response.ok) await responseError(response, label);
  try { return await response.json(); }
  catch (_) { throw new DirectImageError(`${label}：返回内容不是有效 JSON`, { status: response.status, code: 'invalid_json' }); }
}

function directResult(images, response, started, extra = {}) {
  if (!images.length) throw new DirectImageError('生图服务没有返回可用图片', { code: 'empty_images' });
  return {
    ok: true, transport: 'direct', images, text: '',
    durationMs: Date.now() - started,
    ...extra,
    upstreamId: text(extra.upstreamId || response?.headers?.get?.('x-request-id'), 240),
  };
}

async function generateOpenAIDirect(input, fetchImpl) {
  const started = Date.now(), parameters = directParameters(input), references = directReferences(input);
  const compatibility = normalizeOpenAIImageCompatibility(input.compatibility);
  const headers = { Authorization: `Bearer ${text(input.apiKey, 2048)}`, ...normalizeOpenAICompatibleHeaders(input.customHeaders, compatibility) };
  let body;
  if (references.length) {
    body = new FormData();
    const providerOptions = filterOpenAIProviderOptions(parameters.providerOptions, compatibility);
    for (const [key, value] of Object.entries(providerOptions)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) body.append(key, String(value));
    }
    body.append('model', input.model);
    body.append('prompt', combinedPrompt(input));
    if (openAICompatibilityAllows(compatibility, 'n')) body.append('n', String(parameters.count));
    if (parameters.size && openAICompatibilityAllows(compatibility, 'size')) body.append('size', String(parameters.size));
    if (parameters.quality && openAICompatibilityAllows(compatibility, 'quality')) body.append('quality', String(parameters.quality));
    if (parameters.background && openAICompatibilityAllows(compatibility, 'background')) body.append('background', String(parameters.background));
    if (parameters.outputFormat && openAICompatibilityAllows(compatibility, 'output_format')) body.append('output_format', String(parameters.outputFormat));
    const acceptedReferences = compatibility.referenceField === 'image' ? references.slice(0, 1) : references;
    for (const reference of acceptedReferences) body.append(compatibility.referenceField, new Blob([base64ToBytes(reference.data)], { type: reference.mime }), reference.name);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      ...filterOpenAIProviderOptions(parameters.providerOptions, compatibility),
      model: input.model, prompt: combinedPrompt(input),
      ...(openAICompatibilityAllows(compatibility, 'n') ? { n: parameters.count } : {}),
      ...(parameters.size && openAICompatibilityAllows(compatibility, 'size') ? { size: parameters.size } : {}),
      ...(parameters.quality && openAICompatibilityAllows(compatibility, 'quality') ? { quality: parameters.quality } : {}),
      ...(parameters.background && openAICompatibilityAllows(compatibility, 'background') ? { background: parameters.background } : {}),
      ...(parameters.outputFormat && openAICompatibilityAllows(compatibility, 'output_format') ? { output_format: parameters.outputFormat } : {}),
    });
  }
  const response = await directFetch(providerEndpoint(input.baseUrl, references.length ? compatibility.endpoints.edit : compatibility.endpoints.generation, 'openai'), {
    method: 'POST', headers, body, signal: input.signal,
  }, fetchImpl);
  const data = await responseJson(response, 'OpenAI 生图失败');
  return directResult(normalizeJsonImages(data, compatibility), response, started, { upstreamId: data.id || '' });
}

async function generateBananaDirect(input, fetchImpl) {
  const started = Date.now(), parameters = directParameters(input), references = directReferences(input);
  const providerOptions = { ...parameters.providerOptions };
  const configured = plainObject(providerOptions.generationConfig);
  delete providerOptions.generationConfig;
  const imageConfig = {
    ...(parameters.aspectRatio ? { aspectRatio: parameters.aspectRatio } : {}),
    ...(parameters.imageSize ? { imageSize: parameters.imageSize } : {}),
  };
  const body = {
    ...providerOptions,
    contents: [{ role: 'user', parts: [
      { text: combinedPrompt(input) },
      ...references.map((item) => ({ inlineData: { mimeType: item.mime, data: item.data } })),
    ] }],
    generationConfig: {
      ...configured,
      responseModalities: ['TEXT', 'IMAGE'],
      ...(parameters.count > 1 ? { candidateCount: parameters.count } : {}),
      ...(Object.keys(imageConfig).length ? { imageConfig: { ...plainObject(configured.imageConfig), ...imageConfig } } : {}),
    },
  };
  const response = await directFetch(providerEndpoint(input.baseUrl, `models/${encodeURIComponent(input.model)}:generateContent`, 'banana'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': text(input.apiKey, 2048) },
    body: JSON.stringify(body), signal: input.signal,
  }, fetchImpl);
  const data = await responseJson(response, 'Banana / Gemini 生图失败');
  const parts = (data.candidates || []).flatMap((candidate) => candidate?.content?.parts || []);
  const images = parts.filter((item) => item.inlineData || item.inline_data).map((item, index) => {
    const image = item.inlineData || item.inline_data;
    return { id: `banana-${index + 1}`, data: text(image.data, 48 * 1024 * 1024), mime: text(image.mimeType || image.mime_type || 'image/png', 80), url: '' };
  }).filter((item) => item.data);
  return directResult(images, response, started, { text: parts.map((item) => text(item.text, 8000)).filter(Boolean).join('\n').slice(0, 8000) });
}

async function generateSeedreamDirect(input, fetchImpl) {
  const started = Date.now(), parameters = directParameters(input), references = directReferences(input);
  const body = {
    ...parameters.providerOptions,
    model: input.model, prompt: combinedPrompt(input), response_format: 'b64_json',
    ...(parameters.size ? { size: parameters.size } : {}),
    ...(parameters.seed !== undefined && parameters.seed !== '' ? { seed: Number(parameters.seed) } : {}),
    ...(parameters.guidanceScale !== undefined && parameters.guidanceScale !== '' ? { guidance_scale: Number(parameters.guidanceScale) } : {}),
    watermark: parameters.watermark === true,
    ...(parameters.sequential || parameters.count > 1 ? {
      sequential_image_generation: 'auto',
      sequential_image_generation_options: {
        ...plainObject(parameters.providerOptions.sequential_image_generation_options), max_images: parameters.count,
      },
    } : {}),
    ...(references.length ? {
      image: references.length === 1
        ? `data:${references[0].mime};base64,${references[0].data}`
        : references.map((item) => `data:${item.mime};base64,${item.data}`),
    } : {}),
  };
  const response = await directFetch(providerEndpoint(input.baseUrl, 'images/generations', 'seedream'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${text(input.apiKey, 2048)}` },
    body: JSON.stringify(body), signal: input.signal,
  }, fetchImpl);
  const data = await responseJson(response, 'Seedream 生图失败');
  return directResult(normalizeJsonImages(data), response, started, { upstreamId: data.id || data.request_id || '' });
}

function directRequestId() {
  return globalThis.crypto?.randomUUID?.() || `qianmu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function generateComfyDirect(input, fetchImpl, waitImpl) {
  const started = Date.now(), parameters = directParameters(input), references = directReferences(input);
  let template, referenceBytes, execution;
  try {
    const rawReferences = input.referenceImages || input.references || [];
    if (!Array.isArray(rawReferences) || references.length !== rawReferences.length) throw Object.assign(new Error('参考图数据不完整或数量超限'), { code: 'comfy_reference_count' });
    template = prepareComfyWorkflow(parameters.workflow || input.workflow, { ...input, parameters, referenceCount: references.length });
    if (Object.hasOwn(input, 'comfyExecution')) {
      const report = auditComfyWorkflow(template.bind(references.map((_,i) => `qianmu-audit-${i}.png`)), input.comfyExecution, { referenceLoadNodeIds: template.referenceLoadNodeIds });
      execution = requireComfyExecution(report, input.comfyExecution);
    }
    let total = 0;
    referenceBytes = references.map(reference => {
      const encoded = reference.data.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
      if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) throw Object.assign(new Error('参考图 Base64 数据无效'), { code: 'invalid_reference' });
      let bytes;
      try { bytes = base64ToBytes(encoded); }
      catch (_) { throw Object.assign(new Error('参考图 Base64 数据无效'), { code: 'invalid_reference' }); }
      total += bytes.byteLength;
      if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024 || total > 48 * 1024 * 1024) throw Object.assign(new Error('参考图单张须小于 16 MB，总计须小于 48 MB'), { code: 'references_too_large' });
      reference.mime = comfyReferenceStillMime(bytes);
      return bytes;
    });
  } catch (error) { throw new DirectImageError(error.message, { code: error.code, submissionState: 'not_submitted' }); }
  const headers = text(input.apiKey, 2048) ? { Authorization: `Bearer ${text(input.apiKey, 2048)}` } : {};
  const referenceNames = [];
  for (const [index, reference] of references.entries()) {
    const form = new FormData();
    const extension = reference.mime.includes('jpeg') ? 'jpg' : reference.mime.includes('webp') ? 'webp' : 'png';
    const name = `qianmu-${directRequestId()}-reference-${index + 1}.${extension}`;
    form.append('image', new Blob([referenceBytes[index]], { type: reference.mime }), name);
    form.append('overwrite', 'false');
    const response = await directFetch(providerEndpoint(input.baseUrl, 'upload/image', 'comfy'), { method: 'POST', headers, body: form, signal: input.signal }, fetchImpl);
    const uploaded = await responseJson(response, 'ComfyUI 参考图上传失败');
    referenceNames.push(uploaded.subfolder ? `${String(uploaded.subfolder).replace(/^\/+|\/+$/g, '')}/${uploaded.name || name}` : uploaded.name || name);
  }
  let workflow;
  try { workflow = template.bind(referenceNames); }
  catch (error) { throw new DirectImageError(error.message, { code: error.code }); }
  const promptResponse = await directFetch(providerEndpoint(input.baseUrl, 'prompt', 'comfy'), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: directRequestId() }), signal: input.signal,
  }, fetchImpl);
  const submitted = await responseJson(promptResponse, 'ComfyUI 工作流提交失败');
  const promptId = comfyTaskId(submitted.prompt_id || submitted.promptId);
  if (!promptId) throw new DirectImageError('ComfyUI 未返回任务编号', { code: 'comfy_missing_prompt_id' });
  try {
    const deadline = Date.now() + number(parameters.timeoutMs, 15000, 300000, 120000);
    const interval = number(parameters.pollIntervalMs, 250, 3000, 700);
    let descriptors = null;
    while (Date.now() < deadline) {
      await waitImpl(interval);
      const response = await directFetch(providerEndpoint(input.baseUrl, `history/${encodeURIComponent(promptId)}`, 'comfy'), { method: 'GET', headers, signal: input.signal }, fetchImpl);
      const data = await responseJson(response, 'ComfyUI 状态读取失败');
      descriptors = collectComfyStillResults(data, promptId, { workflow, execution });
      if (descriptors) break;
    }
    if (!descriptors) throw new DirectImageError('ComfyUI 工作流等待超时；任务可能仍在运行，请核查原任务', { code: 'comfy_timeout' });
    const images = [];
    let imageBytes = 0;
    for (const descriptor of descriptors) {
      const url = new URL(providerEndpoint(input.baseUrl, 'view', 'comfy'));
      url.searchParams.set('filename', descriptor.filename);
      if (descriptor.subfolder) url.searchParams.set('subfolder', descriptor.subfolder);
      if (descriptor.type) url.searchParams.set('type', descriptor.type);
      const response = await directFetch(url.toString(), { method: 'GET', headers, signal: input.signal }, fetchImpl);
      if (!response.ok) await responseError(response, 'ComfyUI 图片读取失败');
      const bytes = await readComfyImageBytes(response, 48 * 1024 * 1024 - imageBytes);
      const mime = comfyStillMime(bytes); imageBytes += bytes.byteLength;
      images.push({ id: text(descriptor.filename, 240), mime, data: bytesToBase64(bytes), url: '' });
    }
    return directResult(images, promptResponse, started, { upstreamId: promptId });
  } catch (cause) {
    const error = cause instanceof DirectImageError || cause?.name === 'AbortError' ? cause : new DirectImageError(cause?.message || 'ComfyUI 收片失败', { code: cause?.code || 'comfy_result_failed' });
    error.upstreamId = promptId;
    throw error;
  }
}

async function probeDirectGenerationTransport(input, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(6000, timeoutMs || 6000)));
  try {
    await checkDirectImageConnection({ ...input, signal: controller.signal }, { fetchImpl: async (url, options) => {
      // Only reachability matters here: an unavailable model/subscription listing does not
      // prove that generation is unauthorized. Do not read an arbitrary probe response body.
      const response = await fetchImpl(url, options);
      try { await response.body?.cancel(); } catch (_) {}
      return { ok: true, status: response.status, json: async () => ({}) };
    } });
  } catch (error) {
    if (input.signal?.aborted) throw Object.assign(new Error('生图已取消，尚未提交'), { name: 'AbortError', submissionState: 'not_submitted' });
    if (!isDirectImageTransportError(error) && error?.name !== 'AbortError') throw error;
    throw new DirectImageError('浏览器连接探测未通过，尚未提交生图', { code: 'direct_transport', submissionState: 'not_submitted' });
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener('abort', cancel);
  }
}

export async function generateDirectImage(input = {}, { fetchImpl = globalThis.fetch, unzipImpl, probeTransport = false, probeTimeoutMs = 6000, beforeSubmit, waitImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const provider = text(input.provider, 40).toLowerCase();
  if (!['novel', 'openai', 'banana', 'seedream', 'comfy'].includes(provider)) throw new DirectImageError('当前渠道尚未接入浏览器直连生图', { code: 'direct_unsupported' });
  const transportProvider = imageTransportProvider(provider, validateDirectProtocol(provider, input));
  try { input = prepareImageTransportRequest(input); }
  catch (error) { throw new DirectImageError(error.message, { code: error.code }); }
  const apiKey = text(input.apiKey, 2048), prompt = text(input.prompt, 48000), model = text(input.model, 240);
  if (provider !== 'comfy' && !apiKey) throw new DirectImageError('请先填写 API Key', { code: 'missing_api_key' });
  if (!prompt) throw new DirectImageError('提示词不能为空', { code: 'empty_prompt' });
  if (provider !== 'comfy' && !model) throw new DirectImageError('请选择生图模型', { code: 'missing_model' });
  if (provider === 'novel') {
    const novelCaps = novelModelCapabilities(input.model, input.capabilityModelId);
    if (!novelCaps.ok) throw new DirectImageError(novelCaps.message, { code: novelCaps.code });
    const referenceIssue = novelReferenceIssue(novelCaps, input.referenceImages || input.references || [], input.vibes || [], plainObject(input.parameters?.providerOptions));
    if (referenceIssue) throw new DirectImageError(referenceIssue.message, { code: referenceIssue.code });
  }
  let probed = false, submissionState = 'not_submitted', acceptedWrites = 0;
  const guardedFetch = async (url, options = {}) => {
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase());
    if (writes) {
      if (probeTransport && !probed) { await probeDirectGenerationTransport(input, fetchImpl, probeTimeoutMs); probed = true; }
      try { await beforeSubmit?.(); }
      catch (error) {
        if (error?.code === 'storyboard_submission_cancelled') error.submissionState = submissionState;
        throw error;
      }
      if (input.signal?.aborted) throw Object.assign(new Error('生图已取消'), { name: 'AbortError', submissionState });
      // A rejected fetch does not establish whether the upstream accepted this write.
      submissionState = 'unknown';
    }
    const response = await fetchImpl(url, options);
    if (writes) {
      if (response.ok) { acceptedWrites++; submissionState = 'accepted'; }
      else submissionState = [400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)
        ? (acceptedWrites ? 'accepted' : 'rejected') : 'unknown';
    }
    return response;
  };
  try {
    if (transportProvider === 'openai') return await generateOpenAIDirect(input, guardedFetch);
    if (provider === 'banana') return await generateBananaDirect(input, guardedFetch);
    if (provider === 'seedream') return await generateSeedreamDirect(input, guardedFetch);
    if (provider === 'comfy') return await generateComfyDirect(input, guardedFetch, waitImpl);
    return await generateNovelDirect(input, guardedFetch, unzipImpl, waitImpl);
  } catch (error) {
    if (error?.submissionState === 'not_submitted') throw error;
    if (submissionState !== 'not_submitted' && (isDirectImageTransportError(error) || error?.name === 'AbortError')) {
      throw Object.assign(new DirectImageError('生图结果未确认，请先核对渠道记录，勿重复生成', { code: 'image_submission_unknown', submissionState: 'unknown' }),
        comfyTaskId(error?.upstreamId) ? { upstreamId: error.upstreamId } : {});
    }
    if (submissionState !== 'not_submitted' && error && typeof error === 'object') error.submissionState ||= submissionState;
    throw error;
  }
}
