// 千幕·共享片场制片包。纯数据适配器：不读写 DOM、设置、聊天元数据或媒体二进制。
import { normalizeWorldSource } from './qianmu-world-source.js';
export { buildWorldSourceIndex, worldSourceKey, indexWorldMedia } from './qianmu-world-source.js';
export const QIANMU_PRODUCTION_PACKET_SCHEMA = 'qianmu.production.packet.v1';
export const QIANMU_PRODUCTION_TRACKS = Object.freeze(['main_camera', 'second_camera']);
export const QIANMU_CANON_LEVELS = Object.freeze(['canon', 'director', 'draft']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const list = (value, max = 40) => Array.isArray(value) ? [...new Set(value.map((item) => text(item, 240)).filter(Boolean))].slice(0, max) : [];
const integer = (value) => Number.isInteger(value) && value >= 0 ? value : null;
const hash = (value) => {
  let result = 2166136261;
  for (const char of String(value || '')) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(16).padStart(8, '0');
};

function normalizeCharacterState(value, index = 0) {
  const raw = plain(value) ? value : {};
  const id = text(raw.id || raw.name || `character-${index + 1}`, 160);
  return {
    id,
    name: text(raw.name || id, 160),
    state: text(raw.state || raw.emotional_state || raw.current_goal || raw.next_action, 1000),
    ...(raw.visible === false ? {visible:false} : {}),
    knowledge: list(raw.knowledge || raw.knows, 30),
  };
}

function normalizeConsequence(value) {
  if (!value) return null;
  const raw = plain(value) ? value : { summary: value };
  const summary = text(raw.summary || raw.content || raw.text, 1200);
  if (!summary) return null;
  return { summary, visibleTo: list(raw.visibleTo || raw.visible_to, 30), evidenceRefs: list(raw.evidenceRefs || raw.evidence_refs, 40) };
}

export function normalizeQianmuProductionPacket(value = {}) {
  const raw = plain(value) ? value : {};
  const track = QIANMU_PRODUCTION_TRACKS.includes(raw.track) ? raw.track : 'second_camera';
  const canonLevel = QIANMU_CANON_LEVELS.includes(raw.canonLevel || raw.canon_level) ? (raw.canonLevel || raw.canon_level) : (track === 'second_camera' ? 'director' : 'draft');
  const anchorRaw = plain(raw.timelineAnchor || raw.timeline_anchor) ? (raw.timelineAnchor || raw.timeline_anchor) : {};
  const eventId = text(raw.eventId || raw.event_id, 200);
  const sourceRaw = plain(raw.sourceRef || raw.source_ref) ? (raw.sourceRef || raw.source_ref) : {};
  const packetSeed = [eventId, track, canonLevel, sourceRaw.field, sourceRaw.index, anchorRaw.chatKey, anchorRaw.floor].join('|');
  const visibleTo = list(raw.knowledgeScope?.visibleTo || raw.knowledge_scope?.visible_to, 40);
  const hiddenFrom = list(raw.knowledgeScope?.hiddenFrom || raw.knowledge_scope?.hidden_from, 40);
  const directorOnly = raw.knowledgeScope?.directorOnly ?? raw.knowledge_scope?.director_only ?? (canonLevel !== 'canon');
  const sceneRaw = plain(raw.sceneState || raw.scene_state) ? (raw.sceneState || raw.scene_state) : {};
  const visualRaw = plain(raw.visualIntent || raw.visual_intent) ? (raw.visualIntent || raw.visual_intent) : {};
  const audioRaw = plain(raw.audioIntent || raw.audio_intent) ? (raw.audioIntent || raw.audio_intent) : {};
  return {
    schema: QIANMU_PRODUCTION_PACKET_SCHEMA,
    packetId: text(raw.packetId || raw.packet_id, 200) || `packet-${hash(packetSeed)}`,
    eventId: eventId || `event-${hash(packetSeed)}`,
    sceneId: text(raw.sceneId || raw.scene_id, 200),
    track,
    canonLevel,
    timelineAnchor: {
      chatKey: text(anchorRaw.chatKey || anchorRaw.chat_key, 512),
      floor: integer(anchorRaw.floor),
      messageId: text(anchorRaw.messageId || anchorRaw.message_id, 200),
      revisionId: text(anchorRaw.revisionId || anchorRaw.revision_id, 200),
    },
    sourceRef: { field: text(sourceRaw.field, 80), index: integer(sourceRaw.index), itemId: text(sourceRaw.itemId || sourceRaw.item_id, 200),
      ...(normalizeWorldSource(sourceRaw.worldSource) ? {worldSource:normalizeWorldSource(sourceRaw.worldSource)} : {}) },
    knowledgeScope: { directorOnly: Boolean(directorOnly), visibleTo, hiddenFrom },
    sceneState: {
      location: text(sceneRaw.location, 1000), time: text(sceneRaw.time, 240), weather: text(sceneRaw.weather, 240),
      environment: list(sceneRaw.environment, 40), props: list(sceneRaw.props, 40),
    },
    characterState: (Array.isArray(raw.characterState || raw.character_state) ? (raw.characterState || raw.character_state) : []).slice(0, 24).map(normalizeCharacterState).filter((item) => item.id),
    visualIntent: {
      duty: text(visualRaw.duty, 80), shotPattern: text(visualRaw.shotPattern || visualRaw.shot_pattern, 80),
      subject: text(visualRaw.subject, 1000), description: text(visualRaw.description, 4000), evidenceRefs: list(visualRaw.evidenceRefs || visualRaw.evidence_refs, 80),
    },
    audioIntent: { dialogue: list(audioRaw.dialogue, 40), ambience: list(audioRaw.ambience, 40), music: text(audioRaw.music, 1000) },
    continuityRefs: list(raw.continuityRefs || raw.continuity_refs, 80),
    perceivedConsequence: normalizeConsequence(raw.perceivedConsequence || raw.perceived_consequence),
    mediaRefs: list(raw.mediaRefs || raw.media_refs, 80),
  };
}

function itemCharacters(field, item) {
  if (field === 'npc_updates') return [{ id: item.name || item.id, name: item.name, state: item.next_action || item.current_goal || item.emotional_state }];
  if (field === 'relation_undercurrents') return (Array.isArray(item.parties) ? item.parties : []).map((name) => ({ id: name, name, state: item.tension || item.drift }));
  return [];
}

const DIRECTOR_FIELD_PROFILE = Object.freeze({
  quests: Object.freeze({ track: 'main_camera', canonLevel: 'draft', duty: 'action', shotPattern: 'action' }),
  npc_updates: Object.freeze({ track: 'second_camera', canonLevel: 'director', duty: 'reaction', shotPattern: 'single_reaction' }),
  world_updates: Object.freeze({ track: 'second_camera', canonLevel: 'director', duty: 'atmosphere', shotPattern: 'atmosphere' }),
  chain_reactions: Object.freeze({ track: 'second_camera', canonLevel: 'director', duty: 'transition', shotPattern: 'montage' }),
  relation_undercurrents: Object.freeze({ track: 'second_camera', canonLevel: 'director', duty: 'relationship', shotPattern: 'two_shot' }),
});

function itemSummary(field, item) {
  if (field === 'quests') return [item.title, item.objective, item.description, item.trigger].filter(Boolean).join('：');
  if (field === 'npc_updates') return [item.name, item.current_goal, item.next_action, item.hidden_agenda].filter(Boolean).join('：');
  if (field === 'world_updates') return [item.title, item.content, item.scope, item.timing].filter(Boolean).join('：');
  if (field === 'chain_reactions') return [item.spark, item.chain].filter(Boolean).join(' → ');
  if (field === 'relation_undercurrents') return [Array.isArray(item.parties) ? item.parties.join(' / ') : item.parties, item.tension, item.drift].filter(Boolean).join('：');
  return '';
}

export function adaptDirectorPlanToProductionPackets(plan = {}, context = {}) {
  const source = plain(plan) ? plan : {}, anchor = plain(context) ? context : {};
  const story = plain(source.story_status) ? source.story_status : {};
  const packets = [];
  for (const [field, profile] of Object.entries(DIRECTOR_FIELD_PROFILE)) {
    const items = Array.isArray(source[field]) ? source[field].slice(0, 16) : [];
    items.forEach((itemValue, index) => {
      const item = plain(itemValue) ? itemValue : { content: itemValue };
      const summary = itemSummary(field, item);
      if (!summary) return;
      const itemId = text(item.id || item.title || item.name, 200);
      const eventId = itemId || `director-${field}-${hash(`${summary}|${index}`)}`;
      const worldSource = normalizeWorldSource(anchor.worldSourceIndex?.entries?.find(row=>row.index===index && row.source?.field===field)?.source);
      packets.push(normalizeQianmuProductionPacket({
        eventId: worldSource?.itemId || eventId,
        ...(worldSource ? {packetId:`packet-${worldSource.revisionId.slice(5)}-${worldSource.itemId.slice(6)}`} : {}),
        sceneId: anchor.sceneId || '',
        ...profile,
        timelineAnchor: { chatKey: anchor.chatKey, floor: anchor.floor, messageId: anchor.messageId, revisionId: worldSource?.revisionId || anchor.revisionId },
        sourceRef: { field, index, itemId:worldSource?.itemId || itemId, ...(worldSource ? {worldSource} : {}) },
        knowledgeScope: { directorOnly: true, visibleTo: [], hiddenFrom: [] },
        sceneState: { location: anchor.location || '', time: item.timing || anchor.time || '', weather: anchor.weather || '', environment: [story.mood, item.scope].filter(Boolean) },
        characterState: itemCharacters(field, item),
        visualIntent: { duty: profile.duty, shotPattern: profile.shotPattern, subject: item.title || item.name || item.spark || '', description: summary, evidenceRefs: list(item.evidenceRefs || item.evidence_refs || anchor.evidenceRefs, 80) },
        audioIntent: { ambience: field === 'world_updates' ? [item.content || item.title].filter(Boolean) : [], dialogue: [], music: '' },
        continuityRefs: list(item.continuityRefs || item.continuity_refs, 80),
        perceivedConsequence: item.perceivedConsequence || item.perceived_consequence || null,
      }));
    });
  }
  return packets.slice(0, 48);
}

export function canExposeProductionPacketToMainline(value, viewerId = '') {
  const packet = normalizeQianmuProductionPacket(value);
  if (packet.track === 'main_camera' && packet.canonLevel === 'canon' && !packet.knowledgeScope.directorOnly) return true;
  const consequence = packet.perceivedConsequence;
  if (!consequence) return false;
  const viewer = text(viewerId, 160);
  if (packet.knowledgeScope.hiddenFrom.includes(viewer)) return false;
  return consequence.visibleTo.includes('*') || Boolean(viewer && consequence.visibleTo.includes(viewer));
}
