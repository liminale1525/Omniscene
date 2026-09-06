import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_VIDEO_TASK_SCHEMA,
  beginVideoTaskRetry,
  claimVideoTaskLease,
  createVideoTask,
  normalizeVideoTask,
  releaseVideoTaskLease,
  requestVideoTaskCancellation,
  resumeVideoTask,
  transitionVideoTask,
  validateVideoTask,
  videoTasksForChat,
} from '../qianmu-video-task.js';

const create = (extra = {}) => createVideoTask({
  draftId: 'draft-a',
  sourceRecordId: 'image-record-a',
  shotId: 'shot-a',
  manifestId: 'manifest-a',
  owner: { chatKey: 'chat-a', floor: 8, messageId: 'message-a' },
  provider: { channel: 'future-provider', connectionId: 'connection-a' },
  ...extra,
}, { now: 1000, clientNonce: 'nonce-a' });

test('video tasks keep stable ownership and an attempt-scoped idempotency key', () => {
  const task = create();
  assert.equal(task.schema, QIANMU_VIDEO_TASK_SCHEMA);
  assert.equal(task.state, 'queued');
  assert.equal(task.draftId, 'draft-a');
  assert.equal(task.sourceRecordId, 'image-record-a');
  assert.equal(task.owner.chatKey, 'chat-a');
  assert.equal(task.owner.floor, 8);
  assert.equal(task.timing.createdAt, 1000);
  assert.match(task.submission.idempotencyKey, /^qianmu-video-/);
  const restored = normalizeVideoTask(task);
  assert.equal(restored.draftId, 'draft-a');
  assert.equal(restored.sourceRecordId, 'image-record-a');
  assert.equal(restored.submission.idempotencyKey, task.submission.idempotencyKey);
  assert.equal(restored.timing.createdAt, 1000);
});

test('task transitions are explicit and terminal states cannot be mutated', () => {
  let result = transitionVideoTask(create(), 'preparing', { code: 'prepare_started' }, { now: 1100 });
  assert.equal(result.ok, true);
  result = transitionVideoTask(result.task, 'submitted', {
    provider: { remoteTaskId: 'remote-a', lastStatus: 'accepted' },
    submission: { providerAccepted: true, acceptedAt: 1200, requestId: 'request-a' },
    nextPollAt: 1300,
  }, { now: 1200 });
  assert.equal(result.ok, true);
  result = transitionVideoTask(result.task, 'succeeded', {
    result: { recordId: 'video-record-a', durationSeconds: 6, resolution: '768p' },
    budget: { settlement: 'committed', settledAt: 2000 },
  }, { now: 2000 });
  assert.equal(result.task.progress.percent, 100);
  assert.equal(result.task.timing.nextPollAt, 0);
  assert.equal(result.task.lease.holder, '');
  assert.equal(transitionVideoTask(result.task, 'polling', {}, { now: 2100 }).ok, false);
});

test('reload recovery never polls another chat and never blindly resubmits an ambiguous request', () => {
  let task = transitionVideoTask(create(), 'preparing', {}, { now: 1100 }).task;
  task = transitionVideoTask(task, 'submitted', { submission: { providerAccepted: true } }, { now: 1200 }).task;
  assert.equal(resumeVideoTask(task, { chatKey: 'chat-b', workerId: 'worker-a' }, { now: 1300 }).reason, 'owner_mismatch');
  assert.equal(resumeVideoTask(task, { chatKey: 'chat-a', workerId: 'worker-a' }, { now: 1300 }).action, 'reconcile_submission');
  task.provider.remoteTaskId = 'remote-a';
  assert.equal(resumeVideoTask(task, { chatKey: 'chat-a', workerId: 'worker-a' }, { now: 1300 }).action, 'poll');
});

