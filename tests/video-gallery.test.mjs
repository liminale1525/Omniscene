import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildVideoTaskGalleryStatuses,
  buildVideoVersionChains,
  createVideoGallerySession,
  normalizeVideoGalleryItem,
} from '../qianmu-video-gallery.js';
import { normalizeVideoMediaMeta } from '../qianmu-blobstore.js';

function descriptor(extra = {}) {
  return {
    assetId: 'video-asset-a',
    recordId: 'video-record-a',
    size: 11,
    mimeType: 'video/mp4',
    createdAt: 1000,
    updatedAt: 1200,
    meta: {
      taskId: 'video-task-a', shotId: 'shot-a', versionRootId: 'video-task-a', attempt: 1,
      draftId: 'video-draft-a', sourceRecordId: 'image-record-a',
      chatKey: 'chat-a', floor: 4, messageId: 'message-a', durationSeconds: 6,
      resolution: '768P', ratio: '16:9', referenceAssetIds: ['image-a'],
      aiGenerated: true, generator: 'MiniMax H3',
    },
    ...extra,
  };
}

test('gallery list records are metadata-only and reject unstable fields', () => {
  const item = normalizeVideoGalleryItem({
    ...descriptor(),
    blob: new Blob(['video-bytes'], { type: 'video/mp4' }),
    downloadUrl: 'https://media.example/result.mp4',
    apiKey: 'private-key',
    meta: { ...descriptor().meta, prompt: 'secret prompt', referenceAssetIds: ['image-a', 'image-a', 'bad id'] },
  });
  assert.equal(item.owner.chatKey, 'chat-a');
  assert.equal(item.draftId, 'video-draft-a');
  assert.equal(item.sourceRecordId, 'image-record-a');
  assert.deepEqual(item.provenance, { aiGenerated: true, generator: 'MiniMax H3' });
  assert.deepEqual(item.referenceAssetIds, ['image-a']);
  assert.doesNotMatch(JSON.stringify(item), /video-bytes|media\.example|private-key|secret prompt|downloadUrl|blob/);
});

test('gallery-only videos keep a null floor instead of appearing on floor zero', () => {
  const withoutFloor = descriptor({ meta: { ...descriptor().meta, floor: null } });
  assert.equal(normalizeVideoMediaMeta(withoutFloor.meta).floor, null);
  assert.equal(normalizeVideoGalleryItem(withoutFloor).owner.floor, null);
  assert.equal(normalizeVideoGalleryItem(descriptor({ meta: { ...descriptor().meta, floor: 0 } })).owner.floor, 0);
});

test('legacy H3 media infers disclosure from its stable remote task id without rewriting storage', () => {
  const legacy = descriptor({ meta: { ...descriptor().meta, aiGenerated: undefined, generator: '', remoteTaskId: 'remote-old' } });
  assert.deepEqual(normalizeVideoGalleryItem(legacy).provenance, { aiGenerated: true, generator: 'MiniMax H3' });
  assert.equal(normalizeVideoMediaMeta(legacy.meta).generator, 'MiniMax H3');
});

test('versions group by chat and stable root while preserving attempt order', () => {
  const chains = buildVideoVersionChains([
    descriptor({ assetId: 'video-asset-b', recordId: 'video-record-b', updatedAt: 2000, meta: { ...descriptor().meta, attempt: 2 } }),
    descriptor(),
    descriptor({ assetId: 'video-asset-c', recordId: 'video-record-c', meta: { ...descriptor().meta, chatKey: 'chat-b' } }),
  ]);
  assert.equal(chains.length, 2);
  const chain = chains.find((item) => item.chatKey === 'chat-a');
  assert.deepEqual(chain.items.map((item) => item.attempt), [1, 2]);
  assert.equal(chain.latest.assetId, 'video-asset-b');
});

