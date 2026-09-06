// Optional preparation only. The caller must still run node readiness, output auditing and admission before dispatch.
import {normalizeComfyCharacterWorkflow,normalizeComfyCharacterSnapshot,comfyCharacterError} from './qianmu-comfy-character-contract.js';
import {comfyWorkflowReferenceHash,checkComfyReferenceSelection} from './qianmu-comfy-references.js';
import {inspectComfyWorkflow,prepareComfyWorkflow} from './qianmu-comfy-workflow.js';
import {normalizeComfyReferenceSelection} from './qianmu-comfy-reference-contract.js';

const fail = message => { throw comfyCharacterError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const sameWorkflow = (a,b) => ['id','revision','version','hash'].every(key => a[key] === b[key]);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Metadata for an editor, not remote capability detection or a generated node graph.
export function inspectComfyCharacterTargets(workflow) {
  const inspected = inspectComfyWorkflow(workflow); if (!inspected.ok) fail(inspected.message);
  const graph = typeof workflow === 'string' ? JSON.parse(workflow) : workflow;
  if (Object.keys(graph).length > 512) fail('角色实现仅接受工作流库内 512 个节点以内的工作流');
  const loras = [], conditioning = [], referenceSlots = new Set();
  for (const [nodeId,node] of Object.entries(graph)) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    if (node.class_type === 'LoadImage') {
      const token = /^%qianmu_reference(?:_([1-9]|1[0-6]))?%$/.exec(inputs.image);
      if (token) referenceSlots.add(Number(token[1] || 1));
    }
    if (['LoraLoader','LoraLoaderModelOnly'].includes(node.class_type)) loras.push({nodeId,classType:node.class_type,
      neutral:inputs.strength_model === 0 && (node.class_type !== 'LoraLoader' || inputs.strength_clip === 0)});
    if (node.class_type === 'CLIPTextEncode' && typeof inputs.text === 'string') conditioning.push({nodeId,neutral:inputs.text === ''});
  }
  return {referenceSlots:[...referenceSlots].sort((a,b)=>a-b),loras,conditioning};
}

export async function prepareComfyCharacterPlan({workflow,workflowIdentity,namespace,shot,staticSelection=null,parameters={},model='',safetyAdapted=false,guard=async()=>{}}={}) {
  // Capture all inputs before yielding: neither a late archive edit nor a caller-owned object mutation may mix versions.
  const captured = clone({workflow,workflowIdentity,namespace,shot,staticSelection,parameters,model,safetyAdapted});
  await guard();
  const identity = normalizeComfyCharacterWorkflow(captured.workflowIdentity);
  if (typeof captured.namespace !== 'string' || !/^st-user:.+/.test(captured.namespace) || captured.namespace.length > 512
    || /[\u0000-\u001f\u007f]/.test(captured.namespace)) fail('请先确认当前 ST 账户');
  const originalHash = await comfyWorkflowReferenceHash(captured.workflow); await guard();
  if (originalHash !== identity.hash) fail('工作流内容已变化，请重新绑定角色实现');
  const targets = inspectComfyCharacterTargets(captured.workflow);
  const graph = typeof captured.workflow === 'string' ? JSON.parse(captured.workflow) : captured.workflow;
  const staticItems = await checkComfyReferenceSelection({workflow:graph,selection:captured.staticSelection,namespace:captured.namespace}); await guard();
  const slots = new Map(staticItems.map((item,index)=>[index+1,item])), assignedNodes = new Set(), participants = [], seen = new Set();
  const characters = captured.shot?.characters;
  if (!Array.isArray(characters) || characters.length > 64) fail('本镜人物信息无效，请重新提取');
  for (const character of characters.filter(row=>row?.visible !== false)) {
    const archive = character?.archiveSnapshot;
    if (!archive) continue;
    if (archive.invalid || typeof character.id !== 'string' || archive.subjectId !== character.id || character.id !== `archive:${archive.archiveId}`
      || !Number.isSafeInteger(archive.archiveVersion) || archive.archiveVersion < 1 || seen.has(character.id)) fail('本镜角色快照无效或人物重复');
    seen.add(character.id);
    if (!Object.hasOwn(archive,'comfyImplementation')) fail('旧镜头未保存 Comfy 角色实现，请重新提取后使用');
    const snapshot = normalizeComfyCharacterSnapshot(archive.comfyImplementation);
    if (snapshot.namespace !== captured.namespace) fail('角色实现属于另一 ST 账户，请重新提取');
    const implementation = snapshot.implementations.find(row=>sameWorkflow(row.workflow,identity));
    if (!implementation) {
      if (snapshot.implementations.length) fail(`角色 ${archive.name || character.id} 未绑定当前工作流版本`);
      continue; // Explicitly captured absence, never a fresh read from today's archive.
    }
    if (captured.safetyAdapted || captured.shot?.sensitive) fail('此镜头须先核对 Comfy 角色附加内容；安全资格接通前不自动携带');
    const claim = nodeId => { if (assignedNodes.has(nodeId)) fail('两个人物占用了同一角色节点，请调整工作流绑定'); assignedNodes.add(nodeId); };
    if (implementation.referenceSlot !== null) {
      const slot = implementation.referenceSlot;
      if (!targets.referenceSlots.includes(slot)) fail('角色参考槽已缺失或不是明确的 LoadImage 输入');
      if (!snapshot.reference) fail(`角色 ${archive.name || character.id} 未保存参考图`);
      if (slots.has(slot)) fail('角色参考槽与另一人物或工作流参考图冲突');
      slots.set(slot,snapshot.reference);
    }
    for (const row of implementation.loras) {
      const target = targets.loras.find(item=>item.nodeId===row.nodeId && item.classType===row.classType);
      if (!target || !target.neutral) fail('角色 LoRA 节点须存在且原始强度为 0，避免未出镜人物残留');
      claim(row.nodeId); const inputs = graph[row.nodeId].inputs;
      inputs.lora_name = row.loraName; inputs.strength_model = row.strengthModel;
      if (row.classType === 'LoraLoader') inputs.strength_clip = row.strengthClip;
    }
    for (const row of implementation.conditioning) {
      const target = targets.conditioning.find(item=>item.nodeId===row.nodeId);
      if (!target || !target.neutral) fail('角色词须绑定原始内容为空的独立 CLIPTextEncode 节点');
      claim(row.nodeId); graph[row.nodeId].inputs.text = row.text;
    }
    participants.push({subjectId:character.id,archiveVersion:archive.archiveVersion,implementation:clone(implementation)});
  }
  const count = slots.size;
  if (count > 16 || Array.from({length:count},(_,index)=>index+1).some(index=>!slots.has(index))) fail('角色参考槽存在空缺，不能自动挪用其他人物图片补齐');
  const items = Array.from({length:count},(_,index)=>slots.get(index+1));
  const preparedWorkflow = JSON.stringify(graph);
  // Enforce the existing slot contract as well. A missing cast cannot quietly feed a leftover reference.
  prepareComfyWorkflow(preparedWorkflow,{prompt:'qianmu-role-local-check',negativePrompt:'',parameters:captured.parameters,model:captured.model,referenceCount:count});
  const workflowHash = await comfyWorkflowReferenceHash(preparedWorkflow); await guard();
  const references = count ? normalizeComfyReferenceSelection({version:1,enabled:true,namespace:captured.namespace,workflowHash,items}) : null;
  return freeze({version:1,namespace:captured.namespace,workflowIdentity:identity,originalHash,workflow:preparedWorkflow,references,participants,
    remoteExecutionVerified:false,spatialIsolationVerified:false});
}
