// Optional preparation only. The caller must still run node readiness, output auditing and admission before dispatch.
import {normalizeComfyCharacterWorkflow,normalizeComfyCharacterSnapshot,comfyCharacterError} from './qianmu-comfy-character-contract.js';
import {comfyWorkflowReferenceHash,checkComfyReferenceSelection} from './qianmu-comfy-references.js';
import {inspectComfyWorkflow,prepareComfyWorkflow} from './qianmu-comfy-workflow.js';
import {normalizeComfyReferenceSelection} from './qianmu-comfy-reference-contract.js';
import {normalizeComfyCharacterActivation} from './qianmu-comfy-character-contract.js';
export {normalizeComfyCharacterActivation} from './qianmu-comfy-character-contract.js';

const fail = message => { throw comfyCharacterError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const sameWorkflow = (a,b) => ['id','revision','version','hash'].every(key => a[key] === b[key]);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export async function readComfyCharacterRecipe({namespace,binding,expectedWorkflow,expectedOutput,guard=async()=>{}}={}) {
  if(!binding?.id||!binding?.revision)fail('请先在 Comfy 镜头台应用已保存的工作流方案');
  const captured=clone(binding);await guard();
  const {createComfyWorkflowStore}=await import('./qianmu-comfy-library.js');await guard();
  const store=createComfyWorkflowStore();
  try {
    const [versions,document]=await Promise.all([store.versions(namespace,captured.id),store.load(namespace,captured.id,captured.revision)]);await guard();
    const version=versions.find(row=>row.revision===captured.revision);
    if(!document||!version||version.version!==captured.version)fail('绑定的工作流版本已不存在，请重新选择方案');
    const hash=await comfyWorkflowReferenceHash(document.workflow);await guard();
    if(captured.hash&&captured.hash!==hash)fail('工作流版本内容不匹配，不能沿用旧角色绑定');
    if(expectedWorkflow!==undefined&&(await comfyWorkflowReferenceHash(expectedWorkflow)!==hash||expectedOutput!==document.outputNodeId))fail('当前工作流有未保存改动，请先保存并应用方案');
    await guard();return {name:version.name,workflow:normalizeComfyCharacterWorkflow({...captured,hash}),document};
  } finally {store.close();}
}

export function validateComfyCharacterOutput(workflow,implementation,outputNodeId) {
  const graph = typeof workflow === 'string' ? JSON.parse(workflow) : workflow;
  if (!outputNodeId || !Object.hasOwn(graph,outputNodeId)) fail('请先在工作流方案中选择最终输出节点');
  const ancestors = new Set(), pending = [String(outputNodeId)];
  const links = value => {
    if (Array.isArray(value)) {
      if (value.length === 2 && ['string','number'].includes(typeof value[0]) && Number.isInteger(value[1]) && value[1] >= 0 && Object.hasOwn(graph,String(value[0]))) pending.push(String(value[0]));
      else value.forEach(links);
    } else if (value && typeof value === 'object') Object.values(value).forEach(links);
  };
  while (pending.length) { const id=pending.pop(); if (ancestors.has(id)) continue; ancestors.add(id); links(graph[id]?.inputs); }
  for (const row of [...implementation.loras,...implementation.conditioning]) if (!ancestors.has(row.nodeId)) fail(`角色节点 ${row.nodeId} 未接入所选输出`);
  if (implementation.referenceSlot !== null) {
    const used = Object.entries(graph).some(([id,node]) => ancestors.has(id) && node?.class_type === 'LoadImage'
      && (node.inputs?.image === `%qianmu_reference_${implementation.referenceSlot}%` || implementation.referenceSlot === 1 && node.inputs?.image === '%qianmu_reference%'));
    if (!used) fail(`角色参考 ${implementation.referenceSlot} 未接入所选输出`);
  }
  return true; // Connectivity only; this is not proof of regional semantics or runtime model support.
}

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

export async function prepareComfyCharacterPlan({workflow,workflowIdentity,namespace,shot,staticSelection=null,parameters={},model='',outputNodeId='',safetyAdapted=false,guard=async()=>{}}={}) {
  // Capture all inputs before yielding: neither a late archive edit nor a caller-owned object mutation may mix versions.
  const captured = clone({workflow,workflowIdentity,namespace,shot,staticSelection,parameters,model,outputNodeId,safetyAdapted});
  await guard();
  const identity = normalizeComfyCharacterWorkflow(captured.workflowIdentity);
  if (typeof captured.namespace !== 'string' || !/^st-user:.+/.test(captured.namespace) || captured.namespace.length > 512
    || /[\u0000-\u001f\u007f]/.test(captured.namespace)) fail('请先确认当前 ST 账户');
  const originalHash = await comfyWorkflowReferenceHash(captured.workflow); await guard();
  if (originalHash !== identity.hash) fail('工作流内容已变化，请重新绑定角色实现');
  const targets = inspectComfyCharacterTargets(captured.workflow);
  const graph = typeof captured.workflow === 'string' ? JSON.parse(captured.workflow) : captured.workflow;
  if(captured.outputNodeId)validateComfyCharacterOutput(graph,{referenceSlot:null,loras:[],conditioning:[]},captured.outputNodeId);
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
    if (captured.outputNodeId) validateComfyCharacterOutput(graph,implementation,captured.outputNodeId);
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
    outputConnectivityVerified:Boolean(captured.outputNodeId),remoteExecutionVerified:false,spatialIsolationVerified:false});
}