test('task summaries are local-only, concise, and hide already archived successes', () => {
  const task = (state, extra = {}) => ({
    taskId: `task-${state}`, shotId: 'shot-a', state, attempt: 1,
    owner: { chatKey: 'chat-a', floor: null, messageId: 'message-a' },
    timing: { createdAt: 1000, updatedAt: 2000 },
    ...extra,
  });
  const statuses = buildVideoTaskGalleryStatuses([
    task('submitted'),
    task('polling', { progress: { percent: 62 } }),
    task('failed', { draftId: 'draft-a', failure: { retryable: true, chargeState: 'unknown', message: 'private diagnostics' } }),
    task('succeeded', { result: { assetId: 'archived-asset' } }),
    task('succeeded', { taskId: 'task-missing-media', result: { assetId: 'missing-asset' } }),
  ], ['archived-asset']);
  assert.deepEqual(statuses.map((item) => item.taskId), ['task-failed', 'task-missing-media', 'task-polling', 'task-submitted']);
  assert.equal(statuses.find((item) => item.taskId === 'task-submitted').statusLabel, '待核对提交');
  assert.equal(statuses.find((item) => item.taskId === 'task-submitted').needsReconciliation, true);
  assert.equal(statuses.find((item) => item.taskId === 'task-submitted').canRefresh, false);
  assert.equal(statuses.find((item) => item.taskId === 'task-submitted').canCancel, false);
  assert.equal(statuses.find((item) => item.taskId === 'task-polling').progress, 62);
  assert.equal(statuses.find((item) => item.taskId === 'task-failed').retryable, true);
  assert.equal(statuses.find((item) => item.taskId === 'task-failed').draftId, 'draft-a');
  assert.equal(statuses.find((item) => item.taskId === 'task-failed').canReopenDraft, true);
  assert.equal(statuses.find((item) => item.taskId === 'task-missing-media').statusLabel, '成片待归档');
  assert.equal(statuses.every((item) => item.owner.floor === null), true);
  assert.doesNotMatch(JSON.stringify(statuses), /private diagnostics|idempotency|remoteTaskId/);
});

test('only provider-backed active tasks expose an explicit one-shot refresh action', () => {
  const statuses = buildVideoTaskGalleryStatuses([{
    taskId: 'task-known', shotId: 'shot-a', state: 'submitted', attempt: 1,
    owner: { chatKey: 'chat-a', floor: 2 },
    provider: { remoteTaskId: 'remote-a' },
    timing: { createdAt: 1000, updatedAt: 2000 },
  }]);
  assert.equal(statuses[0].canRefresh, true);
  assert.equal(statuses[0].canCancel, true);
  assert.equal(statuses[0].needsReconciliation, false);
});

test('the playback session reads Blobs only on demand and reference-counts Object URLs', async () => {
  let mediaReads = 0;
  const revoked = [];
  const storage = {
    listVideoMedia: async () => [{ ...descriptor(), blob: new Blob(['must-not-return']) }],
    getVideoMedia: async () => {
      mediaReads++;
      return { ...descriptor(), blob: new Blob(['video-bytes'], { type: 'video/mp4' }) };
    },
    deleteVideoMedia: async (assetId) => ({ deleted: assetId }),
  };
  const session = createVideoGallerySession(storage, {
    urlApi: {
      createObjectURL: () => 'blob:qianmu/video-a',
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  const listed = await session.list('chat-a');
  assert.equal(mediaReads, 0, 'listing the gallery must not read media blobs');
  assert.equal(Object.hasOwn(listed[0], 'blob'), false);
  const first = await session.open('video-asset-a', { chatKey: 'chat-a' });
  const second = await session.open('video-asset-a', { chatKey: 'chat-a' });
  assert.equal(mediaReads, 1);
  assert.equal(first.url, 'blob:qianmu/video-a');
  assert.deepEqual(session.snapshot(), [{ assetId: 'video-asset-a', refs: 2 }]);
  assert.equal(first.release(), true);
  assert.equal(first.release(), false);
  assert.deepEqual(revoked, []);
  assert.equal(second.release(), true);
  assert.deepEqual(revoked, ['blob:qianmu/video-a']);
  assert.deepEqual(session.snapshot(), []);
});

test('chat ownership is checked before exposing a playable URL and deletion revokes active media', async () => {
  const revoked = [];
  let deleted = '';
  const session = createVideoGallerySession({
    listVideoMedia: async () => [],
    getVideoMedia: async () => ({ ...descriptor(), blob: new Blob(['video-bytes'], { type: 'video/mp4' }) }),
    deleteVideoMedia: async (assetId) => { deleted = assetId; return { deleted: assetId }; },
  }, {
    urlApi: {
      createObjectURL: () => 'blob:qianmu/video-a',
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  await assert.rejects(session.open('video-asset-a', { chatKey: 'chat-b' }), /another chat/);
  const handle = await session.open('video-asset-a', { chatKey: 'chat-a' });
  await session.delete(handle.assetId);
  assert.equal(deleted, 'video-asset-a');
  assert.deepEqual(revoked, ['blob:qianmu/video-a']);
});

test('the dynamic gallery ships as an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /videoGallery:\s*\{[\s\S]*import\('\.\/qianmu-video-gallery\.js\?v=1\.59\.37'\)/);
assert.match(source, /videoStore:\s*\{[\s\S]*import\('\.\/qianmu-video-store\.js\?v=1\.59\.37'\)/);
  assert.ok(release.files.includes('qianmu-video-gallery.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoGallery'\)|featureRuntime\.load\('videoStore'\)/);
});
