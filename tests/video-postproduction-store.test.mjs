import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createEmptyVideoPostproduction } from '../qianmu-video-postproduction.js';
import { createVideoPostproductionStoreAdapter } from '../qianmu-video-postproduction-store.js';

const timeline = (extra = {}) => ({
  timelineId: 'timeline-a', owner: { chatKey: 'chat-a' },
  clips: [
    { clipId: 'clip-a', playback: { durationSeconds: 6 } },
    { clipId: 'clip-b', playback: { durationSeconds: 4 } },
  ],
  durationSeconds: 10,
  ...extra,
});

function mockStorage(overrides = {}) {
  return {
    putVideoPostproduction: async (value) => ({ timelineId: value.timelineId }),
    getVideoPostproduction: async () => null,
    deleteVideoPostproduction: async (ids) => ({ deleted: ids }),
    ...overrides,
  };
}

test('saving revalidates the exact timeline and refreshes bounded timestamps', async () => {
  let captured;
  const adapter = createVideoPostproductionStoreAdapter(mockStorage({
    putVideoPostproduction: async (value) => { captured = value; return { timelineId: value.timelineId }; },
  }));
  const project = {
    ...createEmptyVideoPostproduction(timeline()),
    mode: 'layered',
    transitions: [{ fromClipId: 'clip-a', toClipId: 'clip-b', type: 'crossfade', durationMs: 500 }],
    createdAt: 1000,
    apiKey: 'private-key',
    renderer: { url: 'blob:secret' },
  };
  const saved = await adapter.save(project, timeline(), { now: 2000 });
  assert.equal(saved.createdAt, 1000);
  assert.equal(saved.updatedAt, 2000);
  assert.equal(captured.owner.chatKey, 'chat-a');
  assert.doesNotMatch(JSON.stringify(captured), /private-key|blob:secret|renderer|apiKey/);
});

test('restore is timeline and chat scoped and rejects stale structural references', async () => {
  const project = createEmptyVideoPostproduction(timeline());
  const adapter = createVideoPostproductionStoreAdapter(mockStorage({
    getVideoPostproduction: async () => ({ project: { ...project, remoteUrl: 'https://private.example/audio' } }),
  }));
  const restored = await adapter.load('timeline-a', 'chat-a', timeline());
  assert.equal(restored.timelineId, 'timeline-a');
  assert.doesNotMatch(JSON.stringify(restored), /private\.example|remoteUrl/);
  assert.equal(await adapter.load('timeline-a', 'chat-b', timeline()), null);
  assert.equal(await adapter.load('timeline-a', 'chat-a', timeline({ timelineId: 'timeline-b' })), null);
});

test('removal is bounded and deduplicated without touching timeline or media stores', async () => {
  let captured;
  const adapter = createVideoPostproductionStoreAdapter(mockStorage({
    deleteVideoPostproduction: async (ids) => { captured = ids; return { deleted: ids }; },
  }));
  await adapter.remove(['timeline-a', 'timeline-a', '', 'timeline-b']);
  assert.deepEqual(captured, ['timeline-a', 'timeline-b']);
});

test('the additive store is separately auditable, chat-cleanable and lazy', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.match(storage, /const DB_VERSION = 15/);
  assert.match(storage, /STORE_VIDEO_POSTPRODUCTION = 'video_postproduction'/);
  const persistence = storage.slice(storage.indexOf('function normalizeStoredVideoPostproduction'), storage.indexOf('export const VIDEO_MEDIA_MAX_BYTES'));
  assert.match(persistence, /schema: 'qianmu\.video-postproduction\.v1'/);
  assert.doesNotMatch(persistence, /apiKey|authorization|remoteUrl|base64|Blob/);
assert.match(source, /videoPostproductionStore:\s*\{[\s\S]*import\('\.\/qianmu-video-postproduction-store\.js\?v=1\.59\.48'\)/);
  assert.match(source, /video_postproduction: \['不可恢复 · 影片字幕与声轨决策', true\]/);
  assert.match(source, /STORAGE_CHAT_CLEARABLE[^\n]*video_postproduction/);
  assert.ok(release.files.includes('qianmu-video-postproduction-store.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoPostproductionStore'\)/);
});
