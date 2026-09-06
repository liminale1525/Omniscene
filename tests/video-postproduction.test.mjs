import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_VIDEO_POSTPRODUCTION_SCHEMA,
  createEmptyVideoPostproduction,
  normalizeVideoPostproduction,
  validateVideoPostproduction,
} from '../qianmu-video-postproduction.js';

const timeline = (extra = {}) => ({
  timelineId: 'timeline-a',
  owner: { chatKey: 'chat-a' },
  clips: [
    { clipId: 'clip-a', playback: { durationSeconds: 6 } },
    { clipId: 'clip-b', playback: { durationSeconds: 4 } },
    { clipId: 'clip-c', playback: { durationSeconds: 3 } },
  ],
  durationSeconds: 13,
  ...extra,
});

test('an old timeline receives a silent native-only postproduction baseline', () => {
  const project = createEmptyVideoPostproduction(timeline());
  assert.equal(project.schema, QIANMU_VIDEO_POSTPRODUCTION_SCHEMA);
  assert.equal(project.timelineId, 'timeline-a');
  assert.equal(project.owner.chatKey, 'chat-a');
  assert.equal(project.durationMs, 13000);
  assert.equal(project.mode, 'native_only');
  assert.deepEqual(project.transitions, []);
  assert.deepEqual(project.subtitles, []);
  assert.deepEqual(project.audio, { dialogue: [], ambience: [], music: [] });
});

test('layered decisions keep bounded cues, stable audio references and adjacent transitions', () => {
  const result = validateVideoPostproduction({
    timelineId: 'timeline-a', owner: { chatKey: 'chat-a' }, mode: 'layered',
    transitions: [{ fromClipId: 'clip-a', toClipId: 'clip-b', type: 'crossfade', durationMs: 800 }],
    subtitles: [{ cueId: 'cue-a', startMs: 250, endMs: 1800, text: '原语言对白', language: 'zh', speakerId: 'character-a' }],
    audio: {
      dialogue: [{ audioId: 'audio-dialogue-a', assetId: 'voice-a', startMs: 250, endMs: 1800, speakerId: 'character-a', dialogueText: '原语言对白' }],
      ambience: [{ audioId: 'audio-room-a', source: { assetId: 'room-tone-a' }, startMs: 0, endMs: 13000, loop: true }],
      music: [{ audioId: 'audio-score-a', source: { assetId: 'score-a' }, startMs: 0, endMs: 13000, gainDb: -8 }],
    },
  }, timeline());
  assert.equal(result.ok, true);
  assert.equal(result.project.mode, 'layered');
  assert.equal(result.project.transitions[0].durationMs, 800);
  assert.equal(result.project.subtitles[0].text, '原语言对白');
  assert.equal(result.project.audio.dialogue[0].source.assetId, 'voice-a');
  assert.equal(result.project.audio.music[0].gainDb, -8);
  assert.equal(result.project.mix.nativeAudio, 'timeline');
});

test('cross-chat, non-adjacent and invalid timed layers fail closed', () => {
  const result = validateVideoPostproduction({
    timelineId: 'timeline-b', owner: { chatKey: 'chat-b' }, mode: 'automatic',
    transitions: [{ transitionId: 'transition-a', fromClipId: 'clip-a', toClipId: 'clip-c', type: 'wipe', durationMs: 500 }],
    subtitles: [{ cueId: 'cue-a', startMs: 2000, endMs: 1000, text: '' }],
    audio: { dialogue: [{ audioId: 'audio-a', startMs: 3000, endMs: 2000 }] },
  }, timeline());
  assert.equal(result.ok, false);
  assert.equal(result.project.mode, 'native_only');
  assert.ok(result.issues.includes('postproduction_timeline_mismatch'));
  assert.ok(result.issues.includes('postproduction_owner_mismatch'));
  assert.ok(result.issues.includes('postproduction_mode_invalid'));
  assert.ok(result.issues.includes('postproduction_transition_not_adjacent:0'));
  assert.ok(result.issues.includes('postproduction_transition_type_invalid:0'));
  assert.ok(result.issues.includes('postproduction_subtitle_text_missing:0'));
  assert.ok(result.issues.includes('postproduction_subtitle_range_invalid:0'));
  assert.ok(result.issues.includes('postproduction_audio_source_missing:dialogue:0'));
  assert.ok(result.issues.includes('postproduction_audio_range_invalid:dialogue:0'));
});

