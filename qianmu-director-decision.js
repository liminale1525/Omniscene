// 千幕·导演决策单。把用户确认后的候选转成下游唯一可消费凭据；不读写存储、媒体或网络。
import { normalizeDirectorCandidate } from './qianmu-director-candidate.js';

export const QIANMU_DIRECTOR_DECISION_SCHEMA = 'qianmu.director-decision.v1';
export const QIANMU_DIRECTOR_DECISION_CONSUMERS = Object.freeze(['storyboard', 'voice', 'subtitle', 'film']);
export const QIANMU_DIRECTOR_DECISION_STATUSES = Object.freeze(['approved', 'revoked']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const list = (value, max = 80, itemMax = 1000) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, itemMax)).filter(Boolean))].slice(0, max)
  : [];
const timestamp = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
const hash = (value) => {
  let result = 2166136261;
  for (const char of String(value || '')) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(16).padStart(8, '0');
};

function normalizeOutputs(value) {
  const raw = plain(value) ? value : {};
  return Object.fromEntries(QIANMU_DIRECTOR_DECISION_CONSUMERS.map((consumer) => [consumer, raw[consumer] === true]));
}

function packetOwner(packet) {
  return text(packet?.timelineAnchor?.chatKey || packet?.timeline_anchor?.chat_key, 512);
}

function normalizeDecisionCharacters(value) {
  return (Array.isArray(value) ? value : []).slice(0, 24).map((item, index) => {
    const raw = plain(item) ? item : {};
    const id = text(raw.id || raw.name || `character-${index + 1}`, 160);
    return { id, name: text(raw.name || id, 160), state: text(raw.state, 1000), ...(raw.visible === false ? {visible:false} : {}) };
  }).filter((item) => item.id);
}

function normalizeDecisionScene(value) {
  const raw = plain(value) ? value : {};
  return {
    location: text(raw.location, 1000),
    time: text(raw.time, 240),
    weather: text(raw.weather, 240),
    environment: list(raw.environment, 40, 240),
    props: list(raw.props, 40, 240),
  };
}

export function normalizeDirectorDecision(value = {}) {
  const raw = plain(value) ? value : {};
  const source = plain(raw.source) ? raw.source : {};
  const approval = plain(raw.approval) ? raw.approval : {};
  const lanes = plain(raw.lanes) ? raw.lanes : {};
  const visual = plain(lanes.visual) ? lanes.visual : {};
  return {
    schema: QIANMU_DIRECTOR_DECISION_SCHEMA,
    decisionId: text(raw.decisionId || raw.decision_id, 200),
    owner: { chatKey: text(raw.owner?.chatKey || raw.owner?.chat_key, 512) },
    status: QIANMU_DIRECTOR_DECISION_STATUSES.includes(raw.status) ? raw.status : 'revoked',
    truthMode: raw.truthMode === 'canon' ? 'canon' : 'speculative',
    source: {
      candidateId: text(source.candidateId || source.candidate_id, 200),
      ledgerEntryId: text(source.ledgerEntryId || source.ledger_entry_id, 200),
      packetId: text(source.packetId || source.packet_id, 200),
      eventId: text(source.eventId || source.event_id, 200),
      track: ['main_camera', 'second_camera'].includes(source.track) ? source.track : '',
      canonLevel: ['canon', 'director', 'draft'].includes(source.canonLevel || source.canon_level) ? (source.canonLevel || source.canon_level) : '',
    },
    approval: {
      mode: approval.mode === 'explicit' ? 'explicit' : 'none',
      approvedAt: timestamp(approval.approvedAt || approval.approved_at),
      revokedAt: timestamp(approval.revokedAt || approval.revoked_at),
      revision: Math.max(1, Math.min(1000, Math.floor(Number(approval.revision) || 1))),
    },
    outputs: normalizeOutputs(raw.outputs),
    lanes: {
      visual: {
        duty: text(visual.duty, 80), shotPattern: text(visual.shotPattern || visual.shot_pattern, 80),
        subject: text(visual.subject, 1000), description: text(visual.description, 4000),
        characters: normalizeDecisionCharacters(visual.characters),
        scene: normalizeDecisionScene(visual.scene),
        evidenceRefs: list(visual.evidenceRefs || visual.evidence_refs, 80, 200),
      },
      dialogue: list(lanes.dialogue, 40, 1000),
      ambience: list(lanes.ambience, 40, 1000),
      caption: text(lanes.caption, 1200),
    },
  };
}

