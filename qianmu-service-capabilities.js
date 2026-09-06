import { IMAGE_MODEL_BINDING_VERSION, IMAGE_PROTOCOL_BINDING_VERSION, IMAGE_COMPATIBLE_PROTOCOLS, resolveImageProtocolBinding } from './qianmu-image-models.js';

export const QIANMU_OPTIONAL_SERVICE_ENDPOINT = '/api/plugins/qianmu-tts/health';
export const QIANMU_IMAGE_CAPABILITIES_ENDPOINT = '/api/plugins/qianmu-tts/image/capabilities';

function cleanServiceList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 24)
    : [];
}

function result(status, details = {}) {
  return {
    status,
    available: status === 'ready',
    plugin: String(details.plugin || ''),
    version: String(details.version || ''),
    services: cleanServiceList(details.services),
    message: String(details.message || ''),
    checkedAt: Date.now(),
  };
}

export async function probeQianmuOptionalService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return result('unsupported', { message: '当前环境不支持服务检测' });
  const timeoutMs = Math.min(15000, Math.max(1000, Number(options.timeoutMs) || 5000));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(options.endpoint || QIANMU_OPTIONAL_SERVICE_ENDPOINT, {
      method: 'GET',
      headers: options.headers || {},
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (response.status === 404) return result('missing', { message: '未安装可选增强服务' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true || body?.plugin !== 'qianmu-tts') {
      return result('error', { message: body?.message || `服务响应异常（${response.status}）` });
    }
    return result('ready', body);
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return result('error', { message: timedOut ? '服务检测超时' : '增强服务暂不可达' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function imageCapabilityResult(status, body = {}) {
  const novel = body.modelBinding?.providers?.novel;
  const ids = Array.isArray(novel?.capabilityModelIds)
    ? [...new Set(novel.capabilityModelIds.slice(0, 128).filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 240 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id)))].slice(0, 64) : [];
  const protocolProviders = {};
  if (status === 'ready' && body.protocolBinding?.version === IMAGE_PROTOCOL_BINDING_VERSION) {
    for (const [provider, protocols] of Object.entries(IMAGE_COMPATIBLE_PROTOCOLS)) {
      const supported = body.protocolBinding?.providers?.[provider];
      if (Array.isArray(supported)) protocolProviders[provider] = protocols.filter(protocol => supported.includes(protocol));
    }
  }
  return {
    status, checkedAt: Date.now(),
    serviceVersion: typeof body.serviceVersion === 'string' ? body.serviceVersion.slice(0, 80) : '',
    bindingVersion: status === 'ready' ? IMAGE_MODEL_BINDING_VERSION : 0,
    novel: status === 'ready' && novel?.protocol === 'novelai' ? { protocol: 'novelai', capabilityModelIds: ids } : null,
    protocolBinding: { version: status === 'ready' && body.protocolBinding?.version === IMAGE_PROTOCOL_BINDING_VERSION ? IMAGE_PROTOCOL_BINDING_VERSION : 0, providers: protocolProviders },
  };
}

// Fresh, read-only, same-origin inspection. Never send an upstream API key or attempt generation.
export async function probeQianmuImageCapabilities(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function' || typeof AbortController !== 'function') return imageCapabilityResult('unsupported');
  const timeoutMs = Math.min(15000, Math.max(1000, Number(options.timeoutMs) || 5000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(QIANMU_IMAGE_CAPABILITIES_ENDPOINT, {
      method: 'GET', headers: options.headers || {}, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 404) return imageCapabilityResult('missing');
    if (!response.ok) return imageCapabilityResult(response.status === 401 || response.status === 403 ? 'unauthorized' : 'error');
    const body = await response.json().catch(() => null);
    if (!body || body.ok !== true || body.version !== 3 || body.plugin !== 'qianmu-tts' || body.modelBinding?.version !== IMAGE_MODEL_BINDING_VERSION) {
      return imageCapabilityResult('incompatible');
    }
    return imageCapabilityResult('ready', body);
  } catch (error) {
    return imageCapabilityResult(error?.name === 'AbortError' ? 'timeout' : 'error');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function checkQianmuImageModelBinding(capabilities, identity) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (capabilities?.status === 'missing') return fail('image_gateway_missing', '未检测到支持模型绑定的增强服务，请安装或更新后重启 ST');
  if (capabilities?.status === 'unauthorized') return fail('image_gateway_unauthorized', '无法读取增强服务能力，请检查 ST 登录或访问权限');
  if (['error', 'timeout', 'unsupported'].includes(capabilities?.status)) return fail('image_gateway_unavailable', '增强服务能力检测失败，未转发生图；请稍后重试');
  if (capabilities?.status !== 'ready' || capabilities.bindingVersion !== IMAGE_MODEL_BINDING_VERSION) {
    return fail('image_binding_incompatible', '尚未确认网关支持此模型能力绑定，请同步更新千幕前端与增强服务并重启 ST');
  }
  if (identity?.modelFamily !== 'novel' || identity?.protocol !== 'novelai' || capabilities.novel?.protocol !== 'novelai'
    || !capabilities.novel?.capabilityModelIds?.includes(identity?.capabilityModelId)) {
    return fail('image_capability_unsupported', '增强服务尚未支持所选模型能力档，请更新服务或改用可直连的连接');
  }
  return { ok: true, bindingVersion: IMAGE_MODEL_BINDING_VERSION };
}

// C2d connects this check to the workbench's fresh fallback probe before exposing protocol selection.
export function checkQianmuImageProtocolBinding(capabilities, identity) {
  const fail = (code, message) => ({ ok: false, code, message });
  try { resolveImageProtocolBinding(identity?.modelFamily, identity || {}, { allowCompatible: true }); }
  catch (_) { return fail('image_protocol_unsupported', '此模型系列的连接协议声明无效，未转发生图'); }
  if (capabilities?.status === 'missing') return fail('image_gateway_missing', '未检测到兼容接口增强服务，请安装或更新后重启 ST');
  if (capabilities?.status === 'unauthorized') return fail('image_gateway_unauthorized', '无法读取增强服务能力，请检查 ST 登录或访问权限');
  if (['error', 'timeout', 'unsupported'].includes(capabilities?.status)) return fail('image_gateway_unavailable', '增强服务能力检测失败，未转发生图；请稍后重试');
  const contract = capabilities?.protocolBinding;
  if (capabilities?.status !== 'ready' || contract?.version !== IMAGE_PROTOCOL_BINDING_VERSION
    || identity.imageProtocolVersion !== IMAGE_PROTOCOL_BINDING_VERSION || !contract.providers?.[identity.modelFamily]?.includes(identity.protocol)) {
    return fail('image_protocol_incompatible', '增强服务尚未确认支持此兼容接口，请同步更新千幕与增强服务并重启 ST');
  }
  return { ok: true, imageProtocolVersion: IMAGE_PROTOCOL_BINDING_VERSION };
}
