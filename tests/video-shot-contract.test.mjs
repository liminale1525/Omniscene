import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_H3_MODE_FAMILIES,
  QIANMU_H3_MODES,
  QIANMU_H3_ASPECT_RATIOS,
  QIANMU_MULTIMODAL_MANIFEST_SCHEMA,
  QIANMU_VIDEO_SHOT_SCHEMA,
  buildStoryboardFrameManifest,
  createVideoShotFromStoryboardFrames,
  normalizeMultimodalAssetManifest,
  normalizeVideoShotSpec,
  resolveH3VideoMode,
  storyboardFrameAssetId,
  validateMultimodalAssetManifest,
  validateVideoShotSpec,
} from '../qianmu-video-contract.js';

const asset = (assetId, kind, roles, extra = {}) => ({
  assetId,
  kind,
  roles,
  locator: { kind: 'indexeddb', ref: `asset:${assetId}` },
  ...extra,
});

test('the video contract keeps the five official prompt modes separate from auto routing', () => {
  assert.deepEqual(QIANMU_H3_MODES, ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va']);
  assert.deepEqual(QIANMU_H3_MODE_FAMILIES, {
    t2va: 'fl2va', i2va: 'fl2va', fl2va: 'fl2va', l2va: 'fl2va', ref2va: 'ref2va',
  });
});

test('a normalized shot keeps character identity, wardrobe and performance in separate lanes', () => {
  const spec = normalizeVideoShotSpec({
    shotId: 'shot-a',
    durationSeconds: 6,
    summary: 'Two people cross a kitchen.',
    characters: [
      { id: 'a', appearance: { identity: ['red hair'], wardrobe: ['coat removed'] }, performance: { action: 'opens the door' } },
      { id: 'b', appearance: { identity: ['black hair'], wardrobe: ['blue apron'] }, performance: { action: 'keeps stirring' } },
    ],
  });
  assert.equal(spec.schema, QIANMU_VIDEO_SHOT_SCHEMA);
  assert.equal(spec.characters[0].appearance.wardrobe[0], 'coat removed');
  assert.equal(spec.characters[0].performance.action, 'opens the door');
  assert.equal(spec.characters[1].appearance.identity[0], 'black hair');
  assert.equal(spec.characters[1].performance.action, 'keeps stirring');
  assert.notDeepEqual(spec.characters[0], spec.characters[1]);
});

test('duration and delivery defaults remain conservative for the first H3 phase', () => {
  assert.equal(normalizeVideoShotSpec({ durationSeconds: 1 }).durationSeconds, 4);
  assert.equal(normalizeVideoShotSpec({}).durationSeconds, 6);
  assert.equal(normalizeVideoShotSpec({ durationSeconds: 5.6 }).durationSeconds, 6);
  assert.equal(normalizeVideoShotSpec({ durationSeconds: 99 }).durationSeconds, 15);
  assert.equal(normalizeVideoShotSpec({}).resolution, '768p');
  assert.equal(normalizeVideoShotSpec({}).fps, 24);
  assert.equal(normalizeVideoShotSpec({}).aspectRatio, '16:9');
  assert.ok(QIANMU_H3_ASPECT_RATIOS.includes('adaptive'));
});

test('auto routing selects text, first, last, first-last and full-reference modes deterministically', () => {
  const route = (assets, keyframes = {}, references = {}) => {
    const manifest = normalizeMultimodalAssetManifest({ shotId: 'shot', assets });
    return resolveH3VideoMode({ keyframes, references }, manifest, 'auto');
  };
  assert.equal(route([]).mode, 't2va');
  assert.equal(route([asset('first', 'image', ['first_frame'])]).mode, 'i2va');
  assert.equal(route([asset('last', 'image', ['last_frame'])]).mode, 'l2va');
  assert.equal(route([asset('first', 'image', ['first_frame']), asset('last', 'image', ['last_frame'])]).mode, 'fl2va');
  assert.equal(route([asset('subject', 'image', ['subject_reference'], { subjectLabel: '<Subject 1>' })]).mode, 'ref2va');
});

test('manual mode overrides are preserved but never pretend missing inputs are ready', () => {
  const route = resolveH3VideoMode({}, { assets: [] }, 'fl2va');
  assert.equal(route.mode, 'fl2va');
  assert.equal(route.ready, false);
  assert.equal(route.reasonCode, 'manual_override_missing_inputs');
  assert.deepEqual(route.missingRequirements, ['first_frame', 'last_frame']);
});

test('duplicate assets merge by fingerprint without duplicating upload or reference budgets', () => {
  const manifest = normalizeMultimodalAssetManifest({
    shotId: 'shot-a',
    assets: [
      asset('a', 'image', ['first_frame'], { fingerprint: 'same' }),
      asset('b', 'image', ['subject_reference'], { fingerprint: 'same', subjectLabel: '<Subject 1>' }),
    ],
  });
  assert.equal(manifest.schema, QIANMU_MULTIMODAL_MANIFEST_SCHEMA);
  assert.equal(manifest.assets.length, 1);
  assert.deepEqual(manifest.assets[0].roles, ['first_frame', 'subject_reference']);
  assert.equal(manifest.assets[0].subjectLabel, '<Subject 1>');
  assert.equal(manifest.usage.images, 1);
});

test('the manifest strips binary payloads and unstable browser blob URLs', () => {
  const manifest = normalizeMultimodalAssetManifest({
    shotId: 'safe',
    imageData: 'data:image/png;base64,SHOULD_NOT_SURVIVE',
    assets: [{
      assetId: 'a', kind: 'image', roles: ['first_frame'],
      locator: { kind: 'chat', ref: 'blob:https://example.invalid/session' },
      bytes: new Uint8Array([1, 2, 3]),
      base64: 'SHOULD_NOT_SURVIVE',
    }],
  });
  assert.equal(manifest.assets[0].locator.ref, '');
  assert.doesNotMatch(JSON.stringify(manifest), /SHOULD_NOT_SURVIVE|imageData|base64|Uint8Array/);
});

test('manifest budgets and rights produce explicit submission blockers', () => {
  const result = validateMultimodalAssetManifest({
    assets: [asset('a', 'image', ['subject_reference'], { rights: { status: 'restricted' } })],
    budget: { maxAssets: 1, maxImages: 0 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('budget_images_exceeded'));
  assert.ok(result.issues.includes('asset_rights_restricted:a'));
});

test('a provider-ready remote asset may use its opaque upload id instead of a local locator', () => {
  const result = validateMultimodalAssetManifest({
    assets: [{
      assetId: 'remote-audio', kind: 'audio', roles: ['audio_reference'],
      locator: { kind: 'upload', ref: '' },
      upload: { state: 'ready', providerId: 'future-h3-provider', remoteId: 'opaque-file-id' },
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.assets[0].upload.remoteId, 'opaque-file-id');
});

test('shot validation catches missing routed inputs and dialogue ownership', () => {
  const result = validateVideoShotSpec({
    summary: 'A short exchange.',
    requestedMode: 'i2va',
    characters: [{ id: 'a' }],
    audio: { dialogue: [{ characterId: 'b', text: 'Hello.' }] },
  }, { assets: [] });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('route_input_missing:first_frame'));
  assert.ok(result.issues.some((issue) => issue.startsWith('dialogue_character_missing:')));
});

test('storyboard frames become stable gallery references without copying image payloads', () => {
  const record = {
    id: 'record-a', chatKey: 'chat-a', floor: 12, width: 1216, height: 832,
    url: 'data:image/png;base64,SHOULD_NOT_SURVIVE',
    finalPrompt: 'SHOULD_NOT_ENTER_THE_ASSET_MANIFEST',
    snapshot: { payload: { image: new Uint8Array([1, 2, 3]) } },
  };
  const manifest = buildStoryboardFrameManifest([record], { shotId: 'video-a', firstRecordId: 'record-a' });
  assert.equal(manifest.assets[0].assetId, storyboardFrameAssetId(record));
  assert.equal(manifest.assets[0].locator.kind, 'gallery');
  assert.equal(manifest.assets[0].locator.ref, 'chat-a\u241frecord-a');
  assert.deepEqual(manifest.assets[0].roles, ['first_frame']);
  assert.doesNotMatch(JSON.stringify(manifest), /SHOULD_NOT_SURVIVE|SHOULD_NOT_ENTER|snapshot|finalPrompt|data:image/);
});

test('the frame bridge feeds existing first and last images into FL2VA routing', () => {
  const records = [
    { id: 'first', chatKey: 'chat-a', floor: 4, width: 832, height: 1216 },
    { id: 'last', chatKey: 'chat-a', floor: 5, width: 1216, height: 832 },
  ];
  const bridged = createVideoShotFromStoryboardFrames({ summary: 'A continuous turn.' }, records, {
    shotId: 'video-shot', firstRecordId: 'first', lastRecordId: 'last', requestedMode: 'auto',
  });
  assert.equal(bridged.spec.route.mode, 'fl2va');
  assert.equal(bridged.spec.route.ready, true);
  assert.equal(bridged.spec.keyframes.firstAssetId, bridged.manifest.assets.find((item) => item.sourceRef.recordId === 'first').assetId);
  assert.equal(bridged.spec.keyframes.lastAssetId, bridged.manifest.assets.find((item) => item.sourceRef.recordId === 'last').assetId);
});

test('one storyboard image may deliberately serve as both loop endpoints without duplicate storage', () => {
  const bridged = createVideoShotFromStoryboardFrames({ summary: 'A seamless loop.' }, [{ id: 'loop', chatKey: 'chat-a' }], {
    firstRecordId: 'loop', lastRecordId: 'loop',
  });
  assert.equal(bridged.manifest.assets.length, 1);
  assert.deepEqual(bridged.manifest.assets[0].roles, ['first_frame', 'last_frame']);
  assert.equal(bridged.spec.route.mode, 'fl2va');
});

test('missing storyboard selections remain explicit instead of embedding stale image URLs', () => {
  const bridged = createVideoShotFromStoryboardFrames({ summary: 'A transition.' }, [{ id: 'first', chatKey: 'chat-a' }], {
    firstRecordId: 'first', lastRecordId: 'deleted-record', requestedMode: 'fl2va',
  });
  assert.equal(bridged.spec.route.mode, 'fl2va');
  assert.equal(bridged.spec.route.ready, false);
  assert.deepEqual(bridged.spec.route.missingRequirements, ['last_frame']);
});

test('the unfinished video contract ships as an idle feature chunk, not a startup dependency', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-contract\.js/m);
assert.match(source, /videoContract:\s*\{[\s\S]*import\('\.\/qianmu-video-contract\.js\?v=1\.59\.52'\)/);
  assert.ok(release.files.includes('qianmu-video-contract.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoContract'\)/);
});
