import {normalizeComfyCharacterImplementation} from './qianmu-comfy-character-contract.js';
import {inspectComfyCharacterTargets,validateComfyCharacterOutput} from './qianmu-comfy-character-plan.js';
const escape = value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const clone = value=>JSON.parse(JSON.stringify(value));
const field = (key,label,value,attrs='')=>`<label><span>${label}</span><input class="text_pole" data-comfy-role-field="${key}" value="${escape(value)}" ${attrs}></label>`;
export function comfyCharacterEditorRecipe(recipe) {
  const targets=inspectComfyCharacterTargets(recipe.document.workflow),output=recipe.document.outputNodeId;
  validateComfyCharacterOutput(recipe.document.workflow,{referenceSlot:null,loras:[],conditioning:[]},output);
  const connected = part=>{try{return validateComfyCharacterOutput(recipe.document.workflow,{referenceSlot:null,loras:[],conditioning:[],...part},output);}catch(_){return false;}};
  return {...recipe,targets:{referenceSlots:targets.referenceSlots.filter(slot=>connected({referenceSlot:slot})),
    loras:targets.loras.filter(row=>row.neutral&&connected({loras:[row]})),conditioning:targets.conditioning.filter(row=>row.neutral&&connected({conditioning:[row]}))}};
}
export function newComfyCharacterImplementation(recipe) {
  return {version:1,name:recipe.name,workflow:clone(recipe.workflow),referenceSlot:null,loras:[],conditioning:[]};
}
const options = (rows,value,render=row=>row.nodeId)=>{
  const entries=rows.map(row=>[row.nodeId,render(row)]);
  if(value&&!entries.some(([id])=>id===value))entries.unshift([value,`${value} · 已失效`]);
  return `<option value="">选择节点</option>${entries.map(([id,label])=>`<option value="${escape(id)}" ${id===value?'selected':''}>${escape(label)}</option>`).join('')}`;
};
export function renderComfyCharacterEditor(editor,icon) {
  const {implementation:impl,recipe}=editor,targets=recipe.targets;
  return `<div class="sd-comfy-role-editor"><div class="sd-character-tools">${icon('comfy-cancel','取消实现编辑','x')}<b>Comfy 实现</b><span class="sd-character-spacer"></span>${icon('comfy-save','保存至档案草稿','floppy-disk')}</div>
    <section class="sd-card"><div class="sd-storyboard-card-body">
      <div class="sd-comfy-role-heading"><span>${escape(recipe.name)} · v${recipe.workflow.version}</span><button type="button" class="sd-btn" data-archive-action="comfy-rebind">改绑当前方案</button></div>
      ${field('name','实现名称',impl.name,'maxlength="80"')}
      <label><span>档案参考图</span><select class="text_pole" data-comfy-role-field="referenceSlot"><option value="">不使用</option>${[...new Set([...(impl.referenceSlot?[impl.referenceSlot]:[]),...targets.referenceSlots])].map(slot=>`<option value="${slot}" ${impl.referenceSlot===slot?'selected':''}>参考 ${slot}${targets.referenceSlots.includes(slot)?'':' · 已失效'}</option>`).join('')}</select></label>
      <small>只使用本档案明确上传的原图；不会自动发送头像。工作流参考槽不能重复占用。</small>
    </div></section>
    <section class="sd-card"><div class="sd-storyboard-card-body"><div class="sd-comfy-role-heading"><span>LoRA</span>${icon('comfy-add-lora','添加 LoRA','plus',impl.loras.length>=8||!targets.loras.length?'disabled':'')}</div>
      ${impl.loras.map((row,index)=>`<div class="sd-comfy-role-item" data-comfy-lora="${index}"><div class="sd-comfy-role-heading"><select class="text_pole" data-comfy-lora-node>${options(targets.loras,row.nodeId,r=>`${r.nodeId} · ${r.classType}`)}</select>${icon('comfy-remove-lora','移除此 LoRA','x',`data-item-index="${index}"`)}</div>
        <label><span>LoRA 目录名</span><input class="text_pole" data-comfy-lora-name value="${escape(row.loraName)}" maxlength="512"></label>
        <div class="sd-character-reference-settings"><label><span>模型强度</span><input class="text_pole" type="number" min="-100" max="100" step="0.05" data-comfy-lora-model value="${escape(row.strengthModel)}"></label>
        ${row.classType==='LoraLoader'?`<label><span>CLIP 强度</span><input class="text_pole" type="number" min="-100" max="100" step="0.05" data-comfy-lora-clip value="${escape(row.strengthClip)}"></label>`:''}</div></div>`).join('')}
      <small>只列出接入最终输出、原始强度为 0 的原生节点。多个 LoRA 不等于人物分区。</small></div></section>
    <section class="sd-card"><div class="sd-storyboard-card-body"><div class="sd-comfy-role-heading"><span>人物节点补充</span>${icon('comfy-add-text','添加人物词节点','plus',impl.conditioning.length>=8||!targets.conditioning.length?'disabled':'')}</div>
      ${impl.conditioning.map((row,index)=>`<div class="sd-comfy-role-item" data-comfy-text="${index}"><div class="sd-comfy-role-heading"><select class="text_pole" data-comfy-text-node>${options(targets.conditioning,row.nodeId)}</select>${icon('comfy-remove-text','移除此人物词','x',`data-item-index="${index}"`)}</div>
        <label><span>节点用途</span><select class="text_pole" data-comfy-text-kind><option value="positive" ${row.kind==='positive'?'selected':''}>正面 / 触发词</option><option value="negative" ${row.kind==='negative'?'selected':''}>专属负面</option></select></label>
        <textarea class="text_pole" data-comfy-text-value rows="3" maxlength="6000">${escape(row.text)}</textarea></div>`).join('')}
      <small>仅列出接入输出的空白文本节点。正负用途只作标记，实际作用由工作流连线决定；不会改写连线或镜头提示词。</small></div></section>
  </div>`;
}
export function captureComfyCharacterEditor(host,editor) {
  const impl=editor.implementation;
  const name=host.querySelector('[data-comfy-role-field="name"]');if(name)impl.name=name.value;
  const slot=host.querySelector('[data-comfy-role-field="referenceSlot"]');if(slot)impl.referenceSlot=slot.value?Number(slot.value):null;
  const amount=input=>!input||input.value===''?'invalid':Number(input.value);
  host.querySelectorAll('[data-comfy-lora]').forEach(element=>{
    const row=impl.loras[Number(element.dataset.comfyLora)];if(!row)return;
    const node=element.querySelector('[data-comfy-lora-node]').value,target=editor.recipe.targets.loras.find(item=>item.nodeId===node);
    row.nodeId=node;row.classType=target?.classType||row.classType;row.loraName=element.querySelector('[data-comfy-lora-name]').value;
    row.strengthModel=amount(element.querySelector('[data-comfy-lora-model]'));
    row.strengthClip=row.classType==='LoraLoader'?(element.querySelector('[data-comfy-lora-clip]')?amount(element.querySelector('[data-comfy-lora-clip]')):1):null;
  });
  host.querySelectorAll('[data-comfy-text]').forEach(element=>{
    const row=impl.conditioning[Number(element.dataset.comfyText)];if(!row)return;
    row.nodeId=element.querySelector('[data-comfy-text-node]').value;row.kind=element.querySelector('[data-comfy-text-kind]').value;row.text=element.querySelector('[data-comfy-text-value]').value;
  });
}
export function saveComfyCharacterEditor(editor) {
  const impl=normalizeComfyCharacterImplementation(editor.implementation);
  validateComfyCharacterOutput(editor.recipe.document.workflow,impl,editor.recipe.document.outputNodeId);
  const targets=editor.recipe.targets;
  if(impl.referenceSlot!==null&&!targets.referenceSlots.includes(impl.referenceSlot)
    ||impl.loras.some(row=>!targets.loras.some(target=>target.nodeId===row.nodeId&&target.classType===row.classType))
    ||impl.conditioning.some(row=>!targets.conditioning.some(target=>target.nodeId===row.nodeId)))throw Error('角色节点已失效，请重新选择');
  return impl;
}
