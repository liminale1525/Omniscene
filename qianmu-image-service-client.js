// Optional service transport. Loading this module does not open storage or probe.
import { imageChannelKey } from './qianmu-image-channel.js';
import { resolveImageAccountNamespace } from './qianmu-image-admission.js';
import { sanitizeStoryboardSnapshot, sanitizeStoryboardDiagnosticData } from './qianmu-storyboard.js';

const BASE = '/api/plugins/qianmu-tts/image/tasks';
const fail = (code, message, state = 'not_submitted') => Object.assign(new Error(message), { code: `image_service_client_${code}`, submissionState: state, retryable: false });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const states = new Set(['prepared', 'submitted', 'available', 'archived', 'rejected']);
function checkedRow(value, namespace) {
  if (!value || ![1,2].includes(value.version) || (value.version === 2 && value.originalOnly !== true) || value.namespace !== namespace || !id(value.attemptId) || !/^[a-f0-9]{64}$/.test(value.channelKey || '') || !states.has(value.status)) throw fail('record', '服务请求记录不完整或版本不兼容，请核查原任务');
  // Version 2 is intentionally unreadable by pre-recovery clients. Otherwise a
  // rollback could normalize the absent recipe into invented model defaults.
  const row = { version: value.originalOnly === true ? 2 : 1, namespace, attemptId: value.attemptId, channelKey: value.channelKey, status: value.status, originalOnly: value.originalOnly === true,
    createdAt: Number(value.createdAt) || 0, logId: id(value.logId) ? value.logId : '',
    snapshot: sanitizeStoryboardSnapshot(value.snapshot, { source: 'novel' }),
    receipt: /^[a-f0-9]{64}$/.test(value.receipt || '') ? value.receipt : '',
    archiveRecords: Array.isArray(value.archiveRecords) ? value.archiveRecords.slice(0,8).map(record => ({ ...sanitizeStoryboardDiagnosticData(record),
      ...(record?.snapshot ? { snapshot: sanitizeStoryboardSnapshot(record.snapshot, { source: 'novel' }) } : {}),
    })) : [],
  };
  if (new TextEncoder().encode(JSON.stringify(row)).length > 256 * 1024) throw fail('size', '服务请求快照过大，未提交');
  return row;
}

