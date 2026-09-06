// Shared native-Comfy result contract; no provider submission, storage or polling.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `comfy_${code}` }); };
const component = value => typeof value === 'string' && value.length > 0 && value.length <= 500
  && value !== '.' && value !== '..' && !/[\\/:\u0000-\u001f\u007f]/.test(value);
export const comfyTaskId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,240}$/.test(value) ? value : '';

// null means still waiting. Nonempty outputs alone never establish completion.
export function collectComfyStillResults(data, promptId, { workflow = {}, maxImages = 8, execution } = {}) {
  if (!object(data)) fail('invalid_history', 'ComfyUI 任务状态格式无效');
  if (!comfyTaskId(promptId)) fail('invalid_prompt_id', 'ComfyUI 任务编号无效');
  if (!Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 8) fail('invalid_output_limit', 'ComfyUI 收片上限无效');
  if (execution && (execution.version !== 1 || !Array.isArray(execution.outputNodeIds) || !execution.outputNodeIds.length
    || execution.outputNodeIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_:-]{1,120}$/.test(id))
    || !Number.isSafeInteger(execution.maxImages) || execution.maxImages < 1 || execution.maxImages > 8
    || (execution.expectedImages != null && (!Number.isSafeInteger(execution.expectedImages) || execution.expectedImages < 1 || execution.expectedImages > execution.maxImages)))) {
    fail('execution_contract', 'ComfyUI 收片约定无效，未读取成图');
  }
  const history = Object.hasOwn(data, promptId) ? data[promptId] : data.prompt_id === promptId ? data : null;
  if (history == null) {
    if (Object.hasOwn(data, 'prompt_id')) fail('history_mismatch', 'ComfyUI 返回了另一任务的状态，未收片');
    return null;
  }
  if (!object(history)) fail('invalid_history', 'ComfyUI 任务状态格式无效');
  if (history.prompt_id !== undefined && history.prompt_id !== promptId) fail('history_mismatch', 'ComfyUI 返回了另一任务的状态，未收片');
  const status = history.status;
  if (status?.status_str === 'error') fail('execution_failed', 'ComfyUI 工作流执行失败，请核查原任务');
  if (status?.completed !== true) return null;
  if (status.status_str && status.status_str !== 'success') fail('invalid_history', 'ComfyUI 未确认任务成功，未收片');
  if (!object(history.outputs)) fail('missing_final_image', 'ComfyUI 已结束，但未返回最终静帧');
  const rows = [], seen = new Set(), allSeen = new Set();
  const selected = execution ? new Set(execution.outputNodeIds) : null;
  if (execution) maxImages = execution.maxImages;
  for (const [nodeId, output] of Object.entries(history.outputs)) {
    if (workflow?.[nodeId]?.class_type === 'PreviewImage') continue;
    if (!object(output)) fail('invalid_output', 'ComfyUI 输出记录无效');
    if (output.images === undefined) continue; // gifs/audio/video never enter still archives.
    if (!Array.isArray(output.images)) fail('invalid_output', 'ComfyUI 图片记录无效');
    for (const item of output.images) {
      if (!object(item)) fail('invalid_output', 'ComfyUI 图片记录无效');
      if (item.type === 'temp' || item.type === 'input') continue;
      if (item.type !== 'output') fail('unclassified_output', 'ComfyUI 未标明最终输出位置，未将预览作为成图');
      const subfolder = item.subfolder ?? '';
      if (!component(item.filename) || typeof subfolder !== 'string' || subfolder.length > 500
        || (subfolder && !subfolder.split('/').every(component))) fail('invalid_output_path', 'ComfyUI 图片位置无效，未读取');
      if (!/\.(?:png|jpe?g|webp)$/i.test(item.filename)) continue;
      const identity = JSON.stringify([subfolder, item.filename]);
      allSeen.add(identity);
      if (allSeen.size > 8) fail('output_limit', 'ComfyUI 实际保存超过 8 张图片；请核查原任务，勿重复生成');
      if (selected && !selected.has(nodeId)) continue;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (rows.length >= maxImages) fail('output_limit', `ComfyUI 成图超过 ${maxImages} 张收片上限；原任务已执行，请到 ComfyUI 核查，勿重复生成`);
      rows.push({ filename: item.filename, subfolder, type: 'output' });
    }
  }
  if (!rows.length) fail('missing_final_image', 'ComfyUI 已结束，但只有预览、动画或无最终静帧');
  if (execution?.automatic && allSeen.size !== 1) fail('output_count_changed', 'ComfyUI 实际保存数超过自动单镜约定，请核查原任务，勿重复生成');
  if (execution?.expectedImages != null && rows.length !== execution.expectedImages) fail('output_count_changed', 'ComfyUI 实际成图数与核查结果不一致，请查看原任务，勿重复生成');
  return rows;
}

