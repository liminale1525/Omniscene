import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDirectorDecision, revokeDirectorDecision } from '../qianmu-director-decision.js';
import {
  canConsumeDirectorWorkOrder,
  createDirectorWorkOrder,
  directorWorkOrderToSubtitleCues,
  directorWorkOrderToStoryboardShot,
  directorWorkOrderToVoiceLines,
  normalizeDirectorWorkOrder,
} from '../qianmu-director-work-order.js';
import { normalizeStoryboardShotSpec, storyboardProductionContext } from '../qianmu-storyboard.js';

const candidate = {
  candidateId: 'candidate-a', owner: { chatKey: 'chat-a' }, entryId: 'simulation-packet-a',
  sourceKind: 'simulation', recommendation: 'manual_review', total: 72,
  gates: { sourceValid: true, factConsistency: true, spoilerSafe: false, shotDistinct: true },
};
const packet = {
  packetId: 'packet-a', eventId: 'event-a', track: 'second_camera', canonLevel: 'director',
  timelineAnchor: { chatKey: 'chat-a' },
  characterState: [{ id: '角色-爱丽丝', name: 'Alice', state: '摘下湿透的外套' }],
  sceneState: { location: '旧车站', time: '深夜', weather: '雨', environment: ['冷色灯'], props: ['来信'] },
  visualIntent: {
    duty: 'reaction', shotPattern: 'single_reaction', subject: '烧焦的来信',
    description: 'Alice 在空车站烧掉来信。', evidenceRefs: ['plan-8'],
  },
  audioIntent: { dialogue: ['Alice：到此为止。'], ambience: ['雨声'] },
  perceivedConsequence: { summary: '灰烬落在长椅旁。' },
};

function approvedDecision(outputs) {
  const result = createDirectorDecision(candidate, packet, {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true,
    approvedAt: 100, outputs,
  });
  assert.equal(result.ok, true);
  return result.decision;
}

test('each downstream work order is a bounded projection of one approved decision', () => {
  const decision = approvedDecision({ storyboard: true, voice: true, subtitle: true, film: true });
  for (const consumer of ['storyboard', 'voice', 'subtitle', 'film']) {
    const result = createDirectorWorkOrder(decision, consumer, 'chat-a', { createdAt: 200 });
    assert.equal(result.ok, true, `${consumer}: ${result.issues.join(',')}`);
    assert.equal(result.workOrder.consumer, consumer);
    assert.equal(result.workOrder.source.decisionId, decision.decisionId);
    assert.equal(result.workOrder.truthMode, 'speculative');
    assert.equal(canConsumeDirectorWorkOrder(result.workOrder, consumer, 'chat-a'), true);
    assert.equal(canConsumeDirectorWorkOrder(result.workOrder, consumer, 'chat-b'), false);
  }
});

test('unapproved consumers and revoked decisions cannot issue work orders', () => {
  const storyboardOnly = approvedDecision({ storyboard: true });
  const denied = createDirectorWorkOrder(storyboardOnly, 'voice', 'chat-a', { createdAt: 200 });
  assert.equal(denied.ok, false);
  assert.ok(denied.issues.includes('decision_not_consumable'));
  const revoked = revokeDirectorDecision(storyboardOnly, 300);
  const closed = createDirectorWorkOrder(revoked, 'storyboard', 'chat-a', { createdAt: 400 });
  assert.equal(closed.ok, false);
  assert.ok(closed.issues.includes('decision_not_consumable'));
});

test('storyboard adapter reads the work order rather than the source production packet', () => {
  const decision = approvedDecision({ storyboard: true });
  const { workOrder } = createDirectorWorkOrder(decision, 'storyboard', 'chat-a', { createdAt: 200 });
  const rawShot = directorWorkOrderToStoryboardShot(workOrder, 'chat-a');
  const shot = normalizeStoryboardShotSpec(rawShot);
  assert.equal(shot.subject, '烧焦的来信');
  assert.equal(shot.characters[0].id, '角色-爱丽丝');
  assert.equal(shot.characters[0].temporaryState[0], '摘下湿透的外套');
  assert.match(shot.scene, /旧车站/);
  assert.deepEqual(storyboardProductionContext(shot), {
    packetId: 'packet-a', eventId: 'event-a', track: 'second_camera', canonLevel: 'director', autoInsert: false,
    decisionId: decision.decisionId, decisionStatus: 'approved', truthMode: 'speculative',
  });
});

