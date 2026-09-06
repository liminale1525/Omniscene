import {characterIdentityProjection, selectCharacterBinding, characterArchiveError} from './qianmu-character-archive.js';

export const CHARACTER_CASTING_SCHEMA = 'qianmu.character.casting.v1';
const fail = (code, message) => { throw characterArchiveError(code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,152}$/.test(value);
const nameKey = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const freeze = value => { if (object(value) || Array.isArray(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const names = row => [...new Set([row.name, ...(row.aliases || [])].map(nameKey).filter(Boolean))];
const mentioned = (name, text) => {
  if (!name || [...name].length < 2) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name)
    ? text.includes(name) : new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(text);
};

// Optional history field: keep a visible invalid marker instead of silently stripping a future/broken snapshot.
export function normalizeCharacterCastingSnapshot(value) {
  if (value == null) return null;
  if (!object(value) || value.schema !== CHARACTER_CASTING_SCHEMA || value.invalid || !id(value.archiveId)
    || !Number.isSafeInteger(value.archiveVersion) || value.archiveVersion < 1
    || value.subjectId !== `archive:${value.archiveId}` || !['char','user','other'].includes(value.category)
    || !['id','alias'].includes(value.match) || typeof value.sourceCharacterId !== 'string' || value.sourceCharacterId.length > 200
    || typeof value.name !== 'string' || !value.name || value.name.length > 80
    || value.negativeScope !== 'model_interface'
    || typeof value.negative !== 'string' || value.negative.length > 6000) return {schema:CHARACTER_CASTING_SCHEMA,invalid:true};
  return {schema:CHARACTER_CASTING_SCHEMA,subjectId:value.subjectId,archiveId:value.archiveId,archiveVersion:value.archiveVersion,
    category:value.category,name:value.name,sourceCharacterId:value.sourceCharacterId,match:value.match,negativeScope:'model_interface',negative:value.negative};
}

export function assertCharacterCastingSnapshots(shot) {
  for (const character of shot?.characters || []) {
    const snapshot = normalizeCharacterCastingSnapshot(character.archiveSnapshot);
    if (snapshot && (snapshot.invalid || snapshot.subjectId !== character.id)) fail('snapshot','人物档案快照无效，请重新提取或使用未损坏的历史记录');
  }
}

// No network, files, sensitive fields or engine-specific assets enter this input catalogue.
export function characterCastingInput(prepared) {
  if (prepared == null) return [];
  if (prepared.schema !== CHARACTER_CASTING_SCHEMA || !Array.isArray(prepared.entries) || prepared.entries.length > 64) fail('casting','人物识别资料无效');
  const string = (value,max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const rows = prepared.entries.map(({identity}) => {
    if (!object(identity) || !id(identity.archiveId) || identity.subjectId !== `archive:${identity.archiveId}`
      || !Number.isSafeInteger(identity.archiveVersion) || identity.archiveVersion < 1 || !string(identity.name,80) || !identity.name
      || !string(identity.appearance,12000) || !Array.isArray(identity.aliases) || identity.aliases.length > 64
      || identity.aliases.some(alias => !string(alias,120))) fail('casting','人物识别资料无效');
    return {subject_id:identity.subjectId,archive_version:identity.archiveVersion,name:identity.name,aliases:[...identity.aliases],base_appearance:identity.appearance};
  });
  if (bytes(rows) > 64 * 1024) fail('casting_size','本次角色形象资料超过 64 KB，请缩短相关档案后提取');
  return rows;
}

// Current bindings are identity candidates, not a cast list. OTHER is nominated only by a named mention.
// Read metadata first, then only the relevant documents; close the short-lived store in the caller.
export async function readCharacterCasting(options) {
  const {createCharacterArchiveStore} = await import('./qianmu-character-archive-store.js');
  const store = createCharacterArchiveStore();
  try { return await prepareCharacterCasting({...options,store}); }
  finally { store.close(); }
}

export async function prepareCharacterCasting({store,namespace,subjects=[],chatKey='',text='',guard=async()=>{}}) {
  await guard();
  const [heads, bindings] = await Promise.all([store.list(namespace),store.bindings(namespace)]);
  await guard();
  const headById = new Map(heads.map(head => [head.id,head])), selected = new Set(), active = [];
  for (const subject of subjects) {
    const binding = subject.subjectKey ? selectCharacterBinding(bindings,subject,chatKey) : null;
    const archiveId = binding?.archiveId || '';
    if (archiveId) {
      const head = headById.get(archiveId);
      if (!head || head.category !== subject.category) fail('binding','当前人物绑定的档案缺失，请先核对角色库');
      selected.add(archiveId);
    }
    active.push({name:subject.name,archiveId});
  }
  const source = nameKey(text);
  for (const head of heads) if (head.category === 'other' && names(head).some(name => mentioned(name,source))) selected.add(head.id);
  if (selected.size > 64) fail('casting_size','本次相关人物超过 64 份，请缩小取景范围');
  const entries = [];
  for (const archiveId of selected) {
    const record = await store.load(namespace,archiveId); await guard();
    if (!record || record.head.revision !== headById.get(archiveId).revision) fail('conflict','角色档案读取期间已变化，请重新提取');
    const identity = characterIdentityProjection(archiveId,record.head.version,record.document);
    identity.aliases = [...new Set([...identity.aliases,...active.filter(row => row.archiveId === archiveId).map(row => row.name).filter(Boolean)])];
    entries.push({identity,negative:record.document.imagegen.negative});
  }
  const prepared = {schema:CHARACTER_CASTING_SCHEMA,entries,unboundNames:active.filter(row => !row.archiveId).map(row => nameKey(row.name)).filter(Boolean)};
  characterCastingInput(prepared); // Validate the entire payload before any LLM request; no truncation.
  return freeze(prepared);
}

// Apply only to a newly extracted structured cast. Never iterate the catalogue to add an absent person.
// Do not call this on edited prompts or archived shots: their explicit visual state already is the snapshot.
export function applyCharacterCasting(shot, prepared) {
  const entries = prepared?.entries || [], byId = new Map(entries.map(entry => [entry.identity.subjectId,entry]));
  const aliases = new Map();
  for (const entry of entries) for (const name of names(entry.identity)) {
    if (!aliases.has(name)) aliases.set(name,new Set()); aliases.get(name).add(entry.identity.subjectId);
  }
  for (const name of prepared?.unboundNames || []) { if (!aliases.has(name)) aliases.set(name,new Set()); aliases.get(name).add('unbound'); }
  const warnings = [], rawCharacters = (shot.characters || []).filter(character => character.visible !== false);
  const matches = rawCharacters.map(character => {
    const characterId = String(character.id || ''), nameIds = aliases.get(nameKey(character.name)) || new Set();
    if (characterId.startsWith('archive:')) {
      if (nameIds.size > 1) return {reason:'ambiguous_name'};
      if (!byId.has(characterId) || character.name && !nameIds.has(characterId)) return {reason:'identity_conflict'};
      return {entry:byId.get(characterId),match:'id'};
    }
    const candidates = nameIds.size ? nameIds : aliases.get(nameKey(characterId)) || new Set();
    if (candidates.size > 1) return {reason:'ambiguous_name'};
    if (candidates.size === 1 && !candidates.has('unbound')) return {entry:byId.get([...candidates][0]),match:'alias'};
    return {};
  });
  const occurrences = new Map();
  for (const match of matches) if (match.entry) {
    const subjectId = match.entry.identity.subjectId; occurrences.set(subjectId,(occurrences.get(subjectId)||0)+1);
  }
  const remap = new Map();
  const characters = rawCharacters.map((character,index) => {
    const {archiveSnapshot:ignored,...visual} = character, match = matches[index], entry = match.entry;
    const reason = entry && occurrences.get(entry.identity.subjectId) > 1 ? 'duplicate_subject' : match.reason;
    if (reason) { warnings.push({characterId:character.id,name:character.name,reason}); return visual; }
    if (!entry) return visual;
    const identity = entry.identity;
    remap.set(character.id,identity.subjectId);
    // The extractor has already reconciled base appearance with current text. Do not append a stale wardrobe
    // or override explicit hair/pose/state with an unstructured archive blob after the LLM returns.
    return {...visual,id:identity.subjectId,archiveSnapshot:{schema:CHARACTER_CASTING_SCHEMA,subjectId:identity.subjectId,
      archiveId:identity.archiveId,archiveVersion:identity.archiveVersion,category:identity.category,name:identity.name,
      sourceCharacterId:character.id,match:match.match,negativeScope:'model_interface',negative:entry.negative}};
  });
  const result = {...shot,characters};
  if (shot.sceneFingerprint) result.sceneFingerprint = {...shot.sceneFingerprint,castIds:(shot.sceneFingerprint.castIds||[]).map(value=>remap.get(value)||value)};
  if (shot.continuityUpdates) {
    result.continuityUpdates = {...shot.continuityUpdates};
    for (const field of ['outfit','injuries','props','actionState']) if (object(shot.continuityUpdates[field])) {
      result.continuityUpdates[field] = Object.fromEntries(Object.entries(shot.continuityUpdates[field]).map(([key,value])=>[remap.get(key)||key,value]));
    }
    result.continuityUpdates.facts = (shot.continuityUpdates.facts||[]).map(fact=>({...fact,subject:remap.get(fact.subject)||fact.subject}));
  }
  return {shot:result,warnings};
}
