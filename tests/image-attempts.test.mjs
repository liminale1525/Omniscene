import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_ATTEMPT_SCHEMA, IMAGE_ATTEMPT_LIMIT, IMAGE_RESERVATION_TTL_MS, imageAttemptScopeKey, normalizeImageAttempts, claimImageAttempt, beginImageAttempt, settleImageAttempt, summarizeImageAttempts } from '../qianmu-image-attempts.js';

const NOW = 1_780_000_000_000;
const scope = { namespace: 'test-account', chatKey: 'chat', messageKey: 'floor-stable-id', revisionId: 'revision-a' };
const request = (extra = {}) => ({ attemptId: 'attempt-a', logicalShotId: 'shot-a', operationKey: 'operation-a', ownerId: 'page-a', kind: 'automatic', maxAutomatic: 3, imageCount: 1, ...extra });
const reserve = (ledger, input = request(), now = NOW) => claimImageAttempt(ledger, scope, input, now);
const begin = (ledger, attemptId = 'attempt-a', ownerId = 'page-a', now = NOW + 1) => beginImageAttempt(ledger, scope, { attemptId, ownerId }, now);
const finish = (ledger, outcome, attemptId = 'attempt-a', now = NOW + 2) => settleImageAttempt(ledger, scope, { attemptId, ownerId: 'page-a', outcome }, now);
function submitted(extra = {}) { return begin(reserve(null, request(extra)).ledger).ledger; }

test('scope is exact across account, chat, message and revision without ambiguous joining or truncation', () => {
  const original = imageAttemptScopeKey(scope);
  for (const key of Object.keys(scope)) assert.notEqual(imageAttemptScopeKey({ ...scope, [key]: `${scope[key]}-other` }), original);
  assert.notEqual(imageAttemptScopeKey({ ...scope, namespace: 'a,b', chatKey: 'c' }), imageAttemptScopeKey({ ...scope, namespace: 'a', chatKey: 'b,c' }));
  for (const value of ['', ' ', 'x'.repeat(241), 'x\n']) assert.throws(() => imageAttemptScopeKey({ ...scope, namespace: value }), { code: 'image_attempt_identity' });
});

test('invalid or mismatched stored state cannot silently reset paid budget', () => {
  const valid = normalizeImageAttempts(null, scope);
  assert.equal(valid.schema, IMAGE_ATTEMPT_SCHEMA);
  for (const malformed of [{}, [], { ...valid, schema: 'v2' }, { ...valid, scopeKey: 'other' }, { ...valid, entries: [{}] }]) {
    assert.throws(() => normalizeImageAttempts(malformed, scope), { code: 'image_attempt_corrupt' });
  }
  const stored = reserve(null).ledger;
  assert.throws(() => normalizeImageAttempts({ ...stored, entries: [...stored.entries, stored.entries[0]] }, scope), { code: 'image_attempt_corrupt' });
});

test('records carry only identifiers and statuses, never prompts, credentials, media or caller metadata', () => {
  const result = reserve(null, request({ prompt: 'private prompt', apiKey: 'secret', data: 'base64', connection: { headers: { Authorization: 'Bearer secret' } } }));
  assert.doesNotMatch(JSON.stringify(result), /private prompt|secret|base64|Authorization|connection/);
  const raw = structuredClone(result.ledger); raw.entries[0].apiKey = 'secret'; raw.extra = 'private prompt';
  assert.doesNotMatch(JSON.stringify(normalizeImageAttempts(raw, scope)), /private prompt|secret/);
});

test('admission reserves an automatic slot and repeated delivery of that receipt creates no new entry', () => {
  const first = reserve(null); assert.equal(first.ok, true); assert.equal(first.automaticUsed, 1);
  const copy = structuredClone(first.ledger), second = reserve(first.ledger);
  assert.equal(second.ok, true); assert.equal(second.ledger.entries.length, 1); assert.deepEqual(first.ledger, copy);
  for (const extra of [{ ownerId: 'page-b' }, { operationKey: 'other' }, { logicalShotId: 'other' }, { kind: 'supplement' }]) {
    assert.equal(reserve(first.ledger, request(extra)).code, 'identity_conflict');
  }
});

test('the same shot or operation cannot acquire a second concurrent attempt from another tab', () => {
  const first = reserve(null).ledger;
  for (const extra of [{}, { logicalShotId: 'other-shot' }, { operationKey: 'other-operation' }]) {
    const result = reserve(first, request({ ...extra, attemptId: 'attempt-b', ownerId: 'page-b' }));
    assert.equal(result.code, 'busy'); assert.equal(result.ledger.entries.length, 1);
  }
});

