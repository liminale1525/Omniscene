// 千幕·导演工作单。下游工种只接收已批准决策的有限投影，不再解释原始推演文本。
import {
  QIANMU_DIRECTOR_DECISION_CONSUMERS,
  canConsumeDirectorDecision,
  normalizeDirectorDecision,
} from './qianmu-director-decision.js';

export const QIANMU_DIRECTOR_WORK_ORDER_SCHEMA = 'qianmu.director-work-order.v1';
export const QIANMU_DIRECTOR_WORK_ORDER_STATUSES = Object.freeze(['ready', 'cancelled']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const list = (value, max = 80, itemMax = 1000) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, itemMax)).filter(Boolean))].slice(0, max)
  : [];
const timestamp = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
const stableId = (value, max = 200) => {
  const result = text(value, max);
  return /^[A-Za-z0-9._:-]+$/.test(result) ? result : '';
};
const hash = (value) => {
  let result = 2166136261;
  for (const char of String(value || '')) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(16).padStart(8, '0');
};

function normalizeCharacters(value) {
  return (Array.isArray(value) ? value : []).slice(0, 24).map((item, index) => {
    const raw = plain(item) ? item : {};
    const id = text(raw.id, 160) || `character-${index + 1}`;
    return { id, name: text(raw.name || id, 160), state: text(raw.state, 1000), ...(raw.visible === false ? {visible:false} : {}) };
  });
}

function normalizeVisual(value) {
  const raw = plain(value) ? value : {};
  const sceneRaw = plain(raw.scene) ? raw.scene : {};
  return {
    duty: text(raw.duty, 80),
    shotPattern: text(raw.shotPattern || raw.shot_pattern, 80),
    subject: text(raw.subject, 1000),
    description: text(raw.description, 4000),
    characters: normalizeCharacters(raw.characters),
    scene: {
      location: text(sceneRaw.location, 1000), time: text(sceneRaw.time, 240), weather: text(sceneRaw.weather, 240),
      environment: list(sceneRaw.environment, 40, 240), props: list(sceneRaw.props, 40, 240),
    },
    evidenceRefs: list(raw.evidenceRefs || raw.evidence_refs, 80, 200),
  };
}

function dialogueLine(value, index = 0) {
  const raw = plain(value) ? value : { text: value };
  const source = text(raw.text, 1000);
  const match = source.match(/^([^：:]{1,80})[：:]\s*(.+)$/u);
  return {
    lineId: stableId(raw.lineId || raw.line_id) || `line-${index + 1}`,
    speaker: text(raw.speaker || match?.[1], 160),
    text: text(match ? match[2] : source, 1000),
  };
}

function normalizePayload(value, consumer) {
  const raw = plain(value) ? value : {};
  const dialogue = (Array.isArray(raw.dialogue) ? raw.dialogue : []).slice(0, 40).map(dialogueLine).filter((line) => line.text);
  const includeVisual = consumer === 'storyboard' || consumer === 'film';
  const includeDialogue = ['voice', 'subtitle', 'film'].includes(consumer);
  return {
    visual: includeVisual ? normalizeVisual(raw.visual) : normalizeVisual({}),
    dialogue: includeDialogue ? dialogue : [],
    ambience: consumer === 'film' ? list(raw.ambience, 40, 1000) : [],
    caption: ['subtitle', 'film'].includes(consumer) ? text(raw.caption, 1200) : '',
  };
}

export function normalizeDirectorWorkOrder(value = {}) {
  const raw = plain(value) ? value : {};
  const source = plain(raw.source) ? raw.source : {};
  const consumer = QIANMU_DIRECTOR_DECISION_CONSUMERS.includes(raw.consumer) ? raw.consumer : '';
  return {
    schema: QIANMU_DIRECTOR_WORK_ORDER_SCHEMA,
    workOrderId: stableId(raw.workOrderId || raw.work_order_id),
    owner: { chatKey: text(raw.owner?.chatKey || raw.owner?.chat_key, 512) },
    status: QIANMU_DIRECTOR_WORK_ORDER_STATUSES.includes(raw.status) ? raw.status : 'cancelled',
    consumer,
    truthMode: raw.truthMode === 'canon' ? 'canon' : 'speculative',
    source: {
      decisionId: stableId(source.decisionId || source.decision_id),
      decisionRevision: Math.max(1, Math.min(1000, Math.floor(Number(source.decisionRevision || source.decision_revision) || 1))),
      candidateId: stableId(source.candidateId || source.candidate_id),
      ledgerEntryId: stableId(source.ledgerEntryId || source.ledger_entry_id),
      packetId: stableId(source.packetId || source.packet_id),
      eventId: stableId(source.eventId || source.event_id),
      track: ['main_camera', 'second_camera'].includes(source.track) ? source.track : '',
      canonLevel: ['canon', 'director', 'draft'].includes(source.canonLevel || source.canon_level) ? (source.canonLevel || source.canon_level) : '',
    },
    payload: normalizePayload(raw.payload, consumer),
    createdAt: timestamp(raw.createdAt || raw.created_at),
  };
}

