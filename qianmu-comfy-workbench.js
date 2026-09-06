// Presentation-only, loaded on entry to the Comfy workbench. No network, storage or node execution.
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fields = [
  ['width','Width','number','min="64" max="8192" step="64"'],
  ['height','Height','number','min="64" max="8192" step="64"'],
  ['steps','Steps','number','min="1" max="300"'],
  ['cfg','CFG','number','min="0" max="100" step="0.1"'],
  ['seed','Seed','number','min="-1"'],['sampler','Sampler','text',''],['scheduler','Scheduler','text',''],
];
export function renderComfyWorkbench({profile, capabilities, collapsed={}, promptLayer={}, workflowNotice='', workflowNodes=0, librarySelection=null}, shared={}) {
  const controls=fields.filter(([key])=>capabilities[key]).map(([key,label,type,attrs])=>
    `<label><span>${label}</span><input class="text_pole sd-storyboard-field${['width','height'].includes(key)?` sd-storyboard-${key}`:''}" data-storyboard-field="${key}" type="${type}" ${attrs} value="${escape(profile[key])}"></label>`).join('');
  const workflow=typeof profile.comfyWorkflow==='string'&&profile.comfyWorkflow.trim().startsWith('{')?profile.comfyWorkflow:'';
  return `<div class="sd-storyboard-create sd-comfy-workbench">
    ${shared.modes||''}${shared.automation||''}${shared.production||''}${shared.connection||''}
    <details class="sd-card sd-comfy-workflow-card" data-storyboard-card="comfy-workflow" ${!workflow||workflowNotice||collapsed['comfy-workflow']===false?'open':''}>
      <summary><span><b>工作流</b><small>${workflowNodes?`${workflowNodes} 个节点`:'API Workflow'}</small></span><button type="button" class="sd-icon-btn sd-comfy-open-library" title="工作流库" aria-label="工作流库"><i data-qm-icon="qm-regular-folder"></i></button></summary>
      <div class="sd-storyboard-card-body">
        <button type="button" class="sd-btn sd-comfy-open-library">${librarySelection?.name?`基于 ${escape(librarySelection.name)} · v${Number(librarySelection.version)||1}`:workflow?'当前自定义工作流':'选择或导入工作流'}</button>
        <button type="button" class="sd-btn sd-comfy-check-workflow" ${workflow?'':'disabled'}>检查节点与模型</button>
        <div class="sd-comfy-readiness-result" role="status" hidden></div>
        <div class="sd-storyboard-workflow-warning sd-storyboard-connection-result failed" ${workflowNotice?'':'hidden'} role="status"><span>${escape(workflowNotice)}</span></div>
      </div>
    </details>
    ${shared.context||''}${shared.worldbook||''}
    <details class="sd-card sd-storyboard-prompt-card" data-storyboard-card="prompt" ${collapsed.prompt?'':'open'}><summary><b>提示词</b></summary>
      <div class="sd-storyboard-card-body"><div class="sd-storyboard-prompt-stack">
        ${shared.promptPreset||''}
        <label><span>提示补充</span><textarea class="text_pole sd-storyboard-prompt sd-storyboard-prompt-textarea" spellcheck="false">${escape(promptLayer.positive)}</textarea></label>
        ${capabilities.supportsNativeNegative?`<label><span>负面提示词</span><textarea class="text_pole sd-storyboard-negative sd-storyboard-prompt-textarea" spellcheck="false">${escape(promptLayer.negative)}</textarea></label>`:''}
      </div></div>
    </details>
    <details class="sd-card sd-storyboard-params" data-storyboard-card="params" ${collapsed.params?'':'open'}><summary><b>工作流参数</b></summary>
      <div class="sd-storyboard-card-body">${shared.parameterPresets||''}${controls?`<div class="sd-storyboard-grid sd-storyboard-grid-two">${controls}</div>`:''}</div>
    </details>
    ${shared.generation||''}${shared.composition||''}${shared.queue||''}${shared.recent||''}
  </div>`;
}
