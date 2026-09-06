import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_VIDEO_BUDGET_POLICY_SCHEMA,
  QIANMU_VIDEO_COST_QUOTE_SCHEMA,
  evaluateVideoBudget,
  normalizeVideoBudgetPolicy,
  normalizeVideoBudgetReservation,
  normalizeVideoCostQuote,
  reserveVideoBudget,
  settleVideoBudgetReservation,
  summarizeVideoBudget,
  videoBudgetDayKey,
} from '../qianmu-video-budget.js';

const NOW = Date.UTC(2026, 8, 3, 8, 0, 0);
const request = (extra = {}) => ({
  taskId: 'video-task-a',
  attempt: 1,
  chatKey: 'chat-a',
  durationSeconds: 6,
  resolution: '768p',
  costConfirmed: true,
  ...extra,
});
const quote = (extra = {}) => ({
  quoteId: 'quote-a',
  provider: 'future-provider',
  model: 'future-model',
  unit: 'credits',
  estimatedUnits: 6,
  maximumUnits: 8,
  createdAt: NOW - 1000,
  expiresAt: NOW + 60_000,
  input: { durationSeconds: 6, resolution: '768p', count: 1, includesAudio: true },
  ...extra,
});
const policy = (extra = {}) => ({
  unit: 'credits',
  totalDailyLimitUnits: 100,
  automatic: { enabled: true, maxPerTaskUnits: 20, dailyLimitUnits: 40, perChatDailyLimitUnits: 24, maxDurationSeconds: 8 },
  ...extra,
});

test('budget policies default to manual-only instead of silently enabling paid automation', () => {
  const normalized = normalizeVideoBudgetPolicy();
  assert.equal(normalized.schema, QIANMU_VIDEO_BUDGET_POLICY_SCHEMA);
  assert.equal(normalized.automatic.enabled, false);
  assert.equal(normalized.automatic.dailyLimitUnits, 0);
  assert.equal(normalized.manual.requireCostConfirmation, true);
  assert.equal(normalized.highResolution.requireExplicitConfirmation, true);
});

test('provider quotes stay portable and omit arbitrary responses or credentials', () => {
  const normalized = normalizeVideoCostQuote({
    ...quote(),
    apiKey: 'SHOULD_NOT_SURVIVE',
    response: { token: 'SHOULD_NOT_SURVIVE' },
  });
  assert.equal(normalized.schema, QIANMU_VIDEO_COST_QUOTE_SCHEMA);
  assert.equal(normalized.maximumUnits, 8);
  assert.doesNotMatch(JSON.stringify(normalized), /SHOULD_NOT_SURVIVE|apiKey|response/);
});

test('manual paid work and 2K output require their own explicit confirmations', () => {
  const result = evaluateVideoBudget(
    request({ resolution: '2k', costConfirmed: false, highResolutionConfirmed: false }),
    quote({ input: { durationSeconds: 6, resolution: '2k' } }),
    [],
    policy(),
    { now: NOW },
  );
  assert.equal(result.allowed, false);
  assert.ok(result.issues.includes('cost_confirmation_required'));
  assert.ok(result.issues.includes('high_resolution_confirmation_required'));
});

test('expired or mismatched quotes cannot authorize a changed generation request', () => {
  const expired = evaluateVideoBudget(request(), quote({ expiresAt: NOW }), [], policy(), { now: NOW });
  assert.ok(expired.issues.includes('cost_quote_expired'));
  const changed = evaluateVideoBudget(request({ durationSeconds: 8 }), quote(), [], policy(), { now: NOW });
  assert.ok(changed.issues.includes('quote_duration_mismatch'));
});

test('automatic limits include pending and unknown charges but ignore released reservations', () => {
  const dayKey = videoBudgetDayKey(NOW, 0);
  const reservations = [
    normalizeVideoBudgetReservation({ taskId: 'old-a', chatKey: 'chat-a', unit: 'credits', units: 10, automatic: true, dayKey, settlement: 'reserved' }),
    normalizeVideoBudgetReservation({ taskId: 'old-b', chatKey: 'chat-a', unit: 'credits', units: 5, automatic: true, dayKey, settlement: 'unknown' }),
    normalizeVideoBudgetReservation({ taskId: 'old-c', chatKey: 'chat-a', unit: 'credits', units: 99, automatic: true, dayKey, settlement: 'released' }),
    normalizeVideoBudgetReservation({ taskId: 'manual', chatKey: 'chat-a', unit: 'credits', units: 50, automatic: false, dayKey, settlement: 'committed' }),
  ];
  const result = evaluateVideoBudget(request({ automatic: true }), quote(), reservations, policy(), { now: NOW });
  assert.equal(result.allowed, true);
  assert.equal(result.usage.automaticUnits, 15);
  assert.equal(result.usage.automaticByChat['chat-a'], 15);
  assert.equal(result.projected.chatUnits, 23);
  assert.equal(result.usage.totalUnits, 65);
});

test('automatic generation fails closed when no budget was configured', () => {
  const result = evaluateVideoBudget(request({ automatic: true }), quote({ unit: 'provider_units' }), [], {}, { now: NOW });
  assert.equal(result.allowed, false);
  assert.ok(result.issues.includes('automatic_video_disabled'));
  assert.ok(result.issues.includes('automatic_task_budget_exceeded'));
  assert.ok(result.issues.includes('automatic_daily_budget_exceeded'));
});

test('reservation is idempotent per logical task attempt and reserves the maximum quote', () => {
  const first = reserveVideoBudget(request(), quote(), [], policy(), { now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.reservation.units, 8);
  const second = reserveVideoBudget(request(), quote(), first.reservations, policy(), { now: NOW + 1000 });
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.reservations.length, 1);
  assert.equal(second.reservation.reservationId, first.reservation.reservationId);
});

test('settlement is explicit, idempotent and cannot rewrite a committed charge', () => {
  const reserved = reserveVideoBudget(request(), quote(), [], policy(), { now: NOW });
  const committed = settleVideoBudgetReservation(reserved.reservations, reserved.reservation.reservationId, 'committed', { now: NOW + 5000 });
  assert.equal(committed.ok, true);
  assert.equal(committed.reservation.settlement, 'committed');
  assert.equal(settleVideoBudgetReservation(committed.reservations, committed.reservation.reservationId, 'committed', { now: NOW + 6000 }).ok, true);
  assert.equal(settleVideoBudgetReservation(committed.reservations, committed.reservation.reservationId, 'released', { now: NOW + 7000 }).issue, 'reservation_already_committed');
  assert.equal(summarizeVideoBudget(committed.reservations, policy(), { now: NOW }).totalUnits, 8);
});

test('the unfinished budget gate ships as an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-budget\.js/m);
assert.match(source, /videoBudget:\s*\{[\s\S]*import\('\.\/qianmu-video-budget\.js\?v=1\.59\.31'\)/);
  assert.ok(release.files.includes('qianmu-video-budget.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoBudget'\)/);
});
