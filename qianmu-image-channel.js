// Browser-wide NAI serialization. Only opaque key fingerprints and request
// identities are persisted; no API keys, prompts or image bytes enter this DB.
const DB_NAME = 'qianmu-image-channels';
const STORE = 'channels';
const PREFIX = 'qianmu:nai:';
const MAINTENANCE = 'qianmu:nai-maintenance';
const MAX_CHANNELS = 256;
const problem = (code, message) => Object.assign(new Error(message), { code: `image_channel_${code}`, submissionState: 'not_submitted' });
const identity = (value, label, max = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw problem('identity', `${label}不完整，未提交生图`);
  return value;
};

export async function imageChannelKey(apiKey) {
  const value = identity(String(apiKey || '').trim(), 'NAI 连接', 2048);
  if (!globalThis.crypto?.subtle) throw problem('unavailable', '当前环境无法安全协调 NAI 请求，请使用 HTTPS 或本机地址');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function readRecord(value, key) {
  if (value === undefined) return null;
  if (!value || value.version !== 1 || value.key !== key || !['reserved', 'submitting', 'uncertain'].includes(value.status)
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw problem('corrupt', 'NAI 请求协调记录不完整，请先核查渠道记录');
  return { version: 1, key, namespace: identity(value.namespace, 'ST 账户'), attemptId: identity(value.attemptId, '请求编号'),
    ownerId: identity(value.ownerId, '页面会话'), fence: identity(value.fence, '请求标识'), status: value.status, updatedAt: value.updatedAt };
}

export function createBrowserImageChannel({ locks = globalThis.navigator?.locks, indexedDB = globalThis.indexedDB,
  dbName = DB_NAME, timeoutMs = 6000, queueTimeoutMs = 10 * 60_000, ownerId = globalThis.crypto?.randomUUID?.(), now = Date.now } = {}) {
  let db = null, opening = null, closed = false;
  const pending = new Set(), transactions = new Set();
  const timeout = Math.max(100, Math.min(15000, Number(timeoutMs) || 6000));
  const assertOpen = () => { if (closed) throw problem('closed', 'NAI 生图会话已结束'); };
  const ensureOpen = () => {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    const operation = new Promise((resolve, reject) => {
      let request, finished = false;
      const done = (error, connection) => {
        if (finished) { connection?.close(); return; }
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(connection);
      };
      const timer = setTimeout(() => done(problem('storage', 'NAI 请求记录读取超时，未提交生图')), timeout);
      try { request = indexedDB.open(dbName, 1); } catch (_) { done(problem('storage', 'NAI 请求记录暂不可用，未提交生图')); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onerror = () => done(problem('storage', 'NAI 请求记录暂不可用，未提交生图'));
      request.onblocked = () => done(problem('storage', '请关闭其它旧版千幕页面后重试'));
      request.onsuccess = () => {
        const connection = request.result;
        if (finished || closed) { connection.close(); done(problem('closed', 'NAI 生图会话已结束')); return; }
        db = connection;
        const release = () => { if (db === connection) db = null; opening = null; };
        connection.onversionchange = () => { connection.close(); release(); }; connection.onclose = release;
        done(null, connection);
      };
    });
    opening = operation;
    void operation.catch(() => { if (opening === operation) opening = null; });
    return operation;
  };

  async function transact(mode, work) {
    const connection = await ensureOpen(); assertOpen();
    return new Promise((resolve, reject) => {
      let tx, result, failure, finished = false;
      const done = error => {
        if (finished) return; finished = true; clearTimeout(timer); transactions.delete(tx);
        if (error) reject(error); else resolve(result);
      };
      const abort = error => {
        failure = typeof error?.code === 'string' && error.code.startsWith('image_channel_') ? error : problem('storage', 'NAI 请求记录未能保存，请先核查渠道记录');
        if (!tx) { done(failure); return; }
        try { tx.abort(); } catch (_) { done(failure); }
      };
      const timer = setTimeout(() => { abort(problem('storage', 'NAI 请求记录保存超时，请先核查渠道记录')); done(failure); }, timeout);
      try {
        tx = connection.transaction(STORE, mode); transactions.add(tx);
        tx.oncomplete = () => done(); tx.onabort = () => done(failure || problem('storage', 'NAI 请求记录未能保存'));
        tx.onerror = () => { failure ||= problem('storage', 'NAI 请求记录未能保存'); };
        work(tx.objectStore(STORE), value => { result = value; }, abort);
      } catch (error) { abort(error); }
    });
  }

  const change = (key, reducer) => transact('readwrite', (store, output, abort) => {
    const get = store.get(key);
    get.onsuccess = () => {
      try {
        const previous = readRecord(get.result, key), next = reducer(previous);
        if (next === undefined) { output(previous); return; }
        if (next === null) { store.delete(key); output(null); return; }
        const validated = readRecord(next, key);
        if (!previous) {
          const count = store.count(); count.onsuccess = () => {
            try { if (count.result >= MAX_CHANNELS) throw problem('full', 'NAI 待核查连接记录已满，请先整理'); store.put(validated, key); output(validated); }
            catch (error) { abort(error); }
          };
        } else { store.put(validated, key); output(validated); }
      } catch (error) { abort(error); }
    };
  });

  const checkLocks = () => { if (typeof locks?.request !== 'function') throw problem('unavailable', '当前浏览器不支持 NAI 跨页顺序生成，请使用支持此功能的浏览器'); };
  return {
    async run({ apiKey, namespace, attemptId, automatic = false, confirmedAttempts = [], valid = () => true, confirm = async () => false, onAcquired = () => {}, onWarning = () => {} }, operation) {
      assertOpen(); checkLocks();
      identity(namespace, 'ST 账户'); identity(attemptId, '请求编号'); identity(ownerId, '页面会话');
      if (!Array.isArray(confirmedAttempts) || confirmedAttempts.length > 256) throw problem('identity', '原请求确认记录无效，未提交生图');
      // Capture consent before the first await; changing UI state while queued
      // cannot silently authorize a different uncertain request.
      const confirmed = new Set(confirmedAttempts.map(value => identity(value, '原请求编号')));
      if (pending.size >= 8) throw problem('queue_full', 'NAI 等待请求已满，请稍后重试');
      const controller = new AbortController(); pending.add(controller);
      const check = () => { assertOpen(); if (!valid()) throw problem('cancelled', 'NAI 生图设置已变化，未继续提交'); };
      const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(10 * 60_000, Number(queueTimeoutMs) || 10 * 60_000)));
      let acquired = false;
      try {
        const key = await imageChannelKey(apiKey); check();
        return await locks.request(MAINTENANCE, { mode: 'shared', signal: controller.signal }, () => locks.request(`${PREFIX}${key}`, { mode: 'exclusive', signal: controller.signal }, async () => {
          acquired = true; clearTimeout(timer); check();
          // Reaching this callback proves there is no live holder. A leftover
          // submitting record therefore remains uncertain after a page crash.
          const previous = await change(key, () => undefined); check();
          if (previous && previous.status !== 'reserved') {
            const alreadyConfirmed = previous.namespace === namespace && confirmed.has(previous.attemptId);
            if (automatic || (!alreadyConfirmed && !await confirm('核对 NAI 原请求', '此连接有结果未确认的请求。请先核对渠道任务或账单；继续将发起新的生图请求。'))) {
              throw problem('uncertain', 'NAI 原请求结果未确认，已暂停此连接的后续自动生图');
            }
            check();
          }
          const fence = globalThis.crypto.randomUUID();
          await change(key, current => {
            if ((current?.fence || '') !== (previous?.fence || '')) throw problem('changed', 'NAI 请求记录已变化，请重新核对');
            return { version: 1, key, namespace, attemptId, ownerId, fence, status: 'reserved', updatedAt: now() };
          });
          let submitted = false, succeeded = false, failure;
          const owned = current => { if (!current || current.fence !== fence || current.ownerId !== ownerId) throw problem('changed', 'NAI 原请求授权已变化，未继续提交'); return current; };
          try {
            check(); await onAcquired(); check();
            const output = await operation({
              async beforeSubmit() {
                check();
                await change(key, current => ({ ...owned(current), status: 'submitting', updatedAt: now() }));
                check(); submitted = true;
              },
            });
            succeeded = true; return output;
          } catch (error) { failure = error; throw error; }
          finally {
            const uncertain = submitted && !succeeded && !['not_submitted', 'rejected'].includes(failure?.submissionState);
            try { await change(key, current => { owned(current); return uncertain ? { ...current, status: 'uncertain', updatedAt: now() } : null; }); }
            catch (error) {
              // Do not replace a successful image with a storage error. The
              // surviving submitting fence will require confirmation next time.
              if (!succeeded && !failure) throw error;
              if (submitted) { try { onWarning(); } catch (_) {} }
            }
          }
        }));
      } catch (error) {
        if (!acquired && error?.name === 'AbortError') throw problem('cancelled', closed ? 'NAI 生图会话已结束' : 'NAI 等待已取消或超时，未提交生图');
        if (!acquired && ['SecurityError', 'InvalidStateError', 'NotSupportedError'].includes(error?.name)) throw problem('unavailable', '当前页面无法使用 NAI 跨页协调，请检查浏览器权限或刷新后重试');
        throw error;
      } finally { clearTimeout(timer); pending.delete(controller); }
    },
    async confirmResult({ namespace, attemptId, channelKey, valid = () => true }) {
      identity(namespace, 'ST 账户'); identity(attemptId, '原请求编号'); assertOpen(); checkLocks();
      if (!/^[a-f0-9]{64}$/.test(channelKey || '')) throw problem('identity', '原连接指纹无效');
      return locks.request(MAINTENANCE, { mode: 'shared', ifAvailable: true }, maintenance => {
        if (!maintenance) throw problem('busy', 'NAI 记录正在维护');
        return locks.request(`${PREFIX}${channelKey}`, { mode: 'exclusive', ifAvailable: true }, lock => {
          if (!lock) throw problem('busy', 'NAI 连接仍在使用，暂缓同步原结果');
          return change(channelKey, current => {
            if (!valid()) throw problem('cancelled', '原图账户已变化');
            return current?.namespace === namespace && current.attemptId === attemptId ? null : undefined;
          });
        });
      });
    },
    async manage(namespace, { remove = false } = {}) {
      identity(namespace, 'ST 账户'); assertOpen();
      const scan = () => transact(remove ? 'readwrite' : 'readonly', (store, output, abort) => {
        const totals = { bytes: 0, count: 0, pending: 0, uncertain: 0 };
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          try {
            const item = cursor.result;
            if (!item) { output(totals); return; }
            if (item.value?.namespace === namespace) {
              totals.count++; totals.bytes += new TextEncoder().encode(JSON.stringify(item.value)).byteLength;
              if (item.value.status === 'uncertain') totals.uncertain++; else totals.pending++;
              if (remove) item.delete();
            }
            item.continue();
          } catch (error) { abort(error); }
        };
      });
      if (!remove) return scan();
      checkLocks();
      return locks.request(MAINTENANCE, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) throw problem('busy', '仍有等待或生成中的 NAI 画面，请结束后再清理连接记录');
        return scan();
      });
    },
    close() {
      closed = true; for (const controller of pending) controller.abort();
      for (const tx of transactions) { try { tx.abort(); } catch (_) {} }
      db?.close(); db = null; opening = null;
    },
  };
}
