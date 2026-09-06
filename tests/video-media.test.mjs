import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createStoryboardGalleryMediaResolver,
  resolveStoryboardGalleryMediaInputs,
  videoSelectedAssetIds,
} from '../qianmu-video-media.js';
import { createVideoShotFromStoryboardFrames } from '../qianmu-video-contract.js';

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

function bridge(records, options = {}) {
  return createVideoShotFromStoryboardFrames({ summary: 'A connected shot.' }, records, {
    shotId: 'video-shot',
    firstRecordId: options.firstRecordId,
    lastRecordId: options.lastRecordId,
    referenceRecordIds: options.referenceRecordIds,
    requestedMode: options.requestedMode || 'auto',
  });
}

test('only assets selected by the final video route are resolved', async () => {
  const records = [
    { id: 'first', chatKey: 'chat-a', url: dataUrl('image/png', pngBytes) },
    { id: 'unused', chatKey: 'chat-a', url: dataUrl('image/jpeg', jpegBytes) },
  ];
  const { spec, manifest } = bridge(records, { firstRecordId: 'first' });
  let loads = 0;
  const result = await resolveStoryboardGalleryMediaInputs({ spec, manifest, chatKey: 'chat-a' }, {
    records,
    loadRecordMedia(record) { loads += 1; return record.url; },
  });
  assert.equal(result.ok, true);
  assert.equal(loads, 1);
  assert.equal(result.mediaInputs.length, 1);
  assert.equal(result.mediaInputs[0].assetId, videoSelectedAssetIds(spec, manifest)[0]);
  assert.equal(result.mediaInputs[0].mime, 'image/png');
  assert.equal(Buffer.from(result.mediaInputs[0].data, 'base64').equals(Buffer.from(pngBytes)), true);
});

test('one image used as both first and last frame is read and sent once', async () => {
  const records = [{ id: 'loop', chatKey: 'chat-a', url: dataUrl('image/png', pngBytes) }];
  const { spec, manifest } = bridge(records, { firstRecordId: 'loop', lastRecordId: 'loop' });
  let loads = 0;
  const resolver = createStoryboardGalleryMediaResolver({ records, loadRecordMedia: (record) => { loads += 1; return record.url; } });
  const result = await resolver({ spec, manifest, chatKey: 'chat-a' });
  assert.equal(result.ok, true);
  assert.equal(result.mediaInputs.length, 1);
  assert.equal(loads, 1);
});

test('deleted and cross-chat gallery records never fall back to stale URLs', async () => {
  const records = [{ id: 'first', chatKey: 'chat-a', url: dataUrl('image/png', pngBytes) }];
  const { spec, manifest } = bridge(records, { firstRecordId: 'first' });
  const missing = await resolveStoryboardGalleryMediaInputs({ spec, manifest, chatKey: 'chat-a' }, { records: [] });
  assert.match(missing.issues[0], /^asset_gallery_record_missing:/);
  assert.deepEqual(missing.mediaInputs, []);

  const wrongOwner = await resolveStoryboardGalleryMediaInputs({ spec, manifest, chatKey: 'chat-a' }, {
    records: [{ ...records[0], chatKey: 'chat-b' }],
  });
  assert.match(wrongOwner.issues[0], /^asset_owner_mismatch:/);
  assert.deepEqual(wrongOwner.mediaInputs, []);

  const wrongRecord = await resolveStoryboardGalleryMediaInputs({ spec, manifest, chatKey: 'chat-a' }, {
    findRecord: async () => ({ id: 'another-record', chatKey: 'chat-a', url: records[0].url }),
  });
  assert.match(wrongRecord.issues[0], /^asset_gallery_record_mismatch:/);
});

test('image bytes are checked against both signatures and declared MIME types', async () => {
  const records = [{ id: 'first', chatKey: 'chat-a', url: dataUrl('image/png', pngBytes), mimeType: 'image/png' }];
  const bridged = bridge(records, { firstRecordId: 'first' });
  bridged.manifest.assets[0].technical.mimeType = 'image/jpeg';
  const mismatch = await resolveStoryboardGalleryMediaInputs({ ...bridged, chatKey: 'chat-a' }, { records });
  assert.match(mismatch.issues[0], /^asset_media_mime_mismatch:/);

  const invalid = await resolveStoryboardGalleryMediaInputs({ ...bridge(records, { firstRecordId: 'first' }), chatKey: 'chat-a' }, {
    records,
    loadRecordMedia: () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }),
  });
  assert.match(invalid.issues[0], /^asset_media_signature_invalid:/);
});

