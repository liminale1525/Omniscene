// Lazy, identity-only preparation. No workflow copy, storage or provider IO.
import { resolveImageAccountNamespace } from './qianmu-image-admission.js';
import { imageChannelKey } from './qianmu-image-channel.js';

export async function prepareComfySubmission(job, { account = resolveImageAccountNamespace } = {}) {
  const saved = job?.imageAdmission, namespace = saved?.namespace;
  const fail = () => Object.assign(new Error('Comfy 原请求身份或 ST 账户已变化，未提交'), { code: 'comfy_submission_identity', submissionState: 'not_submitted' });
  if (job?.source !== 'comfy' || saved?.version !== 1 || !/^st-user:.+/.test(namespace || '')
    || !/^[a-zA-Z0-9_-]{1,240}$/.test(saved?.attemptId || '') || saved.attemptId !== job.id) throw fail();
  const attemptId = saved.attemptId, automatic = Boolean(job.automatic);
  if (await account() !== namespace) throw fail();
  const expectedAccount = `st-user:${await imageChannelKey(namespace.slice(8))}`;
  if (await account() !== namespace) throw fail();
  return { version: 1, expectedAccount, attemptId, automatic };
}

export async function assertComfyAccount(job, { account = resolveImageAccountNamespace } = {}) {
  if (!job?.imageAdmission?.namespace || await account() !== job.imageAdmission.namespace) throw Object.assign(new Error('ST 账户已变化，请回原账户领取 Comfy 原图'), { code: 'comfy_delivery_account', submissionState: 'accepted' });
}

export async function comfyArchiveFilename(job, index) {
  if (!job?.imageAdmission?.namespace || job.imageAdmission.attemptId !== job.id || !Number.isInteger(index) || index < 0 || index > 7) throw Error('Comfy 原图文件身份不完整');
  return `qianmu_comfy_${await imageChannelKey(JSON.stringify([job.imageAdmission.namespace, job.id]))}_${index + 1}`;
}

export async function acknowledgeComfyImage(job, data, { account = resolveImageAccountNamespace, fetchImpl = globalThis.fetch, headers = () => ({}) } = {}) {
  if (!data?.comfyTask?.resultStored || !/^[a-f0-9]{64}$/.test(data.comfyTask.receipt || '')) return '';
  const receipt = data.comfyTask.receipt, attemptId = data.comfyTask.attemptId, baseUrl = job.connection?.baseUrl;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    if (attemptId !== job.id) throw Error('identity');
    const binding = await prepareComfySubmission(job, { account });
    const response = await fetchImpl('/api/plugins/qianmu-tts/image/comfy/tasks/acknowledge', { method: 'POST',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: headers(),
      body: JSON.stringify({ ...binding, baseUrl, receipt, archived: true }),
    });
    // This endpoint has only small metadata. Do not consume arbitrary upstream
    // content and never include a Key in a cache acknowledgement.
    const reader = response.body?.getReader(); let bytes = 0; const chunks = [];
    if (!reader) throw Error('empty');
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 16384) throw Error('large'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    const result = JSON.parse(new TextDecoder().decode(body));
    await assertComfyAccount(job, { account });
    if (!response.ok || result?.ok !== true) throw Error('failed');
    return '';
  } catch (_) { return '原图已归档；服务器暂存仍保留，可稍后确认领取'; }
  finally { clearTimeout(timer); }
}
