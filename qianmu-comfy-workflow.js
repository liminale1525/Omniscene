// Qianmu's explicit API Workflow input slots. No node-name guessing, network or persistence.
const LIMIT = 2 * 1024 * 1024;
const TOKEN = /%qianmu_[^%\r\n]*%/g;
const SLOTS = new Set(['prompt', 'negative', 'model', 'seed', 'width', 'height', 'steps', 'scale', 'cfg', 'sampler', 'scheduler', 'count', 'reference', 'references']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function mapValues(value, visit, depth = 0) {
  if (depth > 64) fail('invalid_workflow', 'ComfyUI 工作流嵌套过深');
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map(item => mapValues(item, visit, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapValues(item, visit, depth + 1)]));
  return value;
}

function scanValues(value, visit, depth = 0) {
  if (depth > 64) fail('invalid_workflow', 'ComfyUI 工作流嵌套过深');
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) { for (const item of value) scanValues(item, visit, depth + 1); }
  else if (object(value)) { for (const item of Object.values(value)) scanValues(item, visit, depth + 1); }
}

function analyze(value) {
  let serialized;
  try { serialized = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? {}); }
  catch (_) { fail('invalid_workflow', 'ComfyUI API Workflow 必须是有效的 JSON'); }
  if (!serialized || serialized === '{}') fail('missing_workflow', '请导入 ComfyUI API Workflow');
  if (serialized.length > LIMIT) fail('invalid_workflow', 'ComfyUI 工作流过大');
  let workflow;
  try { workflow = JSON.parse(serialized); }
  catch (_) { fail('invalid_workflow', 'ComfyUI API Workflow 必须是有效的 JSON'); }
  if (!object(workflow) || Array.isArray(workflow.nodes) || !Object.keys(workflow).length) fail('invalid_workflow', '请使用 ComfyUI 的 API 格式工作流');
  const slots = new Set(); let nodes = 0;
  // Only inputs affect execution. Titles, node IDs, class_type and other metadata are not slots.
  for (const node of Object.values(workflow)) {
    if (!object(node?.inputs)) continue;
    nodes++;
    scanValues(node.inputs, text => {
      if (text.replace(TOKEN, '').includes('%qianmu_')) fail('comfy_unknown_slot', '工作流含不完整的千幕槽位，请核对占位符');
      for (const [token] of text.matchAll(TOKEN)) {
        const slot = token.slice(8, -1);
        if (!SLOTS.has(slot) && !/^reference_(?:[1-9]|1[0-6])$/.test(slot)) fail('comfy_unknown_slot', '工作流含未支持的千幕槽位，请核对占位符');
        if (slot === 'references' && text !== token) fail('comfy_reference_slot_type', '%qianmu_references% 必须单独作为输入值');
        slots.add(slot);
      }
      return text;
    });
  }
  if (!nodes) fail('invalid_workflow', '工作流缺少节点 inputs，请使用 API 格式');
  // Check the rest of the document's depth too; do not interpret its text as input slots.
  scanValues(workflow, () => {});
  return { workflow, slots };
}

function capabilities(slots = new Set()) {
  const has = key => slots.has(key);
  const indexed = [...slots].filter(key => /^reference_\d+$/.test(key)).map(key => Number(key.slice(10)));
  const reference = has('reference') || has('references') || indexed.length > 0;
  return Object.freeze({
    prompt: has('prompt'), negative: has('negative'), width: has('width'), height: has('height'),
    size: has('width') && has('height'), ratio: has('width') && has('height'), count: has('count'),
    seed: has('seed'), steps: has('steps'), cfg: has('cfg') || has('scale'), sampler: has('sampler'), scheduler: has('scheduler'),
    reference: Boolean(reference), multipleReferences: has('references') || indexed.some(index => index > 1),
    imageEdit: Boolean(reference), mask: false, vibe: false, preciseReference: false,
    supportsNativeNegative: has('negative'), supportsExclusionText: false, supportsArtistSyntax: false, supportsVibe: false,
    referenceMode: reference ? 'workflow' : 'none',
  });
}

