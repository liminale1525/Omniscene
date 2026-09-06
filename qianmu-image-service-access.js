// The host's authenticated Request.user is the only source of account identity.
// No HTTP handler may accept a namespace, account or disk path from request.body.
import { createHash } from 'node:crypto';
import { imageServiceChannelKey, normalizeImageServiceChannel } from './qianmu-image-service-queue.js';

const fail = (code, message, status = 400) => Object.assign(new Error(message), {
  name: 'ImageServiceAccessError', code: `image_service_${code}`, status, submissionState: 'not_submitted',
});
function identity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
export function imageServiceAccount(request) {
  const profile = request?.user?.profile;
  if (!profile || profile.enabled === false || !identity(profile.handle)) throw fail('authentication_required', '请先登录 ST 账户再核查生图任务', 401);
  return Object.freeze({
    namespace: `st-user:${createHash('sha256').update(profile.handle).digest('hex')}`,
    admin: profile.admin === true,
  });
}
export function imageServiceAccountStillMatches(request, account) {
  try { return imageServiceAccount(request).namespace === account?.namespace; } catch (_) { return false; }
}
export function imageServiceTaskView(row) {
  return row ? { attemptId: row.attemptId, status: row.status, automatic: row.automatic,
    createdAt: row.createdAt, updatedAt: row.updatedAt, needsReview: row.status === 'uncertain' } : null;
}
export async function queryImageServiceTask(request, input, { store } = {}) {
  const account = imageServiceAccount(request);
  // Query by the actual connection credential, never a client-supplied hash.
  const channelKey = imageServiceChannelKey(input?.apiKey);
  if (!identity(input?.attemptId)) throw fail('identity', '缺少有效的原生图请求编号');
  const attemptId = input.attemptId;
  if (typeof store?.inspectChannel !== 'function') throw fail('storage', '当前增强服务尚未提供任务记录', 503);
  const raw = await store.inspectChannel(channelKey);
  if (!imageServiceAccountStillMatches(request, account)) throw fail('authentication_changed', 'ST 账户已变化，请重新核查', 401);
  const state = normalizeImageServiceChannel(raw, channelKey);
  const row = state.entries.find(item => item.namespace === account.namespace && item.attemptId === attemptId);
  // A guessed id belonging to someone else is indistinguishable from a missing id,
  // even for an administrator. Maintenance is an explicit separate operation.
  if (!row) return { ok: true, schemaVersion: 1, task: null };
  return { ok: true, schemaVersion: 1, task: imageServiceTaskView(row) };
}
