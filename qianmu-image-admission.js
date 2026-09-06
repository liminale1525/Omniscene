import { createImageAttemptStore } from './qianmu-image-attempt-store.js';
import { imageAttemptScopeKey } from './qianmu-image-attempts.js';

const error = (code, message) => Object.assign(new Error(message), { code: `image_attempt_${code}` });
const MESSAGES = {
  busy: '此画面已在等待或生成中', already_generated: '此画面已生成，自动流程不重复提交',
  budget_exhausted: '本层自动插图已达上限，未追加生图',
  confirmation_required: '原请求结果未确认，请先核对渠道记录',
  ledger_full: '本层生图防重记录已满，请在存储管理中核查',
  storage_full: '生图防重记录已满，请在存储管理中核查',
};
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
async function digest(value) {
  if (!globalThis.crypto?.subtle) throw error('identity', '当前环境不能安全识别生图请求，请使用 HTTPS 或本机地址');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Read the actual ST account, never a character/persona name. In account mode
// user.js's default handle is also used while loading, so it is not sufficient.
export async function resolveImageAccountNamespace({ loadUser = () => import('/scripts/user.js'), fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  let handle, expired = false, timer;
  const controller = new AbortController();
  const deadline = new Promise(resolve => { timer = setTimeout(() => { expired = true; controller.abort(); resolve(null); }, Math.max(100, Math.min(15000, Number(timeoutMs) || 6000))); });
  try {
    const userModule = await Promise.race([Promise.resolve().then(loadUser).catch(() => null), deadline]);
    handle = userModule?.currentUser?.handle;
    // accountsEnabled starts as false before ST initializes it. Missing user
    // data therefore always requires a verified authenticated response.
    if (!handle && !expired) {
      const response = await Promise.race([fetchImpl('/api/users/me', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }), deadline]);
      if (response?.ok) handle = (await Promise.race([response.json(), deadline]))?.handle;
    }
  } catch (_) { /* Do not invent a shared identity on auth/network failure. */ }
  finally { clearTimeout(timer); }
  if (typeof handle !== 'string' || !handle.trim() || handle.length > 160 || /[\u0000-\u001f]/.test(handle)) throw error('account', '暂未确认当前 ST 账户，未提交生图，请稍后重试');
  return `st-user:${handle}`;
}

export async function manageImageAdmissionStorage(options = {}) {
  const namespace = await resolveImageAccountNamespace();
  const store = createImageAttemptStore();
  try { return await store.manage(namespace, options); }
  finally { store.close(); }
}

export async function createImageAdmissionIdentity(job, namespace) {
  const ref = job.messageRef;
  let scope;
  if (ref?.messageKey && ref?.revisionId) {
    scope = { namespace, chatKey: job.chatKey, messageKey: ref.messageKey, revisionId: ref.revisionId };
  } else if (job.target === 'gallery' && !job.automatic) {
    scope = { namespace, chatKey: job.chatKey || 'gallery', messageKey: 'gallery-only', revisionId: 'manual' };
  } else throw error('identity', '缺少原正文身份，未授权生图');
  imageAttemptScopeKey(scope);
  const old = job.imageAdmission;
  const sameScope = old?.version === 1 && old.chatKey === scope.chatKey && old.messageKey === scope.messageKey && old.revisionId === scope.revisionId;
  const spec = job.shotSpec || {};
  const logicalShotId = sameScope && /^[a-f0-9]{64}$/.test(old.logicalShotId || '') ? old.logicalShotId : await digest({
    paragraph: job.paragraphSelection || job.paragraphAnchor || null,
    scene: spec.sceneFingerprint || null, subject: spec.subject || job.originalPrompt || job.prompt || job.payload?.prompt || '',
    framing: job.shotType || spec.shotRole || 'custom', camera: spec.promptAtoms?.camera || [],
    variant: Number(job.requestIndex) || 1,
  });
  // Identity deliberately excludes artist/model/seed: a new rendition is still
  // a version of the same narrative shot, not another automatic budget slot.
  return { scope, logicalShotId, operationKey: logicalShotId };
}

export async function createImageHistorySeeds(rows, identity) {
  const seeds = [], seen = new Set();
  const coveredImages = new Set(rows.filter(row => row.snapshot && !row.url).flatMap(row => [row.recordId, ...(row.recordIds || [])]).filter(Boolean));
  for (const row of rows) {
    if (row.url && coveredImages.has(row.id)) continue;
    const job = { ...row, ...(row.snapshot || {}) };
    const ref = job.messageRef || row.messageRef;
    if (String(job.chatKey || row.chatKey || '') !== identity.scope.chatKey
      || ref?.messageKey !== identity.scope.messageKey || ref?.revisionId !== identity.scope.revisionId) continue;
    const state = row.status === 'success' || row.status === 'completed' || row.url ? 'succeeded'
      : ['unknown', 'accepted'].includes(row.submissionState) ? row.submissionState
        : ['generating', 'queued'].includes(row.status) || (!row.submissionState && ['failed', 'cancelled'].includes(row.status) && Number(row.startedAt) > 0) ? 'unknown' : null;
    if (!state) continue;
    const saved = job.imageAdmission;
    const attemptId = saved?.version === 1 && typeof saved.attemptId === 'string' ? saved.attemptId : `history-${await digest(row.logId || (row.url && (row.groupId || row.taskId)) || row.id)}`;
    if (seen.has(attemptId)) continue;
    seen.add(attemptId);
    const derived = await createImageAdmissionIdentity({ ...job, messageRef: ref, chatKey: identity.scope.chatKey }, identity.scope.namespace);
    seeds.push({ attemptId, logicalShotId: derived.logicalShotId, operationKey: derived.operationKey, status: state,
      // Unknown legacy provenance is counted conservatively. Explicit manual
      // work from this version does not spend automatic slots.
      automaticSlot: saved?.version === 1 ? Boolean(saved.automaticSlot) : job.automatic !== false && !['manual', 'manual_supplement'].includes(job.origin) });
    if (seeds.length > 256) throw error('history', '旧生图记录过多，请先核查并整理');
  }
  return seeds;
}

export function createImageAdmission({ store = createImageAttemptStore(), account = resolveImageAccountNamespace,
  ownerId = globalThis.crypto?.randomUUID?.(), confirm = async () => false } = {}) {
  const receipts = new WeakMap(), preparing = new WeakSet(), live = new Set();
  let closed = false;
  const current = (valid) => { if (closed || !valid()) throw error('cancelled', '生图上下文已变化，未继续提交'); };
  return {
    async admit(job, { maxAutomatic, history = [], valid = () => true } = {}) {
      if (preparing.has(job) || receipts.has(job)) throw error('busy', MESSAGES.busy);
      preparing.add(job);
      let receipt;
      try {
        current(valid);
        const identity = await createImageAdmissionIdentity(job, await account());
        const seeds = await createImageHistorySeeds(history, identity);
        current(valid);
        const kind = job.automatic ? 'automatic' : job.imageAdmission || job.variantRootId || Number(job.attempt) > 1 ? 'redraw' : job.manualSupplement ? 'supplement' : 'manual';
        const input = { attemptId: job.id, logicalShotId: identity.logicalShotId, operationKey: identity.operationKey,
          ownerId, kind, maxAutomatic, imageCount: Number(job.payload?.parameters?.count ?? job.profile?.count ?? 1) };
        let decision = await store.claim(identity.scope, input, seeds), confirmedAttempts = [];
        if (!decision.ok && decision.code === 'confirmation_required' && !job.automatic) {
          current(valid);
          if (await confirm('确认重新生图', '原请求可能已受理或扣费。请先核对渠道记录；继续会发起一次新的生图请求。')) {
            current(valid);
            confirmedAttempts = JSON.parse(decision.confirmation).map(row => row[0]);
            decision = await store.claim(identity.scope, { ...input, confirmation: decision.confirmation }, seeds);
          }
        }
        if (!decision.ok) throw error(decision.code, MESSAGES[decision.code] || '未取得本次生图授权，请核查原任务');
        receipt = { ...identity, attemptId: input.attemptId, ownerId, begun: false };
        current(valid);
        receipts.set(job, receipt);
        live.add(job);
        job.imageAdmission = { version: 1, ...identity.scope, logicalShotId: identity.logicalShotId,
          attemptId: input.attemptId, automaticSlot: decision.attempt.automaticSlot };
        // Live consent only: start-log's explicit snapshot whitelist excludes it.
        job.confirmedImageAttempts = confirmedAttempts;
        return true;
      } catch (failure) {
        if (receipt) await store.settle(receipt.scope, { ...receipt, outcome: 'not_submitted' });
        throw failure;
      } finally { preparing.delete(job); }
    },
    async beforeSubmit(job, valid = () => true) {
      const receipt = receipts.get(job);
      current(valid);
      if (!receipt) throw error('missing_reservation', '生图请求缺少有效授权，未继续提交');
      if (await account() !== receipt.scope.namespace) throw error('account_changed', 'ST 账户已变化，未继续提交');
      current(valid);
      const decision = await store[receipt.begun ? 'continue' : 'begin'](receipt.scope, receipt);
      if (!decision.ok) throw error(decision.code, '生图授权已失效，未继续提交');
      receipt.begun = true;
      current(valid);
    },
    async settle(job, outcome) {
      const receipt = receipts.get(job);
      if (!receipt) return;
      const decision = await store.settle(receipt.scope, { ...receipt, outcome });
      if (!decision.ok) throw error(decision.code, '生图受理记录未完成结算，请核对渠道记录');
      if (outcome !== 'accepted') { receipts.delete(job); live.delete(job); }
    },
    async close() {
      closed = true;
      await Promise.allSettled([...live].map(job => {
        const receipt = receipts.get(job);
        return store.settle(receipt.scope, { ...receipt, outcome: receipt.begun ? 'unknown' : 'not_submitted' });
      }));
      live.clear(); store.close();
    },
    async confirmResult(saved) {
      if (!saved || saved.version !== 1 || await account() !== saved.namespace) throw error('account_changed', '原生图账户不匹配');
      const decision = await store.confirmResult({ namespace: saved.namespace, chatKey: saved.chatKey, messageKey: saved.messageKey, revisionId: saved.revisionId },
        { attemptId: saved.attemptId, logicalShotId: saved.logicalShotId });
      if (!decision.ok) throw error('identity', '原图与本地请求记录不匹配，未修改保护记录');
      return decision;
    },
  };
}
