import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createMiniMaxH3Coordinator } from '../qianmu-video-coordinator.js';
import { transitionVideoTask } from '../qianmu-video-task.js';

function memoryStorage() {
  const tasks = new Map();
  const budgets = new Map();
  const media = new Map();
  let checkpointWrites = 0;
  return {
    tasks, budgets, media,
    get checkpointWrites() { return checkpointWrites; },
    async putVideoRuntimeCheckpoint(task, reservations) {
      checkpointWrites++;
      tasks.set(task.taskId, { task: structuredClone(task), updatedAt: task.timing.updatedAt });
      for (const reservation of reservations) budgets.set(reservation.reservationId, { reservation: structuredClone(reservation) });
      return { reservations: reservations.map((item) => item.reservationId) };
    },
    async getVideoRuntimeTask(taskId) { return tasks.get(taskId) || null; },
    async listVideoRuntimeTasks(chatKey) {
      return [...tasks.values()].filter((item) => !chatKey || item.task.owner.chatKey === chatKey);
    },
    async listVideoBudgetRecords(filters = {}) {
      return [...budgets.values()].filter((item) => (!filters.taskId || item.reservation.taskId === filters.taskId)
        && (!filters.chatKey || item.reservation.chatKey === filters.chatKey));
    },
    async deleteVideoRuntimeTasks(ids) {
      ids.forEach((id) => tasks.delete(id));
      return { deleted: ids, budgetDeleted: 0 };
    },
    async hasVideoMedia(assetId) { return media.has(assetId); },
    async putVideoMedia(assetId, blob, meta) { media.set(assetId, { blob, meta }); return { assetId, recordId: meta.recordId }; },
  };
}

const quote = {
  quoteId: 'quote-a', provider: 'minimax-h3', model: 'MiniMax-H3', unit: 'provider_units',
  estimatedUnits: 5, maximumUnits: 5, createdAt: 900, expiresAt: 60_000,
  input: { durationSeconds: 6, resolution: '768p', count: 1, includesAudio: true },
};
const policy = { unit: 'provider_units', totalDailyLimitUnits: 100, manual: { requireCostConfirmation: true } };
const submission = (taskId, extra = {}) => ({
  taskId,
  quote,
  budgetPolicy: policy,
  costConfirmed: true,
  materialRightsConfirmed: true,
  h3LicenseConfirmed: true,
  spec: { shotId: 'shot-a', summary: 'A quiet room.', durationSeconds: 6, resolution: '768p' },
  manifest: { shotId: 'shot-a', assets: [] },
  prompt: 'A quiet room.',
  mediaInputs: [],
  ...extra,
});
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function draft(coordinator, extra = {}) {
  return coordinator.createTask({
    draftId: 'draft-a',
    sourceRecordId: 'image-record-a',
    shotId: 'shot-a', manifestId: 'manifest-a',
    owner: { chatKey: 'chat-a', floor: 8, messageId: 'message-a' },
    connection: { connectionId: 'connection-a' },
    now: 1000,
    ...extra,
  });
}

test('draft and submit use one façade while credentials and prompts stay out of checkpoints', async () => {
  const storage = memoryStorage();
  const requests = [];
  const coordinator = createMiniMaxH3Coordinator({
    storage,
    workerId: 'tab-a',
    getApiKey: async () => 'private-key',
    connection: { region: 'global', connectionId: 'connection-a' },
    headers: { 'x-csrf-token': 'csrf-a' },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ ok: true, remoteTaskId: 'remote-a', requestId: 'request-a' });
    },
  });
  const created = await draft(coordinator);
  assert.equal(created.action, 'created');
  assert.equal(created.task.draftId, 'draft-a');
  assert.equal(created.task.sourceRecordId, 'image-record-a');
  const result = await coordinator.submit(submission(created.task.taskId, { now: 2000 }));
  assert.equal(result.action, 'submitted');
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].init.body).apiKey, 'private-key');
  assert.doesNotMatch(JSON.stringify([...storage.tasks.values(), ...storage.budgets.values()]), /private-key|A quiet room|prompt/);
});

