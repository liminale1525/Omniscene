// Static accounting for explicitly supported native Comfy nodes, never graph execution.
// Custom implementations, remote billing and runtime assets are not inferred from names.
import { prepareComfyWorkflow } from './qianmu-comfy-workflow.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nodeId = value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `comfy_${code}`, submissionState: 'not_submitted' }); };
const TYPES = {
  CheckpointLoaderSimple:['MODEL','CLIP','VAE'], CheckpointLoader:['MODEL','CLIP','VAE'],
  UNETLoader:['MODEL'], CLIPLoader:['CLIP'], DualCLIPLoader:['CLIP'], TripleCLIPLoader:['CLIP'], VAELoader:['VAE'],
  LoraLoader:['MODEL','CLIP'], LoraLoaderModelOnly:['MODEL'], CLIPSetLastLayer:['CLIP'],
  CLIPTextEncode:['CONDITIONING'], CLIPTextEncodeSDXL:['CONDITIONING'], CLIPTextEncodeSDXLRefiner:['CONDITIONING'], CLIPTextEncodeSD3:['CONDITIONING'],
  ConditioningCombine:['CONDITIONING'], ConditioningConcat:['CONDITIONING'], ConditioningAverage:['CONDITIONING'],
  ConditioningZeroOut:['CONDITIONING'], ConditioningSetArea:['CONDITIONING'], ConditioningSetAreaPercentage:['CONDITIONING'],
  LoadImage:['IMAGE','MASK'],
};
const SOURCES = {EmptyLatentImage:'LATENT',EmptySD3LatentImage:'LATENT',EmptyImage:'IMAGE'};
const PASS = {
  VAEDecode:['samples','LATENT','IMAGE'], VAEDecodeTiled:['samples','LATENT','IMAGE'],
  VAEEncode:['pixels','IMAGE','LATENT'], VAEEncodeTiled:['pixels','IMAGE','LATENT'],
  LatentUpscale:['samples','LATENT','LATENT'], LatentUpscaleBy:['samples','LATENT','LATENT'],
  LatentRotate:['samples','LATENT','LATENT'], LatentFlip:['samples','LATENT','LATENT'], LatentCrop:['samples','LATENT','LATENT'],
  ImageScale:['image','IMAGE','IMAGE'], ImageScaleBy:['image','IMAGE','IMAGE'], ImageInvert:['image','IMAGE','IMAGE'],
  SaveImage:['images','IMAGE','IMAGE'], PreviewImage:['images','IMAGE','IMAGE'],
};
const REPEAT = {RepeatLatentBatch:['samples','LATENT'],RepeatImageBatch:['image','IMAGE']};
const SLICE = {LatentFromBatch:['samples','LATENT'],ImageFromBatch:['image','IMAGE']};
const SAMPLERS = new Set(['KSampler','KSamplerAdvanced']);
const known = type => Object.hasOwn(TYPES,type) || Object.hasOwn(SOURCES,type) || Object.hasOwn(PASS,type)
  || Object.hasOwn(REPEAT,type) || Object.hasOwn(SLICE,type) || SAMPLERS.has(type) || type === 'ImageBatch';
export const COMFY_EXECUTION_VERSION = 1;

export function normalizeComfyExecution(value) {
  if (!object(value) || value.version !== COMFY_EXECUTION_VERSION || typeof value.automatic !== 'boolean'
    || !Array.isArray(value.outputNodeIds) || value.outputNodeIds.length > 8 || value.outputNodeIds.some(id => !nodeId(id))
    || new Set(value.outputNodeIds).size !== value.outputNodeIds.length || !Number.isInteger(value.maxImages) || value.maxImages < 1 || value.maxImages > 8
    || typeof value.allowUnverified !== 'boolean' || (value.automatic && (value.allowUnverified || value.maxImages !== 1))) {
    fail('execution_contract', 'ComfyUI 数量约定无效或版本不兼容，请重新确认工作流');
  }
  return Object.freeze({version:1,automatic:value.automatic,outputNodeIds:Object.freeze([...value.outputNodeIds]),maxImages:value.maxImages,allowUnverified:value.allowUnverified});
}

