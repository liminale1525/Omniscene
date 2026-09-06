import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createVideoShotFromStoryboardFrames, normalizeMultimodalAssetManifest, normalizeVideoShotSpec } from '../qianmu-video-contract.js';
import {
  MINIMAX_H3_PROVIDER_CAPABILITY,
  buildMiniMaxH3CancelRequest,
  buildMiniMaxH3CreateRequest,
  buildMiniMaxH3QueryRequest,
  normalizeMiniMaxH3Connection,
  parseMiniMaxH3CancelResponse,
  parseMiniMaxH3CreateResponse,
  parseMiniMaxH3TaskResponse,
  planMiniMaxH3Cancellation,
} from '../qianmu-video-minimax.js';

const mediaAsset = (assetId, kind, role, durationSeconds = 0) => ({
  assetId,
  kind,
  roles: [role],
  locator: { kind: 'indexeddb', ref: `asset:${assetId}` },
  technical: { durationSeconds },
});

test('official H3 connections use the same-origin gateway and only known regional API origins', () => {
  assert.equal(MINIMAX_H3_PROVIDER_CAPABILITY.browserDirect, false);
  assert.equal(MINIMAX_H3_PROVIDER_CAPABILITY.transport, 'same_origin_gateway');
  assert.equal(MINIMAX_H3_PROVIDER_CAPABILITY.keyType, 'pay_as_you_go');
  assert.equal(normalizeMiniMaxH3Connection({ region: 'cn' }).baseUrl, 'https://api.minimaxi.com');
  assert.equal(normalizeMiniMaxH3Connection({ baseUrl: 'https://evil.example/v2' }).baseUrl, 'https://api.minimax.io');
});

test('text-only shots compile to the official V2 content request without a persisted API key', () => {
  const spec = normalizeVideoShotSpec({ shotId: 'text-shot', summary: 'A quiet room begins to move.', aspectRatio: '21:9' });
  const result = buildMiniMaxH3CreateRequest(spec, { shotId: 'text-shot', assets: [] }, { prompt: 'A quiet room begins to move.' });
  assert.equal(result.ok, true);
  assert.equal(result.request.url, 'https://api.minimax.io/v2/video_generation');
  assert.equal(result.request.body.model, 'MiniMax-H3');
  assert.equal(result.request.body.ratio, '21:9');
  assert.equal(result.request.body.duration, 6);
  assert.deepEqual(result.request.body.content, [{ type: 'text', text: 'A quiet room begins to move.' }]);
  assert.doesNotMatch(JSON.stringify(result.request), /apiKey|Bearer\s+[A-Za-z0-9]/);
});

