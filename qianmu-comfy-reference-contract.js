// Lightweight file receipts only. No image bytes, implicit avatars or network access.
export const COMFY_REFERENCE_LIMIT = 16;
export const COMFY_REFERENCE_BYTES = 16 * 1024 * 1024;
export const COMFY_REFERENCE_TOTAL = 48 * 1024 * 1024;
export const comfyReferenceError = message => Object.assign(new Error(message), { code: 'comfy_reference_binding', submissionState: 'not_submitted' });
const fail = message => { throw comfyReferenceError(message); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function comfyReferencePath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\?#]/.test(value)) fail('参考图须先保存到当前 ST');
  const path = value.startsWith('/') ? value : `/${value}`;
  if (!path.startsWith('/user/images/') || !/\.(png|jpe?g|webp)$/i.test(path)) fail('参考图须为当前 ST 的 PNG、JPEG 或 WebP 文件');
  for (const part of path.split('/').slice(1)) {
    let decoded; try { decoded = decodeURIComponent(part); } catch (_) { fail('参考图路径无效'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/%\u0000-\u001f\u007f]/.test(decoded)) fail('参考图路径无效');
  }
  return path;
}
export function normalizeComfyReferenceSelection(value) {
  if (value == null) return null;
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || !hash(value.workflowHash)
    || typeof value.namespace !== 'string' || !/^st-user:.+/.test(value.namespace) || value.namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(value.namespace)
    || !Array.isArray(value.items) || !value.items.length || value.items.length > COMFY_REFERENCE_LIMIT) fail('工作流参考配置无效，请重新选择');
  let total = 0;
  const items = value.items.map(item => {
    const normalized = normalizeStaticReferenceReceipt(item); total += normalized.bytes;
    return normalized;
  });
  if (total > COMFY_REFERENCE_TOTAL) fail('参考图总计须小于 48 MB');
  return { version: 1, enabled: value.enabled, namespace: value.namespace, workflowHash: value.workflowHash, items };
}
export function normalizeStaticReferenceReceipt(item) {
  if (!item || !hash(item.sha256) || !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > COMFY_REFERENCE_BYTES
    || !['image/png','image/jpeg','image/webp'].includes(item.mime) || typeof item.name !== 'string' || item.name.length > 120 || /[\u0000-\u001f\u007f]/.test(item.name)) fail('参考图记录无效，请重新选择');
  return { url: comfyReferencePath(item.url), name: item.name, mime: item.mime, bytes: item.bytes, sha256: item.sha256 };
}
export function retainComfyReferenceSelection(value) {
  try { return normalizeComfyReferenceSelection(value); }
  catch (_) { return { version: 0, invalid: true }; } // Preserve failure, never silently generate without an explicit binding.
}
