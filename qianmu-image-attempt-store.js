import { imageAttemptScopeKey, normalizeImageAttempts, claimImageAttempt, beginImageAttempt, continueImageAttempt, importImageAttempts, settleImageAttempt, confirmImageAttemptResult, summarizeImageAttempts } from './qianmu-image-attempts.js';

// Separate, lazy database: image budget upgrades must not block voice, reading or
// legacy public data stores. No database is opened at module import/factory time.
const DB_NAME = 'qianmu-image-attempts';
const STORE = 'scopes';
const VERSION = 1;
const problem = (code, message) => Object.assign(new Error(message), { code });
const storageProblem = () => problem('image_attempt_storage', '生图请求记录暂不可用，请检查千幕存储空间并核查渠道记录');

export function createImageAttemptStore({ indexedDB = globalThis.indexedDB, dbName = DB_NAME, timeoutMs = 6000, maxScopes = 4096, now = Date.now } = {}) {
  let opening = null, connection = null, disposed = false;
  const transactions = new Set();
  const timeout = Math.max(100, Math.min(15000, Number(timeoutMs) || 6000));
  const capacity = Math.max(1, Math.min(4096, Math.floor(Number(maxScopes) || 4096)));
  const ensureOpen = () => {
    if (disposed) return Promise.reject(problem('image_attempt_closed', '生图请求记录会话已结束'));
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    const operation = new Promise((resolve, reject) => {
      let request, completed = false;
      const finish = (error, db) => {
        if (completed) { db?.close(); return; }
        completed = true; clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      };
      const timer = setTimeout(() => finish(problem('image_attempt_storage_timeout', '生图请求记录读取超时，请关闭其它旧版页面后重试')), timeout);
      try { request = indexedDB.open(dbName, VERSION); }
      catch (_) { finish(storageProblem()); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onerror = () => finish(storageProblem());
      request.onblocked = () => finish(problem('image_attempt_storage_blocked', '生图请求记录正在升级，请关闭其它旧版页面后重试'));
      request.onsuccess = () => {
        const db = request.result;
        if (completed || disposed) { db.close(); finish(problem('image_attempt_closed', '生图请求记录会话已结束')); return; }
        connection = db;
        const release = () => { if (connection === db) connection = null; opening = null; };
        db.onversionchange = () => { db.close(); release(); };
        db.onclose = release;
        finish(null, db);
      };
    });
    opening = operation;
    void operation.catch(() => { if (opening === operation) opening = null; });
    return operation;
  };

  async function operate(scope, reducer, { create = false, readOnly = false } = {}) {
    const scopeKey = imageAttemptScopeKey(scope);
    const db = await ensureOpen();
    if (disposed) throw problem('image_attempt_closed', '生图请求记录会话已结束');
    return new Promise((resolve, reject) => {
      let transaction, output, localError = null, completed = false;
      const done = error => {
        if (completed) return;
        completed = true; clearTimeout(timer); transactions.delete(transaction);
        if (!error && disposed) error = problem('image_attempt_closed', '生图请求记录会话已结束');
        if (error) reject(error); else resolve(output);
      };
      const timer = setTimeout(() => {
        localError = problem('image_attempt_storage_timeout', '生图请求记录写入超时，未确认操作请勿重复提交');
        try { transaction?.abort(); } catch (_) {}
        done(localError);
      }, timeout);
      const abort = error => {
        localError = error?.code?.startsWith?.('image_attempt_') ? error : storageProblem();
        try { transaction?.abort(); } catch (_) { done(localError); }
      };
      try { transaction = db.transaction(STORE, readOnly ? 'readonly' : 'readwrite'); }
      catch (_) { done(storageProblem()); return; }
      transactions.add(transaction);
      transaction.oncomplete = () => done();
      transaction.onabort = () => done(localError || storageProblem());
      transaction.onerror = () => { localError ||= storageProblem(); };
      const store = transaction.objectStore(STORE);
      const read = store.get(scopeKey);
      read.onsuccess = () => {
        try {
          const previous = read.result;
          output = reducer(previous, now());
          if (readOnly || (!previous && (!create || !output.ok))) return;
          const write = () => { try { store.put(output.ledger, scopeKey); } catch (error) { abort(error); } };
          if (!previous) {
            const count = store.count();
            count.onsuccess = () => {
              if (count.result >= capacity) {
                output = { ok: false, code: 'storage_full', ledger: normalizeImageAttempts(null, scope), automaticUsed: 0 };
              } else write();
            };
          } else write();
        } catch (error) { abort(error); }
      };
    });
  }

  return {
    async manage(namespace, { remove = false } = {}) {
      // Validate the account without opening storage. Only the selected account's
      // metadata is visited; another ST account's records are never cleared.
      imageAttemptScopeKey({ namespace, chatKey: '_', messageKey: '_', revisionId: '_' });
      const db = await ensureOpen();
      const prefix = `${JSON.stringify([namespace]).slice(0, -1)},`;
      return new Promise((resolve, reject) => {
        let tx, failure, finished = false;
        const summary = { bytes: 0, count: 0, scopes: 0, pending: 0, uncertain: 0, corrupt: 0 };
        const finish = cause => {
          if (finished) return;
          finished = true; clearTimeout(timer); transactions.delete(tx);
          if (cause || disposed) reject(cause || storageProblem()); else resolve(summary);
        };
        const timer = setTimeout(() => { failure = storageProblem(); try { tx?.abort(); } catch (_) {} finish(failure); }, timeout);
        try {
          tx = db.transaction(STORE, remove ? 'readwrite' : 'readonly'); transactions.add(tx);
          tx.oncomplete = () => finish(); tx.onabort = () => finish(failure || storageProblem());
          tx.onerror = () => { failure ||= storageProblem(); };
          const cursor = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            try {
              const parts = JSON.parse(row.key);
              if (parts[0] !== namespace) { row.continue(); return; }
              const scope = { namespace, chatKey: parts[1], messageKey: parts[2], revisionId: parts[3] };
              summary.scopes++;
              if (summary.scopes > capacity) throw storageProblem();
              summary.bytes += new TextEncoder().encode(JSON.stringify(row.value)).byteLength;
              try {
                const totals = summarizeImageAttempts(row.value, scope, now());
                summary.count += totals.attempts; summary.pending += totals.pending; summary.uncertain += totals.uncertain;
              } catch (_) {
                summary.corrupt++;
                // Do not clear a recognizable live dispatch just because some
                // other field in its ledger is corrupt.
                summary.pending += (row.value?.entries || []).filter?.(entry => ['reserved', 'submitting'].includes(entry?.status))?.length || 0;
              }
              if (remove && summary.pending) throw problem('image_attempt_busy', '仍有等待或生成中的画面，请结束后再清理防重记录');
              if (remove) row.delete();
              row.continue();
            } catch (cause) { failure = cause; tx.abort(); }
          };
        } catch (cause) { finish(cause?.code ? cause : storageProblem()); }
      });
    },
    async claim(scope, input, history = []) {
      const capturedScope = { ...scope }, captured = { ...input }, seeds = history.map(row => ({ ...row }));
      return operate(capturedScope, (value, at) => claimImageAttempt(importImageAttempts(value, capturedScope, seeds, at), capturedScope, captured, at), { create: true });
    },
    async begin(scope, identity) {
      const capturedScope = { ...scope }, captured = { ...identity };
      return operate(capturedScope, (value, at) => beginImageAttempt(value, capturedScope, captured, at));
    },
    async continue(scope, identity) {
      const capturedScope = { ...scope }, captured = { ...identity };
      return operate(capturedScope, (value, at) => continueImageAttempt(value, capturedScope, captured, at));
    },
    async settle(scope, details) {
      const capturedScope = { ...scope }, captured = { ...details };
      return operate(capturedScope, (value, at) => settleImageAttempt(value, capturedScope, captured, at));
    },
    async inspect(scope) {
      const capturedScope = { ...scope };
      return operate(capturedScope, (value, at) => summarizeImageAttempts(value, capturedScope, at), { readOnly: true });
    },
    async confirmResult(scope, details) {
      const capturedScope = { ...scope }, captured = { ...details };
      return operate(capturedScope, (value, at) => confirmImageAttemptResult(value, capturedScope, captured, at));
    },
    close() {
      disposed = true;
      for (const transaction of transactions) { try { transaction.abort(); } catch (_) {} }
      connection?.close(); connection = null; opening = null;
    },
  };
}
