// Explicit cross-family wire projection. Pure and bounded; native requests are never rewritten.
import { IMAGE_NATIVE_PROTOCOLS, isImageModelMetadataField, resolveImageProtocolBinding } from './qianmu-image-models.js';
import { normalizeOpenAIImageCompatibility, normalizeOpenAICompatibleHeaders } from './qianmu-openai-image-compat.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const present = value => value !== undefined && value !== null && value !== '';
function fail(message, code = 'image_protocol_parameters') { throw Object.assign(new Error(message), { code }); }

export function imageTransportProvider(provider, binding) {
  return binding.protocol === 'openai-images' ? 'openai' : provider;
}

export function resolveImageTransportBinding(provider, input) {
  const binding = resolveImageProtocolBinding(provider, input, { allowCompatible: true });
  if (binding.protocol !== IMAGE_NATIVE_PROTOCOLS[provider]) {
    // Never fall back to the family's native host after switching its wire format.
    let url;
    try { url = new URL(input.baseUrl); } catch (_) { fail('请填写兼容接口的 API 地址', 'invalid_base_url'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      fail('兼容接口地址需使用 HTTP(S)，且不能嵌入凭据、查询参数或锚点', 'invalid_base_url');
    }
  }
  return binding;
}

function compatibleReferences(input, compatibility) {
  const rows = input.referenceImages ?? input.references ?? [];
  if (!Array.isArray(rows) || rows.length > 16 || (compatibility.referenceField === 'image' && rows.length > 1)) {
    fail('当前接口的参考图数量不匹配，请调整参考选择', 'image_protocol_references');
  }
  let bytes = 0;
  return rows.map((item, index) => {
    const source = object(item), raw = source.data ?? source.base64;
    if (typeof raw !== 'string' || raw.length > 24 * 1024 * 1024) fail('参考图数据无效或过大', 'image_protocol_references');
    const uri = raw.match(/^data:(image\/(?:png|jpeg|webp));base64,/i);
    const data = (uri ? raw.slice(uri[0].length) : raw).trim();
    if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail('参考图不是有效的 Base64 图片', 'image_protocol_references');
    let binary;
    try { binary = atob(data); } catch (_) { fail('参考图不是有效的 Base64 图片', 'image_protocol_references'); }
    bytes += binary.length;
    if (binary.length > 16 * 1024 * 1024 || bytes > 48 * 1024 * 1024) fail('参考图超出单张 16 MB 或总计 48 MB 限制', 'image_protocol_references');
    const mime = binary.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
      : binary.startsWith('\xff\xd8') ? 'image/jpeg'
        : binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP' ? 'image/webp' : '';
    const declared = String(source.mime || uri?.[1] || mime).toLowerCase();
    if (!mime || declared !== mime || (uri && uri[1].toLowerCase() !== mime)) fail('参考图格式不匹配，仅支持 PNG、JPEG、WebP', 'image_protocol_references');
    return { data, mime, name: String(source.name || `reference-${index + 1}.${mime.split('/')[1]}`).trim().slice(0, 160) };
  });
}

export function prepareImageTransportRequest(input) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const binding = resolveImageTransportBinding(provider, input);
  if (binding.protocol === IMAGE_NATIVE_PROTOCOLS[provider]) return input;
  if (Object.hasOwn(input, 'modelBindingVersion')) fail('NAI 模型绑定声明不能用于其他系列接口');
  if (present(input.parameters) && (typeof input.parameters !== 'object' || Array.isArray(input.parameters))) fail('兼容接口参数必须是对象');
  const compatibility = normalizeOpenAIImageCompatibility(input.compatibility);
  const source = object(input.parameters), parameters = {};
  const allowed = new Set(['size', 'width', 'height', 'quality', 'background', 'outputFormat', 'count', 'providerOptions', 'timeoutMs', 'pollIntervalMs']);
  for (const [key, value] of Object.entries(source)) {
    if (!allowed.has(key) && present(value)) fail('当前接口不支持已设置的原生参数，请使用兼容接口参数');
  }
  if ((input.vibes?.length || Object.keys(object(input.vibes)).length) || present(input.mask) || present(input.maskImage)
    || (present(input.workflow) && (typeof input.workflow !== 'object' || Object.keys(input.workflow).length))) fail('当前兼容接口不支持 Vibe、遮罩或工作流输入');
  const text = (value, max, label) => {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max || /[\u0000\u007f]/.test(value)) fail(`${label}无效或过长`);
    return value.trim();
  };
  const prompt = text(input.prompt, 32000, '画面描述'), negativePrompt = text(input.negativePrompt, 16000, '排除描述');
  if (!prompt) fail('提示词不能为空', 'empty_prompt');
  if ((negativePrompt ? `${prompt}\n\nExclude from the image: ${negativePrompt}` : prompt).length > 32000) fail('画面与排除描述合计过长，请缩短后生成');
  const model = text(input.model, 240, '实际模型名');
  if (!model || /[\u0000-\u001f\u007f]/.test(model)) fail('请选择有效的实际生图模型', 'missing_model');
  const count = present(source.count) ? Number(source.count) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) fail('当前兼容接口单次数量须为 1～4');
  if (!compatibility.allowedParameters.includes('n') && count !== 1) fail('当前接口未启用多图参数');
  parameters.count = count;
  let size = text(source.size, 40, '画幅');
  if (present(source.width) || present(source.height)) {
    const width = Number(source.width), height = Number(source.height);
    if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 8192)) fail('请提供完整且有效的宽高');
    const dimensions = `${width}x${height}`;
    if (size && size !== dimensions) fail('画幅与宽高不一致，请保留一种设置');
    size = dimensions;
  }
  // Relay sizes such as 2K are allowed only as explicitly declared size values, never inferred.
  const fields = { size, quality: text(source.quality, 40, '质量'), background: text(source.background, 40, '背景'), output_format: text(source.outputFormat, 20, '输出格式').toLowerCase() };
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;
    if (!compatibility.allowedParameters.includes(key)) fail('当前接口能力档未启用所设置的参数');
    parameters[key === 'output_format' ? 'outputFormat' : key] = value;
  }
  const options = object(source.providerOptions), providerOptions = {};
  const reserved = new Set(['n', 'size', 'quality', 'background', 'output_format', 'input', 'url', 'baseurl', 'headers', 'constructor', 'prototype']);
  for (const [key, value] of Object.entries(options)) {
    if (isImageModelMetadataField(key)) continue;
    if (!compatibility.providerOptionKeys.includes(key) || reserved.has(key.toLowerCase()) || value === undefined
      || !(value === null || ['string', 'number', 'boolean'].includes(typeof value)) || (typeof value === 'number' && !Number.isFinite(value))) {
      fail('高级参数未声明或格式不适用于当前接口');
    }
    providerOptions[key] = value;
  }
  if (new TextEncoder().encode(JSON.stringify(providerOptions)).length > 64 * 1024) fail('高级参数过大');
  parameters.providerOptions = providerOptions;
  // Local transport timing is not an upstream model parameter.
  for (const key of ['timeoutMs', 'pollIntervalMs']) if (present(source[key])) parameters[key] = source[key];
  return { ...input, ...binding, model, prompt, negativePrompt, compatibility, parameters,
    customHeaders: normalizeOpenAICompatibleHeaders(input.customHeaders, compatibility),
    referenceImages: compatibleReferences(input, compatibility), references: undefined,
  };
}
