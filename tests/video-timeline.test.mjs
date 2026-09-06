import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_VIDEO_TIMELINE_MAX_CLIPS,
  buildVideoTimeline,
  moveVideoTimelineClip,
  normalizeVideoTimeline,
  validateVideoTimeline,
} from '../qianmu-video-timeline.js';

const motion = (extra = {}) => ({
  assetId: 'video-asset-a',
  recordId: 'video-record-a',
  sourceRecordId: 'image-record-a',
  owner: { chatKey: 'chat-a', floor: 4, messageId: 'message-a' },
  technical: { durationSeconds: 6 },
  ...extra,
});

const still = (extra = {}) => ({
  id: 'image-record-b',
  chatKey: 'chat-a',
  floor: 5,
  messageId: 'message-b',
  url: 'data:image/png;base64,SHOULD_NOT_SURVIVE',
  prompt: 'SHOULD_NOT_SURVIVE',
  ...extra,
});

test('a mixed selection becomes one ordered, sequential and credential-free timeline', () => {
  const result = buildVideoTimeline({
    owner: { chatKey: 'chat-a' },
    title: 'Kitchen sequence',
    motionItems: [motion({ downloadUrl: 'https://private.example/movie.mp4', apiKey: 'private-key' })],
    stillRecords: [still()],
    selections: [
      { kind: 'motion', assetId: 'video-asset-a' },
      { kind: 'still', recordId: 'image-record-b', durationSeconds: 4 },
    ],
  }, { now: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.timeline.status, 'ready');
  assert.equal(result.timeline.playbackMode, 'sequential');
  assert.deepEqual(result.timeline.clips.map((clip) => clip.kind), ['motion', 'still']);
  assert.deepEqual(result.timeline.clips.map((clip) => clip.playback.durationSeconds), [6, 4]);
  assert.equal(result.timeline.durationSeconds, 10);
  assert.equal(result.timeline.clips[0].source.posterRecordId, 'image-record-a');
  assert.equal(result.timeline.clips[1].playback.audio, 'mute');
  assert.doesNotMatch(JSON.stringify(result), /private-key|private\.example|SHOULD_NOT_SURVIVE|data:image|prompt/);
});

test('missing and cross-chat sources stay explicit instead of guessing by floor', () => {
  const result = buildVideoTimeline({
    owner: { chatKey: 'chat-a' },
    motionItems: [motion({ owner: { chatKey: 'chat-b', floor: 4 } })],
    stillRecords: [still()],
    selections: [
      { kind: 'motion', assetId: 'video-asset-a' },
      { kind: 'still', recordId: 'missing-record' },
    ],
  }, { now: 1000 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, ['timeline_clip_owner_mismatch:0', 'timeline_clip_not_found:1', 'timeline_clips_missing']);
  assert.deepEqual(result.timeline.clips, []);
});

test('reordering preserves clip identities and never mutates the original timeline', () => {
  const built = buildVideoTimeline({
    owner: { chatKey: 'chat-a' },
    motionItems: [motion()],
    stillRecords: [still()],
    selections: [
      { kind: 'motion', assetId: 'video-asset-a' },
      { kind: 'still', recordId: 'image-record-b' },
    ],
  }, { now: 1000 });
  const before = built.timeline.clips.map((clip) => clip.clipId);
  const moved = moveVideoTimelineClip(built.timeline, 0, 1, { now: 2000 });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.timeline.clips.map((clip) => clip.clipId), [...before].reverse());
  assert.deepEqual(built.timeline.clips.map((clip) => clip.clipId), before);
  assert.equal(moved.timeline.updatedAt, 2000);
  assert.equal(moveVideoTimelineClip(built.timeline, 0, 9).issue, 'timeline_reorder_out_of_range');
});

test('normalization is bounded and ignores transient media fields', () => {
  const clips = Array.from({ length: QIANMU_VIDEO_TIMELINE_MAX_CLIPS + 8 }, (_, index) => ({
    clipId: `clip-${index}`,
    kind: 'still',
    source: { recordId: `record-${index}` },
    owner: { chatKey: 'chat-a' },
    durationSeconds: 3,
    blob: new Blob(['secret']),
    url: 'blob:secret',
  }));
  const timeline = normalizeVideoTimeline({ timelineId: 'timeline-a', owner: { chatKey: 'chat-a' }, clips, apiKey: 'secret-key' });
  assert.equal(timeline.clips.length, QIANMU_VIDEO_TIMELINE_MAX_CLIPS);
  assert.doesNotMatch(JSON.stringify(timeline), /secret-key|blob:secret|Blob|url/);
});

test('timeline validation rejects duplicate clip ids and incomplete stable references', () => {
  const validation = validateVideoTimeline({
    timelineId: 'timeline-a',
    owner: { chatKey: 'chat-a' },
    clips: [
      { clipId: 'same', kind: 'motion', owner: { chatKey: 'chat-a' }, source: { assetId: 'asset-a' } },
      { clipId: 'same', kind: 'still', owner: { chatKey: 'chat-b' }, source: {} },
    ],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes('timeline_motion_source_invalid:0'));
  assert.ok(validation.issues.includes('timeline_clip_id_duplicate:1'));
  assert.ok(validation.issues.includes('timeline_clip_owner_mismatch:1'));
  assert.ok(validation.issues.includes('timeline_still_source_invalid:1'));
});

test('the timeline contract ships as an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /videoTimeline:\s*\{[\s\S]*import\('\.\/qianmu-video-timeline\.js\?v=1\.59\.57'\)/);
  assert.ok(release.files.includes('qianmu-video-timeline.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoTimeline'\)/);
});
