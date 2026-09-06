// Lazy, bounded delivery journal. Never stores a workflow, prompt, image or Key.
const fail = message => Object.assign(new Error(message), { code: 'comfy_delivery_storage', submissionState: 'unknown' });
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const states = ['prepared', 'available', 'archived', 'confirmed'];
export function normalizeComfyDelivery(value, origin = globalThis.location?.origin) {
  if (![1, 2].includes(value?.version) || (value.version === 2 && (value.originalOnly !== true || value.taskLocator?.version !== 1 || !/^[a-f0-9]{64}$/.test(value.taskLocator.channelKey || '')))
    || (value.version === 1 && value.originalOnly === true) || !text(value.namespace, 512) || !/^st-user:.+/.test(value.namespace)
    || !/^[a-zA-Z0-9_-]{1,240}$/.test(value.attemptId || '') || !states.includes(value.status)) throw fail('Comfy 领取记录不完整，请核查原任务');
  let root;
  if (value.version === 1 || value.baseUrl) {
    try { root = new URL(value.baseUrl); } catch (_) { throw fail('Comfy 原连接地址无效'); }
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash || !text(root.href, 2048)) throw fail('Comfy 原连接地址无效');
  }
  if (!text(value.credentialId || '', 240) || !text(value.logId || '', 240) || !text(value.chatKey || '', 4096)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isInteger(value.imageCount) || value.imageCount < 0 || value.imageCount > 8
    || (value.receipt && !/^[a-f0-9]{64}$/.test(value.receipt))) throw fail('Comfy 领取记录无效');
  if (!Array.isArray(value.files) || value.files.length > value.imageCount) throw fail('Comfy 原图检查点数量不符');
  const files = value.files.map((file, index) => {
    let url;
    try { url = new URL(file.url, origin); } catch (_) { throw fail('Comfy 原图保存位置无效'); }
    if (file.imageIndex !== index || !text(file.url, 4096) || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || url.hash || url.search) throw fail('Comfy 原图必须先保存至当前 ST');
    return { imageIndex: index, url: file.url };
  });
  if (['archived', 'confirmed'].includes(value.status) && (!value.imageCount || files.length !== value.imageCount)) throw fail('Comfy 归档检查点未完成');
  const row = { version: value.version, ...(value.version === 2 ? { originalOnly: true, taskLocator: { version: 1, channelKey: value.taskLocator.channelKey } } : {}),
    namespace: value.namespace, attemptId: value.attemptId, baseUrl: root ? root.href.replace(/\/+$/, '') : '',
    allowPrivateNetwork: value.allowPrivateNetwork === true, credentialId: value.credentialId || '', logId: value.logId || '', chatKey: value.chatKey || '',
    automatic: value.automatic === true, createdAt: value.createdAt, status: value.status, receipt: value.receipt || '', imageCount: value.imageCount, files };
  if (bytes(row) > 40 * 1024) throw fail('Comfy 领取记录过大');
  return row;
}