test('submitting and unknown requests remain occupied regardless of elapsed time', () => {
  for (const status of ['submitting', 'unknown', 'accepted', 'succeeded']) {
    const ledger = status === 'submitting' ? submitted() : finish(submitted(), status).ledger;
    const summary = summarizeImageAttempts(ledger, scope, NOW + 30 * 24 * 60 * 60_000);
    assert.equal(summary.automaticUsed, 1, status); assert.equal(summary.ledger.entries[0].status, status === 'submitting' ? 'unknown' : status);
    assert.equal(reserve(ledger, request({ attemptId: 'b', logicalShotId: 'b', operationKey: 'b', maxAutomatic: 1 })).code, 'budget_exhausted');
  }
});

test('only unsubmitted reservations expire, and an expired receipt can no longer start a POST', () => {
  const ledger = reserve(null).ledger;
  assert.equal(summarizeImageAttempts(ledger, scope, NOW + IMAGE_RESERVATION_TTL_MS - 1).automaticUsed, 1);
  const attempted = begin(ledger, 'attempt-a', 'page-a', NOW + IMAGE_RESERVATION_TTL_MS);
  assert.equal(attempted.ok, false); assert.equal(attempted.automaticUsed, 0); assert.equal(attempted.ledger.entries[0].status, 'released');
  const next = reserve(attempted.ledger, request({ attemptId: 'attempt-b' }), NOW + IMAGE_RESERVATION_TTL_MS + 1);
  assert.equal(next.ok, true); assert.equal(next.automaticUsed, 1);
});

test('dispatch requires the original page session and cannot replay a previously dispatched receipt', () => {
  const ledger = reserve(null).ledger;
  assert.equal(begin(ledger, 'attempt-a', 'page-b').code, 'missing_reservation');
  const started = begin(ledger); assert.equal(started.ok, true); assert.equal(started.attempt.status, 'submitting');
  assert.equal(begin(started.ledger).code, 'not_reserved'); assert.equal(reserve(started.ledger).code, 'attempt_exists');
});

test('known rejection or proof of no submission releases a slot; arbitrary cancellation does not', () => {
  for (const outcome of ['rejected', 'not_submitted']) {
    const result = finish(submitted(), outcome); assert.equal(result.ok, true); assert.equal(result.automaticUsed, 0);
    assert.equal(reserve(result.ledger, request({ attemptId: 'next' })).ok, true);
  }
  for (const outcome of ['cancelled', '', 'constructor', '__proto__']) assert.throws(() => finish(submitted(), outcome), { code: 'image_attempt_outcome' });
});

test('accepted, uncertain and successful work cannot be released by a late generic failure', () => {
  for (const status of ['accepted', 'unknown', 'succeeded']) for (const outcome of ['not_submitted', 'rejected']) {
    const ledger = finish(submitted(), status).ledger;
    assert.equal(finish(ledger, outcome).code, 'unsafe_release');
    assert.equal(summarizeImageAttempts(ledger, scope, NOW + 100).automaticUsed, 1);
  }
  const succeeded = finish(submitted(), 'succeeded').ledger;
  assert.equal(finish(succeeded, 'unknown').code, 'unsafe_release');
  const accepted = finish(submitted(), 'accepted').ledger;
  assert.equal(finish(accepted, 'unknown').ledger.entries[0].status, 'accepted', 'cleanup cannot downgrade known acceptance');
});

test('late successful recovery upgrades an uncertain result but stale owners cannot settle it', () => {
  const ledger = finish(submitted(), 'unknown').ledger;
  assert.equal(settleImageAttempt(ledger, scope, { attemptId: 'attempt-a', ownerId: 'new-page', outcome: 'succeeded' }, NOW + 3).ok, false);
  const recovered = finish(ledger, 'succeeded'); assert.equal(recovered.ok, true); assert.equal(recovered.automaticUsed, 1);
  assert.equal(finish(recovered.ledger, 'succeeded').code, 'unchanged');
});

test('manual retry of uncertainty needs an exact current confirmation, while automation cannot acknowledge it', () => {
  const ledger = finish(submitted(), 'unknown').ledger;
  const manual = request({ attemptId: 'attempt-b', kind: 'redraw' });
  const refused = reserve(ledger, manual); assert.equal(refused.code, 'confirmation_required');
  assert.equal(reserve(ledger, { ...manual, confirmation: refused.confirmation }).ok, true);
  assert.equal(reserve(ledger, request({ attemptId: 'attempt-b', confirmation: refused.confirmation })).ok, false);
  const newer = finish(ledger, 'accepted', 'attempt-a', NOW + 3).ledger;
  assert.equal(reserve(newer, { ...manual, confirmation: refused.confirmation }).code, 'confirmation_required');
});

