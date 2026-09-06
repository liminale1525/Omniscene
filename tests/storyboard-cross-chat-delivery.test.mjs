import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SCHEMA_VERSION,
  createStoryboardTaskState,
  normalizeStoryboardState,
  transitionStoryboardTaskState,
} from '../qianmu-storyboard.js';

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const blobSource = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 24);
const pending = transitionStoryboardTaskState(createStoryboardTaskState({ id: 'job-a', chatKey: 'chat-a', floor: 5, now: 100 }), 'completed', {
  stage: 'delivery_pending', progress: 0.96, floor: null, deliveryState: 'pending_chat', linkState: 'foreign', resultIds: ['image-a'], now: 200,
});
assert.equal(pending.floor, null);
assert.equal(pending.stage, 'delivery_pending');
assert.equal(pending.deliveryState, 'pending_chat');
assert.equal(pending.linkState, 'foreign');
assert.equal(pending.progress, 0.96);

const delivered = transitionStoryboardTaskState(pending, 'completed', {
  stage: 'complete', progress: 1, floor: 7, deliveryState: 'delivered', linkState: 'active', now: 300,
});
assert.equal(delivered.floor, 7);
assert.equal(delivered.deliveryState, 'delivered');
assert.equal(delivered.linkState, 'active');

const migrated = normalizeStoryboardState({ schemaVersion: 21, taskStates: [pending] });
assert.equal(migrated.schemaVersion, 24);
assert.equal(migrated.taskStates[0].deliveryState, 'pending_chat');

// Cross-chat results use a durable local inbox because ST only safely saves the current chat metadata.
assert.match(blobSource, /const DB_VERSION = 15/);
assert.match(blobSource, /STORE_STORYBOARD_INBOX = 'storyboard_inbox'/);
assert.match(blobSource, /export async function putStoryboardDelivery/);
assert.match(blobSource, /export async function listStoryboardDeliveries/);
assert.match(blobSource, /export async function deleteStoryboardDelivery/);
assert.match(indexSource, /function storyboardStoreDeferredDelivery[\s\S]*blobStore\.putStoryboardDelivery/);
assert.match(indexSource, /function storyboardDrainPendingDeliveries[\s\S]*resolveStoryboardMessageReference[\s\S]*blobStore\.deleteStoryboardDelivery/);

// Switching chats no longer cancels paid work; a foreign result is deferred instead of entering the visible chat.
const chatChanged = indexSource.slice(indexSource.indexOf('async function storyboardHandleChatChanged'), indexSource.indexOf('async function storyboardPrepareGatewayAssets'));
assert.doesNotMatch(chatChanged, /discardRequested|storyboardQueue\s*=|storyboardFinishLog/);
const runJob = indexSource.slice(indexSource.indexOf('async function storyboardRunJob'), indexSource.indexOf('async function storyboardRunQueuedJob'));
assert.match(runJob, /beforeRequestAnchor\.linkState !== 'foreign'/);
assert.match(runJob, /storyboardDeliverGatewayResult\(job, log, data/);
const deliverJob = indexSource.slice(indexSource.indexOf('async function storyboardDeliverGatewayResult'), indexSource.indexOf('async function storyboardRunJob'));
assert.match(deliverJob, /currentOwnsResult[\s\S]*storyboardStoreDeferredDelivery/);
assert.doesNotMatch(runJob, /聊天已切换，任务未执行|生成期间切换了聊天/);

// Foreign plans cannot leak a placeholder into an unrelated chat with the same floor number.
assert.match(indexSource, /if \(plan\.chatKey && plan\.chatKey !== currentChatKey\) continue/);
assert.match(indexSource, /void storyboardHandleChatChanged\(\)/, 'chat rendering must not wait for IndexedDB delivery');
const appReady = indexSource.slice(indexSource.indexOf('const appReadyHandler'), indexSource.indexOf('const personaChangedHandler'));
assert.match(appReady, /void storyboardHandleChatChanged\(\)/, 'startup delivery and snapshot migration must remain non-blocking');

console.log('Storyboard cross-chat delivery and ownership contract OK');
