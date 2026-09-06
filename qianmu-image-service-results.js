// Bounded private, temporary image results. The request ledger is never deleted
// when the client acknowledges its locally archived copy.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const SCHEMA = 'qianmu.image-service-result.v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { name: 'ImageServiceResultError', code: `image_service_result_${code}`, status: 409, submissionState: 'not_submitted' });
const missing = cause => cause?.code === 'ENOENT';
const safeError = cause => String(cause?.code || '').startsWith('image_service_') ? cause : fail('storage', '生图结果暂存不可用，请保留原请求编号');
function identity(value) {
  const result = {};
  for (const field of ['namespace', 'channelKey', 'attemptId', 'requestDigest', 'fence']) {
    const input = value?.[field];
    if (typeof input !== 'string' || !input || input.length > 240 || /[\u0000-\u001f\u007f]/.test(input)) throw fail('identity', '生图结果身份无效');
    if (['channelKey', 'requestDigest'].includes(field) && !/^[a-f0-9]{64}$/.test(input)) throw fail('identity', '生图结果指纹无效');
    result[field] = input;
  }
  return result;
}
const slotId = value => hash(JSON.stringify([value.namespace, value.channelKey, value.attemptId]));
async function checkedDirectory(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(target)) !== path.resolve(target)) throw fail('path', '生图结果目录已变化');
}
async function read(target, maximum) {
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw fail('corrupt', '生图结果文件类型或大小异常');
  const handle = await fs.open(target, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size !== before.size) throw fail('changed', '生图结果读取时发生变化');
    const buffer = Buffer.alloc(opened.size + 1); let length = 0;
    while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length !== opened.size) throw fail('changed', '生图结果数据不完整');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
