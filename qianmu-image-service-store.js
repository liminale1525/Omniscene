// Private server-side metadata only. Not activated by importing this module.
// dataRoot must come from the ST host, never from an HTTP request or plugin path.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeImageServiceChannel } from './qianmu-image-service-queue.js';

const DISK_SCHEMA = 'qianmu.image-service-disk.v1';
const HASH = /^[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const error = (code, message) => Object.assign(new Error(message), {
  name: 'ImageServiceStoreError', code: `image_service_storage_${code}`, status: 409, submissionState: 'not_submitted',
});
const safeError = cause => String(cause?.code || '').startsWith('image_service_') ? cause
  : error('unavailable', '生图服务记录暂不可用，未授权新请求');
const isMissing = cause => cause?.code === 'ENOENT';
const sameFile = (one, two) => one.dev === two.dev && one.ino === two.ino;

export function createImageServiceStore({ dataRoot, fileSystem = fs, maxChannels = 128,
  maxRecordBytes = 2 * 1024 * 1024, maxPending = 64 } = {}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0') || path.resolve(dataRoot) === path.parse(path.resolve(dataRoot)).root) {
    throw error('root', '增强服务缺少可信的 ST 数据目录');
  }
  const channelLimit = Math.max(1, Math.min(128, Math.trunc(Number(maxChannels) || 128)));
  const recordLimit = Math.max(1024, Math.min(2 * 1024 * 1024, Math.trunc(Number(maxRecordBytes) || 2 * 1024 * 1024)));
  const pendingLimit = Math.max(1, Math.min(64, Math.trunc(Number(maxPending) || 64)));
  const io = fileSystem;
  let directory, initialization, tail = Promise.resolve(), pending = 0, closed = false, poisoned = false;
  const assertOpen = () => { if (closed || poisoned) throw error('closed', '生图服务记录已暂停，请先核查服务状态'); };
  const checkKey = key => { if (typeof key !== 'string' || !HASH.test(key)) throw error('identity', '生图连接指纹无效'); };
  async function checkDirectory(target) {
    const stat = await io.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await io.realpath(target)) !== path.resolve(target)) throw error('path', '生图服务目录不符合安全要求');
  }
  async function initialize() {
    if (!initialization) initialization = (async () => {
      const root = await io.realpath(dataRoot);
      if (!(await io.stat(root)).isDirectory() || path.resolve(root) === path.parse(root).root) throw error('root', 'ST 数据目录无效');
      let current = root;
      for (const segment of ['.qianmu-service', 'image-queue-v1']) {
        current = path.join(current, segment);
        try { await io.mkdir(current, { mode: 0o700 }); } catch (cause) { if (cause?.code !== 'EEXIST') throw cause; }
        await checkDirectory(current);
      }
      directory = current;
    })().catch(cause => { poisoned = true; throw safeError(cause); });
    await initialization;
    // Detect replacement/junctions after initialization rather than following them.
    await checkDirectory(path.dirname(directory)); await checkDirectory(directory);
    return directory;
  }
  async function syncDirectory() {
    // Windows does not expose directory fsync through Node. File data is flushed
    // and rename is atomic, but power-loss guarantees still depend on the volume.
    if (process.platform === 'win32') return;
    const handle = await io.open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function readRecord(key) {
    const target = path.join(directory, `${key}.json`);
    let before;
    try { before = await io.lstat(target); } catch (cause) { if (isMissing(cause)) return undefined; throw cause; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > recordLimit) throw error('record', '生图服务记录类型或大小异常，请先核查');
    const handle = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1 || opened.size > recordLimit) throw error('changed', '读取时生图服务记录已变化');
      const buffer = Buffer.alloc(opened.size + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break; length += bytesRead;
      }
      if (length > recordLimit || length !== opened.size) throw error('record', '读取时生图服务记录大小已变化');
      let envelope;
      try { envelope = JSON.parse(buffer.toString('utf8', 0, length)); } catch (_) { throw error('corrupt', '生图服务记录损坏，请先核查原请求'); }
      if (envelope?.schema !== DISK_SCHEMA || envelope.channelKey !== key || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
        || !envelope.state || envelope.checksum !== sha(JSON.stringify(envelope.state))) throw error('corrupt', '生图服务记录校验失败，请先核查原请求');
      return { revision: envelope.revision, state: normalizeImageServiceChannel(envelope.state, key) };
    } finally { await handle.close(); }
  }
  async function checkCapacity(existing) {
    const stream = await io.opendir(directory); let records = 0, entries = 0;
    for await (const entry of stream) {
      if (++entries > channelLimit + 32) throw error('full', '生图服务目录已满，请先整理记录');
      if (/^[a-f0-9]{64}\.json$/.test(entry.name)) { records++; if (!entry.isFile()) throw error('path', '生图服务记录目录包含异常链接'); }
      else if (!entry.isFile() || (entry.name !== '.transaction.lock' && !/^\.write-[a-f0-9-]{36}\.tmp$/.test(entry.name))) throw error('path', '生图服务记录目录包含未知文件，请先核查');
    }
    if (records > channelLimit || (!existing && records >= channelLimit)) throw error('full', '生图服务连接记录已满，请先整理');
  }
  async function atomicWrite(key, previous, state) {
    const revision = (previous?.revision || 0) + 1;
    if (!Number.isSafeInteger(revision)) throw error('record', '生图服务记录版本已达到上限');
    const normalized = normalizeImageServiceChannel(state, key);
    const body = JSON.stringify({ schema: DISK_SCHEMA, channelKey: key, revision, checksum: sha(JSON.stringify(normalized)), state: normalized });
    if (Buffer.byteLength(body) > recordLimit) throw error('full', '此生图连接记录已满，请先导出或整理');
    const temporary = path.join(directory, `.write-${randomUUID()}.tmp`), target = path.join(directory, `${key}.json`);
    let handle, created = false, renamed = false;
    try {
      handle = await io.open(temporary, 'wx', 0o600); created = true;
      await handle.writeFile(body); await handle.sync(); await handle.close(); handle = undefined;
      await io.rename(temporary, target); renamed = true;
      await syncDirectory();
    } catch (cause) {
      if (renamed) poisoned = true; // committed outcome may be uncertain; never authorize through it
      throw cause;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created && !renamed) await io.unlink(temporary).catch(() => { poisoned = true; });
    }
  }
  async function lockedTransaction(key, reduce) {
    await initialize();
    const lock = path.join(directory, '.transaction.lock');
    let handle, identity;
    try { handle = await io.open(lock, 'wx', 0o600); }
    catch (cause) { if (cause?.code === 'EEXIST') throw error('busy', '生图服务记录正在使用或等待恢复，请先核查'); throw cause; }
    try {
      identity = await handle.stat();
      await handle.writeFile(JSON.stringify({ schema: 'qianmu.image-service-lock.v1', owner: randomUUID(), pid: process.pid }));
      const previous = await readRecord(key);
      await checkCapacity(Boolean(previous));
      const next = reduce(previous?.state);
      if (!next || typeof next !== 'object' || typeof next.then === 'function' || !next.state) throw error('transaction', '生图服务记录事务无效');
      await atomicWrite(key, previous, next.state);
      return next.result;
    } finally {
      await handle.close().catch(() => { poisoned = true; });
      // Never steal an old lock by elapsed time, delete a different owner's lock,
      // or sweep temporary files left by another session. Recovery is separate.
      try {
        const current = await io.lstat(lock);
        if (!identity || current.isSymbolicLink() || !sameFile(identity, current)) throw error('changed', '生图服务写入锁已变化');
        await io.unlink(lock); await syncDirectory();
      } catch (cause) { poisoned = true; throw safeError(cause); }
    }
  }
  const enqueue = operation => {
    try {
      assertOpen();
      if (pending >= pendingLimit) throw error('busy', '生图服务记录等待已满，请稍后重试');
      pending++;
      const work = tail.then(async () => { assertOpen(); return operation(); }).catch(cause => { throw safeError(cause); });
      const settled = work.then(result => { pending--; return result; }, cause => { pending--; throw cause; });
      tail = settled.then(() => {}, () => {}); return settled;
    } catch (cause) { return Promise.reject(safeError(cause)); }
  };
  return {
    transaction(key, reduce) {
      try {
        checkKey(key);
        if (typeof reduce !== 'function') throw error('transaction', '缺少生图服务记录事务');
        return enqueue(() => lockedTransaction(key, reduce));
      } catch (cause) { return Promise.reject(safeError(cause)); }
    },
    inspectChannel(key) {
      try { checkKey(key); return enqueue(async () => { await initialize(); return (await readRecord(key))?.state; }); }
      catch (cause) { return Promise.reject(safeError(cause)); }
    },
    close() { closed = true; return tail; },
    inspect() { return { initialized: Boolean(directory), closed, paused: poisoned, pending }; },
  };
}