export function auditComfyWorkflow(value, execution, { referenceLoadNodeIds = [] } = {}) {
  // Internal evidence, not part of the wire policy. Actual adapters verify the
  // uploaded bytes before submitting any graph that uses these node IDs.
  const singleFrames = new Set(referenceLoadNodeIds);
  const policy = normalizeComfyExecution(execution);
  let graph, serialized;
  try { serialized = JSON.stringify(value); if (serialized.length > 2 * 1024 * 1024) throw Error(); graph = JSON.parse(serialized); }
  catch (_) { fail('audit_graph', 'ComfyUI 工作流结构无效或过大'); }
  if (!object(graph) || !Object.keys(graph).length || Object.keys(graph).length > 512) fail('audit_graph', 'ComfyUI 数量核查支持 1 至 512 个 API 节点');
  const dependencies = new Map(), memo = new Map(), visiting = new Set(), unknown = [], roots = [];
  for (const [id,node] of Object.entries(graph)) {
    if (!nodeId(id) || !object(node) || typeof node.class_type !== 'string' || !node.class_type || node.class_type.length > 120 || !object(node.inputs)) fail('audit_graph', 'ComfyUI 需要完整 API 节点与 inputs');
    const links = [];
    for (const item of Object.values(node.inputs)) {
      if (!Array.isArray(item)) continue;
      if (item.length === 2 && typeof item[0] === 'string' && Number.isInteger(item[1])) {
        if (!Object.hasOwn(graph,item[0]) || item[1] < 0 || item[1] > 64) fail('audit_link', 'ComfyUI 工作流含失效节点连接');
        links.push(item[0]);
      } else if (known(node.class_type)) fail('audit_link', 'ComfyUI 原生节点含未识别的列表输入，请核查');
    }
    dependencies.set(id,links);
    if (node.class_type === 'SaveImage' || node.class_type === 'PreviewImage' || !known(node.class_type)) roots.push(id);
    if (!known(node.class_type)) unknown.push({id,type:node.class_type});
  }
  const active = new Set();
  const walk = (id, stack=new Set(), depth=0) => {
    if (stack.has(id) || depth > 128) fail('audit_cycle', 'ComfyUI 节点连接循环或依赖过深');
    if (active.has(id)) return;
    stack.add(id);for (const dependency of dependencies.get(id)) walk(dependency,stack,depth+1);stack.delete(id);active.add(id);
  };
  for (const id of roots) walk(id);
  const outputs = [], samplers = [], uncertainInputs = new Set();
  const literal = (id, key, fallback, minimum=1) => {
    const item = graph[id].inputs[key];
    if (item === undefined) return fallback;
    if (typeof item !== 'number') { uncertainInputs.add(id); return null; }
    if (!Number.isSafeInteger(item) || item < minimum || item > 65536) fail('audit_count', 'ComfyUI 批量数或截取范围无效');
    return item;
  };
  const total = (left,right,multiply=false) => {
    if (left === null || right === null) return null;
    const result = multiply ? left*right : left+right;
    if (!Number.isSafeInteger(result) || result > 65536) fail('audit_count', 'ComfyUI 内部批量超出核查范围');
    return result;
  };
  const source = (id,key,type) => {
    const link = graph[id].inputs[key];
    if (!Array.isArray(link) || link.length !== 2 || typeof link[0] !== 'string' || !Number.isInteger(link[1]) || !Object.hasOwn(graph,link[0])) fail('audit_link', 'ComfyUI 图像/潜空间输入未正确连接');
    if (['SaveImage','PreviewImage'].includes(graph[link[0]].class_type)) fail('audit_link', 'ComfyUI 保存节点不提供图像连接端口');
    const result = resolve(link[0]);
    if (result === null) return null; // Unknown node is never assumed to produce one image.
    if (!result[link[1]] || result[link[1]].type !== type) fail('audit_link', 'ComfyUI 连接端口类型不匹配');
    return result[link[1]].count;
  };
  const resolve = id => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) fail('audit_cycle', 'ComfyUI 节点连接循环');
    visiting.add(id);
    const node = graph[id], type = node.class_type; let result = null, count = null;
    if (Object.hasOwn(TYPES,type)) result = TYPES[type].map(outputType => ({type:outputType,count:type === 'LoadImage' && singleFrames.has(id) ? 1 : null}));
    else if (Object.hasOwn(SOURCES,type)) result = [{type:SOURCES[type],count:literal(id,'batch_size',1)}];
    else if (Object.hasOwn(PASS,type)) {
      const [key,inputType,outputType] = PASS[type];count = source(id,key,inputType);result = [{type:outputType,count}];
    } else if (SAMPLERS.has(type)) {
      count = source(id,'latent_image','LATENT');result = [{type:'LATENT',count}];
      samplers.push({id,batch:count});
    } else if (Object.hasOwn(REPEAT,type)) {
      const [key,inputType] = REPEAT[type];result = [{type:inputType,count:total(source(id,key,inputType),literal(id,'amount',1),true)}];
    } else if (Object.hasOwn(SLICE,type)) {
      const [key,inputType] = SLICE[type], inputCount = source(id,key,inputType), start = literal(id,'batch_index',0,-65536), length = literal(id,'length',1);
      const index = inputCount === null || start === null ? null : Math.max(0,Math.min(inputCount-1,start < 0 ? inputCount+start : start));
      result = [{type:inputType,count:index === null || length === null ? null : Math.min(inputCount-index,length)}];
    } else if (type === 'ImageBatch') result = [{type:'IMAGE',count:total(source(id,'image1','IMAGE'),source(id,'image2','IMAGE'))}];
    visiting.delete(id);memo.set(id,result);return result;
  };
  for (const id of active) {
    const result = resolve(id), type = graph[id].class_type;
    if (type === 'SaveImage') outputs.push({id,count:result[0].count});
    if (type === 'LoadImage' && !singleFrames.has(id)) uncertainInputs.add(id);
  }
  const selectedIds = policy.outputNodeIds.length ? [...policy.outputNodeIds] : outputs.map(row => row.id);
  if (!selectedIds.length) fail('output_selection', '请为工作流选择最终静帧输出节点');
  if (selectedIds.some(id => !Object.hasOwn(graph,id) || (known(graph[id].class_type) && graph[id].class_type !== 'SaveImage'))) fail('output_selection', '所选节点不是可用的最终保存节点');
  const selected = selectedIds.map(id => ({id,count:outputs.find(row => row.id === id)?.count ?? null}));
  const sum = rows => rows.reduce((count,row)=>total(count,row.count),0);
  const savedImages = unknown.length ? null : sum(outputs), selectedImages = sum(selected);
  const unverified = Boolean(unknown.length || uncertainInputs.size || savedImages === null || selectedImages === null || samplers.some(row => row.batch === null));
  const maxSamplerBatch = samplers.some(row => row.batch === null) ? null : Math.max(0,...samplers.map(row => row.batch));
  const tensorCounts = [...memo.values()].flatMap(value => (value || []).filter(row => ['IMAGE','LATENT'].includes(row.type)).map(row => row.count));
  const maxIntermediateBatch = tensorCounts.some(count => count === null) ? null : Math.max(0,...tensorCounts);
  const upstream = id => {
    const found = new Set(), visit = current => { for (const dep of dependencies.get(current)) if (!found.has(dep)) { found.add(dep); visit(dep); } };
    visit(id); return found;
  };
  const samplerAncestors = new Map(samplers.map(row => [row.id,upstream(row.id)]));
  // Sequential refinement is not a variant batch. Independent sampler branches are.
  const singleSamplingChain = samplers.every((row,i) => samplers.slice(i+1).every(other =>
    samplerAncestors.get(row.id).has(other.id) || samplerAncestors.get(other.id).has(row.id)));
  return Object.freeze({version:1,verified:!unverified,outputNodeIds:Object.freeze(selectedIds),selectedImages,savedImages,
    knownSavedImages:outputs.reduce((count,row)=>count+(row.count||0),0),maxSamplerBatch,maxIntermediateBatch,samplingStages:samplers.length,singleSamplingChain,
    automaticSafe:!unverified && selectedImages === 1 && savedImages === 1 && maxSamplerBatch <= 1 && maxIntermediateBatch <= 1 && singleSamplingChain,
    outputs:Object.freeze(outputs),samplers:Object.freeze(samplers),unknownNodes:Object.freeze(unknown),uncertainInputs:Object.freeze([...uncertainInputs])});
}

