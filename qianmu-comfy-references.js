// Explicitly selected, immutable ST files. Loaded only for Comfy reference work.
import { inspectComfyWorkflow } from './qianmu-comfy-workflow.js';
import { comfyReferenceStillMime } from './qianmu-comfy-results.js';
import { normalizeComfyReferenceSelection, comfyReferencePath, comfyReferenceError, COMFY_REFERENCE_BYTES, COMFY_REFERENCE_TOTAL } from './qianmu-comfy-reference-contract.js';
const fail = message => { throw comfyReferenceError(message); };
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2,'0')).join('');
const base64 = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return btoa(text); };
function mimeOf(bytes) {
  try { return comfyReferenceStillMime(bytes); } catch (_) { fail('参考图须为完整静态 PNG、JPEG 或 WebP，不支持动画或多帧图片'); }
}
export async function comfyWorkflowReferenceHash(workflow) {
  const result = inspectComfyWorkflow(workflow); if (!result.ok) fail(result.message);
  // Preserve the exact saved document: even a graph edit requires explicit reconfirmation.
  return digest(new TextEncoder().encode(JSON.stringify(typeof workflow === 'string' ? JSON.parse(workflow) : workflow)));
}
export async function checkComfyReferenceSelection({workflow,selection,namespace}) {
  const saved = normalizeComfyReferenceSelection(selection);
  if (!saved || !saved.enabled) return [];
  if (saved.namespace !== namespace) fail('参考图属于另一 ST 账户，请在当前账户重新选择');
  if (await comfyWorkflowReferenceHash(workflow) !== saved.workflowHash) fail('参考图绑定的工作流已变化，请确认重新绑定或移除');
  return saved.enabled ? saved.items : [];
}
export async function saveComfyReferenceFiles(files, {workflow,namespace,save,guard = async () => {}}) {
  if (typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)) fail('请先确认当前 ST 账户');
  const captured = Array.from(files || []);
  if (!captured.length || captured.length > 16 || captured.some(file => !Number.isInteger(file.size) || file.size < 1 || file.size > COMFY_REFERENCE_BYTES)
    || captured.reduce((sum,file) => sum + file.size, 0) > COMFY_REFERENCE_TOTAL) fail('最多 16 张参考图，单张 16 MB、总计 48 MB 以内');
  const inspection = inspectComfyWorkflow(workflow);
  if (!inspection.ok || !inspection.capabilities.reference) fail('当前工作流没有接入参考图槽位');
  const workflowHash = await comfyWorkflowReferenceHash(workflow); await guard();
  const items = [];
  for (const file of captured) {
    await guard(); const bytes = new Uint8Array(await file.arrayBuffer()); await guard();
    if (bytes.byteLength !== file.size) fail('参考图文件读取不完整');
    const mime = mimeOf(bytes), sha256 = await digest(bytes); await guard();
    const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
    const url = comfyReferencePath(await save({ data: base64(bytes), mime, filename: `qianmu_reference_${sha256}`, extension })); await guard();
    items.push({ url, name: String(file.name || '参考图').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120), mime, bytes: bytes.length, sha256 });
  }
  return normalizeComfyReferenceSelection({ version: 1, enabled: true, namespace, workflowHash, items });
}
export async function readComfyReferenceImages({workflow,selection,namespace,guard = async () => {},fetchImpl = fetch, timeoutMs = 30000}) {
  const items = await checkComfyReferenceSelection({workflow,selection,namespace}); await guard();
  const images = [];
  for (const item of items) {
    await guard(); const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(30000, Math.max(1000, timeoutMs)));
    try {
      const response = await fetchImpl(item.url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.ok || !response.body) fail('参考图文件已不可读取，请重新选择');
      const declared = Number(response.headers.get('content-length'));
      if (declared > COMFY_REFERENCE_BYTES) { await response.body.cancel(); fail('参考图文件超过 16 MB'); }
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
        if (length > COMFY_REFERENCE_BYTES || length > item.bytes) fail('参考图文件内容已变化，请重新选择');
        chunks.push(next.value); await guard();
      } } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk,at); at += chunk.byteLength; }
      if (length !== item.bytes || mimeOf(bytes) !== item.mime || await digest(bytes) !== item.sha256) fail('参考图文件内容已变化，请重新选择');
      await guard(); images.push({ data: base64(bytes), mime: item.mime, name: `reference-${images.length+1}.${item.mime === 'image/jpeg' ? 'jpg' : item.mime.split('/')[1]}` });
    } catch (error) { if (error.code === 'comfy_reference_binding') throw error; fail('参考图读取中断，请稍后重试，尚未提交生成'); }
    finally { clearTimeout(timer); }
  }
  return images;
}