export function validateDirectorWorkOrder(value = {}, consumer = '', chatKey = '') {
  const workOrder = normalizeDirectorWorkOrder(value);
  const issues = [];
  if (!workOrder.workOrderId) issues.push('work_order_id_missing');
  if (!workOrder.owner.chatKey) issues.push('owner_chat_missing');
  if (chatKey && workOrder.owner.chatKey !== text(chatKey, 512)) issues.push('owner_chat_mismatch');
  if (!workOrder.consumer) issues.push('consumer_invalid');
  if (consumer && workOrder.consumer !== consumer) issues.push('consumer_mismatch');
  if (workOrder.status !== 'ready') issues.push('work_order_not_ready');
  if (!workOrder.source.decisionId || !workOrder.source.candidateId || !workOrder.source.ledgerEntryId || !workOrder.source.packetId) issues.push('source_chain_incomplete');
  if (!workOrder.createdAt) issues.push('created_at_missing');
  const visual = workOrder.payload.visual;
  if (workOrder.consumer === 'storyboard' && !visual.description && !visual.subject) issues.push('storyboard_content_missing');
  if (workOrder.consumer === 'voice' && !workOrder.payload.dialogue.length) issues.push('voice_content_missing');
  if (workOrder.consumer === 'subtitle' && !workOrder.payload.dialogue.length && !workOrder.payload.caption) issues.push('subtitle_content_missing');
  if (workOrder.consumer === 'film' && !visual.description && !visual.subject && !workOrder.payload.dialogue.length && !workOrder.payload.ambience.length && !workOrder.payload.caption) issues.push('film_content_missing');
  return { ok: issues.length === 0, issues: [...new Set(issues)], workOrder };
}

export function createDirectorWorkOrder(decisionValue = {}, consumer = '', chatKey = '', options = {}) {
  const decision = normalizeDirectorDecision(decisionValue);
  const normalizedConsumer = text(consumer, 40);
  const ownerChatKey = text(chatKey, 512);
  const issues = [];
  if (!canConsumeDirectorDecision(decision, normalizedConsumer, ownerChatKey)) issues.push('decision_not_consumable');
  const createdAt = timestamp(options.createdAt || options.created_at) || Date.now();
  const workOrder = normalizeDirectorWorkOrder({
    workOrderId: `work-${hash(`${decision.decisionId}|${decision.approval.revision}|${normalizedConsumer}`)}`,
    owner: { chatKey: ownerChatKey }, status: 'ready', consumer: normalizedConsumer,
    truthMode: decision.truthMode,
    source: {
      decisionId: decision.decisionId, decisionRevision: decision.approval.revision,
      candidateId: decision.source.candidateId, ledgerEntryId: decision.source.ledgerEntryId,
      packetId: decision.source.packetId, eventId: decision.source.eventId,
      track: decision.source.track, canonLevel: decision.source.canonLevel,
    },
    payload: decision.lanes,
    createdAt,
  });
  const validation = validateDirectorWorkOrder(workOrder, normalizedConsumer, ownerChatKey);
  return { ok: issues.length === 0 && validation.ok, issues: [...new Set([...issues, ...validation.issues])], workOrder };
}

export function canConsumeDirectorWorkOrder(value = {}, consumer = '', chatKey = '') {
  return validateDirectorWorkOrder(value, consumer, chatKey).ok;
}