export function createComfyDeliveryStore({ indexedDB = globalThis.indexedDB, origin = globalThis.location?.origin,
  dbName = 'qianmu-comfy-deliveries-v1', timeoutMs = 6000 } = {}) {
  let db, opening, closed = false;
  const active = new Set(), limit = Math.min(10000, Math.max(100, Number(timeoutMs) || 6000));
  const open = () => {
    if (closed) return Promise.reject(fail('Comfy 领取会话已结束'));
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let done = false, request;
      const finish = (error, connection) => { if (done) { connection?.close(); return; } done = true; clearTimeout(timer); error ? reject(error) : resolve(connection); };
      const timer = setTimeout(() => finish(fail('Comfy 领取存储读取超时')), limit);
      try { request = indexedDB.open(dbName, 1); } catch (_) { finish(fail('无法保存 Comfy 领取记录，未继续提交')); return; }
      request.onupgradeneeded = () => {
        request.result.createObjectStore('tasks').createIndex('namespace', 'namespace');
        request.result.createObjectStore('usage');
      };
      request.onerror = request.onblocked = () => finish(fail('Comfy 领取存储不可用，请关闭旧页面后重试'));
      request.onsuccess = () => {
        const connection = request.result;
        if (done || closed) { connection.close(); finish(fail('Comfy 领取会话已结束')); return; }
        db = connection;
        connection.onversionchange = () => { connection.close(); db = opening = null; };
        connection.onclose = () => { if (db === connection) db = opening = null; };
        finish(null, connection);
      };
    });
    void opening.catch(() => { opening = null; });
    return opening;
  };
  async function transaction(namespace, attemptId, value, remove = false, usageOnly = false) {
    if (!text(namespace, 512) || !/^st-user:.+/.test(namespace) || (attemptId !== undefined && !/^[a-zA-Z0-9_-]{1,240}$/.test(attemptId))) throw fail('Comfy 领取身份无效');
    const captured = value ? normalizeComfyDelivery(value, origin) : null;
    const connection = await open();
    return new Promise((resolve, reject) => {
      let tx, error, output, done = false;
      const finish = cause => { if (done) return; done = true; clearTimeout(timer); active.delete(tx); cause ? reject(cause) : resolve(output); };
      const abort = cause => { error = cause; try { tx?.abort(); } catch (_) { finish(cause); } };
      const timer = setTimeout(() => { abort(fail('Comfy 领取记录保存超时')); finish(error); }, limit);
      try {
        if (closed) throw fail('Comfy 领取会话已结束');
        tx = connection.transaction(['tasks', 'usage'], captured ? 'readwrite' : 'readonly'); active.add(tx);
        tx.oncomplete = () => finish(); tx.onabort = () => finish(error || fail('Comfy 领取记录未保存'));
        tx.onerror = () => { error ||= fail('Comfy 领取存储不可用'); };
        const tasks = tx.objectStore('tasks');
        if (usageOnly) {
          const request = tx.objectStore('usage').get(namespace);
          request.onsuccess = () => { try {
            if (request.result !== undefined) {
              const value = request.result;
              if (!Number.isInteger(value.count) || value.count < 0 || value.count > 2048 || !Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > 16 * 1024 * 1024
                || Boolean(value.count) !== Boolean(value.bytes)) throw fail('Comfy 存储计值异常');
              output = { count: value.count, bytes: value.bytes }; return;
            }
            const count = tasks.index('namespace').count(namespace);
            count.onsuccess = () => { if (count.result) { abort(fail('Comfy 存储计值缺失，请核查')); return; } output = { count: 0, bytes: 0 }; };
          } catch (cause) { abort(cause); } };
          return;
        }
        if (attemptId === undefined) {
          output = [];
          const request = tasks.index('namespace').openCursor(namespace);
          request.onsuccess = () => { try {
            const cursor = request.result; if (!cursor) return;
            if (output.length >= 2048) throw fail('Comfy 领取记录超限，请核查');
            output.push(normalizeComfyDelivery(cursor.value, origin)); cursor.continue();
          } catch (cause) { abort(cause); } };
          return;
        }
        const key = JSON.stringify([namespace, attemptId]), request = tasks.get(key);
        request.onsuccess = () => { try {
          const raw = request.result, previous = raw === undefined ? null : normalizeComfyDelivery(raw, origin);
          if (previous && (previous.namespace !== namespace || previous.attemptId !== attemptId)) throw fail('Comfy 存储身份不符');
          if (!captured) { output = previous; return; }
          if (remove && !previous) { output = false; return; }
          if (remove && JSON.stringify(previous) !== JSON.stringify(captured)) throw fail('Comfy 领取记录已变化，请重新选择清理');
          if (previous && ((previous.version === 2 && (captured.version !== 2 || previous.taskLocator.channelKey !== captured.taskLocator.channelKey))
            || ['baseUrl','credentialId','allowPrivateNetwork','chatKey','automatic'].some(name => previous[name] !== captured[name])
            || states.indexOf(captured.status) < states.indexOf(previous.status)
            || previous.files.some((file, index) => captured.files[index]?.url !== file.url)
            || (previous.imageCount && previous.imageCount !== captured.imageCount)
            || (previous.receipt && previous.receipt !== captured.receipt))) throw fail('Comfy 原领取记录不可改写');
          const usageStore = tx.objectStore('usage'), usageRequest = usageStore.get(namespace);
          usageRequest.onsuccess = () => { try {
            const write = usage => {
              if (!Number.isInteger(usage.count) || usage.count < 0 || !Number.isInteger(usage.bytes) || usage.bytes < 0 || (previous && !usage.count)) throw fail('Comfy 存储计值异常');
              const next = { count: usage.count + (remove ? -1 : previous ? 0 : 1), bytes: usage.bytes - (previous ? bytes(raw) : 0) + (remove ? 0 : bytes(captured)) };
              if (next.count > 2048 || next.bytes > 16 * 1024 * 1024 || next.bytes < 0) throw fail('Comfy 领取记录已满，请先整理，不会自动删除原任务');
              if (remove) tasks.delete(key); else tasks.put(captured, key);
              usageStore.put(next, namespace); output = remove ? true : captured;
            };
            if (usageRequest.result !== undefined) { write(usageRequest.result); return; }
            const count = tasks.index('namespace').count(namespace);
            count.onsuccess = () => { try { if (count.result) throw fail('Comfy 存储计值缺失，请核查'); write({ count: 0, bytes: 0 }); } catch (cause) { abort(cause); } };
          } catch (cause) { abort(cause); } };
        } catch (cause) { abort(cause); } };
      } catch (cause) { abort(cause); finish(cause); }
    });
  }
  return { get: (namespace, attemptId) => transaction(namespace, attemptId), list: namespace => transaction(namespace),
    put: value => transaction(value.namespace, value.attemptId, value),
    usage: namespace => transaction(namespace, undefined, undefined, false, true),
    remove: value => transaction(value.namespace, value.attemptId, value, true),
    close() { closed = true; for (const tx of active) { try { tx.abort(); } catch (_) {} } db?.close(); db = null; },
  };
}