export function createImageServiceClientStore({ indexedDB = globalThis.indexedDB, dbName = 'qianmu-image-service-client', timeoutMs = 6000 } = {}) {
  let db, opening, closed = false;
  const open = () => {
    if (closed) return Promise.reject(fail('closed', '服务请求会话已结束'));
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request, done = false;
      const finish = (error, connection) => { if (done) { connection?.close(); return; } done = true; clearTimeout(timer); error ? reject(error) : resolve(connection); };
      const timer = setTimeout(() => finish(fail('storage', '服务请求存储读取超时，未继续提交')), timeoutMs);
      try { request = indexedDB.open(dbName, 1); } catch (_) { finish(fail('storage', '无法保存服务请求，未提交')); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('tasks')) request.result.createObjectStore('tasks').createIndex('namespace', 'namespace', { unique: false });
      };
      request.onerror = request.onblocked = () => finish(fail('storage', '服务请求存储不可用，请关闭旧页面后重试'));
      request.onsuccess = () => {
        const connection = request.result;
        if (done || closed) { connection.close(); finish(fail('closed', '服务请求会话已结束')); return; }
        db = connection;
        connection.onversionchange = () => { connection.close(); db = opening = null; };
        connection.onclose = () => { db = opening = null; };
        finish(null, connection);
      };
    });
    void opening.catch(() => { opening = null; });
    return opening;
  };
  async function transaction(namespace, mutate, attemptId, row) {
    if (!id(namespace) || (attemptId !== undefined && !id(attemptId))) throw fail('identity', '服务请求身份无效');
    const connection = await open();
    return new Promise((resolve, reject) => {
      let tx, output, error, finished = false;
      const done = cause => { if (finished) return; finished = true; clearTimeout(timer); cause ? reject(cause) : resolve(output); };
      const abort = cause => { error = cause; try { tx?.abort(); } catch (_) { done(error); } };
      const timer = setTimeout(() => { abort(fail('storage', '服务请求记录写入超时，请勿重复提交')); done(error); }, timeoutMs);
      try {
        if (closed) throw fail('closed', '服务请求会话已结束');
        tx = connection.transaction('tasks', mutate ? 'readwrite' : 'readonly');
        tx.oncomplete = () => done(); tx.onabort = () => done(error || fail('storage', '服务请求记录未保存'));
        tx.onerror = () => { error ||= fail('storage', '服务请求存储不可用'); };
        const target = tx.objectStore('tasks');
        if (attemptId === undefined) {
          output = [];
          const cursor = target.index('namespace').openCursor(namespace);
          cursor.onsuccess = () => {
            try {
              const current = cursor.result; if (!current) return;
              if (output.length >= 128) throw fail('storage', '服务请求记录需要核查');
              output.push(checkedRow(current.value, namespace)); current.continue();
            } catch (cause) { abort(cause); }
          };
          return;
        }
        const key = JSON.stringify([namespace, attemptId]), request = target.get(key);
        request.onsuccess = () => {
          try {
            const previous = request.result === undefined ? null : checkedRow(request.result, namespace);
            if (previous && previous.attemptId !== attemptId) throw fail('record', '服务请求编号与存储键不符');
            if (!mutate) { output = previous; return; }
            if (row === null) { target.delete(key); output = null; return; }
            const captured = checkedRow(row, namespace);
            if (previous) { target.put(captured, key); output = captured; return; }
            const count = target.index('namespace').count(namespace);
            count.onsuccess = () => {
              if (count.result >= 128) { abort(fail('full', '待领取服务记录已满，请先归档或整理')); return; }
              target.put(captured, key); output = captured;
            };
          } catch (cause) { abort(cause); }
        };
      } catch (cause) { abort(cause); done(cause); }
    });
  }
  return { list: namespace => transaction(namespace, false), get: (namespace, attemptId) => transaction(namespace, false, attemptId),
    put: row => transaction(row.namespace, true, row.attemptId, checkedRow(row, row.namespace)),
    remove: (namespace, attemptId) => transaction(namespace, true, attemptId, null),
    close() { closed = true; db?.close(); db = null; },
  };
}