test('legacy current-chat records without an owner and Blob loaders remain compatible', async () => {
  const manifestRecord = { id: 'legacy', chatKey: 'chat-a' };
  const { spec, manifest } = bridge([manifestRecord], { firstRecordId: 'legacy' });
  const result = await resolveStoryboardGalleryMediaInputs({ spec, manifest, chatKey: 'chat-a' }, {
    records: [{ id: 'legacy', url: '/legacy.png' }],
    loadRecordMedia: () => new Blob([pngBytes], { type: 'image/png' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mediaInputs[0].mime, 'image/png');
});

test('per-asset and aggregate byte limits fail before returning partial payloads', async () => {
  const records = [
    { id: 'first', chatKey: 'chat-a', url: 'unused' },
    { id: 'last', chatKey: 'chat-a', url: 'unused' },
  ];
  const pair = bridge(records, { firstRecordId: 'first', lastRecordId: 'last' });
  const tooLarge = await resolveStoryboardGalleryMediaInputs({ ...pair, chatKey: 'chat-a' }, {
    records,
    maxAssetBytes: 10,
    loadRecordMedia: () => ({ bytes: pngBytes, mime: 'image/png' }),
  });
  assert.match(tooLarge.issues[0], /^asset_media_too_large:/);
  assert.deepEqual(tooLarge.mediaInputs, []);

  const total = await resolveStoryboardGalleryMediaInputs({ ...pair, chatKey: 'chat-a' }, {
    records,
    maxAssetBytes: 20,
    maxTotalBytes: 19,
    loadRecordMedia: (record) => ({ bytes: record.id === 'first' ? pngBytes : jpegBytes, mime: record.id === 'first' ? 'image/png' : 'image/jpeg' }),
  });
  assert.equal(total.issues[0], 'inline_media_too_large');
  assert.deepEqual(total.mediaInputs, []);
});

test('the default loader reads local gallery URLs without forwarding cookies to HTTPS media hosts', async () => {
  const records = [{ id: 'first', chatKey: 'chat-a', url: 'https://media.example/frame.png' }];
  const bridged = bridge(records, { firstRecordId: 'first' });
  let init;
  const result = await resolveStoryboardGalleryMediaInputs({ ...bridged, chatKey: 'chat-a' }, {
    records,
    fetchImpl: async (_url, value) => {
      init = value;
      return new Response(pngBytes, { headers: { 'content-type': 'image/png', 'content-length': String(pngBytes.byteLength) } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
});

test('loader failures expose stable issue codes instead of URLs or callback diagnostics', async () => {
  const records = [{ id: 'first', chatKey: 'chat-a', url: 'https://secret.example/private-frame.png' }];
  const bridged = bridge(records, { firstRecordId: 'first' });
  const network = await resolveStoryboardGalleryMediaInputs({ ...bridged, chatKey: 'chat-a' }, {
    records,
    fetchImpl: async () => { throw new Error('request to https://secret.example/private-frame.png failed'); },
  });
  assert.match(network.issues[0], /^asset_media_unreadable:/);
  assert.doesNotMatch(JSON.stringify(network), /secret\.example/);

  const callback = await resolveStoryboardGalleryMediaInputs({ ...bridged, chatKey: 'chat-a' }, {
    records,
    loadRecordMedia: async () => { throw new Error('private callback details'); },
  });
  assert.match(callback.issues[0], /^asset_media_unreadable:/);
  assert.doesNotMatch(JSON.stringify(callback), /private callback/);
});

test('the media resolver is shipped as an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-media\.js/m);
assert.match(source, /videoMedia:\s*\{[\s\S]*import\('\.\/qianmu-video-media\.js\?v=1\.59\.61'\)/);
  assert.ok(release.files.includes('qianmu-video-media.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoMedia'\)/);
});
