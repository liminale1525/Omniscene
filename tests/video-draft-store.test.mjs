import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createVideoDraftFromStoryboardFrame } from '../qianmu-video-draft.js';
import { createVideoDraftStoreAdapter } from '../qianmu-video-draft-store.js';

const draft = (extra = {}) => ({
  ...createVideoDraftFromStoryboardFrame({ id: 'frame-a', chatKey: 'chat-a', floor: 2 }, {
    now: 1000,
    clientNonce: 'draft-store-test',
  }),
  ...extra,
});

function mockStorage(overrides = {}) {
  return {
    putVideoDraft: async (value) => ({ draftId: value.draftId }),
    getVideoDraft: async () => null,
    listVideoDrafts: async () => [],
    deleteVideoDrafts: async (ids) => ({ deleted: ids }),
    ...overrides,
  };
}

test('draft saves pass through the strict contract before storage', async () => {
  let captured;
  const adapter = createVideoDraftStoreAdapter(mockStorage({
    putVideoDraft: async (value) => { captured = value; return { draftId: value.draftId }; },
  }));
  const value = draft({
    apiKey: 'private-key',
    prompt: 'secret prompt',
    remoteUrl: 'https://media.example/video.mp4',
    binary: new Uint8Array([1, 2, 3]),
  });
  const saved = await adapter.save(value);
  assert.equal(saved.owner.chatKey, 'chat-a');
  assert.equal(captured.schema, 'qianmu.video-draft.v1');
  assert.doesNotMatch(JSON.stringify(captured), /private-key|secret prompt|media\.example|Uint8Array|apiKey/);
});

test('draft restore stays within its chat and normalizes untrusted records', async () => {
  const safe = draft();
  const adapter = createVideoDraftStoreAdapter(mockStorage({
    getVideoDraft: async () => ({ draft: { ...safe, apiKey: 'private-key' } }),
    listVideoDrafts: async () => [
      { draft: { ...safe, prompt: 'secret prompt' } },
      { draft: { ...safe, draftId: 'draft-other', owner: { ...safe.owner, chatKey: 'chat-b' } } },
      { draft: { draftId: 'invalid', owner: {} } },
    ],
  }));
  const restored = await adapter.load(safe.draftId);
  assert.equal(restored.draftId, safe.draftId);
  assert.doesNotMatch(JSON.stringify(restored), /private-key|apiKey/);
  const listed = await adapter.list('chat-a');
  assert.deepEqual(listed.map((item) => item.draftId), [safe.draftId]);
  assert.doesNotMatch(JSON.stringify(listed), /secret prompt/);
});

test('draft removal is bounded and deduplicated', async () => {
  let captured;
  const adapter = createVideoDraftStoreAdapter(mockStorage({
    deleteVideoDrafts: async (ids) => { captured = ids; return { deleted: ids }; },
  }));
  await adapter.remove(['draft-a', 'draft-a', '', 'draft-b']);
  assert.deepEqual(captured, ['draft-a', 'draft-b']);
});

test('the additive draft store is idle and included in the release', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.match(storage, /const DB_VERSION = 15/);
  assert.match(storage, /STORE_VIDEO_DRAFTS = 'video_drafts'/);
  const persistence = storage.slice(storage.indexOf('function normalizeStoredVideoDraft'), storage.indexOf('// ── 完整影片：时间线草稿'));
  assert.match(persistence, /schema: 'qianmu\.video-draft\.v1'/);
  assert.doesNotMatch(persistence, /apiKey|authorization|remoteUrl|base64|blob/i);
assert.match(source, /videoDraftStore:\s*\{[\s\S]*import\('\.\/qianmu-video-draft-store\.js\?v=1\.59\.67'\)/);
  assert.ok(release.files.includes('qianmu-video-draft-store.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoDraftStore'\)/);
});