export function comfyCharacterPlanReceipt(plan) {
  return {version:1,namespace:plan.namespace,workflowIdentity:clone(plan.workflowIdentity),originalHash:plan.originalHash,references:clone(plan.references),
    participants:plan.participants.map(row=>({subjectId:row.subjectId,archiveVersion:row.archiveVersion}))};
}
export async function assertComfyCharacterPlan(plan,payload) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
  if (JSON.stringify(canonical(comfyCharacterPlanReceipt(plan))) !== JSON.stringify(canonical(payload?.comfyCharacterPlan))
    || await comfyWorkflowReferenceHash(plan.workflow) !== await comfyWorkflowReferenceHash(payload?.parameters?.workflow)) fail('本镜 Comfy 角色配置已变化，请重新准备后生成');
}

export async function checkComfyCharacterCandidates({profile,prepared,namespace,guard=async()=>{}}) {
  const activation=normalizeComfyCharacterActivation(profile.comfyCharacterActivation);
  if(activation.namespace!==namespace)fail('Comfy 角色启用配置属于另一账户，请重新绑定');
  const hash=await comfyWorkflowReferenceHash(profile.comfyWorkflow);await guard();
  if(hash!==activation.workflow.hash)fail('Comfy 角色绑定的工作流已变化，请重新绑定');
  const targets=inspectComfyCharacterTargets(profile.comfyWorkflow),slots=new Set();
  const staticItems=await checkComfyReferenceSelection({workflow:profile.comfyWorkflow,selection:profile.comfyReferences,namespace});await guard();
  staticItems.forEach((_,index)=>slots.add(index+1));
  validateComfyCharacterOutput(profile.comfyWorkflow,{referenceSlot:null,loras:[],conditioning:[]},profile.comfyOutputNodeId);
  for(const entry of prepared?.entries||[]) {
    if(!entry.comfyImplementation)fail('Comfy 人物资料未准备，请重新提取');
    const snapshot=normalizeComfyCharacterSnapshot(entry.comfyImplementation);
    if(snapshot.namespace!==namespace)fail('Comfy 人物资料账户已变化');
    const impl=snapshot.implementations.find(row=>sameWorkflow(row.workflow,activation.workflow));if(!impl)continue;
    validateComfyCharacterOutput(profile.comfyWorkflow,impl,profile.comfyOutputNodeId);
    if(impl.loras.some(row=>!targets.loras.some(target=>target.nodeId===row.nodeId&&target.classType===row.classType&&target.neutral))
      ||impl.conditioning.some(row=>!targets.conditioning.some(target=>target.nodeId===row.nodeId&&target.neutral)))fail('Comfy 人物节点已失效或不是空白专用节点');
    if(impl.referenceSlot!==null){
      if(!snapshot.reference)fail(`角色 ${entry.identity.name} 的 Comfy 参考图缺失`);
      if(impl.referenceSlot<=staticItems.length)fail('Comfy 角色参考槽与工作流参考图冲突');
      slots.add(impl.referenceSlot);
    }
  }
  if(Array.from({length:slots.size},(_,index)=>index+1).some(slot=>!slots.has(slot)))fail('Comfy 角色参考槽存在空缺');
  return {referenceCount:slots.size}; // Candidates are not a cast: same-slot alternatives resolve only after extraction.
}

export async function prepareComfyCharacterJob(job,{namespace,guard=async()=>{}}) {
  if(job.source!=='comfy'||job.profile?.comfyCharacterEnabled!==true){if(job.payload?.comfyCharacterPlan)fail('角色实现已关闭，但本镜仍携带 Comfy 角色配置');return null;}
  const activation=normalizeComfyCharacterActivation(job.profile.comfyCharacterActivation);
  if(activation.namespace!==namespace)fail('Comfy 角色配置属于另一账户，请重新绑定');
  if(!job.profile.comfyOutputNodeId)fail('请先选择角色工作流的最终输出节点');
  if(job.shotSpec&&job.payload?.shotSpec){
    const cast=shot=>(shot.characters||[]).filter(row=>row.archiveSnapshot).map(row=>({id:row.id,archiveVersion:row.archiveSnapshot.archiveVersion,
      implementation:row.archiveSnapshot.comfyImplementation?normalizeComfyCharacterSnapshot(row.archiveSnapshot.comfyImplementation):null}));
    if(JSON.stringify(cast(job.shotSpec))!==JSON.stringify(cast(job.payload.shotSpec)))fail('镜头与发送配置中的 Comfy 角色快照不一致，请重新准备');
  }
  const plan=await prepareComfyCharacterPlan({workflow:job.profile.comfyWorkflow,workflowIdentity:activation.workflow,namespace,
    shot:job.payload?.shotSpec||job.shotSpec,staticSelection:job.profile.comfyReferences,
    parameters:Object.fromEntries(['width','height','count','steps','scale','cfg','seed','sampler','scheduler'].map(key=>[key,job.payload?.parameters?.[key]])),model:job.profile.model,
    outputNodeId:job.profile.comfyOutputNodeId,safetyAdapted:job.safetyAdapted||job.sensitive,guard});
  if(job.automatic&&plan.participants.length&&(job.payload?.shotSpec||job.shotSpec)?.characters?.filter(row=>row.visible!==false).length>1)fail('多人 Comfy 角色工作流尚未验证空间隔离，请改为手动确认生成');
  return plan;
}
