// Engine-specific character recipes. This module never reads files, contacts Comfy or edits a saved workflow.
import {normalizeStaticReferenceReceipt} from './qianmu-comfy-reference-contract.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const comfyCharacterError = message => Object.assign(new Error(message), {
  code:'comfy_character_binding', submissionState:'not_submitted', retryable:false,
});
const fail = message => { throw comfyCharacterError(message); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const nodeId = value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const boundedText = (value,max) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('Comfy 角色字段格式或长度无效');
  return value.trim();
};
const amount = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100) fail('LoRA 强度须为 -100 至 100 的数字');
  return value;
};
const list = (value,max) => {
  if (!Array.isArray(value) || value.length > max) fail('Comfy 角色配置条目过多或格式无效');
  return value;
};
export function normalizeComfyCharacterWorkflow(value) {
  if (!object(value) || !identifier(value.id) || !identifier(value.revision) || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) fail('请绑定已保存的 Comfy 工作流版本');
  return {id:value.id,revision:value.revision,version:value.version,hash:value.hash};
}
export function normalizeComfyCharacterActivation(value) {
  if (!object(value) || typeof value.namespace !== 'string' || !/^st-user:.+/.test(value.namespace) || value.namespace.length>512 || /[\u0000-\u001f\u007f]/.test(value.namespace)) fail('Comfy 角色启用账户无效，请重新绑定');
  return {namespace:value.namespace,workflow:normalizeComfyCharacterWorkflow(value.workflow)};
}
export function normalizeComfyCharacterImplementation(value) {
  if (!object(value) || value.version !== 1) fail('Comfy 角色实现版本无效');
  const name = boundedText(value.name,80); if (!name) fail('请填写 Comfy 实现名称');
  const workflow = normalizeComfyCharacterWorkflow(value.workflow);
  const referenceSlot = value.referenceSlot;
  if (referenceSlot !== null && (!Number.isInteger(referenceSlot) || referenceSlot < 1 || referenceSlot > 16)) fail('参考槽须为 1 至 16，或明确不使用');
  const occupied = new Set();
  const claim = id => {
    if (!nodeId(id) || occupied.has(id)) fail('角色节点编号无效或重复');
    occupied.add(id); return id;
  };
  const loras = list(value.loras,8).map(row => {
    if (!object(row) || !['LoraLoader','LoraLoaderModelOnly'].includes(row.classType)) fail('请选择受支持的原生 LoRA 节点');
    const loraName = boundedText(row.loraName,512);
    // A model name is relative to Comfy's LoRA catalogue, not a URL, absolute path or arbitrary file request.
    if (!loraName || /[:%?#\\\u0000-\u001f\u007f]/.test(loraName) || loraName.split('/').some(part => !part || part === '.' || part === '..')
      || loraName.includes('%qianmu_')) fail('LoRA 名称须来自 Comfy 模型目录');
    if (row.classType === 'LoraLoaderModelOnly' && row.strengthClip != null) fail('此 LoRA 节点没有 CLIP 强度');
    return {nodeId:claim(row.nodeId),classType:row.classType,loraName,strengthModel:amount(row.strengthModel),
      strengthClip:row.classType === 'LoraLoader' ? amount(row.strengthClip) : null};
  });
  const conditioning = list(value.conditioning,8).map(row => {
    if (!object(row) || !['positive','negative'].includes(row.kind)) fail('请选择角色词的明确用途');
    const text = boundedText(row.text,6000);
    if (!text || text.includes('%qianmu_')) fail('角色节点补充须为普通文字，不能包含工作流槽位');
    return {nodeId:claim(row.nodeId),kind:row.kind,text};
  });
  if (referenceSlot === null && !loras.length && !conditioning.length) fail('请至少配置一个参考槽或角色节点');
  return {version:1,name,workflow,referenceSlot,loras,conditioning};
}
export function normalizeComfyCharacterSettings(value) {
  if (!object(value) || value.version !== 1) fail('Comfy 角色设置版本无效');
  const workflows = new Set();
  const implementations = list(value.implementations,8).map(row => {
    const implementation = normalizeComfyCharacterImplementation(row);
    const key = JSON.stringify([implementation.workflow.id,implementation.workflow.revision]);
    if (workflows.has(key)) fail('同一角色与工作流版本只保留一个实现');
    workflows.add(key); return implementation;
  });
  const result = {version:1,implementations};
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 48 * 1024) fail('Comfy 角色设置超过 48 KB，请精简节点补充');
  return result;
}
export function normalizeComfyCharacterSnapshot(value) {
  if (!object(value) || value.version !== 1 || typeof value.namespace !== 'string' || !/^st-user:.+/.test(value.namespace)
    || value.namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(value.namespace) || !Object.hasOwn(value,'reference')) fail('Comfy 角色快照无效');
  const settings = normalizeComfyCharacterSettings(value);
  return {...settings,namespace:value.namespace,reference:value.reference === null ? null : normalizeStaticReferenceReceipt(value.reference)};
}