test('cancellation distinguishes local finalization from provider cancellation', () => {
  let result = requestVideoTaskCancellation(create(), { now: 1200 });
  assert.equal(result.task.state, 'cancel_requested');
  assert.equal(resumeVideoTask(result.task, { chatKey: 'chat-a' }, { now: 1300 }).action, 'finalize_cancel');

  let remote = transitionVideoTask(create(), 'preparing', {}, { now: 1100 }).task;
  remote = transitionVideoTask(remote, 'submitted', { provider: { remoteTaskId: 'remote-a' } }, { now: 1200 }).task;
  remote = requestVideoTaskCancellation(remote, { now: 1300 }).task;
  assert.equal(resumeVideoTask(remote, { chatKey: 'chat-a' }, { now: 1400 }).action, 'cancel_provider');
});

test('a paid retry requires confirmation, keeps logical identity and gets a new idempotency key', () => {
  let failed = transitionVideoTask(create(), 'failed', {
    failure: { code: 'provider_busy', message: 'try later', retryable: true, chargeState: 'unknown' },
  }, { now: 1500 }).task;
  const originalKey = failed.submission.idempotencyKey;
  assert.equal(beginVideoTaskRetry(failed, { now: 1600 }).issue, 'retry_requires_charge_confirmation');
  const retried = beginVideoTaskRetry(failed, { now: 1600, allowNewCharge: true });
  assert.equal(retried.ok, true);
  assert.equal(retried.task.taskId, failed.taskId);
  assert.equal(retried.task.attempt, 2);
  assert.notEqual(retried.task.submission.idempotencyKey, originalKey);
  assert.equal(retried.task.budget.settlement, 'unsettled');
});

test('short leases prevent two tabs from driving the same remote task', () => {
  const task = create();
  const first = claimVideoTaskLease(task, 'tab-a', { now: 1000, ttlMs: 15000 });
  assert.equal(first.acquired, true);
  assert.equal(claimVideoTaskLease(first.task, 'tab-b', { now: 2000 }).reason, 'lease_held');
  assert.equal(resumeVideoTask(first.task, { chatKey: 'chat-a', workerId: 'tab-b' }, { now: 2000 }).reason, 'leased_by_another_worker');
  assert.equal(releaseVideoTaskLease(first.task, 'tab-b').reason, 'lease_owner_mismatch');
  assert.equal(releaseVideoTaskLease(first.task, 'tab-a').released, true);
});

test('persisted diagnostics are bounded, redact credentials and omit arbitrary media payloads', () => {
  const raw = create();
  raw.history = Array.from({ length: 100 }, (_, index) => ({
    at: index,
    state: 'polling',
    message: 'Authorization: Bearer secret-token-value api_key=sk-secretsecret',
    image: 'data:image/png;base64,SHOULD_NOT_SURVIVE',
  }));
  const task = normalizeVideoTask(raw);
  assert.equal(task.history.length, 80);
  const serialized = JSON.stringify(task);
  assert.doesNotMatch(serialized, /secret-token-value|sk-secretsecret|SHOULD_NOT_SURVIVE|data:image/);
  assert.match(serialized, /REDACTED/);
});

test('legacy tasks without a draft reference remain compatible', () => {
  const task = normalizeVideoTask({
    taskId: 'legacy-task', shotId: 'shot-a', owner: { chatKey: 'chat-a' }, state: 'failed',
  });
  assert.equal(task.draftId, '');
  assert.equal(task.sourceRecordId, '');
  assert.equal(validateVideoTask(task).ok, true);
});

test('task lookup and validation enforce chat isolation and stable record references', () => {
  const a = create();
  const b = createVideoTask({ shotId: 'shot-b', owner: { chatKey: 'chat-b' } }, { now: 1000, clientNonce: 'nonce-b' });
  assert.deepEqual(videoTasksForChat([a, b], 'chat-a').map((task) => task.taskId), [a.taskId]);
  assert.equal(validateVideoTask(a).ok, true);
  assert.ok(validateVideoTask({ state: 'polling' }).issues.includes('remote_task_id_missing'));
});

test('the unfinished task engine ships as an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-task\.js/m);
assert.match(source, /videoTask:\s*\{[\s\S]*import\('\.\/qianmu-video-task\.js\?v=1\.59\.51'\)/);
  assert.ok(release.files.includes('qianmu-video-task.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoTask'\)/);
});
