// ST-only coordination of the native Comfy API. No browser-direct guarantee,
// no implicit tunnel, no replay, and no persistence of workflows or credentials.
import { createHash } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches, imageServiceTaskView } from './qianmu-image-service-access.js';
import { createImageServiceStore } from './qianmu-image-service-store.js';
import { createImageServiceResults } from './qianmu-image-service-results.js';
import { createImageServiceQueue, describeImageServiceRequest, imageServiceChannelKey, normalizeImageServiceChannel } from './qianmu-image-service-queue.js';
import { generateImage, recoverComfyImage, sanitizeImageRequest, ImageGatewayError } from './qianmu-image-gateway.js';
import { normalizeComfyTarget } from './qianmu-comfy-server-transport.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, state = 'not_submitted', status = 409) => Object.assign(new ImageGatewayError(status, `comfy_queue_${code}`, message), { submissionState: state });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,240}$/.test(value);
export function comfyInstanceResource(baseUrl) {
  // Private permission and Key do not identify hardware. Different roots/ports
  // remain distinct; aliases are never inferred to be the same physical instance.
  return `comfy-instance:${hash(normalizeComfyTarget(baseUrl))}`;
}
function binding(req, input) {
  const account = imageServiceAccount(req);
  if (input?.version !== 1 || input.expectedAccount !== account.namespace || !validId(input.attemptId)) {
    throw fail('binding', 'Comfy 请求身份未确认，请同步更新前后端并核对 ST 账户');
  }
  return { ...account, attemptId: input.attemptId };
}
function validAccount(req, account) {
  if (!imageServiceAccountStillMatches(req, account)) throw fail('account', 'ST 账户已变化，请回原账户核查原任务', 'unknown', 401);
}
function safeError(cause) {
  if (cause instanceof ImageGatewayError) {
    cause.submissionState ||= 'not_submitted';
    return cause;
  }
  const known = /^(?:image_service_|comfy_)/.test(cause?.code || '');
  const error = fail('unavailable', known ? cause.message : 'Comfy 服务记录暂不可用，请核查原任务',
    cause?.submissionState || 'unknown', [400,401,403,409,429,503].includes(cause?.status) ? cause.status : 409);
  if (known) error.code = cause.code;
  if (validId(cause?.upstreamId)) error.upstreamId = cause.upstreamId;
  return error;
}

