// Engine-specific reference policy. No archive lookup, image decode or network at import time.
import {normalizeStaticReferenceReceipt} from './qianmu-comfy-reference-contract.js';
export const characterReferenceError = message => Object.assign(new Error(message),{code:'character_reference',submissionState:'not_submitted',retryable:false});
const fail = message => { throw characterReferenceError(message); };
export function normalizeCharacterReferenceSettings(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) fail('角色参考设置无效');
  const amount = (key,fallback) => {
    const raw = value?.[key];
    if (raw == null) return fallback;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) fail('参考强度与保真度须在 0～1 之间');
    return raw;
  };
  return {strength:amount('strength',0.6),fidelity:amount('fidelity',1)};
}
export function normalizeCharacterReferenceSnapshot(value) {
  if (!value || typeof value !== 'object' || value.version !== 1
    || typeof value.namespace !== 'string' || !/^st-user:.+/.test(value.namespace) || value.namespace.length > 512
    || /[\u0000-\u001f\u007f]/.test(value.namespace) || !Object.hasOwn(value,'reference')) fail('角色参考快照无效');
  return {version:1,namespace:value.namespace,reference:value.reference == null ? null : normalizeStaticReferenceReceipt(value.reference),
    ...normalizeCharacterReferenceSettings(value)};
}
export function planCharacterReference({source,enabled,capabilities={},shot={},hasVibes=false,safetyAdapted=false}={}) {
  if (!enabled || shot.characterReferenceDisabled === true) return null;
  if (source !== 'novel' || !capabilities.preciseReference) fail('当前模型不支持角色精确参考，请关闭角色参考或切换至 NAI V4.5');
  const characters = shot.characters || [];
  if (!characters.length) return {version:1,status:'no_subject'};
  const subjectId = shot.primarySubjectId || (characters.length === 1 ? characters[0].id : '');
  const matches = characters.filter(character => character.id === subjectId);
  if (matches.length !== 1) fail('本镜缺少唯一主视觉人物，请重新提取或在图片编辑中指定');
  const character = matches[0], archive = character.archiveSnapshot;
  if (!archive) return {version:1,status:'no_reference',subjectId};
  if (archive.invalid || archive.subjectId !== subjectId || !Object.hasOwn(archive,'imageReference')) fail('本镜未保存有效参考快照，请重新提取或选择不使用参考');
  const saved = normalizeCharacterReferenceSnapshot(archive.imageReference);
  if (!saved.reference) return {version:1,status:'no_reference',subjectId};
  if (hasVibes) fail('角色精确参考与 Vibe 不能同时使用，请选择一种');
  if (safetyAdapted || shot.sensitive && capabilities.contentPolicy === 'filtered') fail('安全适配镜头不能自动携带原人物参考，请选择不使用参考');
  return {version:1,status:'selected',subjectId,...saved};
}
export function characterReferenceNotice(plan) {
  return plan?.status === 'no_subject' ? '空镜不使用角色参考' : plan?.status === 'no_reference' ? '主视觉人物未配置参考，使用文字形象' : '';
}
export function characterReferenceChoice(shot={}) {
  return shot.characterReferenceDisabled === true || !shot.characters?.length ? '__none__' : shot.primarySubjectId || (shot.characters.length === 1 ? shot.characters[0].id : '');
}
export function renderCharacterReferencePicker(shot={}) {
  const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const choice = characterReferenceChoice(shot);
  return `<label><span>主参考人物</span><select class="text_pole sd-character-reference-picker"><option value="" disabled ${choice ? '' : 'selected'}>选择主参考人物</option><option value="__none__" ${choice === '__none__' ? 'selected' : ''}>不使用参考</option>${(shot.characters || []).map(character => `<option value="${escape(character.id)}" ${choice === character.id ? 'selected' : ''}>${escape(character.name || character.id)}</option>`).join('')}</select></label>`;
}
export function applyCharacterReferenceChoice(shot,choice) {
  if (choice === '__none__') return {...shot,characterReferenceDisabled:true};
  if (!(shot.characters || []).some(character => character.id === choice)) fail('请选择本镜主参考人物，或选择不使用参考');
  return {...shot,primarySubjectId:choice,characterReferenceDisabled:false};
}
export function assertCharacterReferencePlan(saved,expected) {
  const stable = value => JSON.stringify(value,(key,item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name,item[name]])) : item);
  if (stable(saved ?? null) !== stable(expected ?? null)) fail('角色参考配方与镜头快照不一致，请核对原记录');
}
export async function readCharacterReferenceImages(plan,{namespace,guard=async()=>{},read,fetchImpl}={}) {
  if (!plan || plan.status !== 'selected') return [];
  const saved = normalizeCharacterReferenceSnapshot(plan);
  if (namespace !== saved.namespace) fail('参考图属于另一 ST 账户，请在当前账户重新选择');
  await guard();
  const reader = read || (await import('./qianmu-comfy-references.js')).readStaticReferenceImages;
  await guard();
  const images = await reader([saved.reference],{guard,fetchImpl});
  await guard();
  return images.map(image => ({...image,referenceType:'character',strength:saved.strength,fidelity:saved.fidelity,information:1}));
}
