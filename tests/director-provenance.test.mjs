import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDirectorDecision } from '../qianmu-director-decision.js';
import { createDirectorWorkOrder, directorWorkOrderToStoryboardShot } from '../qianmu-director-work-order.js';
import {
  normalizeStoryboardShotSpec,
  storyboardDirectorDecisionSnapshot,
  storyboardProductionContext,
} from '../qianmu-storyboard.js';

const candidate = {
  candidateId: 'candidate-a', owner: { chatKey: 'chat-a' }, entryId: 'simulation-packet-a', sourceKind: 'simulation',
  recommendation: 'manual_review', gates: { sourceValid: true, factConsistency: true, spoilerSafe: false, shotDistinct: true },
};
const packet = {
  packetId: 'packet-a', eventId: 'event-a', track: 'second_camera', canonLevel: 'director', timelineAnchor: { chatKey: 'chat-a' },
  visualIntent: { duty: 'reaction', shotPattern: 'single_reaction', subject: '来信', description: 'Alice 烧掉来信。' },
  audioIntent: { dialogue: ['Alice：到此为止。'], ambience: ['雨声'] },
  sceneState: { location: '车站', weather: '雨' },
  characterState: [{ id: '角色-爱丽丝', name: 'Alice', state: '未穿外套' }],
  perceivedConsequence: { summary: '灰烬落下。' },
};

function approvedDecision() {
  const result = createDirectorDecision(candidate, packet, {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100,
    outputs: { storyboard: true, voice: true, subtitle: true, film: true },
  });
  assert.equal(result.ok, true);
  return result.decision;
}

test('an approved decision survives the generated shot as a bounded provenance snapshot', () => {
  const decision = approvedDecision();
  const { workOrder } = createDirectorWorkOrder(decision, 'storyboard', 'chat-a', { createdAt: 200 });
  const shot = normalizeStoryboardShotSpec({ ...directorWorkOrderToStoryboardShot(workOrder, 'chat-a'), directorDecision: decision });
  const restored = storyboardDirectorDecisionSnapshot({ shotSpec: shot });
  assert.equal(restored.decisionId, decision.decisionId);
  assert.equal(restored.owner.chatKey, 'chat-a');
  assert.deepEqual(restored.outputs, { storyboard: true, voice: true, subtitle: true, film: true });
  assert.equal(restored.lanes.visual.characters[0].id, '角色-爱丽丝');
  assert.equal(restored.lanes.dialogue[0], 'Alice：到此为止。');
  assert.equal(storyboardProductionContext(shot).decisionId, decision.decisionId);
});

test('provenance normalization drops unknown and sensitive payloads', () => {
  const decision = approvedDecision();
  const shot = normalizeStoryboardShotSpec({
    directorDecision: {
      ...decision, prompt: 'secret prompt', apiKey: 'secret-key', url: 'https://example.invalid', blob: new Blob(['x']),
      lanes: { ...decision.lanes, providerResponse: { raw: true }, visual: { ...decision.lanes.visual, imageData: 'data:image/png;base64,AAAA' } },
    },
  });
  const serialized = JSON.stringify(shot.directorDecision);
  assert.doesNotMatch(serialized, /secret prompt|secret-key|example\.invalid|providerResponse|base64|blob/);
});

test('world-side submission validates its durable decision immediately before generation', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('async function storyboardGenerateProductionPacket'), source.indexOf('async function storyboardGenerate(root'));
  assert.match(create, /outputs: \{ storyboard: true \}/, 'still-image confirmation must not authorize other consumers');
  assert.match(create, /shotInput\.directorDecision = decision/);
  const submit = source.slice(source.indexOf('async function storyboardGenerate(root'), source.indexOf('async function storyboardRunQueuedJob'));
  assert.match(submit, /storyboardDirectorDecisionSnapshot\(productionDraft\)/);
  assert.match(submit, /canConsumeDirectorDecision\(decision, 'storyboard', currentChatKey\)/);
  assert.ok(submit.indexOf("canConsumeDirectorDecision(decision, 'storyboard'") < submit.indexOf('storyboardCreateJob'));
});
