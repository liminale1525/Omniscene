// Read-only legacy /object_info contract inspection. Never execute a workflow or a descriptor's remote route.
import { prepareComfyWorkflow } from './qianmu-comfy-workflow.js';
import { checkComfyConfiguration } from './qianmu-comfy-preflight.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const fail = (code, message) => Object.assign(new Error(message), { code: `comfy_readiness_${code}`, submissionState: 'not_submitted' });
const safeClass = value => typeof value === 'string' && value.length > 0 && value.length <= 180
  && value.trim() === value && !/[\u0000-\u001f\u007f/\\?#%]/.test(value) && value !== '.' && value !== '..';
const label = value => String(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);

export function prepareComfyReadiness(input = {}) {
  const configuration = { ...input, referenceCount: 0, automatic: false };
  checkComfyConfiguration(configuration);
  const graph = prepareComfyWorkflow(input.workflow, { prompt: 'qianmu-readiness-check', negativePrompt: '',
    model: input.model, parameters: input.parameters, referenceCount: 0 }).bind([]);
  const classes = [...new Set(Object.values(graph).map(node => node.class_type))];
  if (classes.length > 64 || classes.some(value => !safeClass(value))) throw fail('node_classes', '节点种类过多或名称不能安全查询，请分段核查工作流');
  return { graph, classes };
}

export function inspectComfyDefinitions(graph, definitions = {}) {
  const issues = []; let issueCount = 0, errors = 0, warnings = 0;
  const add = (severity, code, id, field, message) => {
    issueCount++; if (severity === 'error') errors++; else warnings++;
    if (issues.length < 64) issues.push({ severity, code, nodeId: label(id), field: label(field), message });
  };
  for (const [id, node] of Object.entries(graph)) {
    const definition = own(definitions, node.class_type) ? definitions[node.class_type] : undefined;
    const at = field => `节点 ${label(id)} · ${label(node.class_type)}${field ? ` / ${label(field)}` : ''}`;
    if (!definition) { add('error', 'missing_node', id, '', `${at('')}：未安装或未开放节点定义`); continue; }
    if (!object(definition.input) || !Array.isArray(definition.output) || definition.output.length > 128
      || own(definition.input, 'required') && !object(definition.input.required)
      || own(definition.input, 'optional') && !object(definition.input.optional)
      || Object.keys(definition.input.required || {}).length + Object.keys(definition.input.optional || {}).length > 256) {
      add('warning', 'unknown_definition', id, '', `${at('')}：节点定义格式尚不支持`); continue;
    }
    const required = object(definition.input.required) ? definition.input.required : {};
    const optional = object(definition.input.optional) ? definition.input.optional : {};
    for (const field of Object.keys(required)) if (!own(node.inputs, field)) add('error', 'missing_input', id, field, `${at(field)}：缺少必填输入`);
    for (const [field, value] of Object.entries(node.inputs)) {
      const spec = own(required, field) ? required[field] : own(optional, field) ? optional[field] : undefined;
      if (!Array.isArray(spec) || !spec.length) { add('warning', 'unknown_input', id, field, `${at(field)}：自定义输入待运行时核查`); continue; }
      const type = spec[0], options = object(spec[1]) ? spec[1] : {};
      if (options.remote) { add('warning', 'remote_options', id, field, `${at(field)}：动态选项未读取`); continue; }
      if (Array.isArray(value)) {
        if (value.length !== 2 || typeof value[0] !== 'string' || !Number.isInteger(value[1]) || value[1] < 0 || !own(graph, value[0])) {
          add('error', 'invalid_link', id, field, `${at(field)}：连接格式或来源无效`); continue;
        }
        const sourceNode = graph[value[0]], source = own(definitions, sourceNode.class_type) ? definitions[sourceNode.class_type] : null;
        if (!Array.isArray(source?.output)) { add('warning', 'unknown_link', id, field, `${at(field)}：来源输出尚未核定`); continue; }
        if (value[1] >= source.output.length) { add('error', 'output_index', id, field, `${at(field)}：来源输出序号不存在`); continue; }
        const from = source.output[value[1]];
        if (typeof type !== 'string' || typeof from !== 'string' || type.includes('*') || from.includes('*')) {
          add('warning', 'dynamic_type', id, field, `${at(field)}：动态连接类型待运行时核查`);
        } else if (!from.split(',').some(item => type.split(',').map(item => item.trim()).includes(item.trim()))) {
          add('error', 'type_mismatch', id, field, `${at(field)}：输入与来源输出类型不符`);
        }
        continue;
      }
      if (Array.isArray(type)) {
        if (type.length > 20000 || !type.every(item => ['string', 'number', 'boolean'].includes(typeof item))) add('warning', 'dynamic_options', id, field, `${at(field)}：复杂或过大的选项清单待核查`);
        else if (!type.includes(value)) add('error', 'option_unavailable', id, field, `${at(field)}：所选模型、资源或选项不在当前清单内`);
      } else if (type === 'INT' || type === 'FLOAT') {
        if (typeof value !== 'number' || !Number.isFinite(value) || type === 'INT' && !Number.isSafeInteger(value)
          || Number.isFinite(options.min) && value < options.min || Number.isFinite(options.max) && value > options.max) {
          add('error', 'number_range', id, field, `${at(field)}：数值类型或范围不符`);
        }
      } else if (type === 'STRING' || type === 'BOOLEAN') {
        if (typeof value !== (type === 'STRING' ? 'string' : 'boolean')) add('error', 'value_type', id, field, `${at(field)}：输入类型不符`);
      } else add('warning', 'custom_value', id, field, `${at(field)}：自定义值待运行时核查`);
    }
    if (node.class_type === 'SaveImage' && definition.output_node !== true) add('error', 'output_contract', id, '', `${at('')}：当前实现未声明最终输出能力`);
  }
  return { schemaVersion: 1, ok: true, ready: errors === 0 && warnings === 0, actualGenerationVerified: false,
    nodeCount: Object.keys(graph).length, classCount: new Set(Object.values(graph).map(node => node.class_type)).size,
    errors, warnings, issueCount, issues, message: errors ? `发现 ${errors} 项配置不匹配` : warnings ? `静态核查有 ${warnings} 项待确认` : '节点与模型清单相符；请以生图验证' };
}

export function comfyReadinessBase(value) {
  let base; try { base = new URL(value); } catch (_) { throw fail('address', '请填写有效的 Comfy API 根地址'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw fail('address', 'Comfy 地址仅支持 HTTP/HTTPS，且不能包含账号、查询参数或锚点');
  return base;
}

async function readDefinition(response, budget) {
  const limit = Math.min(1024 * 1024, budget.remaining);
  const tooLarge = () => fail('response_limit', '节点定义清单过大，请缩小工作流后核查');
  if (Number(response.headers?.get?.('content-length')) > limit) { await response.body?.cancel?.(); throw tooLarge(); }
  const reader = response.body?.getReader?.(); let raw = '', bytes = 0;
  if (reader) {
    const parts = [], decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) { await reader.cancel(); throw tooLarge(); }
        parts.push(decoder.decode(value, { stream: true }));
      }
      raw = parts.join('') + decoder.decode();
    } finally { reader.releaseLock(); }
  } else { raw = await response.text(); bytes = new TextEncoder().encode(raw).byteLength; if (bytes > limit) throw tooLarge(); }
  budget.remaining -= bytes;
  try { const value = JSON.parse(raw); if (!object(value)) throw new Error(); return value; }
  catch (_) { throw fail('definition_format', '接口未返回 Comfy 节点定义 JSON，请核对 API 地址及服务类型'); }
}

