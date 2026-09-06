// Server-only, small atomic registry under the trusted ST data root. No API keys.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ImageGatewayError } from './qianmu-image-gateway.js';
import { normalizeComfyTarget } from './qianmu-comfy-server-transport.js';

const fail = (code, message) => Object.assign(new ImageGatewayError(409, `comfy_targets_${code}`, message), { submissionState: 'not_submitted' });
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const comfyTargetId = (baseUrl, allowPrivateNetwork) => digest(`${normalizeComfyTarget(baseUrl)}\n${allowPrivateNetwork === true}`);

export function normalizeComfyTargets(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.targets) || value.targets.length > 64) throw fail('corrupt', '可信连接记录无效，请先核查服务数据');
  const seen = new Set();
  const targets = value.targets.map(row => {
    if (!row || typeof row.name !== 'string' || row.name.length > 80 || /[\u0000-\u001f\u007f]/.test(row.name)
      || typeof row.allowPrivateNetwork !== 'boolean' || typeof row.shared !== 'boolean' || (row.allowPrivateNetwork && row.shared)
      || !/^[a-f0-9-]{36}$/.test(row.grantId || '') || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0
      || normalizeComfyTarget(row.baseUrl) !== row.baseUrl || comfyTargetId(row.baseUrl, row.allowPrivateNetwork) !== row.id || seen.has(row.id)) throw fail('corrupt', '可信连接记录无效，请先核查服务数据');
    seen.add(row.id);
    return { id: row.id, baseUrl: row.baseUrl, name: row.name, allowPrivateNetwork: row.allowPrivateNetwork, shared: row.shared, grantId: row.grantId, updatedAt: row.updatedAt };
  });
  return { schemaVersion: 1, revision: value.revision, targets };
}

export function createComfyTargetStore({ dataRoot } = {}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0') || path.resolve(dataRoot) === path.parse(path.resolve(dataRoot)).root) throw fail('root', '增强服务缺少可信的 ST 数据目录');
  let poisoned = false;
  const plainDirectory = async target => {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(target)) !== path.resolve(target)) throw fail('path', '可信连接数据目录异常');
  };
  async function directory(create) {
    if (poisoned) throw fail('paused', '可信连接记录需核查，暂不允许新请求');
    const root = await fs.realpath(dataRoot);
    if (!(await fs.stat(root)).isDirectory() || root === path.parse(root).root) throw fail('root', 'ST 数据目录无效');
    let current = root;
    for (const segment of ['.qianmu-service', 'comfy-targets-v1']) {
      current = path.join(current, segment);
      if (create) { try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      try { await plainDirectory(current); } catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
    }
    return current;
  }
  async function readAt(dir) {
    if (!dir) return { schemaVersion: 1, revision: 0, targets: [] };
    const file = path.join(dir, 'registry.json'); let before;
    try { before = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, revision: 0, targets: [] }; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024) throw fail('path', '可信连接记录类型或大小异常');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!same(before, stat) || !stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw fail('changed', '可信连接记录在读取时发生变化');
      const buffer = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length !== stat.size) throw fail('changed', '可信连接记录大小发生变化');
      let envelope; try { envelope = JSON.parse(buffer.toString('utf8', 0, length)); } catch (_) { throw fail('corrupt', '可信连接记录损坏，未自动重建'); }
      if (envelope.checksum !== digest(JSON.stringify(envelope.state))) throw fail('corrupt', '可信连接记录校验失败');
      return normalizeComfyTargets(envelope.state);
    } finally { await handle.close(); }
  }
  const guarded = async operation => {
    try { return await operation(); } catch (error) { if (error instanceof ImageGatewayError) throw error; throw fail('storage', '可信连接记录暂不可用，请核查 ST 服务数据'); }
  };
  return {
    read: () => guarded(async () => readAt(await directory(false))),
    update: (expectedRevision, change) => guarded(async () => {
      const dir = await directory(true), lockPath = path.join(dir, '.lock'); let lock;
      try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('busy', '可信连接正在更新或等待核查，请稍后刷新'); throw error; }
      const identity = await lock.stat(); let temp, committed = false;
      try {
        const previous = await readAt(dir);
        if (previous.revision !== expectedRevision) throw fail('revision', '可信连接已被其他页面更新，请刷新后重试');
        const next = normalizeComfyTargets({ schemaVersion: 1, revision: previous.revision + 1, targets: await change(previous.targets) });
        const bytes = JSON.stringify({ state: next, checksum: digest(JSON.stringify(next)) });
        if (Buffer.byteLength(bytes) > 64 * 1024) throw fail('full', '可信连接容量已满，请先整理');
        temp = path.join(dir, `.write-${randomUUID()}.tmp`);
        const writer = await fs.open(temp, 'wx', 0o600);
        try { await writer.writeFile(bytes); await writer.sync(); } finally { await writer.close(); }
        await plainDirectory(path.dirname(dir)); await plainDirectory(dir);
        await fs.rename(temp, path.join(dir, 'registry.json')); committed = true;
        if (process.platform !== 'win32') { const handle = await fs.open(dir, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
        return next;
      } catch (error) { if (committed) poisoned = true; throw error; }
      finally {
        if (temp && !committed) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') poisoned = true; });
        await lock.close();
        const current = await fs.lstat(lockPath);
        if (!same(identity, current) || current.isSymbolicLink()) { poisoned = true; throw fail('changed', '可信连接写入锁已变化'); }
        await fs.unlink(lockPath);
      }
    }),
  };
}