test('missing credentials and same-tab duplicate operations stop before another paid request', async () => {
  const storage = memoryStorage();
  const withoutKey = createMiniMaxH3Coordinator({ storage, workerId: 'tab-a', connection: { connectionId: 'connection-a' } });
  const created = await draft(withoutKey);
  const writesBefore = storage.checkpointWrites;
  const missing = await withoutKey.submit(submission(created.task.taskId, { now: 2000 }));
  assert.equal(missing.issue, 'missing_api_key');
  assert.equal(storage.checkpointWrites, writesBefore);

  let releaseFetch;
  let calls = 0;
  const coordinator = createMiniMaxH3Coordinator({
    storage,
    workerId: 'tab-a',
    getApiKey: () => 'private-key',
    connection: { region: 'global', connectionId: 'connection-a' },
    fetchImpl: async () => {
      calls++;
      return new Promise((resolve) => { releaseFetch = () => resolve(jsonResponse({ ok: true, remoteTaskId: 'remote-a' })); });
    },
  });
  const first = coordinator.submit(submission(created.task.taskId, { now: 2000 }));
  const duplicate = await coordinator.submit(submission(created.task.taskId, { now: 2000 }));
  assert.equal(duplicate.issue, 'local_operation_in_progress');
  while (!releaseFetch) await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFetch();
  await first;
  assert.equal(calls, 1);
});

test('the coordinator resolves gallery media before budget checkpoints and never persists the transient payload', async () => {
  const storage = memoryStorage();
  const seen = [];
  const coordinator = createMiniMaxH3Coordinator({
    storage,
    workerId: 'tab-a',
    getApiKey: () => 'private-key',
    connection: { region: 'global', connectionId: 'connection-a' },
    resolveMediaInputs: async (value) => {
      seen.push(value);
      return { ok: true, mediaInputs: [{ assetId: 'first', mime: 'image/png', data: 'private-base64' }] };
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.mediaInputs[0].data, 'private-base64');
      return jsonResponse({ ok: true, remoteTaskId: 'remote-a' });
    },
  });
  const created = await draft(coordinator);
  const result = await coordinator.submit({ ...submission(created.task.taskId), mediaInputs: undefined, now: 2000 });
  assert.equal(result.action, 'submitted');
  assert.equal(seen[0].chatKey, 'chat-a');
  assert.equal(seen[0].taskId, created.task.taskId);
  assert.doesNotMatch(JSON.stringify([...storage.tasks.values(), ...storage.budgets.values()]), /private-base64/);
});

test('media resolution failure blocks before any reservation or network request', async () => {
  const storage = memoryStorage();
  let requests = 0;
  const coordinator = createMiniMaxH3Coordinator({
    storage,
    workerId: 'tab-a',
    getApiKey: () => 'private-key',
    resolveMediaInputs: async () => ({ ok: false, issues: ['asset_gallery_record_missing:first'] }),
    fetchImpl: async () => { requests += 1; throw new Error('not expected'); },
  });
  const created = await draft(coordinator);
  const writesBefore = storage.checkpointWrites;
  const result = await coordinator.submit({ ...submission(created.task.taskId), mediaInputs: undefined, now: 2000 });
  assert.equal(result.issue, 'asset_gallery_record_missing:first');
  assert.equal(storage.checkpointWrites, writesBefore);
  assert.equal(requests, 0);
});

