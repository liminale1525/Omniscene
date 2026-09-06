// Pure still-frame admission rules. Persistence must apply each operation inside one
// read/write transaction; this module does not open storage or authorize network I/O.
export const IMAGE_ATTEMPT_SCHEMA = 'qianmu.image-attempts.v1';
export const IMAGE_ATTEMPT_LIMIT = 256;
export const IMAGE_RESERVATION_TTL_MS = 10 * 60_000;
const STATES = new Set(['reserved', 'submitting', 'unknown', 'accepted', 'succeeded', 'rejected', 'released']);
const KINDS = new Set(['automatic', 'manual', 'supplement', 'redraw']);
const OCCUPIED = new Set(['reserved', 'submitting', 'unknown', 'accepted', 'succeeded']);
const UNCONFIRMED = new Set(['unknown', 'accepted']);
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function id(value, name, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail('image_attempt_identity', `${name}不完整，未授权生图`);
  return value;
}
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - IMAGE_RESERVATION_TTL_MS) fail('image_attempt_time', '请求时间无效');
  return value;
}

export function imageAttemptScopeKey(scope) {
  if (!plain(scope)) fail('image_attempt_identity', '缺少原正文身份');
  return JSON.stringify([
    id(scope.namespace, '账户存储范围'), id(scope.chatKey, '聊天', 512),
    id(scope.messageKey, '原正文'), id(scope.revisionId, '正文版本'),
  ]);
}

function readEntry(value) {
  if (!plain(value) || !STATES.has(value.status) || !KINDS.has(value.kind)) fail('image_attempt_corrupt', '生图请求记录损坏，请先核查');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.automaticSlot !== 'boolean') fail('image_attempt_corrupt', '生图请求版本无效');
  const row = {
    attemptId: id(value.attemptId, '请求编号'), logicalShotId: id(value.logicalShotId, '镜头编号'),
    operationKey: id(value.operationKey, '操作编号'), ownerId: id(value.ownerId, '页面会话'),
    kind: value.kind, automaticSlot: value.automaticSlot, status: value.status, revision: value.revision,
    createdAt: time(value.createdAt), updatedAt: time(value.updatedAt), expiresAt: time(value.expiresAt),
  };
  if (row.expiresAt < row.createdAt || (row.kind === 'automatic' && !row.automaticSlot)) fail('image_attempt_corrupt', '生图预留范围无效');
  return row;
}

export function normalizeImageAttempts(value, scope) {
  const scopeKey = imageAttemptScopeKey(scope);
  if (value === undefined || value === null) return { schema: IMAGE_ATTEMPT_SCHEMA, scopeKey, entries: [] };
  if (!plain(value) || value.schema !== IMAGE_ATTEMPT_SCHEMA || value.scopeKey !== scopeKey || !Array.isArray(value.entries)
    || value.entries.length > IMAGE_ATTEMPT_LIMIT) fail('image_attempt_corrupt', '生图预算记录不完整，未授权生图');
  const entries = value.entries.map(readEntry);
  if (new Set(entries.map(row => row.attemptId)).size !== entries.length) fail('image_attempt_corrupt', '生图请求编号重复');
  return { schema: IMAGE_ATTEMPT_SCHEMA, scopeKey, entries };
}

function expireReservations(ledger, now) {
  for (const row of ledger.entries) if (row.status === 'reserved' && row.expiresAt <= now) {
    row.status = 'released'; row.updatedAt = now; row.revision++;
  }
}
function countAutomatic(ledger) {
  return new Set(ledger.entries.filter(row => row.automaticSlot && OCCUPIED.has(row.status)).map(row => row.logicalShotId)).size;
}
function confirmationFor(entries) {
  return JSON.stringify(entries.filter(row => UNCONFIRMED.has(row.status)).map(row => [row.attemptId, row.revision, row.status]).sort((a,b) => a[0].localeCompare(b[0])));
}
function result(ledger, ok, code, extra = {}) { return { ledger, ok, code, automaticUsed: countAutomatic(ledger), ...extra }; }