test('work order normalization strips raw prompts, credentials and media payloads', () => {
  const decision = approvedDecision({ film: true });
  const { workOrder } = createDirectorWorkOrder(decision, 'film', 'chat-a', { createdAt: 200 });
  const normalized = normalizeDirectorWorkOrder({
    ...workOrder, prompt: 'secret prompt', apiKey: 'secret', url: 'https://example.invalid',
    blob: new Blob(['x']), payload: { ...workOrder.payload, providerResponse: { raw: true } },
  });
  assert.doesNotMatch(JSON.stringify(normalized), /secret prompt|secret|example\.invalid|providerResponse|blob/);
});

test('subtitle adapter creates timed, clip-owned cues from the approved projection', () => {
  const decision = approvedDecision({ subtitle: true });
  const { workOrder } = createDirectorWorkOrder(decision, 'subtitle', 'chat-a', { createdAt: 200 });
  const cues = directorWorkOrderToSubtitleCues(workOrder, 'chat-a', {
    startMs: 4000, endMs: 7000, recordId: 'record-a', clipId: 'clip-a',
  });
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map((cue) => cue.kind), ['dialogue', 'caption']);
  assert.equal(cues[0].text, '到此为止。');
  assert.equal(cues[0].startMs, 4000);
  assert.equal(cues[1].endMs, 7000);
  assert.equal(cues[0].source.kind, 'director');
  assert.equal(cues[0].source.decisionId, decision.decisionId);
  assert.equal(cues[0].source.workOrderId, workOrder.workOrderId);
  assert.equal(cues[0].source.clipId, 'clip-a');
  assert.equal(directorWorkOrderToSubtitleCues(workOrder, 'chat-b', { startMs: 0, endMs: 1000 }).length, 0);
});

test('voice adapter creates bounded lines without exposing visual or provider state', () => {
  const decision = approvedDecision({ voice: true });
  const { workOrder } = createDirectorWorkOrder(decision, 'voice', 'chat-a', { createdAt: 200 });
  const lines = directorWorkOrderToVoiceLines(workOrder, 'chat-a', {
    startMs: 1000, endMs: 3000, recordId: 'record-a', clipId: 'clip-a', apiKey: 'discard',
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].speaker, 'Alice');
  assert.equal(lines[0].text, '到此为止。');
  assert.equal(lines[0].source.kind, 'director_voice');
  assert.equal(lines[0].source.clipId, 'clip-a');
  assert.equal(lines[0].source.decisionId, decision.decisionId);
  assert.doesNotMatch(JSON.stringify(lines), /discard|旧车站|雨声|烧焦/);
  assert.equal(directorWorkOrderToVoiceLines(workOrder, 'chat-b').length, 0);
});

test('world-side storyboard runtime dispatches a validated work order before prompt compilation', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const generate = source.slice(source.indexOf('async function storyboardGenerateProductionPacket'), source.indexOf('async function storyboardGenerate(root'));
  assert.match(generate, /featureRuntime\.load\('directorWorkOrders'\)/);
  assert.match(generate, /createDirectorWorkOrder\(decision, 'storyboard', currentChatKey/);
  assert.match(generate, /canConsumeDirectorWorkOrder\(dispatch\.workOrder, 'storyboard', currentChatKey\)/);
  assert.match(generate, /directorWorkOrderToStoryboardShot\(workOrder, currentChatKey\)/);
  assert.doesNotMatch(generate.slice(generate.indexOf('const shotInput')), /adaptProductionPacketToStoryboardShotSpec/);
  assert.ok(generate.indexOf('directorWorkOrderToStoryboardShot') < generate.indexOf('compileStoryboardPrompt'));
});

test('director work orders remain lazy and ship inside the release boundary', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /directorWorkOrders:\s*\{[\s\S]*import\('\.\/qianmu-director-work-order\.js\?v=1\.59\.44'\)/);
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function cleanupRuntime'));
  assert.doesNotMatch(init, /featureRuntime\.load\('directorWorkOrders'\)/);
  assert.ok(release.files.includes('qianmu-director-work-order.js'));
});
