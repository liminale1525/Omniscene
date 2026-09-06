import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_VIDEO_CONFIRMATION_SCHEMA,
  QIANMU_VIDEO_CONFIRMATION_TTL_MS,
  createVideoGenerationConfirmation,
} from '../qianmu-video-confirmation.js';

const NOW = Date.UTC(2026, 8, 3, 10, 0, 0);
const prompt = `integrated_multimodal_description:
[Shot 1]
00:00.000-00:06.000: A quiet kitchen holds steady while the camera slowly pushes toward the doorway.

overall_soundscape:
Soft room tone and a distant kettle.

non_diegetic_music:
N/A`;

const acknowledged = (extra = {}) => ({
  cost: true,
  materialRights: true,
  h3License: true,
  ...extra,
});

function input(extra = {}) {
  return {
    service: { status: 'ready', services: ['minimax-h3'] },
    credentialConfigured: true,
    region: 'global',
    owner: { chatKey: 'chat-a', floor: 4 },
    spec: {
      shotId: 'shot-a',
      durationSeconds: 6,
      resolution: '768p',
      aspectRatio: '16:9',
      requestedMode: 't2va',
      intent: { summary: 'A quiet kitchen.' },
    },
    manifest: { shotId: 'shot-a', assets: [] },
    prompt,
    ...extra,
  };
}

test('a ready draft requires price, material-rights and H3-license acknowledgements', () => {
  const review = createVideoGenerationConfirmation(input(), { now: NOW });
  assert.equal(review.schema, QIANMU_VIDEO_CONFIRMATION_SCHEMA);
  assert.equal(review.readyForConfirmation, true);
  assert.equal(review.confirmed, false);
  assert.deepEqual(review.confirmationIssues, [
    'cost_confirmation_required',
    'material_rights_confirmation_required',
    'h3_license_confirmation_required',
  ]);
  assert.equal(review.quote, null);
  assert.equal(review.costPreview.displayLabel, '$0.48');
  assert.equal(review.costPreview.lockedPrice, false);
});

test('acknowledgement creates a short-lived normalized quote without prompt or credentials', () => {
  const review = createVideoGenerationConfirmation(input({
    apiKey: 'SHOULD_NOT_SURVIVE',
    acknowledgements: acknowledged(),
  }), { now: NOW });
  assert.equal(review.confirmed, true);
  assert.equal(review.readyForTaskCreation, true);
  assert.equal(review.quote.provider, 'minimax-h3');
  assert.equal(review.quote.unit, 'usd');
  assert.equal(review.quote.maximumUnits, 0.48);
  assert.equal(review.quote.expiresAt - review.quote.createdAt, QIANMU_VIDEO_CONFIRMATION_TTL_MS);
  assert.doesNotMatch(JSON.stringify(review), /SHOULD_NOT_SURVIVE|integrated_multimodal_description/);
});

test('2K requires a separate acknowledgement from the price acknowledgement', () => {
  const first = createVideoGenerationConfirmation(input({
    spec: { ...input().spec, resolution: '2k' },
    acknowledgements: acknowledged(),
  }), { now: NOW });
  assert.equal(first.confirmed, false);
  assert.deepEqual(first.confirmationIssues, ['high_resolution_confirmation_required']);
  const second = createVideoGenerationConfirmation(input({
    spec: { ...input().spec, resolution: '2k' },
    acknowledgements: acknowledged({ highResolution: true }),
  }), { now: NOW });
  assert.equal(second.confirmed, true);
  assert.equal(second.quote.maximumUnits, 0.78);
});

test('invalid prompt, missing capability and unverified regional price fail closed', () => {
  const blocked = createVideoGenerationConfirmation(input({
    service: { status: 'ready', services: ['doubao-tts'] },
    credentialConfigured: false,
    region: 'china',
    prompt: 'not an H3 prompt',
    acknowledgements: acknowledged(),
  }), { now: NOW });
  assert.equal(blocked.readyForConfirmation, false);
  assert.equal(blocked.confirmed, false);
  assert.ok(blocked.blockers.includes('h3_gateway_unavailable'));
  assert.ok(blocked.blockers.includes('h3_credential_missing'));
  assert.ok(blocked.blockers.some((issue) => issue.startsWith('h3_section_missing:')));
  assert.ok(blocked.blockers.includes('h3_cost_unavailable:regional_pricing_unverified'));
  assert.equal(blocked.quote, null);
});

test('the confirmation fingerprint invalidates any changed prompt or generation setting', () => {
  const base = createVideoGenerationConfirmation(input({ acknowledgements: acknowledged() }), { now: NOW });
  const changedPrompt = createVideoGenerationConfirmation(input({ prompt: prompt.replace('quiet kitchen', 'rainy kitchen'), acknowledgements: acknowledged() }), { now: NOW });
  const changedDuration = createVideoGenerationConfirmation(input({ spec: { ...input().spec, durationSeconds: 8 }, acknowledgements: acknowledged() }), { now: NOW });
  assert.notEqual(base.fingerprint, changedPrompt.fingerprint);
  assert.notEqual(base.fingerprint, changedDuration.fingerprint);
  assert.notEqual(base.quote.quoteId, changedPrompt.quote.quoteId);
});

test('the confirmation contract stays lazy and only submits after the explicit fingerprinted gate', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-confirmation\.js/m);
assert.match(source, /videoConfirmation:\s*\{[\s\S]*qianmu-video-confirmation\.js\?v=1\.59\.42/);
  assert.ok(release.files.includes('qianmu-video-confirmation.js'));
  const editor = source.slice(source.indexOf('async function storyboardOpenVideoDraftEditor'), source.indexOf('function renderStoryboardVideoDraftShelf'));
  assert.match(editor, /storyboardEnsureVideoCoordinator\(\)/);
  assert.match(editor, /!guard\.confirmed \|\| guard\.fingerprint !== videoConfirmationFingerprint/);
  assert.match(editor, /costConfirmed: true/);
  assert.match(editor, /materialRightsConfirmed: guard\.acknowledgements\.materialRights/);
  assert.match(editor, /h3LicenseConfirmed: guard\.acknowledgements\.h3License/);
  assert.match(editor, /sd-video-confirmation-rights-check/);
  assert.match(editor, /sd-video-confirmation-license-check/);
  assert.match(editor, /automatic: false/);
  assert.match(editor, /videoSubmissionPending = true/);
  assert.match(editor, /videoSubmissionOutcomeUnknown = true/);
  assert.doesNotMatch(editor, /fetch\(|apiKey/);
});