function mime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216) return 'image/jpeg';
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(buffer.subarray(0,6).toString())) return 'image/gif';
  throw fail('image', '生图返回不是可保存的图片');
}
async function replace(folder, name, value, kind) {
  const temporary = path.join(folder, `.${kind}-${randomUUID()}.tmp`);
  let handle, created = false, renamed = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); created = true;
    await handle.writeFile(value); await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temporary, path.join(folder, name)); renamed = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created && !renamed) await fs.unlink(temporary).catch(cause => { if (!missing(cause)) throw cause; });
  }
}
async function sync(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export function createImageServiceResults({ dataRoot, store, maxSlots = 128, maxBytes = 512 * 1024 * 1024 } = {}) {
  if (!store?.exclusive || typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0') || path.resolve(dataRoot) === path.parse(path.resolve(dataRoot)).root) throw fail('storage', '缺少可信的生图结果存储');
  const slotLimit = Math.max(1, Math.min(128, Math.trunc(Number(maxSlots) || 128)));
  const byteLimit = Math.max(MAX_IMAGE_BYTES, Math.min(512 * 1024 * 1024, Math.trunc(Number(maxBytes) || 512 * 1024 * 1024)));
  async function locate(create = false) {
    const root = await fs.realpath(dataRoot), parent = path.join(root, '.qianmu-service'), results = path.join(parent, 'image-results-v1');
    for (const target of [parent, results]) {
      if (create) { try { await fs.mkdir(target, { mode: 0o700 }); } catch (cause) { if (cause?.code !== 'EEXIST') throw cause; } }
      try { await checkedDirectory(target); } catch (cause) { if (!create && missing(cause)) return null; throw cause; }
    }
    return results;
  }
  async function manifest(folder, expected) {
    await checkedDirectory(folder);
    const body = await read(path.join(folder, 'manifest.json'), 16 * 1024); let value;
    try { value = JSON.parse(body.toString()); } catch (_) { throw fail('corrupt', '生图结果清单损坏'); }
    if (value?.schema !== SCHEMA || !['reserved', 'remote', 'ready'].includes(value.status) || JSON.stringify(identity(value.identity)) !== JSON.stringify(expected)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_IMAGE_BYTES || !Array.isArray(value.images) || value.images.length > 8) throw fail('corrupt', '生图结果清单不匹配');
    if (value.status === 'reserved' && (value.bytes || value.images.length)) throw fail('corrupt', '结果预留状态无效');
    if (value.status !== 'reserved') {
      let total = 0, remote = false;
      if (!value.images.length || !value.result || typeof value.result.model !== 'string' || value.result.model.length > 240) throw fail('corrupt', '结果内容信息缺失');
      for (const [index, image] of value.images.entries()) {
        if (image.name !== `image-${index}.bin` || !Number.isSafeInteger(image.bytes) || image.bytes < 0 || image.bytes > MAX_IMAGE_BYTES) throw fail('corrupt', '图片清单无效');
        if (image.sourceUrl) {
          let url; try { url = new URL(image.sourceUrl); } catch (_) { throw fail('corrupt', '原图地址无效'); }
          if (typeof image.sourceUrl !== 'string' || image.sourceUrl.length > 4096 || url.protocol !== 'https:' || url.username || url.password || image.bytes) throw fail('corrupt', '原图地址无效');
          remote = true;
        } else if (image.bytes < 1 || !/^[a-f0-9]{64}$/.test(image.checksum || '') || !/^image\/(png|jpeg|webp|gif)$/.test(image.mime || '')) throw fail('corrupt', '图片校验信息无效');
        total += image.bytes;
      }
      if (total !== value.bytes || remote !== (value.status === 'remote')) throw fail('corrupt', '结果容量信息不一致');
    }
    return { value, receipt: hash(body) };
  }
  async function usage(root) {
    const stream = await fs.opendir(root); let count = 0, bytes = 0;
    for await (const entry of stream) {
      if (++count > slotLimit || !entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) throw fail('full', '生图暂存记录已满或需要核查');
      const folder = path.join(root, entry.name); await checkedDirectory(folder);
      // A partially created slot still reserves the full allowance; it is not free.
      let meta;
      try { meta = JSON.parse((await read(path.join(folder, 'manifest.json'), 16 * 1024)).toString()); }
      catch (cause) { if (!missing(cause)) throw cause; bytes += MAX_IMAGE_BYTES; continue; }
      if (slotId(identity(meta?.identity)) !== entry.name) throw fail('corrupt', '生图暂存归属不匹配');
      meta = (await manifest(folder, identity(meta.identity))).value;
      if (meta.status === 'ready') for (const image of meta.images) {
        const stat = await fs.lstat(path.join(folder, image.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== image.bytes) throw fail('corrupt', '原图容量与记录不符');
      }
      bytes += meta.status === 'ready' ? meta.bytes : MAX_IMAGE_BYTES;
    }
    return { count, bytes };
  }
  const exclusive = operation => store.exclusive(operation).catch(cause => { throw safeError(cause); });
  return {
    reserve(rawIdentity) {
      const captured = identity(rawIdentity);
      return exclusive(async () => {
        const root = await locate(true), folder = path.join(root, slotId(captured));
        try { await fs.lstat(folder); throw fail('exists', '原生图结果暂存已存在，请查询原请求'); } catch (cause) { if (!missing(cause)) throw cause; }
        const used = await usage(root);
        if (used.count >= slotLimit || used.bytes + MAX_IMAGE_BYTES > byteLimit) throw fail('full', '生图结果暂存已满，请先领取或清理旧结果');
        await fs.mkdir(folder, { mode: 0o700 });
        try {
          await replace(folder, 'manifest.json', JSON.stringify({ schema: SCHEMA, identity: captured, status: 'reserved', bytes: 0, images: [], createdAt: Date.now() }), 'manifest');
          await sync(folder); await sync(root);
        } catch (cause) {
          // This brand-new, still unpaid slot was created under our exclusive
          // lock. Remove only its own initial metadata if it is the sole file.
          try {
            await checkedDirectory(folder);
            const entries = await fs.readdir(folder, { withFileTypes: true });
            if (entries.length === 0) await fs.rmdir(folder);
            else if (entries.length === 1 && entries[0].name === 'manifest.json' && entries[0].isFile()) {
              await fs.unlink(path.join(folder, 'manifest.json')); await fs.rmdir(folder);
            }
          } catch (_) {}
          throw cause;
        }
      });
    },
    save(rawIdentity, result) {
      const captured = identity(rawIdentity);
      return exclusive(async () => {
        const root = await locate(), folder = root && path.join(root, slotId(captured));
        if (!folder) throw fail('missing', '原结果暂存不存在');
        const previous = await manifest(folder, captured);
        if (!['reserved', 'remote'].includes(previous.value.status)) throw fail('exists', '原结果已保存，未覆盖');
        if (!result?.ok || !Array.isArray(result.images) || !result.images.length || result.images.length > 8) throw fail('image', '生图结果不完整');
        let bytes = 0; const images = [];
        for (let index = 0; index < result.images.length; index++) {
          const image = result.images[index], encoded = image?.data;
          if (!encoded && image?.url) {
            let url; try { url = new URL(image.url); } catch (_) { throw fail('image', '原图地址无效'); }
            if (url.protocol !== 'https:' || url.username || url.password || String(image.url).length > 4096) throw fail('image', '原图地址无效');
            images.push({ name: `image-${index}.bin`, bytes: 0, sourceUrl: url.toString(), mime: /^image\/(png|jpeg|webp|gif)$/.test(image.mime || '') ? image.mime : 'image/png' });
            continue;
          }
          if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw fail('image', '图片数据尚未完整取回');
          const buffer = Buffer.from(encoded, 'base64');
          if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw fail('image', '图片编码不完整');
          bytes += buffer.length; if (bytes > MAX_IMAGE_BYTES) throw fail('full', '本次生图结果超过暂存上限');
          const type = mime(buffer), name = `image-${index}.bin`;
          await replace(folder, name, buffer, 'image');
          images.push({ name, bytes: buffer.length, checksum: hash(buffer), mime: type,
            ...(Number.isSafeInteger(image.width) && image.width > 0 && image.width <= 16384 ? { width: image.width } : {}),
            ...(Number.isSafeInteger(image.height) && image.height > 0 && image.height <= 16384 ? { height: image.height } : {}),
          });
        }
        const value = { ...previous.value, status: images.some(image => image.sourceUrl) ? 'remote' : 'ready', bytes, images, result: {
          provider: String(result.provider || '').slice(0,40), model: String(result.model || '').slice(0,240),
          upstreamId: String(result.upstreamId || '').slice(0,240), durationMs: Math.max(0, Math.min(3600000, Number(result.durationMs) || 0)),
        } };
        const serialized = JSON.stringify(value);
        await replace(folder, 'manifest.json', serialized, 'manifest'); await sync(folder);
        return { receipt: hash(serialized), bytes, imageCount: images.length, ready: value.status === 'ready' };
      });
    },
    load(rawIdentity, { metadataOnly = false } = {}) {
      const captured = identity(rawIdentity);
      return exclusive(async () => {
        const root = await locate(); if (!root) return null;
        const folder = path.join(root, slotId(captured));
        try { await fs.lstat(folder); } catch (cause) { if (missing(cause)) return null; throw cause; }
        const current = await manifest(folder, captured);
        if (metadataOnly) return { receipt: current.receipt, bytes: current.value.bytes, imageCount: current.value.images.length, ready: current.value.status === 'ready', remote: current.value.status === 'remote' };
        if (current.value.status === 'reserved') return null;
        let total = 0; const images = [];
        for (const [index, image] of current.value.images.entries()) {
          if (image.sourceUrl) { images.push({ id: `image-${index+1}`, mime: image.mime, data: '', url: image.sourceUrl }); continue; }
          if (image.name !== `image-${index}.bin` || !/^[a-f0-9]{64}$/.test(image.checksum || '') || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES) throw fail('corrupt', '生图文件清单无效');
          const buffer = await read(path.join(folder, image.name), MAX_IMAGE_BYTES); total += buffer.length;
          if (total > MAX_IMAGE_BYTES || buffer.length !== image.bytes || hash(buffer) !== image.checksum || mime(buffer) !== image.mime) throw fail('corrupt', '原图片校验失败，未重新生成');
          images.push({ id: `image-${index+1}`, mime: image.mime, data: buffer.toString('base64'), url: '', ...(image.width ? {width:image.width}:{}), ...(image.height ? {height:image.height}:{}) });
        }
        if (total !== current.value.bytes || !images.length) throw fail('corrupt', '原图片大小校验失败');
        return { ...current.value.result, ok: true, text: '', images, receipt: current.receipt, ready: current.value.status === 'ready' };
      });
    },
    discard(rawIdentity, receipt, { valid = () => true } = {}) {
      const captured = identity(rawIdentity);
      return exclusive(async () => {
        if (!valid()) throw fail('cancelled', '账户已变化，未清理暂存');
        const root = await locate(); if (!root) return { bytes: 0 };
        const folder = path.join(root, slotId(captured));
        try { await fs.lstat(folder); } catch (cause) { if (missing(cause)) return { bytes: 0 }; throw cause; }
        const current = await manifest(folder, captured);
        if (receipt !== current.receipt) throw fail('changed', '暂存结果已变化，未清理');
        const entries = await fs.opendir(folder), names = [];
        for await (const entry of entries) {
          if (names.length >= 26 || !entry.isFile() || !/^(?:manifest\.json|image-[0-7]\.bin|\.(?:manifest|image)-[a-f0-9-]{36}\.tmp)$/.test(entry.name)) throw fail('corrupt', '暂存目录含未知文件，未清理');
          names.push(entry.name);
        }
        // The directory is validated and every exact filename is checked. Keep the
        // manifest until last; a partial cleanup must never look like a free slot.
        if (!valid()) throw fail('cancelled', '账户已变化，未清理暂存');
        for (const name of names.filter(name => name !== 'manifest.json')) await fs.unlink(path.join(folder, name));
        await fs.unlink(path.join(folder, 'manifest.json')); await fs.rmdir(folder); await sync(root);
        return { bytes: current.value.bytes };
      });
    },
  };
}
