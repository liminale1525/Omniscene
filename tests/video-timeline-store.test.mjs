import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildVideoTimeline } from '../qianmu-video-timeline.js';
import { createVideoTimelineStoreAdapter } from '../qianmu-video-timeline-store.js';

const timeline = (extra = {}) => {
  const built = buildVideoTimeline({
    owner: { chatKey: 'chat-a' },
    motionItems: [{
      assetId: 'asset-a', recordId: 'record-a', sourceRecordId: 'poster-a',
      owner: { chatKey: 'chat-a', floor: 2, messageId: 'message-a' },
      technical: { durationSeconds: 6 },
    }],
    selections: [{ kind: 'motion', assetId: 'asset-a' }],
    ...extra,
  }, { now: 1000 });
  assert.equal(built.ok, true);
  return built.timeline;
};

function mockStorage(overrides = {}) {
  return {
    putVideoTimeline: async (value) => ({ timelineId: value.timelineId }),
    getVideoTimeline: async () => null,
    listVideoTimelines: async () => [],
    deleteVideoTimelines: async (ids) => ({ deleted: ids }),
    ...overrides,
  };
}

test('timeline saves pass through the strict contract and refresh update time', async () => {
  let captured;
  const adapter = createVideoTimelineStoreAdapter(mockStorage({
    putVideoTimeline: async (value) => { captured = value; return { timelineId: value.timelineId }; },
  }));
  const source = { ...timeline(), apiKey: 'private-key', prompt: 'secret prompt', blob: new Blob(['secret']) };
  const saved = await adapter.save(source, { now: 2000 });
  assert.equal(saved.createdAt, 1000);
  assert.equal(saved.updatedAt, 2000);
  assert.equal(captured.owner.chatKey, 'chat-a');
  assert.doesNotMatch(JSON.stringify(captured), /private-key|secret prompt|apiKey|blob/i);
});

test('timeline restore is chat-scoped and normalizes untrusted records', async () => {
  const safe = timeline();
  const adapter = createVideoTimelineStoreAdapter(mockStorage({
    getVideoTimeline: async () => ({ timeline: { ...safe, remoteUrl: 'https://private.example/movie.mp4' } }),
    listVideoTimelines: async () => [
      { timeline: { ...safe, prompt: 'secret prompt' } },
      { timeline: { ...safe, timelineId: 'timeline-b', owner: { chatKey: 'chat-b' }, clips: safe.clips.map((clip) => ({ ...clip, owner: { ...clip.owner, chatKey: 'chat-b' } })) } },
      { timeline: { timelineId: 'invalid', owner: {} } },
    ],
  }));
  const restored = await adapter.load(safe.timelineId, 'chat-a');
  assert.equal(restored.timelineId, safe.timelineId);
  assert.doesNotMatch(JSON.stringify(restored), /private\.example|remoteUrl/);
  assert.equal(await adapter.load(safe.timelineId, 'chat-b'), null);
  const listed = await adapter.list('chat-a');
  assert.deepEqual(listed.map((item) => item.timelineId), [safe.timelineId]);
  assert.doesNotMatch(JSON.stringify(listed), /secret prompt/);
});

test('timeline removal is bounded and deduplicated', async () => {
  let captured;
  const adapter = createVideoTimelineStoreAdapter(mockStorage({
    deleteVideoTimelines: async (ids) => { captured = ids; return { deleted: ids }; },
  }));
  await adapter.remove(['timeline-a', 'timeline-a', '', 'timeline-b']);
  assert.deepEqual(captured, ['timeline-a', 'timeline-b']);
});

test('the additive timeline store is idle, chat-cleanable and included in the release', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.match(storage, /const DB_VERSION = 15/);
  assert.match(storage, /STORE_VIDEO_TIMELINES = 'video_timelines'/);
  const persistence = storage.slice(storage.indexOf('function normalizeStoredVideoTimeline'), storage.indexOf('// ── 动态镜头：本地成片仓'));
  assert.match(persistence, /schema: 'qianmu\.video-timeline\.v1'/);
  assert.doesNotMatch(persistence, /apiKey|authorization|remoteUrl|base64|Blob/);
assert.match(source, /videoTimelineStore:\s*\{[\s\S]*import\('\.\/qianmu-video-timeline-store\.js\?v=1\.59\.31'\)/);
  assert.match(source, /video_timelines: \['不可恢复 · 完整影片时间线', true\]/);
  assert.match(source, /STORAGE_CHAT_CLEARABLE[^\n]*video_timelines/);
  assert.ok(release.files.includes('qianmu-video-timeline-store.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoTimelineStore'\)/);
});