test('a second unknown attempt invalidates an old confirmation instead of acknowledging unseen work', () => {
  let ledger = finish(submitted(), 'unknown').ledger;
  const prior = reserve(ledger, request({ attemptId: 'b', kind: 'redraw' }));
  ledger = reserve(ledger, request({ attemptId: 'b', kind: 'redraw', confirmation: prior.confirmation })).ledger;
  ledger = begin(ledger, 'b').ledger; ledger = finish(ledger, 'unknown', 'b').ledger;
  assert.equal(reserve(ledger, request({ attemptId: 'c', kind: 'redraw', confirmation: prior.confirmation })).code, 'confirmation_required');
});

test('completed auto shots are not repeated and changed LLM IDs cannot exceed the layer maximum', () => {
  let ledger = finish(submitted(), 'succeeded').ledger;
  assert.equal(reserve(ledger, request({ attemptId: 'repeat' })).code, 'already_generated');
  for (const id of ['b', 'c']) ledger = reserve(ledger, request({ attemptId: id, logicalShotId: id, operationKey: id })).ledger;
  assert.equal(reserve(ledger, request({ attemptId: 'd', logicalShotId: 'new-llm-id', operationKey: 'new-llm-key' })).code, 'budget_exhausted');
});

test('manual supplements and legacy redraws do not multiply the automatic quota', () => {
  const automatic = finish(submitted({ maxAutomatic: 1 }), 'succeeded').ledger;
  for (const kind of ['manual', 'supplement', 'redraw']) {
    const extra = reserve(automatic, request({ attemptId: 'manual-extra', logicalShotId: 'manual-scene', operationKey: 'manual-op', kind, maxAutomatic: 1, imageCount: 4 }));
    assert.equal(extra.ok, true); assert.equal(extra.automaticUsed, 1);
  }
  const redraw = reserve(automatic, request({ attemptId: 'version-b', kind: 'redraw' }));
  assert.equal(redraw.ok, true); assert.equal(redraw.automaticUsed, 1, 'same shot, not a second automatic frame');
});

test('automatic count multiplication and invalid quota inputs fail before any reservation', () => {
  for (const value of [0, 2, 4, '1', NaN, undefined]) assert.throws(() => reserve(null, request({ imageCount: value })), { code: 'image_attempt_count' });
  for (const value of [0, 5, 1.5, '3', NaN]) assert.throws(() => reserve(null, request({ maxAutomatic: value })), { code: 'image_attempt_budget' });
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => reserve(null, request(), value), { code: 'image_attempt_time' });
});

test('capacity is explicit and cannot evict old uncertain records to free budget', () => {
  let ledger = normalizeImageAttempts(null, scope);
  for (let n = 0; n < IMAGE_ATTEMPT_LIMIT; n++) {
    ledger = reserve(ledger, request({ attemptId: `a-${n}`, logicalShotId: `s-${n}`, operationKey: `o-${n}`, kind: 'supplement' })).ledger;
    ledger = begin(ledger, `a-${n}`).ledger; ledger = finish(ledger, 'unknown', `a-${n}`).ledger;
  }
  const full = reserve(ledger, request({ attemptId: 'extra', logicalShotId: 'extra', operationKey: 'extra', kind: 'manual' }));
  assert.equal(full.code, 'ledger_full'); assert.equal(full.ledger.entries.length, IMAGE_ATTEMPT_LIMIT);
  assert.equal(summarizeImageAttempts(full.ledger, scope, NOW + 99_000_000).uncertain, IMAGE_ATTEMPT_LIMIT);
});

test('JSON reload preserves the exact budget and independent operations never mutate the caller state', () => {
  const ledger = finish(submitted(), 'unknown').ledger, before = structuredClone(ledger);
  const loaded = normalizeImageAttempts(JSON.parse(JSON.stringify(ledger)), scope);
  assert.deepEqual(loaded, ledger);
  reserve(ledger, request({ attemptId: 'b', logicalShotId: 'b', operationKey: 'b' })); summarizeImageAttempts(ledger, scope, NOW + 99_000_000);
  assert.deepEqual(ledger, before);
});