export function createImageServiceClient({ store = createImageServiceClientStore(), account = resolveImageAccountNamespace,
  fetchImpl = globalThis.fetch, headers = () => ({}), locks = globalThis.navigator?.locks, confirm = async () => false } = {}) {
  let closed = false;
  const assertAccount = async namespace => {
    if (closed || await account() !== namespace || closed) throw fail('account', '服务会话或 ST 账户已变化，未继续操作', 'unknown');
  };
  async function call(action, body, timeoutMs = 15000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${BASE}/${action}`, { method: action === 'capabilities' ? 'GET' : 'POST',
        headers: headers(), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const error = fail('response', action === 'capabilities' ? '增强服务未就绪，请更新后端并重启 ST'
          : action === 'catalog' && (!data || [404,405].includes(response.status)) ? '服务目录未就绪，请更新后端并重启 ST' : data?.message || '服务任务结果未确认，请查询原任务',
          ['not_submitted','rejected','unknown','accepted'].includes(data?.submissionState) ? data.submissionState : action === 'submit' ? 'unknown' : 'accepted');
        error.serviceCode = data?.code; error.confirmation = data?.confirmation; throw error;
      }
      return data;
    } catch (cause) {
      if (cause?.code?.startsWith('image_service_client_')) throw cause;
      throw fail('network', action === 'capabilities' ? '增强服务暂不可达，未提交生图' : '服务连接中断，请查询原任务；不会自动重发', action === 'submit' ? 'unknown' : 'accepted');
    } finally { clearTimeout(timer); }
  }
  const accountBinding = async namespace => {
    if (!namespace.startsWith('st-user:')) throw fail('account', '无法确认当前 ST 账户');
    return `st-user:${await imageChannelKey(namespace.slice(8))}`;
  };
  const locator = async row => ({ schemaVersion: 1, attemptId: row.attemptId, expectedAccount: await accountBinding(row.namespace), taskLocator: { version: 1, channelKey: row.channelKey } });
  const locked = (namespace, attemptId, operation) => {
    if (!locks?.request) throw fail('locks', '当前浏览器无法安全协调服务任务');
    return locks.request(`qianmu:service-maintenance:${namespace}`, { mode: 'shared', ifAvailable: true }, maintenance => {
      if (!maintenance) throw fail('busy', '服务领取记录正在整理，请稍后重试');
      return locks.request(`qianmu:service-result:${namespace}:${attemptId}`, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) throw fail('busy', '原任务正在处理，请稍后查询', 'accepted');
        return operation();
      });
    });
  };
  async function probe() {
    const data = await call('capabilities');
    if (data.schemaVersion !== 1 || data.taskLocatorVersion !== 1 || data.accountBindingVersion !== 1 || data.scope !== 'coordinated-endpoints-only'
      || !data.providers?.includes('novel') || !data.protocols?.includes('novelai') || data.resultRetrieval !== true || data.resultAcknowledgement !== true) throw fail('version', '增强服务版本不匹配，请同步更新前后端并重启 ST');
    return data;
  }
  async function receive(row, data, deliver) {
    await assertAccount(row.namespace);
    if (data.serviceTask?.attemptId !== row.attemptId || !Array.isArray(data.images) || !data.images.length || data.images.length > 8) throw fail('result', '原图返回不完整，请查询原任务', 'accepted');
    row.status = 'available'; row.receipt = data.serviceTask?.resultStored === true ? data.serviceTask.receipt || '' : '';
    await store.put(row);
    const checkpoint = async records => { await assertAccount(row.namespace); row.archiveRecords = records; await store.put(row); };
    const archived = await deliver(data, structuredClone(row), checkpoint, () => assertAccount(row.namespace));
    await assertAccount(row.namespace);
    if (archived !== true) return { archived: false, warning: '原图尚未完成本地归档，服务暂存已保留' };
    row.status = 'archived'; await store.put(row);
    const finished = await finishArchive(row);
    return { ...finished, warning: finished.warning || data.serviceTask?.warning || '' };
  }
  async function finishArchive(row) {
    try {
      await assertAccount(row.namespace);
      if (!row.receipt) {
        const queried = await call('query', await locator(row)); await assertAccount(row.namespace);
        if (!queried.task || queried.task.status !== 'succeeded') throw fail('pending', '任务完成记录尚待核查', 'accepted');
        row.receipt = queried.task.cacheReceipt || '';
      }
      if (row.receipt) await call('acknowledge', { ...await locator(row), receipt: row.receipt, archived: true });
      await assertAccount(row.namespace); await store.remove(row.namespace, row.attemptId);
      return { archived: true, warning: '' };
    } catch (_) { return { archived: true, warning: '本地已归档；服务暂存待清理' }; }
  }
  return {
    probe,
    async catalog({ cursor = null } = {}) {
      const namespace = await account();
      const data = await call('catalog', { schemaVersion: 1, expectedAccount: await accountBinding(namespace), cursor, limit: 40 }, 30000);
      await assertAccount(namespace);
      if (data.catalogVersion !== 1 || !Array.isArray(data.originals) || data.originals.length > 128 || !Array.isArray(data.tasks) || data.tasks.length > 50) throw fail('version', '服务目录版本不匹配，请更新后端并重启 ST');
      return { ...data, namespace };
    },
    async rememberOriginal(task, { chatKey } = {}) {
      task = structuredClone(task);
      const namespace = await account();
      if (task?.namespace !== namespace) throw fail('account', 'ST 账户已变化，请重新读取服务目录');
      if (!id(task?.attemptId) || task.taskLocator?.version !== 1 || !/^[a-f0-9]{64}$/.test(task.taskLocator.channelKey || '') || typeof chatKey !== 'string' || !chatKey || chatKey.length > 512) throw fail('identity', '请先进入要保存原图的聊天');
      return locked(namespace, task.attemptId, async () => {
        const previous = await store.get(namespace, task.attemptId);
        if (previous) {
          if (previous.channelKey !== task.taskLocator.channelKey) throw fail('conflict', '同编号属于另一连接，请先核查本机领取记录');
          return previous;
        }
        if (!await confirm('找回原图至阅片室', '此设备没有原取景配置。仅保存原图到当前聊天的阅片室，不插入正文，也不套用当前设置作为重绘配置。')) return null;
        await assertAccount(namespace);
        const row = checkedRow({ version: 1, namespace, attemptId: task.attemptId, channelKey: task.taskLocator.channelKey, status: 'prepared',
          originalOnly: true, createdAt: Number(task.createdAt) || Date.now(), snapshot: { source: 'novel', target: 'gallery', chatKey, inlineByDefault: false } }, namespace);
        const queried = await call('query', await locator(row)); await assertAccount(namespace);
        if (queried.task?.attemptId !== row.attemptId || queried.task.resultAvailable !== true) throw fail('pending', '原图暂不可领取，请刷新服务目录', 'accepted');
        await store.put(row); return structuredClone(row);
      });
    },
    async discardOriginal(task) {
      task = structuredClone(task);
      const namespace = await account();
      if (task?.namespace !== namespace) throw fail('account', 'ST 账户已变化，请重新读取服务目录');
      if (!id(task?.attemptId) || task.taskLocator?.version !== 1 || !/^[a-f0-9]{64}$/.test(task.taskLocator.channelKey || '')) throw fail('identity', '原图记录无效');
      return locked(namespace, task.attemptId, async () => {
        const row = { namespace, attemptId: task.attemptId, channelKey: task.taskLocator.channelKey };
        const queried = await call('query', await locator(row)); await assertAccount(namespace);
        const current = queried.task;
        if (!current?.cacheReceipt || current.live || ['reserved','submitting'].includes(current.status)) throw fail('pending', '原任务正在运行或待核查，未清理暂存', 'accepted');
        if (!await confirm('删除服务器暂存原图', '只删除这项服务器原图暂存，无法撤销。不会删除已归档图片或防重记录，也不会退款；请确认已保存或不再需要。')) return false;
        await assertAccount(namespace);
        await call('discard', { ...await locator(row), receipt: current.cacheReceipt, confirmed: true });
        await assertAccount(namespace); return true;
      });
    },
    async list() { const namespace = await account(), rows = await store.list(namespace); await assertAccount(namespace); return rows; },
    async submit(job, request, { beforeSubmit, deliver, valid = () => true, onPrepared = () => {} } = {}) {
      job = structuredClone(job); request = structuredClone(request);
      const namespace = await account();
      if (job.imageAdmission?.namespace !== namespace || !id(job.id) || request.provider !== 'novel' || (request.protocol && request.protocol !== 'novelai')) throw fail('identity', '服务模式仅支持当前账户的 NAI 原生请求');
      return locked(namespace, job.id, async () => {
        if (await store.get(namespace, job.id)) throw fail('exists', '原服务请求已存在，请领取原图', 'accepted');
        await probe(); await assertAccount(namespace);
        const row = checkedRow({ version: 1, namespace, attemptId: job.id, channelKey: await imageChannelKey(request.apiKey),
          status: 'prepared', createdAt: Date.now(), logId: job.logId, snapshot: job }, namespace);
        const body = { schemaVersion: 1, expectedAccount: await accountBinding(namespace), attemptId: job.id, automatic: Boolean(job.automatic), request: structuredClone(request) };
        await store.put(row); onPrepared(structuredClone(row));
        const send = async () => {
          await assertAccount(namespace); if (!valid()) throw fail('cancelled', '上下文已变化，未提交生图');
          await beforeSubmit(); row.status = 'submitted'; await store.put(row);
          await assertAccount(namespace); if (!valid()) throw fail('cancelled', '上下文已变化，未提交生图');
          return call('submit', body, 10 * 60_000);
        };
        let data;
        try { data = await send(); }
        catch (cause) {
          // Only a proven pre-submission refusal permits this explicit consent.
          if (!job.automatic && cause.submissionState === 'not_submitted' && cause.serviceCode === 'image_service_confirmation_required'
            && /^[a-f0-9]{64}$/.test(cause.confirmation || '') && await confirm('确认服务连接继续生图', '此连接有结果未确认的请求。请先核查渠道记录；继续将生成新图，不是领取原图。')) {
            body.confirmation = cause.confirmation; data = await send();
          } else {
            if (['not_submitted','rejected'].includes(cause.submissionState)) { row.status = 'rejected'; await store.put(row); }
            throw cause;
          }
        }
        try { return await receive(row, data, deliver); }
        catch (cause) { cause.submissionState = 'accepted'; throw cause; }
      });
    },
    async retrieve(attemptId, deliver, { namespace: expectedNamespace } = {}) {
      const namespace = await account();
      if (expectedNamespace && expectedNamespace !== namespace) throw fail('account', 'ST 账户已变化，请重新读取领取记录');
      if (!id(attemptId)) throw fail('identity', '原请求编号无效');
      return locked(namespace, attemptId, async () => {
        const row = await store.get(namespace, attemptId); if (!row) throw fail('missing', '未找到当前账户的待领取请求');
        await assertAccount(namespace);
        if (row.status === 'archived') {
          return finishArchive(row);
        }
        const queried = await call('query', await locator(row)); await assertAccount(namespace);
        if (!queried.task?.resultAvailable) throw fail('pending', queried.task?.live ? '原任务仍在生成，请稍后领取' : '原图尚未暂存，请核查原任务；未重新生成', 'accepted');
        const data = await call('result', await locator(row), 2 * 60_000);
        try { return await receive(row, data, deliver); }
        catch (cause) { cause.submissionState = 'accepted'; throw cause; }
      });
    },
    async dismiss(attemptId, { namespace: expectedNamespace } = {}) {
      const namespace = await account();
      if (expectedNamespace && expectedNamespace !== namespace) throw fail('account', 'ST 账户已变化，请重新读取领取记录');
      if (!id(attemptId)) throw fail('identity', '原请求编号无效');
      return locked(namespace, attemptId, async () => {
        const row = await store.get(namespace, attemptId); if (!row) return;
        if (!await confirm('移除此设备的领取记录', '这会移除本机的原图领取入口，不删除服务器暂存和防重记录。请确认图片已保存或不再需要领取。')) return;
        await assertAccount(namespace); await store.remove(namespace, attemptId);
      });
    },
    async manage({ remove = false } = {}) {
      const namespace = await account();
      const run = async () => {
        const rows = await store.list(namespace); await assertAccount(namespace);
        const totals = { count: rows.length, bytes: rows.reduce((sum,row) => sum + new TextEncoder().encode(JSON.stringify(row)).length,0) };
        if (remove) for (const row of rows) { await assertAccount(namespace); await store.remove(namespace,row.attemptId); }
        return totals;
      };
      if (!remove) return run();
      if (!locks?.request) throw fail('locks', '当前浏览器无法安全清理服务请求');
      return locks.request(`qianmu:service-maintenance:${namespace}`, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) throw fail('busy', '仍有生成或领取中的服务任务，未清理');
        return run();
      });
    },
    close() { closed = true; store.close(); },
  };
}