export function inspectComfyWorkflow(value) {
  try {
    const { slots } = analyze(value);
    return { ok: true, slots: Object.freeze([...slots]), capabilities: capabilities(slots), code: '', message: slots.has('prompt') ? '' : '工作流未接入 %qianmu_prompt%，当前画面提示词无法生效' };
  } catch (error) {
    return { ok: false, slots: Object.freeze([]), capabilities: capabilities(), code: error.code, message: error.message };
  }
}

// Prepared once before any upload/DNS await. bind() substitutes uploaded names into a private snapshot.
export function prepareComfyWorkflow(value, input = {}) {
  const { workflow, slots } = analyze(value);
  if (!slots.has('prompt')) fail('comfy_prompt_slot_missing', '工作流未接入 %qianmu_prompt%，无法使用当前画面提示词');
  const count = input.referenceCount ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > 16) fail('comfy_reference_count', 'ComfyUI 参考图数量须为 0 至 16 张');
  const used = new Set();
  for (const slot of slots) {
    if (slot === 'references') {
      if (!count) fail('comfy_reference_missing', '工作流需要参考图，请先选择图片');
      for (let index = 1; index <= count; index++) used.add(index);
    } else if (slot === 'reference' || /^reference_\d+$/.test(slot)) {
      const index = slot === 'reference' ? 1 : Number(slot.slice(10));
      if (index > count) fail('comfy_reference_missing', `工作流缺少第 ${index} 张参考图`);
      used.add(index);
    }
  }
  if (used.size !== count) fail('comfy_reference_unused', '所选参考图未全部接入工作流，请检查参考槽位');
  const p = object(input.parameters) ? input.parameters : {};
  const number = (value, min, max, fallback, integer = false) => {
    const n = value === '' || value == null ? fallback : Number(value);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail('comfy_invalid_parameter', '工作流参数超出范围或格式无效');
    return n;
  };
  const replacements = { prompt: String(input.prompt ?? ''), negative: String(input.negativePrompt ?? ''), model: String(input.model ?? '') };
  const definitions = {
    width: [p.width, 64, 8192, 1024, true], height: [p.height, 64, 8192, 1024, true],
    steps: [p.steps, 1, 300, 28, true], count: [p.count, 1, 4, 1, true], seed: [p.seed, -1, Number.MAX_SAFE_INTEGER, -1, true],
    cfg: [p.scale === '' || p.scale == null ? p.cfg : p.scale, 0, 100, 5],
  };
  for (const [key, args] of Object.entries(definitions)) {
    if (slots.has(key) || (key === 'cfg' && slots.has('scale'))) replacements[key] = number(...args);
  }
  if (replacements.seed === -1) replacements.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  replacements.scale = replacements.cfg;
  for (const key of ['sampler', 'scheduler']) {
    if (!slots.has(key)) continue;
    replacements[key] = String(p[key] ?? '').trim();
    if (!replacements[key]) fail('comfy_parameter_missing', `请填写工作流所需的 ${key === 'sampler' ? 'Sampler' : 'Scheduler'}`);
  }
  if (slots.has('model') && (!replacements.model || replacements.model === 'comfy-workflow')) fail('comfy_model_slot_unbound', '请在工作流中设置实际模型；comfy-workflow 不是模型文件名');
  return Object.freeze({
    capabilities: capabilities(slots),
    bind(referenceNames = []) {
      if (!Array.isArray(referenceNames) || referenceNames.length !== count || referenceNames.some(name => typeof name !== 'string' || !name)) fail('comfy_reference_missing', '参考图上传结果不完整，未提交工作流');
      const values = { ...replacements, reference: referenceNames[0] || '', references: [...referenceNames],
        ...Object.fromEntries(referenceNames.map((name, index) => [`reference_${index + 1}`, name])) };
      return Object.fromEntries(Object.entries(workflow).map(([key, node]) => [key,
        object(node?.inputs) ? { ...mapValues(node, text => text), inputs: mapValues(node.inputs, text => {
          const slot = text.match(/^%qianmu_([A-Za-z0-9_]+)%$/)?.[1];
          if (slot && Object.hasOwn(values, slot)) return Array.isArray(values[slot]) ? [...values[slot]] : values[slot];
          // One pass: text inserted from a prompt is literal, never a second template.
          return text.replace(TOKEN, token => String(values[token.slice(8, -1)] ?? ''));
        }) } : mapValues(node, text => text),
      ]));
    },
  });
}