// Identify supported still containers from bytes, not filename or Content-Type.
// This is a container check, not an image decoder or integrity/CRC validator.
export function comfyStillMime(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) fail('invalid_image', 'ComfyUI 返回的静帧数据无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte)) {
    let end = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), kind = tag(offset + 4);
      if (offset + size + 12 > bytes.length) fail('invalid_image', 'ComfyUI PNG 数据不完整');
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') fail('animated_output', 'ComfyUI 返回了动画，未加入静帧阅片室');
      offset += size + 12;
      if (kind === 'IEND') { end = size === 0 && offset === bytes.length; break; }
    }
    if (!end) fail('invalid_image', 'ComfyUI PNG 数据不完整');
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length-2] === 255 && bytes[bytes.length-1] === 217) return 'image/jpeg';
  if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    if (view.getUint32(4, true) + 8 !== bytes.length) fail('invalid_image', 'ComfyUI WebP 数据不完整');
    let image = false, offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = tag(offset), size = view.getUint32(offset + 4, true), next = offset + 8 + size + (size % 2);
      if (next > bytes.length) fail('invalid_image', 'ComfyUI WebP 数据不完整');
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && size > 0 && (bytes[offset + 8] & 2))) fail('animated_output', 'ComfyUI 返回了动画，未加入静帧阅片室');
      if (kind === 'VP8 ' || kind === 'VP8L') image = size > 0;
      offset = next;
    }
    if (!image || offset !== bytes.length) fail('invalid_image', 'ComfyUI WebP 数据不完整');
    return 'image/webp';
  }
  fail('invalid_image', 'ComfyUI 返回的内容不是受支持的静帧图片');
}

export async function readComfyImageBytes(response, limit) {
  const tooLarge = () => fail('image_too_large', 'ComfyUI 原图总量超过收片上限，请到 ComfyUI 获取原图，勿重复生成');
  if (!Number.isSafeInteger(limit) || limit < 0) tooLarge();
  if (Number(response.headers?.get?.('content-length')) > limit) { await response.body?.cancel?.().catch(() => {}); tooLarge(); }
  const reader = response.body?.getReader?.();
  if (!reader) { const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > limit) tooLarge(); return bytes; }
  const parts = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel().catch(() => {}); tooLarge(); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

// Reference-specific single-frame evidence; not an image decoder. JPEG MPF/MPO
// and appended streams cannot count as one native LoadImage result.
export function comfyReferenceStillMime(bytes) {
  const mime = comfyStillMime(bytes); if (mime !== 'image/jpeg') return mime;
  const invalid = () => fail('invalid_reference_image', 'Comfy 参考图须为完整的单帧图片，请将该文件另存为静态 PNG 后重试');
  let at = 2, scan = false, frame = false;
  while (at < bytes.length) {
    if (bytes[at++] !== 255) invalid();
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217) { if (at !== bytes.length || !scan || !frame) invalid(); return mime; }
    if (marker === 216 || marker === 0 || at + 2 > bytes.length) invalid();
    const length = bytes[at] * 256 + bytes[at+1];
    if (length < 2 || at + length > bytes.length) invalid();
    if (marker === 226 && length >= 6 && [77,80,70,0].every((byte,index) => bytes[at+2+index] === byte)) invalid();
    if (marker >= 192 && marker <= 207 && ![196,200,204].includes(marker)) { if (frame) invalid(); frame = true; }
    at += length;
    if (marker === 218) {
      scan = true;
      while (at < bytes.length) {
        if (bytes[at] !== 255) { at++; continue; }
        if (bytes[at+1] === 0 || bytes[at+1] >= 208 && bytes[at+1] <= 215) { at += 2; continue; }
        break;
      }
    }
  }
  invalid();
}