export function createComfyService({ dataRoot, store = createImageServiceStore({ dataRoot, scope: 'comfy' }),
  authorizeTarget, prepareTransport, generate = generateImage, recover = recoverComfyImage, queueOptions = {}, results } = {}) {
  if (typeof authorizeTarget !== 'function' || typeof prepareTransport !== 'function') throw fail('configuration', 'Comfy 服务未配置可信连接边界');
  const queue = createImageServiceQueue({ ...queueOptions, store, resourceLabel: 'Comfy 实例' });
  const cache = results || createImageServiceResults({ dataRoot, store, scope: 'comfy' });
  const jobs = new Map(), retrieving = new Map(); let closed = false, admitted = 0, retainedBytes = 0;
  const keyOf = value => JSON.stringify([value.namespace, value.channelKey, value.attemptId]);
  const find = async value => normalizeImageServiceChannel(await store.inspectChannel(value.channelKey), value.channelKey)
    .entries.find(row => row.namespace === value.namespace && row.attemptId === value.attemptId);
  const cacheIdentity = (value, row) => ({ namespace: value.namespace, channelKey: value.channelKey, attemptId: value.attemptId, requestDigest: row.requestDigest, fence: row.fence });
  const packet = (value, result, stored, warning = '') => ({ ...result, comfyTask: { version: 1, attemptId: value.attemptId, scope: 'st-api-root',
    resultStored: stored?.ready === true, ...(stored?.receipt ? { receipt: stored.receipt } : {}), ...(warning ? { warning } : {}) } });
  async function reconcile(value, row) {
    if (jobs.has(keyOf(value)) || row.status === 'succeeded') return '';
    try {
      await store.transaction(value.channelKey, raw => {
        const state = normalizeImageServiceChannel(raw, value.channelKey);
        const current = state.entries.find(item => item.namespace === value.namespace && item.attemptId === value.attemptId);
        if (!current || current.fence !== row.fence || current.requestDigest !== row.requestDigest || current.upstreamId !== row.upstreamId
          || !['submitting','uncertain','acknowledged','succeeded'].includes(current.status)) throw fail('changed', 'Comfy 原任务记录已变化', 'accepted');
        current.status = 'succeeded'; current.updatedAt = Math.max(current.updatedAt, Date.now()); return { state };
      });
      return '';
    } catch (_) { return '原图已取回；Comfy 任务记录尚待核查'; }
  }
  async function recordKnownFailure(value, cause, expected) {
    // This code is emitted only by the native collector after matching the
    // stored id to an explicit error status, not by an HTTP timeout or 404.
    if (cause?.code !== 'comfy_execution_failed' || !validId(cause.upstreamId) || !expected?.fence) return;
    try {
      await store.transaction(value.channelKey, raw => {
        const state = normalizeImageServiceChannel(raw, value.channelKey);
        const row = state.entries.find(item => item.namespace === value.namespace && item.attemptId === value.attemptId);
        if (!row || row.upstreamId !== cause.upstreamId || row.fence !== expected.fence || row.requestDigest !== expected.requestDigest
          || !['submitting','uncertain','failed'].includes(row.status)) throw fail('changed', '原任务状态已变化', 'accepted');
        row.status = 'failed'; row.updatedAt = Math.max(row.updatedAt, Date.now()); return { state };
      });
    } catch (_) { /* Keep the conservative fence if durable settlement fails. */ }
  }
  async function releaseEmpty(value) {
    try {
      const row = await find(value);
      if (row && ['released','rejected','failed'].includes(row.status)) {
        const identity = cacheIdentity(value, row), meta = await cache.load(identity, { metadataOnly: true });
        if (meta && !meta.ready && !meta.remote) await cache.discard(identity, meta.receipt);
      }
    } catch (_) { /* Keep unverifiable contents rather than delete evidence. */ }
  }
  async function receive(req, value, connection, signal) {
    const row = await find(value); validAccount(req, value);
    if (!row) throw fail('missing', '未找到当前账户的 Comfy 原任务', 'not_submitted', 404);
    if (jobs.has(keyOf(value))) return { ok: true, status: 'collecting', message: '原请求仍在等待或收片，请稍后领取' };
    const identity = cacheIdentity(value, row);
    let result = await cache.load(identity), stored;
    validAccount(req, value); signal?.throwIfAborted();
    if (result) {
      if (!result.ready || result.provider !== 'comfy' || !row.upstreamId || result.upstreamId !== row.upstreamId) throw fail('cache', 'Comfy 原图暂存与任务不符，未继续领取', 'accepted');
      stored = { ready: true, receipt: result.receipt };
    } else {
      if (!row.upstreamId || !row.comfyReceipt) throw fail('receipt_missing', '原任务缺少可核对的收片约定，请到 Comfy 核查；未重新生成', 'unknown');
      const existing = await cache.load(identity, { metadataOnly: true });
      if (!existing) await cache.reserve(identity);
      validAccount(req, value); signal?.throwIfAborted();
      try {
        result = await recover(connection, row.upstreamId, row.comfyReceipt, {
          prepareComfyTransport: (input, operation) => prepareTransport(req, input, operation, { signal }),
        });
      } catch (cause) { await recordKnownFailure(value, cause, row); await releaseEmpty(value); throw cause; }
      validAccount(req, value); signal?.throwIfAborted();
      if (result.status !== 'ready') return { ok: true, status: result.status, message: result.message, upstreamId: row.upstreamId };
      if (result.provider !== 'comfy' || result.upstreamId !== row.upstreamId) throw fail('result', 'Comfy 返回的不是原任务，未归档', 'accepted');
      try { stored = await cache.save(identity, result); }
      catch (_) { validAccount(req, value); signal?.throwIfAborted(); return packet(value, result, null, '原图已取回；服务器暂存未完成，请先保存图片'); }
    }
    const warning = await reconcile(value, row); validAccount(req, value); signal?.throwIfAborted();
    return packet(value, { ...result, status: 'ready' }, stored, warning);
  }
  return {
    async submit(req, input, { signal } = {}) {
      let counted = false, weight = 0;
      try {
        const account = binding(req, input?.comfyQueue);
        if (closed || signal?.aborted) throw fail('closed', 'Comfy 等待已停止，未提交');
        if (admitted >= 32) throw fail('full', 'Comfy 等待队列已满，请稍后再试', 'not_submitted', 429);
        if (typeof input.comfyQueue.automatic !== 'boolean') throw fail('binding', 'Comfy 请求缺少明确的自动生成状态');
        const automatic = input.comfyQueue.automatic;
        // Synchronous bounds before cloning or awaiting an authorization read.
        const sanitized = sanitizeImageRequest(input);
        if (sanitized.provider !== 'comfy' || !sanitized.comfyExecution) throw fail('request', 'Comfy 工作流缺少已确认的输出与数量规则');
        if (sanitized.comfyExecution.automatic !== automatic) throw fail('binding', 'Comfy 自动生成与数量核查状态不一致');
        const references = input.referenceImages || input.references || [];
        if (!Array.isArray(references) || references.length !== sanitized.references.length) throw fail('request', 'Comfy 参考图数量无效或超限');
        sanitized.baseUrl = normalizeComfyTarget(sanitized.baseUrl);
        // The instance key is independent of credentials, but the identity of a
        // retry still includes a one-way credential fingerprint (never the Key).
        const description = describeImageServiceRequest({ ...sanitized, credentialFingerprint: hash(sanitized.apiKey) });
        weight = description.requestBytes;
        if (retainedBytes + weight > 128 * 1024 * 1024) throw fail('size', 'Comfy 正在处理较大的素材，请稍后再试', 'not_submitted', 429);
        admitted++; retainedBytes += weight; counted = true;
        const frozen = structuredClone(sanitized), resource = comfyInstanceResource(frozen.baseUrl);
        const value = { ...account, channelKey: imageServiceChannelKey(resource) };
        const authorization = await authorizeTarget(req, frozen);
        if (typeof authorization !== 'function') throw fail('configuration', 'Comfy 可信连接未确认');
        validAccount(req, value);
        const previous = await find(value); validAccount(req, value);
        if (previous) {
          const error = fail(previous.requestDigest === description.requestDigest ? 'already_exists' : 'conflict',
            previous.requestDigest === description.requestDigest ? '原 Comfy 请求已存在，请核查原任务；未重复提交' : '原 Comfy 请求配置已变化，未重新提交',
            ['reserved','released','rejected'].includes(previous.status) ? 'not_submitted' : previous.upstreamId ? 'accepted' : 'unknown');
          if (previous.upstreamId) error.upstreamId = previous.upstreamId;
          throw error;
        }
        const key = keyOf(value);
        if (jobs.has(key)) throw fail('already_exists', '原 Comfy 请求仍在等待，请勿重复提交', 'unknown');
        let warning = '', stored, executionIdentity;
        const work = queue.run({ apiKey: resource, ...value, ...description, automatic, signal,
          valid: () => !closed && imageServiceAccountStillMatches(req, value),
          onWarning: () => { warning = '图片已生成；Comfy 任务记录尚待核查'; },
        }, async ticket => {
          await authorization(); validAccount(req, value);
          const identity = cacheIdentity(value, { ...description, fence: ticket.fence });
          executionIdentity = identity;
          await cache.reserve(identity);
          const result = await generate(frozen, {
            prepareComfyTransport: (connection, operation) => prepareTransport(req, connection, operation),
            beforeSubmit: async () => { await authorization(); await ticket.beforeSubmit(); },
            onComfyAccepted: (promptId, receipt) => ticket.recordUpstreamId(promptId, receipt),
          });
          try { stored = await cache.save(identity, result); }
          catch (_) { warning = '图片已生成；服务器暂存未完成，请先保存图片'; }
          return result;
        });
        jobs.set(key, work);
        try {
          const result = await work;
          if (!imageServiceAccountStillMatches(req, value)) throw fail('account', 'ST 账户已变化；请回原账户核查 Comfy 原任务', 'accepted', 401);
          return packet(value, result, stored, warning);
        } catch (cause) {
          await recordKnownFailure(value, cause, executionIdentity);
          // Remove only an empty reservation proven never accepted. Uncertain
          // submissions retain both ledger and reserved capacity for recovery.
          await releaseEmpty(value);
          throw cause;
        } finally { if (jobs.get(key) === work) jobs.delete(key); }
      } catch (cause) { throw safeError(cause); }
      finally { if (counted) { admitted--; retainedBytes -= weight; } }
    },
    async query(req, input) {
      try {
        const account = binding(req, input), channelKey = imageServiceChannelKey(comfyInstanceResource(input?.baseUrl));
        const value = { ...account, channelKey }, row = await find(value); validAccount(req, value);
        // Lookup reads only this account's own local receipt. It cannot fetch
        // remote history, leak another account's ids or grant submission rights.
        const live = jobs.has(keyOf(value));
        const meta = row ? await cache.load(cacheIdentity(value, row), { metadataOnly: true }) : null; validAccount(req, value);
        return { ok: true, version: 1, task: row ? { ...imageServiceTaskView(row), live, persisted: true,
          resultStored: meta?.ready === true, recoverable: Boolean(row.upstreamId && row.comfyReceipt),
          ...(meta ? { cacheReceipt: meta.receipt, cacheBytes: meta.bytes } : {}),
          ...(row.upstreamId ? { upstreamId: row.upstreamId } : {}) } : live ? { attemptId: value.attemptId, status: 'queued', live: true, persisted: false } : null };
      } catch (cause) { throw safeError(cause); }
    },
    async result(req, input, { signal } = {}) {
      try {
        const account = binding(req, input), connection = { baseUrl: normalizeComfyTarget(input?.baseUrl), apiKey: input.apiKey, allowPrivateNetwork: input.allowPrivateNetwork === true };
        const value = { ...account, channelKey: imageServiceChannelKey(comfyInstanceResource(connection.baseUrl)) }, key = keyOf(value);
        if (closed || signal?.aborted || retrieving.has(key) || retrieving.size >= 2) throw fail('busy', 'Comfy 原图正在领取或服务正在停止，请稍后再试', 'accepted');
        const work = receive(req, value, connection, signal); retrieving.set(key, work);
        try { return await work; }
        finally { if (retrieving.get(key) === work) retrieving.delete(key); }
      } catch (cause) { throw safeError(cause); }
    },
    async acknowledge(req, input) {
      try {
        const account = binding(req, input), value = { ...account, channelKey: imageServiceChannelKey(comfyInstanceResource(input?.baseUrl)) }, receipt = input.receipt;
        const row = await find(value); validAccount(req, value);
        if (!row || row.status !== 'succeeded' || jobs.has(keyOf(value)) || retrieving.has(keyOf(value)) || input.archived !== true
          || typeof receipt !== 'string' || !/^[a-f0-9]{64}$/.test(receipt)) throw fail('acknowledge', '请先确认原图已归档，未清理服务器暂存', 'accepted');
        return { ok: true, ...(await cache.discard(cacheIdentity(value, row), receipt, { valid: () => imageServiceAccountStillMatches(req, value) })) };
      } catch (cause) { throw safeError(cause); }
    },
    async close() {
      closed = true; queue.close();
      await Promise.allSettled([...jobs.values(), ...retrieving.values()]); await store.close();
    },
  };
}