test('normalization strips URLs, blobs, credentials and arbitrary renderer state', () => {
  const project = normalizeVideoPostproduction({
    timelineId: 'timeline-a', owner: { chatKey: 'chat-a' }, apiKey: 'private-key',
    subtitles: [{ startMs: 0, endMs: 1000, text: 'caption', url: 'https://private.example/subtitle' }],
    audio: { music: [{ assetId: 'score-a', startMs: 0, endMs: 1200, blob: new Blob(['secret']), url: 'blob:secret', providerResponse: { secret: true } }] },
  }, timeline());
  const serialized = JSON.stringify(project);
  assert.doesNotMatch(serialized, /private-key|private\.example|blob:secret|providerResponse|Blob|apiKey|url/);
});

test('director subtitles retain a bounded decision and clip provenance chain', () => {
  const result = validateVideoPostproduction({
    timelineId: 'timeline-a', owner: { chatKey: 'chat-a' }, mode: 'layered',
    subtitles: [{
      cueId: 'cue-director-a', startMs: 100, endMs: 1200, text: '到此为止。', kind: 'dialogue',
      source: {
        kind: 'director', refId: 'work-a:clip-a:line-1', decisionId: 'decision-a', workOrderId: 'work-a',
        recordId: 'record-a', clipId: 'clip-a', relativeStartMs: 100, relativeEndMs: 1200,
        prompt: 'discard me', apiKey: 'discard me too',
      },
    }],
  }, timeline());
  assert.equal(result.ok, true, result.issues.join(','));
  assert.equal(result.project.subtitles[0].source.kind, 'director');
  assert.equal(result.project.subtitles[0].source.clipId, 'clip-a');
  assert.doesNotMatch(JSON.stringify(result.project), /discard me|apiKey|prompt/);

  const invalid = validateVideoPostproduction({
    timelineId: 'timeline-a', owner: { chatKey: 'chat-a' }, mode: 'layered',
    subtitles: [{ startMs: 0, endMs: 500, text: 'orphan', source: { kind: 'director', refId: 'ref-a', clipId: 'missing' } }],
  }, timeline());
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.includes('postproduction_subtitle_director_source_missing:0'));
  assert.ok(invalid.issues.includes('postproduction_subtitle_director_clip_missing:0'));
});

test('director voice tracks retain only a bounded audio and decision source', () => {
  const result = validateVideoPostproduction({
    timelineId: 'timeline-a', owner: { chatKey: 'chat-a' }, mode: 'layered',
    audio: { dialogue: [{
      audioId: 'voice-work-a', role: 'dialogue', label: 'Alice', startMs: 100, endMs: 1200,
      speakerId: 'alice', dialogueText: '到此为止。',
      source: {
        kind: 'director_voice', assetId: 'tts:abc', refId: 'work-a:clip-a:line-1', decisionId: 'decision-a',
        workOrderId: 'work-a', recordId: 'record-a', clipId: 'clip-a', relativeStartMs: 100, relativeEndMs: 1200,
        apiKey: 'discard', url: 'https://private.invalid/audio',
      },
    }] },
  }, timeline());
  assert.equal(result.ok, true, result.issues.join(','));
  assert.equal(result.project.audio.dialogue[0].source.kind, 'director_voice');
  assert.equal(result.project.audio.dialogue[0].source.assetId, 'tts:abc');
  assert.doesNotMatch(JSON.stringify(result.project), /discard|private\.invalid|apiKey|url/);

  const invalid = validateVideoPostproduction({
    timelineId: 'timeline-a', owner: { chatKey: 'chat-a' }, mode: 'layered',
    audio: { ambience: [{ audioId: 'voice-a', startMs: 0, endMs: 500, source: { kind: 'director_voice', assetId: 'tts:a', clipId: 'missing' } }] },
  }, timeline());
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.includes('postproduction_audio_director_role_invalid:ambience:0'));
  assert.ok(invalid.issues.includes('postproduction_audio_director_source_missing:ambience:0'));
  assert.ok(invalid.issues.includes('postproduction_audio_director_clip_missing:ambience:0'));
});

test('the postproduction contract is an idle release chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /videoPostproduction:\s*\{[\s\S]*import\('\.\/qianmu-video-postproduction\.js\?v=1\.59\.45'\)/);
  assert.ok(release.files.includes('qianmu-video-postproduction.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoPostproduction'\)/);
});