test('the same storyboard image can be sent as both first and last frame for a loop', () => {
  const bridged = createVideoShotFromStoryboardFrames({ summary: 'A seamless loop.' }, [{ id: 'loop', chatKey: 'chat-a' }], {
    shotId: 'loop-shot', firstRecordId: 'loop', lastRecordId: 'loop',
  });
  const assetId = bridged.manifest.assets[0].assetId;
  const result = buildMiniMaxH3CreateRequest(bridged.spec, bridged.manifest, {
    prompt: 'The movement returns exactly to the opening pose.',
    mediaUrls: { [assetId]: 'https://media.example/loop.png' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.request.body.ratio, 'adaptive');
  assert.deepEqual(result.request.body.content.slice(1).map((item) => item.role), ['first_frame', 'last_frame']);
  assert.equal(result.request.body.content[1].image_url.url, result.request.body.content[2].image_url.url);
});

test('reference mode maps image, video and audio without mixing keyframe roles', () => {
  const manifest = normalizeMultimodalAssetManifest({
    shotId: 'reference-shot',
    assets: [
      mediaAsset('image-a', 'image', 'subject_reference'),
      mediaAsset('video-a', 'video', 'motion_reference', 5),
      mediaAsset('audio-a', 'audio', 'audio_reference', 4),
    ],
  });
  const spec = normalizeVideoShotSpec({ shotId: 'reference-shot', summary: 'Follow all references.', requestedMode: 'auto' }, manifest);
  const result = buildMiniMaxH3CreateRequest(spec, manifest, {
    prompt: 'Follow the referenced subject, motion, and voice.',
    mediaUrls: new Map([
      ['image-a', 'https://media.example/subject.png'],
      ['video-a', 'https://media.example/motion.mp4'],
      ['audio-a', 'https://media.example/voice.wav'],
    ]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request.body.content.slice(1).map((item) => item.role), ['reference_image', 'reference_video', 'reference_audio']);
  assert.ok(result.request.body.content.every((item) => !['first_frame', 'last_frame'].includes(item.role)));
});

test('missing, insecure, or oversized provider inputs fail before submission', () => {
  const manifest = normalizeMultimodalAssetManifest({ assets: [mediaAsset('first', 'image', 'first_frame')] });
  const spec = normalizeVideoShotSpec({ shotId: 'blocked', summary: 'Move.', requestedMode: 'i2va' }, manifest);
  const missing = buildMiniMaxH3CreateRequest(spec, manifest, { prompt: 'Move.' });
  assert.ok(missing.issues.includes('provider_asset_url_missing:first'));
  const insecure = buildMiniMaxH3CreateRequest(spec, manifest, { prompt: 'Move.', mediaUrls: { first: 'data:image/png;base64,AAAA' } });
  assert.ok(insecure.issues.includes('provider_asset_url_missing:first'));
  const longPrompt = buildMiniMaxH3CreateRequest(spec, manifest, { prompt: 'x'.repeat(7001), mediaUrls: { first: 'https://media.example/first.png' } });
  assert.ok(longPrompt.issues.includes('video_prompt_too_long'));
});

test('create and query responses map into task states without preserving raw payloads', () => {
  assert.deepEqual(parseMiniMaxH3CreateResponse({ task_id: 'remote-a' }), { ok: true, status: 200, remoteTaskId: 'remote-a', requestId: '' });
  const running = parseMiniMaxH3TaskResponse({ task: { id: 'remote-a', status: 'running', usage: { total_tokens: 12 } } });
  assert.equal(running.state, 'polling');
  assert.equal(running.usage.totalTokens, 12);
  const success = parseMiniMaxH3TaskResponse({
    task: {
      id: 'remote-a', status: 'succeeded', content: { url: 'https://media.example/result.mp4', secret: 'DROP' },
      created_at: 100, updated_at: 120, resolution: '768P', duration: 6, ratio: '16:9', task_type: 'generation', modality: 'video',
    },
    raw_request: 'DROP',
  });
  assert.equal(success.ok, true);
  assert.equal(success.state, 'succeeded');
  assert.equal(success.result.downloadUrl, 'https://media.example/result.mp4');
  assert.equal(success.timing.createdAt, 100000);
  assert.doesNotMatch(JSON.stringify(success), /DROP|raw_request|secret/);
  assert.equal(parseMiniMaxH3TaskResponse({ task: { id: 'remote-a', status: 'succeeded', content: {} } }).code, 'result_url_missing');
});

test('provider HTTP errors have stable retry and user-action categories', () => {
  const limited = parseMiniMaxH3CreateResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'later' }, request_id: 'request-a' }, 429);
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.retryable, true);
  assert.equal(limited.requestId, 'request-a');
  assert.equal(parseMiniMaxH3CreateResponse({ error: { message: 'balance' } }, 402).code, 'insufficient_balance');
  assert.equal(parseMiniMaxH3CreateResponse({ error: { message: 'unsafe' } }, 422).code, 'content_rejected');
});

test('official cancellation only sends DELETE while the task is still queued', () => {
  assert.equal(planMiniMaxH3Cancellation('queued').action, 'cancel');
  assert.equal(planMiniMaxH3Cancellation('running').action, 'wait_terminal');
  assert.equal(planMiniMaxH3Cancellation('succeeded').action, 'preserve_record');
  assert.equal(buildMiniMaxH3CancelRequest('remote-a', 'running').request, null);
  const queued = buildMiniMaxH3CancelRequest('remote-a', 'queued');
  assert.equal(queued.ok, true);
  assert.equal(queued.request.method, 'DELETE');
  assert.match(queued.request.url, /\/v2\/video_generation\/remote-a$/);
  assert.equal(parseMiniMaxH3CancelResponse({ task_id: 'remote-a', action: 'cancelled', status: 'cancelled' }).ok, true);
  assert.equal(parseMiniMaxH3CancelResponse({ task_id: 'remote-a', action: 'deleted', status: 'deleted' }).code, 'cancel_not_confirmed');
});

test('query descriptors encode task IDs and never embed authentication material', () => {
  const result = buildMiniMaxH3QueryRequest('remote/a b', { region: 'cn' });
  assert.equal(result.ok, true);
  assert.equal(result.request.url, 'https://api.minimaxi.com/v2/query/video_generation/remote%2Fa%20b');
  assert.deepEqual(result.request.auth, { type: 'bearer', source: 'runtime_api_key' });
});

test('the provider adapter ships as an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-minimax\.js/m);
assert.match(source, /minimaxH3:\s*\{[\s\S]*import\('\.\/qianmu-video-minimax\.js\?v=1\.59\.41'\)/);
  assert.ok(release.files.includes('qianmu-video-minimax.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('minimaxH3'\)/);
});
