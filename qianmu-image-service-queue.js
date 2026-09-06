// Server-only queue contract. A durable, atomic transaction port is mandatory:
// never substitute an in-memory ledger when persistence is unavailable.
import { createHash, randomUUID } from 'node:crypto';

export const IMAGE_SERVICE_QUEUE_VERSION = 1;
const SCHEMA = 'qianmu.image-service-channel.v1';
const STATES = new Set(['reserved', 'submitting', 'uncertain', 'acknowledged', 'succeeded', 'rejected', 'released']);
const PENDING = new Set(['reserved', 'submitting']);
const TERMINAL = new Set(['acknowledged', 'succeeded', 'rejected', 'released']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, extra = {}) => Object.assign(new Error(message), {
  name: 'ImageServiceQueueError', code: `image_service_${code}`, status: 409,
  submissionState: 'not_submitted', ...extra,
});
function id(value, name, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail('identity', `${name}不完整，未提交生图`, { status: 400 });
  return value;
}
function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fail('identity', '生图请求指纹无效', { status: 400 });
  return value;
}
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('state', '生图服务记录时间无效');
  return value;
}
export function imageServiceChannelKey(apiKey) { return hash(id(apiKey?.trim?.(), 'NAI 连接', 2048)); }

// Call with a locally validated provider request, never with a client-supplied
// digest. The channel key already identifies credentials; secrets are excluded.
export function describeImageServiceRequest(request) {
  const seen = new Set(), fingerprint = createHash('sha256'); let nodes = 0, bytes = 0;
  const emit = value => {
    bytes += Buffer.byteLength(value); if (bytes > 80 * 1024 * 1024) throw fail('request', '生图请求内容过大', { status: 400 });
    fingerprint.update(value);
  };
  const encode = (value, depth = 0) => {
    if (++nodes > 50_000 || depth > 40) throw fail('request', '生图请求结构过大', { status: 400 });
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return emit(JSON.stringify(value));
    if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw fail('request', '生图请求结构无效', { status: 400 });
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(item => item.get || item.set)) throw fail('request', '生图请求不能包含动态属性', { status: 400 });
    if (Array.isArray(value)) {
      emit('[');
      for (let index = 0; index < value.length; index++) { if (index) emit(','); encode(value[index], depth + 1); }
      emit(']');
    } else {
      const keys = Object.keys(value).filter(key => value[key] !== undefined && !(depth === 0 && /^(?:apiKey|signal|serviceQueue)$/i.test(key))).sort();
      emit('{');
      keys.forEach((key, index) => { if (index) emit(','); emit(`${JSON.stringify(key)}:`); encode(value[key], depth + 1); });
      emit('}');
    }
    seen.delete(value);
  };
  encode(request); return { requestDigest: fingerprint.digest('hex'), requestBytes: bytes };
}
export function imageServiceRequestDigest(request) { return describeImageServiceRequest(request).requestDigest; }

export function normalizeImageServiceChannel(value, channelKey, maxEntries = 4096) {
  digest(channelKey);
  if (value === undefined || value === null) return { schema: SCHEMA, channelKey, entries: [] };
  if (value?.schema !== SCHEMA || value.channelKey !== channelKey || !Array.isArray(value.entries) || value.entries.length > maxEntries) throw fail('state', '生图服务记录不完整，请先核查原请求');
  const seen = new Set();
  const entries = value.entries.map(raw => {
    if (!raw || !STATES.has(raw.status) || typeof raw.automatic !== 'boolean') throw fail('state', '生图服务请求状态无效');
    const row = {
      namespace: id(raw.namespace, 'ST 账户'), attemptId: id(raw.attemptId, '请求编号'), requestDigest: digest(raw.requestDigest),
      ownerId: id(raw.ownerId, '服务会话'), fence: id(raw.fence, '服务请求票'), status: raw.status,
      automatic: raw.automatic, createdAt: time(raw.createdAt), updatedAt: time(raw.updatedAt),
    };
    const identity = JSON.stringify([row.namespace, row.attemptId]);
    if (seen.has(identity) || row.updatedAt < row.createdAt) throw fail('state', '生图服务请求身份或时间重复');
    seen.add(identity); return row;
  });
  if (entries.filter(row => PENDING.has(row.status)).length > 1) throw fail('state', '生图服务有冲突的在途请求，请先核查');
  return { schema: SCHEMA, channelKey, entries };
}