test('resume planning is inert, chat ownership is enforced, and explicit drive archives a result', async () => {
  const storage = memoryStorage();
  let requests = 0;
  const coordinator = createMiniMaxH3Coordinator({
    storage,
    workerId: 'tab-a',
    getApiKey: () => 'private-key',
    connection: { region: 'global', connectionId: 'connection-a' },
    fetchImpl: async (url) => {
      requests++;
      if (url.endsWith('/query')) return jsonResponse({
        ok: true, remoteTaskId: 'remote-a', providerStatus: 'succeeded', recognizedStatus: true, state: 'succeeded',
        result: { downloadUrl: 'https://cdn.example/result.mp4', resolution: '768P', durationSeconds: 6, ratio: '16:9' },
        usage: { totalSeconds: 6 },
      });
      if (url.endsWith('/result')) return new Response('video-bytes', { status: 200, headers: { 'content-type': 'video/mp4' } });
      return jsonResponse({ ok: true, remoteTaskId: 'remote-a' });
    },
  });
  const created = await draft(coordinator);
  await coordinator.submit(submission(created.task.taskId, { now: 2000 }));
  requests = 0;
  const plans = await coordinator.resumePlans('chat-a', { now: 3000 });
  assert.equal(plans[0].action, 'poll');
  assert.equal(requests, 0, 'restoring the page must not silently poll paid tasks');
  const wrongChat = await coordinator.drive({ taskId: created.task.taskId, chatKey: 'chat-b', now: 3000 });
  assert.equal(wrongChat.issue, 'owner_mismatch');
  assert.equal(requests, 0);
  const completed = await coordinator.drive({ taskId: created.task.taskId, chatKey: 'chat-a', now: 20_000 });
  assert.equal(completed.action, 'succeeded');
  assert.equal(requests, 2);
  assert.equal(storage.media.size, 1);
  assert.doesNotMatch(JSON.stringify([...storage.media.values()].map((item) => item.meta)), /private-key|cdn\.example|downloadUrl/);
});

test('cancellation is a persisted intent and requires a separate explicit drive', async () => {
  const storage = memoryStorage();
  let requests = 0;
  const coordinator = createMiniMaxH3Coordinator({ storage, workerId: 'tab-a', fetchImpl: async () => { requests++; throw new Error('not expected'); } });
  const created = await draft(coordinator, { shotId: 'shot-cancel' });
  const requested = await coordinator.requestCancellation({ taskId: created.task.taskId, chatKey: 'chat-a', now: 2000 });
  assert.equal(requested.action, 'cancel_requested');
  assert.equal(requests, 0);
  const completed = await coordinator.drive({ taskId: created.task.taskId, chatKey: 'chat-a', now: 3000 });
  assert.equal(completed.action, 'cancelled');
  assert.equal(requests, 0);
});

test('retry stays a separate confirmed state change and never submits by itself', async () => {
  const storage = memoryStorage();
  let requests = 0;
  const coordinator = createMiniMaxH3Coordinator({ storage, workerId: 'tab-a', fetchImpl: async () => { requests++; throw new Error('not expected'); } });
  const created = await draft(coordinator, { shotId: 'shot-retry' });
  const failed = transitionVideoTask(created.task, 'failed', {
    code: 'provider_task_failed',
    failure: { code: 'provider_task_failed', message: 'failed', retryable: true, chargeState: 'unknown' },
  }, { now: 2000 }).task;
  await storage.putVideoRuntimeCheckpoint(failed, []);
  const denied = await coordinator.retry({ taskId: failed.taskId, chatKey: 'chat-a', allowNewCharge: false, now: 3000 });
  assert.equal(denied.issue, 'retry_requires_charge_confirmation');
  const accepted = await coordinator.retry({ taskId: failed.taskId, chatKey: 'chat-a', allowNewCharge: true, now: 3000 });
  assert.equal(accepted.action, 'retry_ready');
  assert.equal(accepted.task.state, 'queued');
  assert.equal(accepted.task.attempt, 2);
  assert.equal(requests, 0);
});

test('the coordinator remains an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /videoCoordinator:\s*\{[\s\S]*import\('\.\/qianmu-video-coordinator\.js\?v=1\.59\.42'\)/);
  assert.ok(release.files.includes('qianmu-video-coordinator.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoCoordinator'\)/);
});
