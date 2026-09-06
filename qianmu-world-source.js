// Lightweight provenance only. No settings, media reads, network or generation.
export const WORLD_SOURCE_FIELDS = Object.freeze(['quests','npc_updates','world_updates','chain_reactions','relation_undercurrents']);
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
export function normalizeWorldSource(value) {
  if (!plain(value) || value.schema !== 'qianmu.world-source.v1' || !validText(value.chatKey,512)
    || !/^wrev-[a-f0-9]{64}$/.test(value.revisionId || '') || !/^witem-[a-f0-9]{64}$/.test(value.itemId || '')
    || !WORLD_SOURCE_FIELDS.includes(value.field)) return null;
  return {schema:'qianmu.world-source.v1',chatKey:value.chatKey,revisionId:value.revisionId,field:value.field,itemId:value.itemId};
}
export function worldSourceKey(value) {
  const source = normalizeWorldSource(value);
  return source ? JSON.stringify([source.chatKey,source.revisionId,source.field,source.itemId]) : '';
}
function canonical(value, depth = 0) {
  if (depth > 32) throw new Error('世界来源层级过深');
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item=>canonical(item,depth+1));
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key],depth+1)]));
}
const digest = async value => {
  if (!globalThis.crypto?.subtle?.digest) throw new Error('世界来源校验需要 HTTPS 或本机 localhost，请检查访问地址');
  const bytes = new TextEncoder().encode(value);
  const result = await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(result)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
};
export async function buildWorldSourceIndex(plan, {chatKey,revisionId} = {}) {
  if (!plain(plan) || !validText(chatKey,512) || !validText(revisionId,200)) throw new Error('世界来源缺少聊天或推演版本');
  // Bound before sorting/hashing. Never truncate a plan into an apparently identical source.
  const serialized = JSON.stringify(plan);
  if (serialized.length > 2 * 1024 * 1024) throw new Error('世界来源内容过大，请缩减后再创作');
  const snapshot = canonical(JSON.parse(serialized));
  const revision = `wrev-${await digest(JSON.stringify([chatKey,revisionId,snapshot]))}`;
  const entries = [];
  for (const field of WORLD_SOURCE_FIELDS) {
    const occurrences = new Map();
    const items = Array.isArray(snapshot[field]) ? snapshot[field].slice(0,16) : [];
    for (let index=0;index<items.length;index++) {
      const itemText = JSON.stringify(items[index]);
      const ordinal = occurrences.get(itemText) || 0;
      occurrences.set(itemText,ordinal+1);
      const itemId = `witem-${await digest(JSON.stringify([field,itemText,ordinal]))}`;
      const source = {schema:'qianmu.world-source.v1',chatKey,revisionId:revision,field,itemId};
      entries.push({index,source,key:worldSourceKey(source)});
    }
  }
  return {revisionId:revision,entries};
}
export function indexWorldMedia(records, chatKey) {
  const index = new Map(), seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    // Read only the lightweight record; never hydrate a generation snapshot or image here.
    const source = normalizeWorldSource(record?.productionContext?.worldSource);
    if (!source || source.chatKey !== chatKey || record.chatKey !== chatKey || !record.id || seen.has(record.id)) continue;
    seen.add(record.id);
    const key = worldSourceKey(source);
    if (!index.has(key)) index.set(key,[]);
    index.get(key).push(record);
  }
  return index;
}
