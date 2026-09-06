// Small immutable output contract, not a workflow or prompt snapshot. Shared by
// the accepted-task ledger and GET-only recovery; never accept UI overrides.
const nodeId = value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(value);
const fail = () => { throw Object.assign(new Error('Comfy 原任务收片约定缺失或无效，请核查原任务'), { code: 'comfy_receipt_invalid', submissionState: 'not_submitted' }); };
export function normalizeComfyReceipt(value) {
  const execution = value?.execution;
  if (value?.version !== 1 || typeof value.model !== 'string' || value.model.length > 240
    || !Array.isArray(value.previewNodeIds) || value.previewNodeIds.length > 512 || value.previewNodeIds.some(id => !nodeId(id))
    || new Set(value.previewNodeIds).size !== value.previewNodeIds.length
    || execution?.version !== 1 || typeof execution.automatic !== 'boolean'
    || !Number.isInteger(execution.maxImages) || execution.maxImages < 1 || execution.maxImages > 8
    || !Array.isArray(execution.outputNodeIds) || !execution.outputNodeIds.length || execution.outputNodeIds.length > 8
    || execution.outputNodeIds.some(id => !nodeId(id) || value.previewNodeIds.includes(id))
    || new Set(execution.outputNodeIds).size !== execution.outputNodeIds.length
    || (execution.expectedImages != null && (!Number.isInteger(execution.expectedImages) || execution.expectedImages < 1 || execution.expectedImages > execution.maxImages))
    || (execution.automatic && (execution.maxImages !== 1 || execution.expectedImages !== 1))) fail();
  const result = { version: 1, model: value.model, previewNodeIds: [...value.previewNodeIds], execution: {
    version: 1, automatic: execution.automatic, maxImages: execution.maxImages, outputNodeIds: [...execution.outputNodeIds],
    ...(execution.expectedImages != null ? { expectedImages: execution.expectedImages } : {}),
  } };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) fail();
  return result;
}
