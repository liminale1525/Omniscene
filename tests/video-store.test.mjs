import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createVideoTask } from '../qianmu-video-task.js';
import { createVideoRuntimeStoreAdapter, normalizeVideoStoreCheckpoint } from '../qianmu-video-store.js';

const task = (extra = {}) => createVideoTask({
  shotId: 'shot-a',
  owner: { chatKey: 'chat-a', floor: 4, messageId: 'message-a' },
  provider: { channel: 'minimax-h3', connectionId: 'connection-a' },
  ...extra,
}, { now: 1000, clientNonce: 'video-store-test' });

const reservation = (extra = {}) => ({
  reservationId: 'reservation-a',
  taskId: task().taskId,
  attempt: 1,
  chatKey: 'chat-a',
  quoteId: 'quote-a',
  unit: 'provider_units',
  units: 5,
  dayKey: '2026-09-03',
  settlement: 'reserved',
  createdAt: 1000,
  ...extra,
});

function mockStorage(overrides = {}) {
  return {
    putVideoRuntimeCheckpoint: async (_task, reservations) => ({ reservations: reservations.map((item) => item.reservationId) }),
    getVideoRuntimeTask: async () => null,
    listVideoRuntimeTasks: async () => [],
    listVideoBudgetRecords: async () => [],
    deleteVideoRuntimeTasks: async (ids) => ({ deleted: ids, budgetDeleted: 0 }),
    ...overrides,
  };
}

test('checkpoint normalization strips transient secrets and unrelated reservations', () => {
  const sourceTask = task();
  sourceTask.apiKey = 'private-key';
  sourceTask.prompt = 'secret prompt';
  sourceTask.downloadUrl = 'https://media.example/result.mp4';
  sourceTask.result.binary = 'data:image/png;base64,SECRET';
  const normalized = normalizeVideoStoreCheckpoint({
    reason: 'submission_accepted',
    task: sourceTask,
    reservations: [reservation({ taskId: sourceTask.taskId }), reservation({ reservationId: 'other', taskId: 'other-task' })],
  });
  assert.equal(normalized.task.taskId, sourceTask.taskId);
  assert.deepEqual(normalized.reservations.map((item) => item.reservationId), ['reservation-a']);
  assert.doesNotMatch(JSON.stringify(normalized), /private-key|secret prompt|media\.example|data:image|SECRET/);
});

test('the adapter writes a normalized task and its budget records through one checkpoint call', async () => {
  let captured;
  const adapter = createVideoRuntimeStoreAdapter(mockStorage({
    putVideoRuntimeCheckpoint: async (storedTask, reservations) => {
      captured = { storedTask, reservations };
      return { taskId: storedTask.taskId, reservations: reservations.map((item) => item.reservationId) };
    },
  }));
  const sourceTask = task();
  const writer = adapter.checkpointWriter();
  const result = await writer({ task: sourceTask, reservations: [reservation({ taskId: sourceTask.taskId })] });
  assert.equal(result.taskId, sourceTask.taskId);
  assert.deepEqual(result.reservationIds, ['reservation-a']);
  assert.equal(captured.storedTask.schema, 'qianmu.video-task.v1');
  assert.equal(captured.reservations[0].schema, 'qianmu.video-budget-reservation.v1');
});

test('restore and list paths normalize untrusted stored values before returning them', async () => {
  const sourceTask = task();
  const malicious = { ...sourceTask, apiKey: 'private-key', prompt: 'secret prompt', arbitrary: { data: 'secret' } };
  const budgets = Array.from({ length: 150 }, (_, index) => ({
    reservation: reservation({ reservationId: `reservation-${index}`, taskId: sourceTask.taskId }),
  }));
  const adapter = createVideoRuntimeStoreAdapter(mockStorage({
    getVideoRuntimeTask: async () => ({ task: malicious, updatedAt: 1200 }),
    listVideoRuntimeTasks: async () => [
      { task: malicious, updatedAt: 1200 },
      { task: { ...task({ shotId: 'shot-terminal' }), state: 'succeeded', result: { recordId: 'video-record-a' } }, updatedAt: 1100 },
    ],
    listVideoBudgetRecords: async () => [...budgets, budgets[0]],
  }));
  const restored = await adapter.restoreTask(sourceTask.taskId);
  assert.equal(restored.task.taskId, sourceTask.taskId);
  assert.equal(restored.reservations.length, 100, 'one task can retain at most its bounded attempt history');
  assert.doesNotMatch(JSON.stringify(restored), /private-key|secret prompt|arbitrary/);
  const resumable = await adapter.listTasks('chat-a', { resumableOnly: true });
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0].taskId, sourceTask.taskId);
  const allBudget = await adapter.listBudget({}, { limit: 200 });
  assert.equal(allBudget.length, 150, 'budget accounting must not silently truncate to the per-task checkpoint limit');
});