// Store.transaction(key, reducer) must commit reducer(...).state atomically
// before returning reducer(...).result. A failure must never grant authorization;
// disk failure after an atomic rename may leave a committed, conservatively fenced
// record. Callers must not assume a rejected transaction means nothing was saved.
export function createImageServiceQueue({ store, ownerId = randomUUID(), now = Date.now,
  maxPending = 32, maxActive = 2, maxPendingBytes = 128 * 1024 * 1024, maxEntries = 4096, waitTimeoutMs = 10 * 60_000 } = {}) {
  if (typeof store?.transaction !== 'function') throw fail('storage', '增强服务缺少持久请求记录，未启用服务端生图');
  id(ownerId, '服务会话');
  const capacity = Math.max(1, Math.min(32, Math.trunc(Number(maxPending) || 32)));
  const activeLimit = Math.max(1, Math.min(8, Math.trunc(Number(maxActive) || 2)));
  const byteLimit = Math.max(1, Math.min(128 * 1024 * 1024, Math.trunc(Number(maxPendingBytes) || 128 * 1024 * 1024)));
  const entryLimit = Math.max(1, Math.min(4096, Math.trunc(Number(maxEntries) || 4096)));
  const deadline = Math.max(100, Math.min(10 * 60_000, Number(waitTimeoutMs) || 10 * 60_000));
  const channels = new Map(); let pending = 0, active = 0, pendingBytes = 0, closed = false;
  const check = (valid, signal) => {
    if (closed || signal?.aborted || !valid()) throw fail('cancelled', '生图等待已取消，未继续提交');
  };
  const transact = (key, reduce) => store.transaction(key, value => {
    const state = normalizeImageServiceChannel(value, key, entryLimit);
    const result = reduce(state, time(now()));
    return { state: normalizeImageServiceChannel(state, key, entryLimit), result };
  });
  const owned = (state, identity, fence) => {
    const row = state.entries.find(item => item.namespace === identity.namespace && item.attemptId === identity.attemptId);
    if (!row || row.fence !== fence || row.ownerId !== ownerId) throw fail('changed', '原服务请求授权已变化');
    return row;
  };
  async function execute(input, operation) {
    const { channelKey: key, valid, signal, identity } = input;
    check(valid, signal);
    const fence = randomUUID();
    await transact(key, (state, at) => {
      const previous = state.entries.find(row => row.namespace === identity.namespace && row.attemptId === identity.attemptId);
      if (previous) {
        if (previous.requestDigest !== identity.requestDigest) throw fail('conflict', '同一请求编号对应的生图配置已变化，未重新提交');
        throw fail(TERMINAL.has(previous.status) ? 'already_finished' : 'already_submitted', '此请求已经存在，请查看原任务而非重复提交');
      }
      // A new service session cannot infer whether an older process is dead.
      // Only the persistent store's recovery procedure may mark old work uncertain.
      if (state.entries.some(row => PENDING.has(row.status))) throw fail('busy', '此 NAI 连接仍有在途请求，请查看原任务');
      const uncertain = state.entries.filter(row => row.status === 'uncertain');
      const confirmation = uncertain.length ? hash(JSON.stringify(uncertain.map(row => JSON.stringify([row.namespace, row.attemptId, row.fence, row.updatedAt])).sort())) : '';
      if (confirmation && (identity.automatic || input.confirmation !== confirmation)) {
        throw fail('confirmation_required', '此连接有结果未确认的原请求，请核对后手动继续', { confirmation });
      }
      if (state.entries.length >= entryLimit) throw fail('full', '生图服务记录已满，请先导出或整理');
      // Confirmation authorizes this new request, not a historical replay. Old
      // uncertain rows remain historical evidence rather than becoming free jobs.
      for (const row of uncertain) { row.status = 'acknowledged'; row.updatedAt = at; }
      state.entries.push({ ...identity, ownerId, fence, status: 'reserved', createdAt: at, updatedAt: at });
    });
    let submitted = false, finished = false, failure;
    try {
      check(valid, signal);
      const result = await operation({
        async beforeSubmit() {
          check(valid, signal);
          await transact(key, (state, at) => {
            const row = owned(state, identity, fence);
            if (!['reserved', 'submitting'].includes(row.status)) throw fail('changed', '原服务请求不允许再次提交');
            row.status = 'submitting'; row.updatedAt = at;
          });
          check(valid, signal); submitted = true;
        },
      });
      finished = true; return result;
    } catch (error) { failure = error; throw error; }
    finally {
      const status = finished ? 'succeeded' : !submitted || failure?.submissionState === 'not_submitted' ? 'released'
        : failure?.submissionState === 'rejected' ? 'rejected' : 'uncertain';
      try { await transact(key, (state, at) => {
        const row = owned(state, identity, fence);
        if (!['reserved', 'submitting'].includes(row.status)) throw fail('changed', '原服务请求已结算，未覆盖其状态');
        row.status = status; row.updatedAt = at;
      }); }
      catch (_) {
        // A completed image must not turn into a failed generation because the
        // bookkeeping write failed. Persistent submitting state fences the next job.
        try { input.onWarning(); } catch (_) {}
      }
    }
  }
  const advance = key => {
    const queue = channels.get(key);
    if (!queue || queue.active || active >= activeLimit) return;
    const item = queue.items.shift();
    if (!item) { channels.delete(key); return; }
    active++; queue.active = true; item.started = true; clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.cancel);
    const settle = () => {
      pending--; active--; pendingBytes -= item.bytes; queue.active = false;
      channels.delete(key); if (queue.items.length) channels.set(key, queue);
      schedule();
    };
    void execute(item.input, item.operation).then(
      result => { settle(); item.resolve(result); },
      error => { settle(); item.reject(error); },
    );
  };
  const schedule = () => { for (const key of channels.keys()) { if (active >= activeLimit) break; advance(key); } };
  return {
    run({ apiKey, namespace, attemptId, requestDigest, requestBytes, automatic = false, confirmation = '', valid = () => true, signal, onWarning = () => {} }, operation) {
      try {
        check(valid, signal);
        const channelKey = imageServiceChannelKey(apiKey);
        const identity = { namespace: id(namespace, 'ST 账户'), attemptId: id(attemptId, '请求编号'), requestDigest: digest(requestDigest), automatic: Boolean(automatic) };
        if (!Number.isSafeInteger(requestBytes) || requestBytes < 1 || requestBytes > 80 * 1024 * 1024) throw fail('request', '生图服务缺少有效的请求大小，未提交生图', { status: 400 });
        if (confirmation !== '') digest(confirmation);
        if (typeof operation !== 'function') throw fail('request', '缺少生图执行操作');
        if (pending >= capacity) throw fail('queue_full', '增强服务等待队列已满，请稍后重试', { status: 429 });
        if (pendingBytes + requestBytes > byteLimit) throw fail('queue_size', '增强服务正在处理较大的画面素材，请稍后重试', { status: 429 });
        const input = { channelKey, identity, confirmation, valid, signal, onWarning };
        return new Promise((resolve, reject) => {
          const queue = channels.get(channelKey) || { active: false, items: [] };
          channels.set(channelKey, queue); pending++; pendingBytes += requestBytes;
          const item = { input, operation, resolve, reject, signal, bytes: requestBytes, started: false };
          item.cancel = () => {
            if (item.started) return;
            const index = queue.items.indexOf(item); if (index < 0) return;
            queue.items.splice(index, 1); pending--; pendingBytes -= item.bytes; clearTimeout(item.timer); signal?.removeEventListener('abort', item.cancel);
            reject(fail('cancelled', closed ? '增强服务正在关闭，未提交等待任务' : '增强服务等待已取消或超时，未提交生图'));
            if (!queue.active && !queue.items.length) channels.delete(channelKey);
          };
          item.timer = setTimeout(item.cancel, deadline); signal?.addEventListener('abort', item.cancel, { once: true });
          queue.items.push(item); schedule();
        });
      } catch (error) { return Promise.reject(error); }
    },
    close() {
      closed = true;
      for (const queue of channels.values()) for (const item of [...queue.items]) item.cancel();
      // Already submitted callbacks retain their queue slot until they settle.
      // Closing is not evidence that an upstream request stopped or was refunded.
    },
    inspect() { return { closed, pending, active, pendingBytes }; },
  };
}
