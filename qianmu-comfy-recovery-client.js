// Comfy delivery only: no generation route, reference upload or workflow copy.
import { prepareComfySubmission, assertComfyAccount, acknowledgeComfyImage } from './qianmu-comfy-submission.js';
import { resolveImageAccountNamespace } from './qianmu-image-admission.js';
import { imageChannelKey } from './qianmu-image-channel.js';
import { createComfyDeliveryStore, normalizeComfyDelivery } from './qianmu-comfy-delivery-store.js';

const fail = (code, message) => Object.assign(new Error(message), { code: `comfy_delivery_${code}`, submissionState: 'accepted', retryable: false });
const BASE = '/api/plugins/qianmu-tts/image/comfy/tasks';
const identity = job => ({ id: job?.id, source: job?.source, logId: job?.logId, chatKey: job?.chatKey, automatic: job?.automatic,
  imageAdmission: { version: job?.imageAdmission?.version, namespace: job?.imageAdmission?.namespace, attemptId: job?.imageAdmission?.attemptId },
  connection: { baseUrl: job?.connection?.baseUrl, credentialId: job?.connection?.credentialId, allowPrivateNetwork: job?.connection?.allowPrivateNetwork } });
export function createComfyRecoveryClient({ account = resolveImageAccountNamespace, store = createComfyDeliveryStore(),
  locks = globalThis.navigator?.locks, origin = globalThis.location?.origin, fetchImpl = globalThis.fetch,
  headers = () => ({}), timeoutMs = 45000 } = {}) {
  let closed = false;
  const controllers = new Set();
  async function guard(job) {
    if (closed) throw fail('closed', 'Comfy 领取会话已结束，请在原账户重新领取');
    await assertComfyAccount(job, { account });
    if (closed) throw fail('closed', 'Comfy 领取会话已结束，请在原账户重新领取');
  }
  async function locked(job, work, { wait = false } = {}) {
    await guard(job);
    if (typeof locks?.request !== 'function') throw fail('lock', '当前浏览器无法保护跨页归档，请使用支持页面锁的 HTTPS 浏览器');
    // All Comfy deliveries for this account serialize their metadata writes.
    // Different accounts do not share either a lock or a journal namespace.
    const key = await imageChannelKey(job.imageAdmission.namespace);
    const controller = wait ? new AbortController() : null;
    if (controller) controllers.add(controller);
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
    try {
      return await locks.request(`qianmu-comfy-delivery:${key}`, { mode: 'exclusive', ...(controller ? { signal: controller.signal } : { ifAvailable: true }) }, async lock => {
        if (!lock) throw fail('busy', '另一个 Comfy 任务正在归档，请稍后领取');
        if (timer) clearTimeout(timer); if (controller) controllers.delete(controller);
        await guard(job); return work();
      });
    } catch (error) {
      if (controller?.signal.aborted && error?.name === 'AbortError') throw fail('busy', 'Comfy 归档等待已停止，原图保留，可稍后领取');
      throw error;
    } finally { if (timer) clearTimeout(timer); if (controller) controllers.delete(controller); }
  }
  const fresh = job => normalizeComfyDelivery({ version: 1, namespace: job.imageAdmission.namespace, attemptId: job.id,
    baseUrl: job.connection?.baseUrl, credentialId: job.connection?.credentialId || '', allowPrivateNetwork: job.connection?.allowPrivateNetwork === true,
    chatKey: job.chatKey || '', logId: job.logId || '', automatic: Boolean(job.automatic), createdAt: Date.now(), status: 'prepared', receipt: '', imageCount: 0, files: [] }, origin);
  async function remember(job) {
    const expected = fresh(job), existing = await store.get(expected.namespace, expected.attemptId); await guard(job);
    if (existing) {
      const row = normalizeComfyDelivery(existing, origin);
      if (['namespace','attemptId','baseUrl','credentialId','allowPrivateNetwork','chatKey'].some(key => row[key] !== expected[key])) throw fail('identity', '原 Comfy 连接或任务已变化，请使用原日志领取');
      return row;
    }
    await store.put(expected); await guard(job); return expected;
  }
  async function save(job, row) { await guard(job); const clean = normalizeComfyDelivery(row, origin); await store.put(clean); await guard(job); return clean; }
  async function request(job, action, body, maxBytes) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.min(60000, Math.max(1000, Number(timeoutMs) || 45000)));
    try {
      await guard(job);
      const response = await fetchImpl(`${BASE}/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { ...headers(), 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(body) });
      const reader = response.body?.getReader(); if (!reader) throw fail('response', 'Comfy 服务未返回领取结果');
      const chunks = []; let size = 0;
      try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maxBytes) throw fail('size', 'Comfy 领取结果超限，服务器原图未清理'); chunks.push(item.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const buffer = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      let result;
      try { result = JSON.parse(new TextDecoder().decode(buffer)); } catch (_) { throw fail('response', 'Comfy 服务返回格式异常，未重新生成'); }
      await guard(job);
      if (!response.ok || result?.ok !== true) throw fail('response', typeof result?.message === 'string' ? result.message.slice(0, 300) : `Comfy 领取暂不可用（${response.status}）`);
      return result;
    } catch (error) {
      if (/^(?:comfy_|image_)/.test(error?.code || '')) throw error;
      throw fail('network', 'Comfy 领取连接中断，原任务未重投，请稍后再试');
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  async function acknowledge(job, row) {
    if (row.status === 'confirmed') return { archived: true, alreadyArchived: true, warning: '' };
    await guard(job);
    if (!row.receipt) return { archived: true, warning: '原图已归档；服务器暂存状态尚待核查' };
    const warning = await acknowledgeComfyImage(job, { comfyTask: { resultStored: true, receipt: row.receipt, attemptId: row.attemptId } },
      { account: async () => { await guard(job); return job.imageAdmission.namespace; }, fetchImpl, headers });
    await guard(job);
    if (!warning) await save(job, { ...row, status: 'confirmed' });
    return { archived: true, warning };
  }
  async function archive(job, row, data, deliver) {
    if (['archived','confirmed'].includes(row.status)) return acknowledge(job, row);
    const count = data.images?.length, task = data.comfyTask;
    if (!Number.isInteger(count) || count < 1 || count > 8 || task?.version !== 1 || task.attemptId !== row.attemptId
      || (task.resultStored && !/^[a-f0-9]{64}$/.test(task.receipt || ''))
      || (row.imageCount && row.imageCount !== count) || (row.receipt && row.receipt !== task.receipt)) throw fail('identity', 'Comfy 原结果与领取记录不符，未清理暂存');
    row = await save(job, { ...row, status: 'available', imageCount: count, receipt: task.resultStored ? task.receipt : row.receipt });
    const archived = await deliver(data, row.files, async records => {
      if (!Array.isArray(records) || records.length < row.files.length || records.length > count) throw fail('checkpoint', 'Comfy 原图检查点不完整');
      const files = records.map((record, imageIndex) => ({ imageIndex, url: record.url }));
      if (row.files.some((file, index) => file.url !== files[index].url)) throw fail('checkpoint', 'Comfy 已归档文件不可改写');
      row = await save(job, { ...row, files });
    }, () => guard(job));
    await guard(job);
    if (archived !== true) return { archived: false, warning: '原图已保留，请回原聊天完成归档' };
    row = await save(job, { ...row, status: 'archived' });
    return acknowledge(job, row);
  }
  return {
    async prepare(job) {
      // Called before provider submission. If local safety prerequisites fail,
      // no paid upstream request may have been made by this method.
      job = identity(job);
      try {
        const binding = await prepareComfySubmission(job, { account });
        if (typeof locks?.request !== 'function') throw fail('lock', '当前浏览器无法保护跨页归档，请使用支持页面锁的 HTTPS 浏览器');
        // IDB already serializes bounded journal writes; preparation must not
        // fail merely because a different completed image is being archived.
        await remember(job); return binding;
      }
      catch (error) { error.submissionState = 'not_submitted'; throw error; }
    },
    deliver(job, data, callback) { job = identity(job); return locked(job, async () => archive(job, await remember(job), data, callback), { wait: true }); },
    retrieve(job, { apiKey = '', deliver } = {}) {
      job = identity(job);
      return locked(job, async () => {
        const binding = await prepareComfySubmission(job, { account });
        const row = await remember(job);
        if (['archived','confirmed'].includes(row.status)) return acknowledge(job, row);
        const body = { ...binding, baseUrl: row.baseUrl };
        const query = await request(job, 'query', body, 64 * 1024);
        if (!query.task) return { archived: false, warning: '未找到原账户的 Comfy 任务记录，未重新生成' };
        if (query.task.live) return { archived: false, warning: '原 Comfy 任务仍在收片，请稍后领取' };
        if (!query.task.resultStored && (typeof apiKey !== 'string' || apiKey.length > 2048)) throw fail('credential', 'Comfy 原连接凭据无效，请核对原连接');
        // Cached ST results do not need the upstream credential or its network.
        const data = await request(job, 'result', { ...body, allowPrivateNetwork: row.allowPrivateNetwork,
          ...(!query.task.resultStored && apiKey ? { apiKey } : {}) }, 68 * 1024 * 1024);
        if (data.status !== 'ready') return { archived: false, warning: ({ queued: '原 Comfy 任务仍在排队', running: '原 Comfy 任务仍在生成', collecting: '原 Comfy 任务仍在收片', unavailable: '原任务历史暂不可读，请核查 Comfy；未重新生成' })[data.status] || '原图暂不可领取，未重新生成' };
        return archive(job, row, data, deliver);
      });
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); store.close(); },
  };
}
