// New image-generation identities. Never revive the retired characters/entities settings.
import { normalizeStaticReferenceReceipt } from './qianmu-comfy-reference-contract.js';
import { normalizeCharacterReferenceSettings } from './qianmu-character-reference.js';
import { normalizeComfyCharacterSettings } from './qianmu-comfy-character-contract.js';
export const CHARACTER_ARCHIVE_SCHEMA = 'qianmu.character.archive.v1';
export const CHARACTER_CATEGORIES = Object.freeze(['char', 'user', 'other']);
export const characterArchiveError = (code, message) => Object.assign(new Error(message), { code: `character_archive_${code}` });
const fail = (code, message) => { throw characterArchiveError(code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000\u0008\u000b\u000c]/.test(value)) fail('field', '档案字段格式或长度无效');
  return value.trim();
};
export function normalizeCharacterArchive(value) {
  if (!object(value) || value.schema !== CHARACTER_ARCHIVE_SCHEMA || !CHARACTER_CATEGORIES.includes(value.category)) fail('schema', '角色档案版本或分类无效');
  const name = text(value.name, 80); if (!name) fail('name', '请填写档案名');
  if (!Array.isArray(value.aliases) || value.aliases.length > 24) fail('aliases', '别名最多 24 个');
  const aliases = [...new Set(value.aliases.map(item => text(item, 80)).filter(Boolean))];
  const imagegen = object(value.imagegen) ? value.imagegen : {};
  const reference=imagegen.reference == null ? null : normalizeStaticReferenceReceipt(imagegen.reference);
  const preview=imagegen.preview == null ? null : normalizeStaticReferenceReceipt(imagegen.preview);
  if(preview&&(!reference||imagegen.preview.sourceSha256!==reference.sha256||preview.bytes>256*1024))fail('preview','档案缩略图与原图不匹配');
  const document = {schema:CHARACTER_ARCHIVE_SCHEMA,category:value.category,name,aliases,
    ageStatus:['unknown','adult','minor'].includes(value.ageStatus) ? value.ageStatus : 'unknown',
    imagegen:{appearance:text(imagegen.appearance,12000),negative:text(imagegen.negative,6000),
      sensitiveAppearance:text(imagegen.sensitiveAppearance,6000),reference,preview:preview?{...preview,sourceSha256:reference.sha256}:null}};
  if (Object.hasOwn(imagegen,'novelReference')) document.imagegen.novelReference = normalizeCharacterReferenceSettings(imagegen.novelReference);
  if (Object.hasOwn(value,'comfy')) document.comfy = normalizeComfyCharacterSettings(value.comfy);
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > 64 * 1024) fail('size','档案文字过长，请缩短后保存');
  return document;
}
export function newCharacterArchive(category = 'char') {
  return {schema:CHARACTER_ARCHIVE_SCHEMA,category,name:'',aliases:[],ageStatus:'unknown',imagegen:{appearance:'',negative:'',sensitiveAppearance:'',reference:null,preview:null}};
}
// Identification projection deliberately excludes negative/sensitive fields and file locations.
export function characterIdentityProjection(id, version, document) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,152}$/.test(id) || !Number.isSafeInteger(version) || version < 1) fail('id','角色档案身份或版本无效');
  const value = normalizeCharacterArchive(document);
  return {subjectId:`archive:${id}`,archiveId:id,archiveVersion:version,category:value.category,name:value.name,aliases:[...value.aliases],appearance:value.imagegen.appearance};
}
export function exportCharacterArchive(document) {
  const normalized = normalizeCharacterArchive(document);
  // Workflow IDs, versions and reference permission are local bindings, not portable identity text.
  const {comfy,...portable} = normalized;
  return {schema:CHARACTER_ARCHIVE_SCHEMA,document:{...portable,imagegen:{...normalized.imagegen,reference:null,preview:null}},referenceOmitted:Boolean(normalized.imagegen.reference),
    ...(comfy ? {comfyOmitted:true} : {})};
}
export function importCharacterArchive(contents) {
  if (typeof contents !== 'string' || new TextEncoder().encode(contents).byteLength > 128 * 1024) fail('import','档案文件须小于 128 KB');
  let value; try { value = JSON.parse(contents); } catch (_) { fail('import','档案文件不是有效 JSON'); }
  if (value?.schema !== CHARACTER_ARCHIVE_SCHEMA || !object(value.document)) fail('schema','请选择千幕角色档案文件');
  // A portable document cannot grant access to another account's ST file.
  const {comfy,...portable} = value.document;
  return {document:normalizeCharacterArchive({...portable,imagegen:{...portable.imagegen,reference:null,preview:null}}),referenceOmitted:Boolean(value.referenceOmitted || value.document.imagegen?.reference),
    ...(comfy || value.comfyOmitted ? {comfyOmitted:true} : {})};
}
export function characterBindingTarget(value) {
  if (!object(value) || !['char','user'].includes(value.category) || typeof value.subjectKey !== 'string' || !value.subjectKey || value.subjectKey.length > 1024
    || /[\u0000-\u001f\u007f]/.test(value.subjectKey) || !['chat','default'].includes(value.scope)) fail('binding','角色绑定位置无效');
  const chatKey = value.scope === 'chat' ? text(value.chatKey,512) : '';
  if (value.scope === 'chat' && !chatKey) fail('binding','请先打开聊天后使用当前聊天绑定');
  return {category:value.category,subjectKey:value.subjectKey,scope:value.scope,chatKey};
}
export function selectCharacterBinding(bindings, subject, chatKey = '') {
  const rows = bindings.filter(row => row.category === subject.category && row.subjectKey === subject.subjectKey);
  // Explicit chat-level null overrides a default binding; absence permits inheritance.
  return rows.find(row => row.scope === 'chat' && row.chatKey === chatKey) || rows.find(row => row.scope === 'default') || null;
}