test('delete requests are bounded and deduplicated before reaching storage', async () => {
  let captured;
  const adapter = createVideoRuntimeStoreAdapter(mockStorage({
    deleteVideoRuntimeTasks: async (ids) => { captured = ids; return { deleted: ids, budgetDeleted: 2 }; },
  }));
  const result = await adapter.deleteTasks(['task-a', 'task-a', '', 'task-b']);
  assert.deepEqual(captured, ['task-a', 'task-b']);
  assert.equal(result.budgetDeleted, 2);
});

test('IndexedDB adds task, budget, local media, draft and timeline stores without changing old store names', async () => {
  const source = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
  assert.match(source, /const DB_VERSION = 15/);
  assert.match(source, /STORE_VIDEO_TASKS = 'video_tasks'/);
  assert.match(source, /STORE_VIDEO_BUDGET = 'video_budget'/);
  assert.match(source, /STORE_VIDEO_MEDIA = 'video_media'/);
  assert.match(source, /STORE_VIDEO_DRAFTS = 'video_drafts'/);
  assert.match(source, /STORE_VIDEO_TIMELINES = 'video_timelines'/);
  assert.match(source, /onupgradeneeded[\s\S]*createObjectStore\(STORE_VIDEO_TASKS\)[\s\S]*createObjectStore\(STORE_VIDEO_BUDGET\)[\s\S]*createObjectStore\(STORE_VIDEO_MEDIA\)[\s\S]*createObjectStore\(STORE_VIDEO_DRAFTS\)[\s\S]*createObjectStore\(STORE_VIDEO_TIMELINES\)/);
  const checkpoint = source.slice(source.indexOf('export async function putVideoRuntimeCheckpoint'), source.indexOf('export async function getVideoRuntimeTask'));
  assert.match(checkpoint, /db\.transaction\(\[STORE_VIDEO_TASKS, STORE_VIDEO_BUDGET\], 'readwrite'\)/);
  assert.match(checkpoint, /transaction\.oncomplete/);
  assert.match(checkpoint, /transaction\.onabort/);
  assert.match(checkpoint, /transaction\.abort\(\)/);
  assert.match(source, /listVideoBudgetRecords[\s\S]*records\.length >= limit[\s\S]*video budget ledger exceeds the safe scan limit/);
  const removal = source.slice(source.indexOf('export async function deleteVideoRuntimeTasks'), source.indexOf('// ── 存储治理'));
  assert.match(removal, /db\.transaction\(\[STORE_VIDEO_TASKS, STORE_VIDEO_BUDGET\], 'readwrite'\)/);
  assert.match(removal, /budgetStore\.openCursor/);
  assert.match(source, /STORE_VIDEO_TASKS\]: \{ label: '动态镜头任务', category: 'video', recoverable: false \}/);
  assert.match(source, /STORE_VIDEO_BUDGET\]: \{ label: '视频费用流水', category: 'video', recoverable: false \}/);
  assert.match(source, /STORE_VIDEO_MEDIA\]: \{ label: '动态镜头成片', category: 'video', recoverable: false \}/);
  assert.match(source, /STORE_VIDEO_DRAFTS\]: \{ label: '动态镜头草稿', category: 'video', recoverable: false \}/);
  assert.match(source, /STORE_VIDEO_TIMELINES\]: \{ label: '影片时间线', category: 'video', recoverable: false \}/);
  assert.match(source, /export async function putVideoMedia[\s\S]*VIDEO_MEDIA_MAX_BYTES[\s\S]*export async function listVideoMedia/);
  assert.match(source, /CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_VIDEO_TASKS[\s\S]*STORE_VIDEO_BUDGET[\s\S]*STORE_VIDEO_MEDIA[\s\S]*STORE_VIDEO_DRAFTS[\s\S]*STORE_VIDEO_TIMELINES/);
});

test('storage UI identifies video records as destructive and the adapter stays idle at startup', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.match(source, /video: '动态影片'/);
  assert.match(source, /video_tasks: \['可能含进行中任务 · 清理后无法恢复追踪', true\]/);
  assert.match(source, /video_budget: \['费用与预算流水 · 清理后无法对账', true\]/);
  assert.match(source, /video_media: \['不可恢复 · H3 动态成片', true\]/);
  assert.match(source, /video_drafts: \['不可恢复 · 动态镜头编辑草稿', true\]/);
  assert.match(source, /video_timelines: \['不可恢复 · 完整影片时间线', true\]/);
  assert.match(source, /STORAGE_CHAT_CLEARABLE[^\n]*video_tasks[^\n]*video_budget[^\n]*video_media[^\n]*video_drafts[^\n]*video_timelines/);
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-store\.js/m);
assert.match(source, /videoStore:\s*\{[\s\S]*import\('\.\/qianmu-video-store\.js\?v=1\.59\.68'\)/);
assert.match(source, /videoResult:\s*\{[\s\S]*import\('\.\/qianmu-video-result\.js\?v=1\.59\.68'\)/);
  assert.ok(release.files.includes('qianmu-video-store.js'));
  assert.ok(release.files.includes('qianmu-video-result.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoStore'\)/);
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoResult'\)/);
});