export function directorWorkOrderToStoryboardShot(value = {}, chatKey = '') {
  const result = validateDirectorWorkOrder(value, 'storyboard', chatKey);
  if (!result.ok) return null;
  const order = result.workOrder;
  const visual = order.payload.visual;
  const pattern = ['master', 'two_shot', 'over_shoulder', 'single_reaction', 'action', 'insert', 'atmosphere', 'montage'].includes(visual.shotPattern) ? visual.shotPattern : 'action';
  const duty = ['space', 'relationship', 'action', 'reaction', 'detail', 'atmosphere', 'motif', 'transition'].includes(visual.duty) ? visual.duty : 'action';
  const role = ({ space: 'establishing', relationship: 'relationship', action: 'action', reaction: 'reaction', detail: 'detail', atmosphere: 'establishing', motif: 'detail', transition: 'turn' })[duty] || 'action';
  const scale = ({ master: 'wide_shot', two_shot: 'medium_shot', over_shoulder: 'medium_close_up', single_reaction: 'close_up', action: 'medium_full', insert: 'insert', atmosphere: 'extreme_wide_shot', montage: 'wide_shot' })[pattern] || 'medium_shot';
  const environment = [visual.scene.location, visual.scene.time, visual.scene.weather, ...visual.scene.environment].filter(Boolean);
  const visibleCharacters = visual.characters.filter(character=>character.visible!==false);
  return {
    id: order.workOrderId,
    sourceParagraphIds: visual.evidenceRefs,
    narrativeLayer: order.truthMode === 'canon' ? 'present' : 'imagined',
    narrativePurpose: visual.description || visual.subject,
    shotPattern: pattern, visualDuty: duty, shotRole: role, shotScale: scale,
    subject: visual.subject,
    subjectKind: visibleCharacters.length ? 'character' : (['atmosphere', 'space'].includes(duty) ? 'environment' : duty === 'motif' ? 'symbolic' : 'mixed'),
    location: visual.scene.location,
    scene: environment.join(', '),
    characters: visibleCharacters.map((character) => ({ id: character.id, name: character.name, temporaryState: [character.state].filter(Boolean) })),
    promptAtoms: { global: [visual.description, visual.subject].filter(Boolean), environment },
    continuityUpdates: {
      time: visual.scene.time, weather: visual.scene.weather,
      props: Object.fromEntries(visual.scene.props.map((prop) => [prop, true])),
    },
    evidence: { type: 'inferred', paragraphIds: visual.evidenceRefs, rationale: '由已批准导演工作单映射。' },
    productionContext: {
      packetId: order.source.packetId, eventId: order.source.eventId, track: order.source.track,
      canonLevel: order.source.canonLevel, autoInsert: false, decisionId: order.source.decisionId,
      decisionStatus: 'approved', truthMode: order.truthMode,
    },
    decisions: [`导演工作单：${order.workOrderId}`],
  };
}

export function directorWorkOrderToSubtitleCues(value = {}, chatKey = '', options = {}) {
  const result = validateDirectorWorkOrder(value, 'subtitle', chatKey);
  if (!result.ok) return [];
  const order = result.workOrder;
  const startMs = Math.max(0, Math.floor(Number(options.startMs) || 0));
  const endMs = Math.max(startMs + 100, Math.floor(Number(options.endMs) || startMs + 100));
  const recordId = stableId(options.recordId);
  const clipId = stableId(options.clipId);
  const items = [
    ...order.payload.dialogue.map((line) => ({
      id: line.lineId,
      kind: 'dialogue',
      speakerId: stableId(line.speaker, 160),
      text: line.text,
    })),
    ...(order.payload.caption ? [{ id: 'caption', kind: 'caption', speakerId: '', text: order.payload.caption }] : []),
  ];
  const span = Math.max(100, endMs - startMs);
  const step = span / Math.max(1, items.length);
  return items.map((item, index) => {
    const cueStart = Math.round(startMs + (step * index));
    const cueEnd = index === items.length - 1 ? endMs : Math.max(cueStart + 100, Math.round(startMs + (step * (index + 1))));
    const refId = stableId(`${order.workOrderId}:${clipId || 'clip'}:${item.id}`);
    return {
      cueId: stableId(`cue-${refId}`),
      startMs: cueStart,
      endMs: cueEnd,
      text: item.text,
      language: '',
      speakerId: item.speakerId,
      kind: item.kind,
      source: {
        kind: 'director',
        refId,
        decisionId: order.source.decisionId,
        workOrderId: order.workOrderId,
        recordId,
        clipId,
        relativeStartMs: Math.max(0, cueStart - startMs),
        relativeEndMs: Math.max(100, cueEnd - startMs),
      },
    };
  });
}

export function directorWorkOrderToVoiceLines(value = {}, chatKey = '', options = {}) {
  const result = validateDirectorWorkOrder(value, 'voice', chatKey);
  if (!result.ok) return [];
  const order = result.workOrder;
  const startMs = Math.max(0, Math.floor(Number(options.startMs) || 0));
  const endMs = Math.max(startMs + 100, Math.floor(Number(options.endMs) || startMs + 100));
  const recordId = stableId(options.recordId);
  const clipId = stableId(options.clipId);
  const lines = order.payload.dialogue;
  const span = Math.max(100, endMs - startMs);
  const step = span / Math.max(1, lines.length);
  return lines.map((line, index) => {
    const lineStart = Math.round(startMs + (step * index));
    const lineEnd = index === lines.length - 1 ? endMs : Math.max(lineStart + 100, Math.round(startMs + (step * (index + 1))));
    const refId = stableId(`${order.workOrderId}:${clipId || 'clip'}:${line.lineId}`);
    return {
      lineId: stableId(`voice-${refId}`),
      speaker: line.speaker,
      text: line.text,
      emotion: 'auto',
      startMs: lineStart,
      endMs: lineEnd,
      source: {
        kind: 'director_voice',
        refId,
        decisionId: order.source.decisionId,
        workOrderId: order.workOrderId,
        recordId,
        clipId,
        relativeStartMs: Math.max(0, lineStart - startMs),
        relativeEndMs: Math.max(100, lineEnd - startMs),
      },
    };
  });
}