export function validateDirectorDecision(value = {}) {
  const decision = normalizeDirectorDecision(value);
  const issues = [];
  if (!decision.decisionId) issues.push('decision_id_missing');
  if (!decision.owner.chatKey) issues.push('owner_chat_missing');
  if (!decision.source.candidateId || !decision.source.ledgerEntryId || !decision.source.packetId) issues.push('source_chain_incomplete');
  if (decision.status === 'approved' && decision.approval.mode !== 'explicit') issues.push('explicit_approval_missing');
  if (decision.status === 'approved' && !decision.approval.approvedAt) issues.push('approval_time_missing');
  if (!Object.values(decision.outputs).some(Boolean)) issues.push('consumer_missing');
  if (!decision.lanes.visual.description && !decision.lanes.visual.subject && !decision.lanes.dialogue.length && !decision.lanes.ambience.length && !decision.lanes.caption) issues.push('decision_content_missing');
  if (decision.status === 'revoked' && !decision.approval.revokedAt) issues.push('revocation_time_missing');
  return { ok: issues.length === 0, issues, decision };
}

export function createDirectorDecision(candidateValue = {}, packetValue = {}, options = {}) {
  const candidate = normalizeDirectorCandidate(candidateValue);
  const packet = plain(packetValue) ? packetValue : {};
  const input = plain(options) ? options : {};
  const chatKey = text(input.chatKey || input.chat_key, 512);
  const packetChatKey = packetOwner(packet);
  const issues = [];
  if (!chatKey || candidate.owner.chatKey !== chatKey || packetChatKey !== chatKey) issues.push('owner_chat_mismatch');
  if (candidate.recommendation === 'reject') issues.push('candidate_rejected');
  if (candidate.recommendation === 'manual_review' && input.explicitApproval !== true) issues.push('explicit_approval_required');
  if (candidate.entryId !== text(input.ledgerEntryId || input.ledger_entry_id, 200)) issues.push('ledger_entry_mismatch');
  const visual = plain(packet.visualIntent) ? packet.visualIntent : {};
  const audio = plain(packet.audioIntent) ? packet.audioIntent : {};
  const scene = plain(packet.sceneState) ? packet.sceneState : {};
  const consequence = plain(packet.perceivedConsequence) ? packet.perceivedConsequence : {};
  const outputs = normalizeOutputs(input.outputs || { storyboard: true });
  const approvedAt = timestamp(input.approvedAt || input.approved_at) || Date.now();
  const decision = normalizeDirectorDecision({
    decisionId: `decision-${hash(`${chatKey}|${candidate.candidateId}|${packet.packetId}|${approvedAt}`)}`,
    owner: { chatKey },
    status: 'approved',
    truthMode: candidate.sourceKind === 'prose' ? 'canon' : 'speculative',
    source: {
      candidateId: candidate.candidateId, ledgerEntryId: candidate.entryId, packetId: packet.packetId,
      eventId: packet.eventId, track: packet.track, canonLevel: packet.canonLevel,
    },
    approval: { mode: 'explicit', approvedAt, revision: 1 },
    outputs,
    lanes: {
      visual: {
        duty: visual.duty, shotPattern: visual.shotPattern, subject: visual.subject, description: visual.description,
        characters: packet.characterState, scene, evidenceRefs: visual.evidenceRefs,
      },
      dialogue: audio.dialogue,
      ambience: audio.ambience,
      caption: consequence.summary,
    },
  });
  const validation = validateDirectorDecision(decision);
  return { ok: issues.length === 0 && validation.ok, issues: [...new Set([...issues, ...validation.issues])], decision };
}

export function canConsumeDirectorDecision(value = {}, consumer = '', chatKey = '') {
  const validation = validateDirectorDecision(value);
  if (!validation.ok || validation.decision.status !== 'approved') return false;
  const normalizedConsumer = text(consumer, 40);
  if (!QIANMU_DIRECTOR_DECISION_CONSUMERS.includes(normalizedConsumer)) return false;
  if (text(chatKey, 512) !== validation.decision.owner.chatKey) return false;
  return validation.decision.outputs[normalizedConsumer] === true;
}

export function revokeDirectorDecision(value = {}, revokedAt = Date.now()) {
  const current = normalizeDirectorDecision(value);
  return normalizeDirectorDecision({
    ...current,
    status: 'revoked',
    approval: { ...current.approval, revokedAt: timestamp(revokedAt) || Date.now(), revision: current.approval.revision + 1 },
  });
}
