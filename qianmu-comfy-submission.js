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
