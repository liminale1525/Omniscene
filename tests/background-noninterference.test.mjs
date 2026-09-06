import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('message receipt releases the ST event immediately and starts automatic capture independently', () => {
  const events = source.slice(source.indexOf('function bindEvents()'), source.indexOf('function init()'));
  const refresh = events.slice(events.indexOf('const refreshHandler ='), events.indexOf('const rerenderHandler ='));
  assert.match(refresh, /const refreshHandler = \(messageIndex\) =>/);
  assert.doesNotMatch(refresh, /const refreshHandler = async|await /);
  assert.ok(refresh.indexOf('storyboardHandleAutomaticCapture(messageIndex)') < refresh.indexOf('queueMicrotask'));
  assert.match(refresh, /queueMicrotask\(\(\) => void runBackgroundDirectorRefresh\(\)\)/);
  assert.match(events, /MESSAGE_RECEIVED[^\n]+refreshHandler/);
});

test('background director completion does not rebuild the open panel or stop live media', () => {
  const generate = source.slice(
    source.indexOf('async function generateDirectorPlan'),
    source.indexOf('// MIGRATED to qianmu-storyboard-utils.js'),
  );
  assert.match(generate, /const background = Boolean\(options\?\.background\)/);
  assert.match(generate, /if \(!background\) \{[\s\S]*renderModal\(\);[\s\S]*renderFloatButton\(\);[\s\S]*\}/);
  assert.doesNotMatch(generate, /storyboardCloseFilmViewer|storyboardCloseVideoViewer|ttsStopPlayback|ttsStopChat/);
  const background = source.slice(source.indexOf('const runBackgroundDirectorRefresh ='), source.indexOf('const refreshHandler ='));
  assert.match(background, /generateDirectorPlan\(false, true, \{ background: true \}\)/);
  assert.doesNotMatch(background, /renderModal|scrollTop|\.pause\(|\.abort\(|storyboardClearWaitingQueue/);
});

test('director bridge invalidation changes only ephemeral director state', () => {
  const reset = source.slice(
    source.indexOf('function resetDirectorNarrativeBridge'),
    source.indexOf('async function refreshDirectorCandidatePool'),
  );
  assert.match(reset, /directorNarrativeBridgeEpoch\+\+/);
  assert.match(reset, /directorProductionPacketState =/);
  assert.match(reset, /directorCandidatePoolState =/);
  assert.doesNotMatch(reset, /abort|close|pause|remove|scroll|render|storyboardQueue|tts|audio|video/i);
});

test('automatic capture failures are contained outside the ST message event', () => {
  const events = source.slice(source.indexOf('function bindEvents()'), source.indexOf('function init()'));
  const refresh = events.slice(events.indexOf('const refreshHandler ='), events.indexOf('const rerenderHandler ='));
  assert.match(refresh, /storyboardHandleAutomaticCapture\(messageIndex\)\.catch/);
  assert.match(refresh, /automatic storyboard capture failed/);
});
