import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canConsumeDirectorDecision,
  createDirectorDecision,
  normalizeDirectorDecision,
  revokeDirectorDecision,
  validateDirectorDecision,
} from '../qianmu-director-decision.js';
import { adaptProductionPacketToStoryboardShotSpec, storyboardProductionContext } from '../qianmu-storyboard.js';

const candidate = (overrides = {}) => ({
  candidateId: 'candidate-a', owner: { chatKey: 'chat-a' }, entryId: 'simulation-packet-a',
  sourceKind: 'simulation', recommendation: 'manual_review', total: 64,
  gates: { sourceValid: true, factConsistency: true, spoilerSafe: false, shotDistinct: true },
  ...overrides,
});
const packet = (overrides = {}) => ({
  packetId: 'packet-a', eventId: 'event-a', timelineAnchor: { chatKey: 'chat-a' },
  sourceRef: { field: 'npc_updates' },
  visualIntent: { duty: 'reaction', shotPattern: 'single_reaction', subject: '来信', description: 'Alice 烧掉来信。' },
  audioIntent: { dialogue: ['Alice：到此为止。'], ambience: ['雨声'] },
  perceivedConsequence: { summary: '灰烬落入水池。' },
  ...overrides,
});

test('manual-review candidates require explicit approval before any consumer can use them', () => {
  const denied = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', approvedAt: 100,
    outputs: { storyboard: true },
  });
  assert.equal(denied.ok, false);
  assert.ok(denied.issues.includes('explicit_approval_required'));
  const approved = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100,
    outputs: { storyboard: true },
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.decision.truthMode, 'speculative');
  assert.equal(canConsumeDirectorDecision(approved.decision, 'storyboard', 'chat-a'), true);
  assert.equal(canConsumeDirectorDecision(approved.decision, 'voice', 'chat-a'), false);
});

test('rejected, mismatched and cross-chat sources cannot produce a usable decision', () => {
  const rejected = createDirectorDecision(candidate({ recommendation: 'reject' }), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, outputs: { storyboard: true },
  });
  assert.ok(rejected.issues.includes('candidate_rejected'));
  const foreign = createDirectorDecision(candidate(), packet({ timelineAnchor: { chatKey: 'chat-b' } }), {
    chatKey: 'chat-a', ledgerEntryId: 'wrong-entry', explicitApproval: true, outputs: { storyboard: true },
  });
  assert.ok(foreign.issues.includes('owner_chat_mismatch'));
  assert.ok(foreign.issues.includes('ledger_entry_mismatch'));
  assert.equal(canConsumeDirectorDecision(foreign.decision, 'storyboard', 'chat-b'), false);
});

test('revocation immediately closes every downstream consumer', () => {
  const result = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100,
    outputs: { storyboard: true, subtitle: true, film: true },
  });
  const revoked = revokeDirectorDecision(result.decision, 200);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.approval.revision, 2);
  assert.equal(validateDirectorDecision(revoked).ok, true);
  assert.equal(canConsumeDirectorDecision(revoked, 'storyboard', 'chat-a'), false);
  assert.equal(canConsumeDirectorDecision(revoked, 'subtitle', 'chat-a'), false);
  assert.equal(canConsumeDirectorDecision(revoked, 'film', 'chat-a'), false);
});

test('decision normalization keeps only bounded creative lanes and stable references', () => {
  const result = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, outputs: { storyboard: true },
  });
  const normalized = normalizeDirectorDecision({
    ...result.decision, prompt: 'secret prompt', apiKey: 'secret', url: 'https://example.invalid',
    blob: new Blob(['x']), providerResponse: { raw: true },
  });
  assert.match(normalized.lanes.visual.description, /Alice/);
  assert.deepEqual(normalized.lanes.dialogue, ['Alice：到此为止。']);
  assert.doesNotMatch(JSON.stringify(normalized), /secret prompt|secret|example\.invalid|providerResponse|blob/);
});

test('world-side storyboard generation creates and consumes the decision before compiling prompts', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const generate = source.slice(source.indexOf('async function storyboardGenerateProductionPacket'), source.indexOf('async function storyboardGenerate(root'));
  assert.match(generate, /featureRuntime\.load\('directorDecision'\)/);
  assert.match(generate, /createDirectorDecision\(candidate, packet/);
  assert.match(generate, /canConsumeDirectorDecision\(result\.decision, 'storyboard', currentChatKey\)/);
  assert.ok(generate.indexOf('createDirectorDecision(candidate, packet') < generate.indexOf('compileStoryboardPrompt'));
  assert.match(generate, /createDirectorWorkOrder\(decision, 'storyboard', currentChatKey/);
  assert.match(generate, /directorWorkOrderToStoryboardShot\(workOrder, currentChatKey\)/);
  const commonGenerate = source.slice(source.indexOf('async function storyboardGenerate(root'), source.indexOf('async function storyboardRunQueuedJob'));
  assert.match(commonGenerate, /productionDraft[\s\S]*decisionStatus !== 'approved'/);
});

test('approved decision identity survives storyboard shot normalization', () => {
  const result = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100,
    outputs: { storyboard: true },
  });
  const shot = adaptProductionPacketToStoryboardShotSpec(packet(), {
    productionContext: {
      packetId: 'packet-a', eventId: 'event-a', track: 'second_camera', canonLevel: 'director', autoInsert: false,
      decisionId: result.decision.decisionId, decisionStatus: result.decision.status, truthMode: result.decision.truthMode,
    },
  });
  assert.deepEqual(storyboardProductionContext(shot), {
    packetId: 'packet-a', eventId: 'event-a', track: 'second_camera', canonLevel: 'director', autoInsert: false,
    decisionId: result.decision.decisionId, decisionStatus: 'approved', truthMode: 'speculative',
  });
});

test('director decision stays lazy and ships in the release boundary', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /directorDecision:\s*\{[\s\S]*import\('\.\/qianmu-director-decision\.js\?v=1\.59\.27'\)/);
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function cleanupRuntime'));
  assert.doesNotMatch(init, /featureRuntime\.load\('directorDecision'\)/);
  assert.ok(release.files.includes('qianmu-director-decision.js'));
});
