// Offline administration only; never expose this module as a normal retry route.
// The operator must stop ALL ST instances using this local data directory first.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeImageServiceChannel } from './qianmu-image-service-queue.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const recordName = /^[a-f0-9]{64}\.json$/;
const tempName = /^\.write-[a-f0-9-]{36}\.tmp$/;
const fail = (code, message) => Object.assign(new Error(message), { name: 'ImageServiceRecoveryError', code: `image_service_recovery_${code}`, status: 409 });
const safeError = cause => String(cause?.code || '').startsWith('image_service_') ? cause : fail('io', '记录恢复未完成，请保留备份并核查磁盘状态');
const missing = cause => cause?.code === 'ENOENT';
async function directory(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(target)) !== path.resolve(target)) throw fail('path', '恢复目录包含链接或路径变化');
}
async function locate(dataRoot) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0') || path.resolve(dataRoot) === path.parse(path.resolve(dataRoot)).root) throw fail('root', '请指定实际 ST 数据目录');
  const root = await fs.realpath(dataRoot), parent = path.join(root, '.qianmu-service'), active = path.join(parent, 'image-queue-v1');
  await directory(root);
  try { await directory(parent); await directory(active); }
  catch (cause) { if (missing(cause)) return { root, parent, active, exists: false }; throw cause; }
  return { root, parent, active, exists: true };
}
async function read(target, max = 2 * 1024 * 1024) {
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) throw fail('file', '恢复记录类型或大小异常');
  const handle = await fs.open(target, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw fail('changed', '恢复记录已变化，请重新核查');
    const buffer = Buffer.alloc(opened.size + 1); let bytes = 0;
    while (bytes < buffer.length) { const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!chunk.bytesRead) break; bytes += chunk.bytesRead; }
    if (bytes !== opened.size) throw fail('changed', '读取时恢复记录已变化');
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}
function parseRecord(buffer, name) {
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); } catch (_) { throw fail('corrupt', '存在损坏记录，未覆盖原数据'); }
  const key = name.slice(0, -5);
  if (value?.schema !== 'qianmu.image-service-disk.v1' || value.channelKey !== key || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !value.state || value.checksum !== hash(JSON.stringify(value.state))) throw fail('corrupt', '恢复记录校验失败，未覆盖原数据');
  return { ...value, state: normalizeImageServiceChannel(value.state, key) };
}
function checkOwner(buffer) {
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); } catch (_) { return; }
  if (!Number.isSafeInteger(value?.pid) || value.pid < 1) return;
  try { process.kill(value.pid, 0); }
  catch (cause) { if (cause?.code === 'ESRCH') return; throw fail('owner', '无法确认原写入进程已停止'); }
  throw fail('owner', '原写入进程仍存在，请先停止对应服务；不要终止无关进程');
}
async function scan(location) {
  if (!location.exists) return { schemaVersion: 1, confirmation: hash('empty'), exists: false, maintenance: false, files: [], channels: 0, bytes: 0, reserved: 0, submitting: 0, uncertain: 0 };
  await directory(location.parent); await directory(location.active);
  const stream = await fs.opendir(location.active), names = []; let maintenance = false, count = 0;
  for await (const entry of stream) {
    if (++count > 160) throw fail('full', '恢复目录项目过多，请先核查');
    if (entry.name === '.maintenance.lock') { maintenance = true; continue; }
    if (!entry.isFile() || (!recordName.test(entry.name) && !tempName.test(entry.name) && entry.name !== '.transaction.lock')) throw fail('file', '恢复目录包含未知文件，未进行修改');
    names.push(entry.name);
  }
  const files = []; let channels = 0, bytes = 0, reserved = 0, submitting = 0, uncertain = 0;
  for (const name of names.sort()) {
    const buffer = await read(path.join(location.active, name));
    bytes += buffer.length; if (bytes > 256 * 1024 * 1024) throw fail('full', '恢复记录总量超过上限');
    if (recordName.test(name)) {
      const record = parseRecord(buffer, name); channels++;
      for (const item of record.state.entries) { if (item.status === 'reserved') reserved++; if (item.status === 'submitting') submitting++; if (item.status === 'uncertain') uncertain++; }
    }
    files.push({ name, bytes: buffer.length, checksum: hash(buffer) });
  }
  if (channels > 128) throw fail('full', '恢复连接数量超过上限');
  return { schemaVersion: 1, confirmation: hash(JSON.stringify(files)), exists: true, maintenance, files, channels, bytes, reserved, submitting, uncertain };
}
async function write(target, body) {
  const handle = await fs.open(target, 'wx', 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
}
async function sync(target) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(target, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function newBackup(location) {
  const parent = path.join(location.parent, 'image-queue-recovery');
  try { await fs.mkdir(parent, { mode: 0o700 }); } catch (cause) { if (cause?.code !== 'EEXIST') throw cause; }
  await directory(parent);
  const entries = await fs.opendir(parent); let count = 0;
  for await (const _entry of entries) if (++count >= 8) throw fail('backup_full', '恢复备份已满，请先自行归档旧备份');
  const backup = path.join(parent, randomUUID()); await fs.mkdir(backup, { mode: 0o700 }); return backup;
}
export async function inspectImageServiceRecovery({ dataRoot } = {}) {
  try { return await scan(await locate(dataRoot)); } catch (cause) { throw safeError(cause); }
}
export async function recoverImageServiceRecords({ dataRoot, confirmation, serverStopped = false } = {}) {
  // A local administrative assertion, NOT a field to accept from an HTTP client.
  if (serverStopped !== true) throw fail('offline_required', '请先停止所有使用此数据目录的 ST 和维护进程，再明确确认离线恢复');
  if (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation)) throw fail('confirmation', '请先核查恢复计划');
  let location, gate, owner, backup, modified = false, complete = false;
  try {
    location = await locate(dataRoot); if (!location.exists) throw fail('empty', '此 ST 尚无服务生图记录');
    gate = path.join(location.active, '.maintenance.lock'); owner = randomUUID();
    try { await write(gate, JSON.stringify({ schema: 'qianmu.image-service-maintenance.v1', owner, pid: process.pid })); }
    catch (cause) { if (cause?.code === 'EEXIST') throw fail('maintenance', '已有恢复操作或遗留恢复锁，请保留原备份'); throw cause; }
    const plan = await scan(location);
    if (plan.confirmation !== confirmation) throw fail('changed', '恢复计划已变化，请重新核查后确认');
    const oldLock = plan.files.find(item => item.name === '.transaction.lock');
    if (oldLock) checkOwner(await read(path.join(location.active, oldLock.name)));
    if (!plan.reserved && !plan.submitting && plan.files.every(item => recordName.test(item.name))) {
      complete = true; return { ok: true, backup: null, released: 0, uncertain: 0, automaticResubmissions: 0 };
    }
    backup = await newBackup(location);
    for (const item of plan.files) {
      const buffer = await read(path.join(location.active, item.name));
      if (hash(buffer) !== item.checksum) throw fail('changed', '备份前记录已变化，未继续恢复');
      await write(path.join(backup, item.name), buffer);
    }
    await write(path.join(backup, 'manifest.json'), JSON.stringify({ schema: 'qianmu.image-service-backup.v1', recoveryOwner: owner, confirmation, createdAt: Date.now(), files: plan.files }));
    await sync(backup); await sync(path.dirname(backup));
    // Every original file is backed up before the first active record is changed.
    for (const item of plan.files) {
      const original = await read(path.join(location.active, item.name));
      if (hash(original) !== item.checksum) throw fail('changed', '恢复时原记录已变化，已保留备份');
      if (recordName.test(item.name)) {
        const record = parseRecord(original, item.name); let changed = false;
        for (const row of record.state.entries) {
          if (row.status === 'reserved' || row.status === 'submitting') {
            row.status = row.status === 'reserved' ? 'released' : 'uncertain';
            row.updatedAt = Math.max(Date.now(), row.updatedAt); changed = true;
          }
        }
        if (!changed) continue;
        record.revision++; if (!Number.isSafeInteger(record.revision)) throw fail('corrupt', '记录版本已到上限，请保留原备份');
        record.checksum = hash(JSON.stringify(record.state));
        const serialized = JSON.stringify(record);
        if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw fail('full', '恢复后的记录超过容量，请保留原备份');
        const temporary = path.join(location.active, `.write-${randomUUID()}.tmp`);
        modified = true; await write(temporary, serialized); await fs.rename(temporary, path.join(location.active, item.name));
      } else {
        // Preserve stale lock/staged bytes instead of deleting their evidence.
        modified = true; await fs.rename(path.join(location.active, item.name), path.join(backup, `evidence-${item.name}`));
      }
    }
    await sync(location.active); await sync(backup);
    await write(path.join(backup, 'completed.json'), JSON.stringify({ completedAt: Date.now(), released: plan.reserved, uncertain: plan.submitting }));
    await sync(backup); complete = true;
    return { ok: true, backup, released: plan.reserved, uncertain: plan.submitting, automaticResubmissions: 0 };
  } catch (cause) {
    const failure = safeError(cause);
    if (backup) { failure.backupId = path.basename(backup); failure.recoveryInterrupted = modified; }
    throw failure;
  }
  finally {
    // On partial failure, the maintenance fence and backup remain deliberately.
    // An operator must inspect/restore them; restarting is not authorization.
    if (gate && (complete || !modified)) {
      try {
        const current = JSON.parse((await read(gate, 4096)).toString('utf8'));
        if (current.owner !== owner) throw fail('changed', '恢复锁已由其他操作接管');
        await fs.unlink(gate); await sync(location.active);
      } catch (_) { if (complete) throw fail('cleanup', '记录已恢复并备份，但恢复锁未能移除，请先核查'); }
    }
  }
}

// Roll back only an interrupted recovery owned by this exact backup. This is not
// a generic "restore old history" operation that could erase newer paid requests.
export async function restoreInterruptedImageRecovery({ dataRoot, backupId, serverStopped = false } = {}) {
  if (serverStopped !== true) throw fail('offline_required', '请先停止所有使用此数据目录的 ST 和维护进程');
  if (typeof backupId !== 'string' || !/^[a-f0-9-]{36}$/.test(backupId)) throw fail('backup', '恢复备份编号无效');
  try {
    const location = await locate(dataRoot); if (!location.exists) throw fail('empty', '服务记录目录不存在');
    const parent = path.join(location.parent, 'image-queue-recovery'), backup = path.join(parent, backupId);
    await directory(parent); await directory(backup);
    try { await fs.lstat(path.join(backup, 'completed.json')); throw fail('completed', '此恢复已完成，不允许用旧备份覆盖后续任务'); }
    catch (cause) { if (!missing(cause)) throw cause; }
    let manifest, gate;
    try {
      manifest = JSON.parse((await read(path.join(backup, 'manifest.json'), 128 * 1024)).toString('utf8'));
      gate = JSON.parse((await read(path.join(location.active, '.maintenance.lock'), 4096)).toString('utf8'));
    } catch (cause) { throw fail('backup', '中断恢复的备份或恢复锁不完整，请保留原文件'); }
    if (manifest?.schema !== 'qianmu.image-service-backup.v1' || !/^[a-f0-9-]{36}$/.test(manifest.recoveryOwner || '')
      || gate?.schema !== 'qianmu.image-service-maintenance.v1' || gate.owner !== manifest.recoveryOwner
      || !Array.isArray(manifest.files) || manifest.files.length > 160 || manifest.confirmation !== hash(JSON.stringify(manifest.files))) throw fail('backup', '备份与中断恢复不匹配，未还原');
    checkOwner(Buffer.from(JSON.stringify(gate)));
    const expected = new Map();
    for (const item of manifest.files) {
      if (!item || typeof item.name !== 'string' || (!recordName.test(item.name) && !tempName.test(item.name) && item.name !== '.transaction.lock')
        || !/^[a-f0-9]{64}$/.test(item.checksum || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 2 * 1024 * 1024 || expected.has(item.name)) throw fail('backup', '备份文件清单无效');
      const buffer = await read(path.join(backup, item.name));
      if (buffer.length !== item.bytes || hash(buffer) !== item.checksum) throw fail('backup', '备份内容校验失败，未还原');
      if (recordName.test(item.name)) parseRecord(buffer, item.name);
      expected.set(item.name, item);
    }
    const current = await scan(location);
    for (const item of current.files) {
      const original = expected.get(item.name);
      if (!original) { if (tempName.test(item.name)) continue; throw fail('changed', '存在备份之外的新记录，未覆盖'); }
      if (item.checksum === original.checksum) continue;
      if (!recordName.test(item.name)) throw fail('changed', '原写锁或临时记录已变化，未覆盖');
      const oldRecord = parseRecord(await read(path.join(backup, item.name)), item.name);
      const changed = parseRecord(await read(path.join(location.active, item.name)), item.name);
      if (changed.revision !== oldRecord.revision + 1 || changed.state.entries.length !== oldRecord.state.entries.length) throw fail('changed', '记录存在其他任务变更，未覆盖');
      for (let n = 0; n < oldRecord.state.entries.length; n++) {
        const oldRow = oldRecord.state.entries[n], nextRow = changed.state.entries[n];
        const expectedStatus = oldRow.status === 'reserved' ? 'released' : oldRow.status === 'submitting' ? 'uncertain' : oldRow.status;
        if (nextRow.status !== expectedStatus || nextRow.updatedAt < oldRow.updatedAt
          || JSON.stringify({ ...nextRow, status: oldRow.status, updatedAt: oldRow.updatedAt }) !== JSON.stringify(oldRow)) throw fail('changed', '记录不是本次恢复的变更，未覆盖');
      }
    }
    for (const item of expected.values()) if (recordName.test(item.name) && !current.files.some(entry => entry.name === item.name)) throw fail('changed', '原任务记录缺失，未自动覆盖');
    // A second administrator cannot run this rollback concurrently. A crash leaves
    // this extra guard for inspection; no lock is stolen automatically.
    const guard = path.join(backup, '.restore.lock');
    try { await write(guard, JSON.stringify({ pid: process.pid, owner: randomUUID() })); }
    catch (cause) { if (cause?.code === 'EEXIST') throw fail('maintenance', '已有还原操作或遗留还原锁，请保留备份'); throw cause; }
    let modified = false, completed = false;
    try {
      // Recheck the whole active snapshot after obtaining the exclusive guard.
      if ((await scan(location)).confirmation !== current.confirmation) throw fail('changed', '还原前记录已变化');
      for (const item of current.files) if (!expected.has(item.name)) {
        modified = true; await fs.rename(path.join(location.active, item.name), path.join(backup, `interrupted-${item.name}`));
      }
      for (const item of expected.values()) {
        const buffer = await read(path.join(backup, item.name));
        if (hash(buffer) !== item.checksum) throw fail('backup', '还原时备份发生变化');
        const temporary = path.join(location.active, `.write-${randomUUID()}.tmp`);
        modified = true; await write(temporary, buffer); await fs.rename(temporary, path.join(location.active, item.name));
      }
      await sync(location.active);
      const restored = await scan(location); if (restored.confirmation !== manifest.confirmation) throw fail('changed', '还原后的记录校验不一致');
      await write(path.join(backup, 'restored.json'), JSON.stringify({ restoredAt: Date.now(), automaticResubmissions: 0 })); await sync(backup);
      const lock = JSON.parse((await read(path.join(location.active, '.maintenance.lock'), 4096)).toString('utf8'));
      if (lock.owner !== gate.owner) throw fail('changed', '恢复锁已变化，未移除');
      await fs.unlink(path.join(location.active, '.maintenance.lock')); await sync(location.active); completed = true;
      return { ok: true, backup, restored: expected.size, automaticResubmissions: 0, next: 'inspect-before-recovery' };
    } finally { if (completed || !modified) await fs.unlink(guard); }
  } catch (cause) { throw safeError(cause); }
}
