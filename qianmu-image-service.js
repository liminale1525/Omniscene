import { randomUUID } from 'node:crypto';
import { generateImage, materializeImageResult, sanitizeImageRequest, imageGatewayErrorPayload } from './qianmu-image-gateway.js';
import { createImageServiceStore } from './qianmu-image-service-store.js';
import { createImageServiceQueue, imageServiceChannelKey, describeImageServiceRequest, normalizeImageServiceChannel } from './qianmu-image-service-queue.js';
import { createImageServiceResults } from './qianmu-image-service-results.js';
import { imageServiceAccount, imageServiceAccountStillMatches, imageServiceTaskView } from './qianmu-image-service-access.js';

export const IMAGE_SERVICE_TASK_VERSION = 1;
const fail = (code, message, state = 'not_submitted', status = 409) => Object.assign(new Error(message), {
  name: 'ImageServiceTaskError', code: `image_service_${code}`, status, submissionState: state,
});
function taskId(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw fail('identity', '缺少有效的原生图请求编号');
  return value;
}
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const jobKey = value => JSON.stringify([value.namespace, value.channelKey, value.attemptId]);
export function imageServiceTaskErrorPayload(error) {
  const result = imageGatewayErrorPayload(error);
  if (String(error?.code || '').startsWith('image_service_')) {
    result.status = [400,401,403,404,409,429,503].includes(error.status) ? error.status : 409;
    result.body = { ok: false, code: error.code, message: String(error.message || '生图服务任务未完成').slice(0,240),
      submissionState: ['not_submitted','rejected','accepted','unknown'].includes(error.submissionState) ? error.submissionState : 'unknown', retryable: false,
      ...(/^[a-f0-9]{64}$/.test(error.confirmation || '') ? { confirmation: error.confirmation } : {}),
    };
  }
  return result;
}
export function createImageService({ dataRoot, store = createImageServiceStore({ dataRoot }), results,
  generate = generateImage, materialize = materializeImageResult, gatewayOptions = {}, queueOptions = {} } = {}) {
  const cache = results || createImageServiceResults({ dataRoot, store });
  const queue = createImageServiceQueue({ ...queueOptions, store, ownerId: randomUUID() });
  const jobs = new Map(), retrieving = new Map(); let closed = false, admitted = 0, admissionBytes = 0;
  const context = (request, input, allowLocator = false) => {
    const account = imageServiceAccount(request);
    if (input?.schemaVersion !== IMAGE_SERVICE_TASK_VERSION) throw fail('version', '增强生图任务协议不兼容，请同步更新前后端');
    if (input.expectedAccount !== undefined && input.expectedAccount !== account.namespace) throw fail('authentication_changed', 'ST 登录账户已变化，未提交本次操作', 'not_submitted', 401);
    // A locator selects a channel, never an account or authorization. Retrieval
    // remains scoped to the authenticated owner and survives API-key rotation.
    const locator = input.taskLocator;
    const channelKey = allowLocator && locator?.version === 1 && /^[a-f0-9]{64}$/.test(locator.channelKey || '')
      ? locator.channelKey : imageServiceChannelKey(input.apiKey ?? input.request?.apiKey);
    return { ...account, channelKey, attemptId: taskId(input.attemptId) };
  };
  const validAccount = (request, value) => { if (!imageServiceAccountStillMatches(request, value)) throw fail('authentication_changed', 'ST 账户已变化，请重新操作', 'not_submitted', 401); };
  const find = async value => {
    const state = normalizeImageServiceChannel(await store.inspectChannel(value.channelKey), value.channelKey);
    return state.entries.find(row => row.namespace === value.namespace && row.attemptId === value.attemptId);
  };
  const resultIdentity = (value, row) => ({ namespace: value.namespace, channelKey: value.channelKey, attemptId: row.attemptId, requestDigest: row.requestDigest, fence: row.fence });
  const packet = (value, result, stored, warning = '') => ({ ok: true, provider: result.provider, model: result.model,
    images: result.images, text: result.text || '', upstreamId: result.upstreamId || '', durationMs: result.durationMs || 0,
    serviceTask: { schemaVersion: 1, attemptId: value.attemptId, resultStored: stored?.ready === true,
      ...(stored?.receipt ? { receipt: stored.receipt } : {}), ...(warning ? { warning } : {}),
    },
  });
  async function readCachedResult(request, value, row) {
    if (!row) throw fail('task_missing', '未找到当前账户的原生图任务', 'not_submitted', 404);
    const identity = resultIdentity(value, row);
    let result = await cache.load(identity);
    if (!result) throw fail('result_missing', '原图尚未暂存或已领取，请查看原任务；未重新生成', ['released','rejected'].includes(row.status) ? 'not_submitted' : 'accepted');
    validAccount(request, value);
    let stored = { receipt: result.receipt, ready: result.ready };
    if (!result.ready) {
      try { result = await materialize(result, gatewayOptions); stored = await cache.save(identity, result); }
      catch (_) { throw fail('result_download', '原图暂未取回，请稍后重试领取；不会重新生图', 'accepted'); }
    }
    validAccount(request, value);
    let warning = '';
    if (!jobs.has(jobKey(value)) && ['submitting','uncertain','acknowledged'].includes(row.status)) {
      // A cached image with the exact request/fence proves completion. Do not
      // reconcile an actively running callback or overwrite a replaced request.
      try { await store.transaction(value.channelKey, state => {
        const current = normalizeImageServiceChannel(state, value.channelKey);
        const target = current.entries.find(item => item.namespace === value.namespace && item.attemptId === value.attemptId);
        if (!target || target.fence !== row.fence || target.requestDigest !== row.requestDigest) throw fail('changed', '原任务记录已变化', 'accepted');
        if (['submitting','uncertain','acknowledged'].includes(target.status)) { target.status = 'succeeded'; target.updatedAt = Math.max(target.updatedAt, Date.now()); }
        return { state: current };
      }); } catch (_) { warning = '原图已取回；任务记录尚待核查'; }
    }
    validAccount(request, value);
    return packet(value, result, stored, warning);
  }
  function readResult(request, value, row) {
    const id = jobKey(value);
    if (closed || retrieving.has(id) || retrieving.size >= 32) return Promise.reject(fail('result_busy', '原图正在领取或服务正在停止，请稍后查询', 'accepted'));
    const work = readCachedResult(request, value, row); retrieving.set(id, work);
    return work.finally(() => { if (retrieving.get(id) === work) retrieving.delete(id); });
  }
  return {
    async submit(request, input, { signal } = {}) {
      if (closed) throw fail('closed', '增强服务正在停止，未提交新请求');
      const value = context(request, input);
      if (typeof input.automatic !== 'boolean') throw fail('identity', '请明确本次为自动还是手动生成');
      const automatic = input.automatic, confirmation = input.confirmation || '';
      if (admitted >= 32) throw fail('queue_full', '增强服务等待已满，请稍后重试', 'not_submitted', 429);
      const weight = describeImageServiceRequest(input.request).requestBytes;
      if (admissionBytes + weight > 128 * 1024 * 1024) throw fail('queue_size', '增强服务正在处理较大的素材，请稍后重试', 'not_submitted', 429);
      admitted++; admissionBytes += weight;
      try {
      const frozen = freeze(structuredClone(sanitizeImageRequest(input.request)));
      if (frozen.provider !== 'novel' || (frozen.protocol && frozen.protocol !== 'novelai')) throw fail('provider', '当前服务队列仅支持 NAI 原生协议；其他渠道保持原通路');
      if (imageServiceChannelKey(frozen.apiKey) !== value.channelKey) throw fail('identity', '任务连接与生图连接不一致');
      const description = describeImageServiceRequest(frozen), id = jobKey(value);
      const previous = await find(value); validAccount(request, value);
      if (previous) {
        if (previous.requestDigest !== description.requestDigest) throw fail('conflict', '原请求配置已变化，未重新提交', 'accepted');
        return await readResult(request, value, previous);
      }
      if (closed || signal?.aborted) throw fail('cancelled', '生图等待已取消，未提交');
      if (jobs.has(id)) throw fail('already_submitted', '原任务仍在等待，请查询原任务', 'accepted');
      let job;
      const work = queue.run({ apiKey: frozen.apiKey, ...value, ...description, automatic, confirmation,
        valid: () => !closed && imageServiceAccountStillMatches(request, value), signal,
        onWarning: () => { if (job) job.warning = '图片已生成；任务记录尚待核查'; },
      }, async ticket => {
        const identity = { namespace: value.namespace, channelKey: value.channelKey, attemptId: value.attemptId, requestDigest: description.requestDigest, fence: ticket.fence };
        await cache.reserve(identity);
        let result = await generate(frozen, { ...gatewayOptions, beforeSubmit: async () => { await ticket.beforeSubmit(); if (job) job.submitted = true; } });
        let stored, warning = '';
        try {
          stored = await cache.save(identity, result);
          if (!stored.ready) { result = await materialize(result, gatewayOptions); stored = await cache.save(identity, result); }
        } catch (_) { warning = '图片已生成；服务暂存尚未完成，请先保存当前图片'; }
        return packet(value, result, stored, warning);
      });
      job = { promise: work, submitted: false, warning: '', requestDigest: description.requestDigest };
      job.done = new Promise(resolve => { job.settled = resolve; });
      jobs.set(id, job);
      try {
        const result = await work;
        if (job.warning) result.serviceTask.warning = job.warning;
        if (!imageServiceAccountStillMatches(request, value)) throw fail('authentication_changed', 'ST 账户已变化；原图保留在原账户任务中', 'accepted', 401);
        return result;
      } catch (error) {
        // A reserved result slot is safe to remove only after a definitive
        // never-sent/rejected ledger settlement. Unknown work retains its evidence.
        try {
          const row = await find(value);
          if (row && ['released','rejected'].includes(row.status)) {
            const identity = resultIdentity(value, row), stored = await cache.load(identity, { metadataOnly: true });
            if (stored && !stored.ready && !stored.remote) await cache.discard(identity, stored.receipt);
          }
        } catch (_) {}
        throw error;
      } finally { if (jobs.get(id) === job) jobs.delete(id); job.settled(); }
      } finally { admitted--; admissionBytes -= weight; }
    },
    async query(request, input) {
      const value = context(request, input, true), row = await find(value); validAccount(request, value);
      const pending = jobs.get(jobKey(value));
      const result = { ok: true, schemaVersion: 1, task: imageServiceTaskView(row) };
      if (!row) return pending ? { ok: true, schemaVersion: 1, task: { attemptId: value.attemptId, status: 'queued', persisted: false, resultAvailable: false } } : result;
      const stored = await cache.load(resultIdentity(value, row), { metadataOnly: true }); validAccount(request, value);
      return { ...result, task: { ...result.task, live: Boolean(pending || retrieving.has(jobKey(value))), resultAvailable: Boolean(stored?.ready || stored?.remote), resultStored: stored?.ready === true,
        ...(stored ? { cacheReceipt: stored.receipt, cacheBytes: stored.bytes } : {}),
      } };
    },
    async result(request, input) {
      const value = context(request, input, true), row = await find(value); validAccount(request, value);
      return readResult(request, value, row);
    },
    async acknowledge(request, input) {
      const value = context(request, input, true), row = await find(value); validAccount(request, value);
      if (!row || row.status !== 'succeeded' || jobs.has(jobKey(value)) || retrieving.has(jobKey(value))) throw fail('not_complete', '原任务尚未完成，未清理暂存');
      if (input.archived !== true || typeof input.receipt !== 'string' || !/^[a-f0-9]{64}$/.test(input.receipt)) throw fail('receipt', '请先确认图片已在本地保存');
      return { ok: true, ...(await cache.discard(resultIdentity(value, row), input.receipt, { valid: () => imageServiceAccountStillMatches(request, value) })) };
    },
    async discard(request, input) {
      const value = context(request, input, true), row = await find(value); validAccount(request, value);
      if (!row || ['reserved','submitting'].includes(row.status) || jobs.has(jobKey(value)) || retrieving.has(jobKey(value))) throw fail('not_complete', '原任务仍在运行或等待核查，未清理暂存');
      if (input.confirmed !== true || !/^[a-f0-9]{64}$/.test(input.receipt || '')) throw fail('receipt', '请先确认清理当前暂存图片');
      return { ok: true, ...(await cache.discard(resultIdentity(value, row), input.receipt, { valid: () => imageServiceAccountStillMatches(request, value) })) };
    },
    async close() {
      closed = true; queue.close(); await Promise.allSettled([...jobs.values()].map(job => job.done).concat([...retrieving.values()])); await store.close();
    },
    inspect() { return { ...queue.inspect(), tasks: jobs.size, admitted, admissionBytes }; },
  };
}