export function requireComfyExecution(report, execution) {
  const policy = normalizeComfyExecution(execution);
  if (report.knownSavedImages > 8 || (report.selectedImages !== null && report.selectedImages > policy.maxImages)) fail('audit_output_limit','ComfyUI 实际出图超过本次约定，请调整工作流批量或输出节点');
  if (policy.automatic && !report.automaticSafe) fail('automatic_unverified','ComfyUI 尚不能确认一镜一张；请核对内部批量、输入资源与保存节点，自动任务未提交');
  if (!report.verified && !policy.allowUnverified) fail('manual_confirmation_required','工作流包含未核定的节点或动态数量，请核查后仅为本次手动生成确认');
  return Object.freeze({...policy,outputNodeIds:report.outputNodeIds,expectedImages:report.selectedImages});
}

export function inspectComfyImageExecution(input) {
  const template = prepareComfyWorkflow(input.parameters?.workflow || input.workflow, {...input,referenceCount:(input.referenceImages || input.references || []).length});
  const names = Array.from({length:(input.referenceImages || input.references || []).length},(_,i)=>`qianmu-audit-reference-${i+1}.png`);
  return auditComfyWorkflow(template.bind(names),input.comfyExecution,{referenceLoadNodeIds:template.referenceLoadNodeIds});
}