export async function checkComfyReadiness(input, { fetchImpl = globalThis.fetch, signal, timeoutMs = 20000 } = {}) {
  const { graph, classes } = prepareComfyReadiness(input);
  const base = comfyReadinessBase(input.baseUrl), definitions = Object.create(null);
  const apiKey = String(input.apiKey || '').trim();
  if (apiKey.length > 2048 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw fail('credential', '访问令牌格式无效');
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(100, Math.min(30000, Number(timeoutMs) || 20000)));
  const budget = { remaining: 8 * 1024 * 1024 };
  try {
    for (const name of classes) {
      controller.signal.throwIfAborted();
      const url = new URL(base); url.pathname = `${base.pathname.replace(/\/+$/, '')}/object_info/${encodeURIComponent(name)}`;
      let response;
      try { response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted || String(error?.code || '').startsWith('comfy_readiness_')) throw error; throw fail('transport', '无法读取 Comfy 节点清单，请核对网络、浏览器跨域限制或 ST 转发方式'); }
      if (!response.ok) {
        await response.body?.cancel?.();
        const message = response.status === 401 || response.status === 403 ? 'Comfy 节点清单访问被拒绝，请核对令牌与权限'
          : response.status === 404 ? '当前地址没有节点检查接口，请核对 Comfy 根地址或云平台接口类型'
            : `节点清单读取失败（${Number(response.status) || 0}），未提交生成`;
        throw fail(`http_${Number(response.status) || 0}`, message);
      }
      const data = await readDefinition(response, budget);
      // Returned descriptions, scripts and remote option routes never leave this inspector.
      if (own(data, name) && object(data[name])) definitions[name] = data[name];
    }
    controller.signal.throwIfAborted();
    return inspectComfyDefinitions(graph, definitions);
  } catch (error) {
    if (controller.signal.aborted) throw fail('cancelled', signal?.aborted ? '节点检查已取消' : '节点检查超时，未提交生成');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