export function claimImageAttempt(value, scope, input, now) {
  now = time(now);
  const ledger = normalizeImageAttempts(value, scope);
  if (!plain(input) || !KINDS.has(input.kind)) fail('image_attempt_request', '缺少明确的生图操作类型');
  const attemptId = id(input.attemptId, '请求编号'), logicalShotId = id(input.logicalShotId, '镜头编号');
  const operationKey = id(input.operationKey, '操作编号'), ownerId = id(input.ownerId, '页面会话');
  const automatic = input.kind === 'automatic';
  if (!Number.isInteger(input.maxAutomatic) || input.maxAutomatic < 1 || input.maxAutomatic > 4) fail('image_attempt_budget', '自动镜头上限无效');
  if (automatic && input.imageCount !== 1) fail('image_attempt_count', '自动镜头每次只能生成一张');
  expireReservations(ledger, now);
  const previous = ledger.entries.find(row => row.attemptId === attemptId);
  if (previous) {
    if (previous.ownerId !== ownerId || previous.logicalShotId !== logicalShotId || previous.operationKey !== operationKey || previous.kind !== input.kind) return result(ledger, false, 'identity_conflict');
    // Reusing an admission receipt is allowed only before dispatch. A persisted
    // submitting/unknown attempt is never a replay token after refresh.
    return result(ledger, previous.status === 'reserved', previous.status === 'reserved' ? 'reserved' : 'attempt_exists', { attempt: { ...previous } });
  }
  const related = ledger.entries.filter(row => row.logicalShotId === logicalShotId || row.operationKey === operationKey);
  if (related.some(row => row.status === 'reserved' || row.status === 'submitting')) return result(ledger, false, 'busy');
  const uncertain = related.filter(row => UNCONFIRMED.has(row.status));
  if (uncertain.length && (automatic || input.confirmation !== confirmationFor(uncertain))) {
    return result(ledger, false, 'confirmation_required', { confirmation: confirmationFor(uncertain) });
  }
  if (automatic && related.some(row => row.status === 'succeeded')) return result(ledger, false, 'already_generated');
  const existingSlot = ledger.entries.some(row => row.logicalShotId === logicalShotId && row.automaticSlot);
  const occupiedSlot = ledger.entries.some(row => row.logicalShotId === logicalShotId && row.automaticSlot && OCCUPIED.has(row.status));
  if (automatic && !occupiedSlot && countAutomatic(ledger) >= input.maxAutomatic) return result(ledger, false, 'budget_exhausted');
  // Never prune accepted/unknown attempts to manufacture new budget. Storage
  // management must disclose the effect of an explicit user-requested reset.
  if (ledger.entries.length >= IMAGE_ATTEMPT_LIMIT) return result(ledger, false, 'ledger_full');
  const attempt = {
    attemptId, logicalShotId, operationKey, ownerId, kind: input.kind,
    automaticSlot: automatic || (input.kind === 'redraw' && existingSlot), status: 'reserved', revision: 1,
    createdAt: now, updatedAt: now, expiresAt: now + IMAGE_RESERVATION_TTL_MS,
  };
  ledger.entries.push(attempt);
  return result(ledger, true, 'reserved', { attempt: { ...attempt } });
}

export function beginImageAttempt(value, scope, { attemptId, ownerId }, now) {
  now = time(now);
  const ledger = normalizeImageAttempts(value, scope);
  expireReservations(ledger, now);
  const row = ledger.entries.find(entry => entry.attemptId === id(attemptId, '请求编号'));
  if (!row || row.ownerId !== id(ownerId, '页面会话')) return result(ledger, false, 'missing_reservation');
  if (row.status !== 'reserved') return result(ledger, false, 'not_reserved');
  row.status = 'submitting'; row.updatedAt = now; row.revision++;
  return result(ledger, true, 'submitting', { attempt: { ...row } });
}

export function settleImageAttempt(value, scope, { attemptId, ownerId, outcome }, now) {
  now = time(now);
  const ledger = normalizeImageAttempts(value, scope);
  const row = ledger.entries.find(entry => entry.attemptId === id(attemptId, '请求编号'));
  if (!row || row.ownerId !== id(ownerId, '页面会话')) return result(ledger, false, 'missing_reservation');
  const outcomes = { not_submitted: 'released', rejected: 'rejected', unknown: 'unknown', accepted: 'accepted', succeeded: 'succeeded' };
  if (!Object.hasOwn(outcomes, outcome)) fail('image_attempt_outcome', '缺少明确的受理状态');
  const target = outcomes[outcome];
  if (row.status === target) return result(ledger, true, 'unchanged', { attempt: { ...row } });
  if (row.status === 'succeeded' || (['accepted', 'unknown'].includes(row.status) && ['released', 'rejected'].includes(target))) return result(ledger, false, 'unsafe_release');
  if (['released', 'rejected'].includes(row.status) || (row.status === 'reserved' && !['released', 'rejected'].includes(target))) return result(ledger, false, 'invalid_transition');
  row.status = target; row.updatedAt = now; row.revision++;
  return result(ledger, true, target, { attempt: { ...row } });
}

export function summarizeImageAttempts(value, scope, now) {
  const ledger = normalizeImageAttempts(value, scope);
  expireReservations(ledger, time(now));
  return { ledger, automaticUsed: countAutomatic(ledger), pending: ledger.entries.filter(row => ['reserved', 'submitting'].includes(row.status)).length,
    uncertain: ledger.entries.filter(row => UNCONFIRMED.has(row.status)).length, attempts: ledger.entries.length };
}
