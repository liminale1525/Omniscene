// Loaded only when opening the workflow library. Drafts never live in global ST settings.
import {createComfyWorkflowStore,normalizeComfyLibraryDocument,inspectComfyLibraryDocument,importComfyLibraryDocument,exportComfyLibraryDocument,COMFY_LIBRARY_PARAMETERS} from './qianmu-comfy-library.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const icon=(action,label,glyph,extra='')=>`<button type="button" class="sd-icon-btn" data-comfy-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${extra}><i class="fa-solid fa-${glyph}"></i></button>`;
const clone=value=>JSON.parse(JSON.stringify(value));
const size=bytes=>bytes<1024*1024?`${Math.ceil(bytes/1024)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
const emptyDocument=()=>({workflow:'',outputNodeId:'',parameters:{},positivePrompt:'',negativePrompt:''});
const titles={width:'Width',height:'Height',count:'Count',steps:'Steps',cfg:'CFG',seed:'Seed',sampler:'Sampler',scheduler:'Scheduler'};
const options=document=>{
  let nodes={};try{nodes=JSON.parse(document.workflow);}catch(_){}
  const selected=document.outputNodeId||'';
  return `<option value="">自动识别最终静帧</option>${selected&&!Object.hasOwn(nodes,selected)?`<option value="${escape(selected)}" selected>${escape(selected)} · 待核对</option>`:''}${Object.entries(nodes).filter(([,node])=>node&&typeof node.class_type==='string').map(([id,node])=>`<option value="${escape(id)}" ${id===selected?'selected':''}>${escape(id)} · ${escape(node.class_type)}</option>`).join('')}`;
};
export function renderComfyLibrary(view) {
  const draft=view.draft,disabled=view.busy?'disabled':'';
  if(draft){
    let inspection;try{inspection=inspectComfyLibraryDocument(draft.document);}catch(error){inspection={issue:error.message,slots:[]};}
    return `<div class="sd-comfy-library sd-comfy-library-editor" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>
      <div class="sd-comfy-library-tools">${icon('cancel','取消编辑','xmark')}<span>${escape(draft.name||'新工作流')}${draft.version?` · v${draft.version}`:''}</span>${icon('save-copy','另存新方案','copy')}${icon('save','保存版本','floppy-disk')}</div>
      <section class="sd-card"><div class="sd-storyboard-card-body">
        <label><span>方案名</span><input class="text_pole" data-comfy-draft="name" maxlength="80" value="${escape(draft.name)}"></label>
        ${draft.versions?.length?`<label><span>已保存版本</span><select class="text_pole" data-comfy-version>${draft.versions.map(row=>`<option value="${escape(row.revision)}" ${row.revision===draft.revision?'selected':''}>v${row.version} · ${escape(new Date(row.updatedAt).toLocaleString())}</option>`).join('')}</select></label><button type="button" class="sd-btn" data-comfy-action="apply-version">应用此已保存版本</button>`:''}
        <label><span>API Workflow</span><textarea class="text_pole sd-comfy-library-json" data-comfy-draft="workflow" spellcheck="false" aria-label="API Workflow JSON">${escape(draft.document.workflow)}</textarea></label>
        <div class="sd-comfy-library-tools"><button type="button" class="sd-btn" data-comfy-action="inspect">检查接线</button>${icon('import','导入工作流','upload')}${icon('export-draft','导出当前草稿','download')}</div>
        <label><span>最终静帧输出</span><select class="text_pole" data-comfy-draft="outputNodeId">${options(draft.document)}</select></label>
        <div class="sd-comfy-library-note">${escape(inspection.issue||`${inspection.slots.length} 个输入槽位；本地接线检查不代表远端执行验证`)}</div>
      </div></section>
      <details class="sd-card"><summary><b>参数默认值</b></summary><div class="sd-storyboard-card-body sd-storyboard-grid sd-storyboard-grid-two">${COMFY_LIBRARY_PARAMETERS.map(key=>`<label><span>${titles[key]}</span><input class="text_pole" data-comfy-parameter="${key}" maxlength="120" value="${escape(draft.document.parameters[key]||'')}" ${['sampler','scheduler'].includes(key)?'':'inputmode="decimal"'}></label>`).join('')}</div></details>
      <details class="sd-card"><summary><b>提示补充</b></summary><div class="sd-storyboard-card-body"><label><span>正面补充</span><textarea class="text_pole" data-comfy-draft="positivePrompt" maxlength="12000">${escape(draft.document.positivePrompt)}</textarea></label><label><span>负面补充</span><textarea class="text_pole" data-comfy-draft="negativePrompt" maxlength="12000">${escape(draft.document.negativePrompt)}</textarea></label></div></details>
      <p class="sd-comfy-library-note">仅已接入工作流的参数生效。保存不切换当前配方；返回列表后可明确应用。</p>
    </fieldset><input type="file" data-comfy-file accept=".json,application/json" hidden></div>`;
  }
  return `<div class="sd-comfy-library" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>
    <div class="sd-comfy-library-tools"><input class="text_pole" data-comfy-search type="search" aria-label="搜索工作流" value="${escape(view.search||'')}">${icon('import','导入工作流','upload')}${icon('new','新建工作流','plus')}</div>
    <div class="sd-comfy-library-tools"><button type="button" class="sd-btn" data-comfy-action="from-current">保存当前配方到库</button><button type="button" class="sd-btn ${view.archived?'active':''}" aria-pressed="${Boolean(view.archived)}" data-comfy-action="archived">归档</button>${icon('refresh','刷新列表','rotate')}</div>
    ${view.usage?`<div class="sd-comfy-library-note">${view.usage.count} 个方案 · ${view.usage.versions} 个版本 · ${size(view.usage.bytes)} / ${size(view.usage.limit)}（当前浏览器 · 正文估算）</div>`:''}
    <div class="sd-comfy-library-rows">${(view.rows||[]).map(row=>`<section class="sd-card sd-comfy-library-row" data-comfy-id="${escape(row.id)}" data-comfy-name="${escape(row.name.toLocaleLowerCase())}" ${view.search&&!row.name.toLocaleLowerCase().includes(view.search.toLocaleLowerCase())?'hidden':''}>
      <div class="sd-comfy-library-row-head"><button type="button" class="sd-comfy-library-name" data-comfy-action="${view.archived?'export':'edit'}">${escape(row.name)}</button><span>v${row.version}</span></div>
      <div class="sd-comfy-library-note">${row.nodes} 个节点 · ${size(row.totalBytes)}${row.issue?` · ${escape(row.issue)}`:''}</div>
      <div class="sd-comfy-library-row-actions">${view.archived?`${icon('restore','恢复方案','rotate-left')}${icon('export','导出最新版本','download')}${icon('purge','永久清理全部版本','trash-can')}`:`<button type="button" class="sd-btn" data-comfy-action="apply">应用</button>${icon('edit','编辑版本','pen')}${icon('copy','复制为新方案','copy')}${icon('export','导出最新版本','download')}${icon('archive','归档方案','box-archive')}`}</div>
    </section>`).join('')}</div>
  </fieldset><input type="file" data-comfy-file accept=".json,application/json" hidden></div>`;
}

export function createComfyLibraryController({resolveNamespace,getCurrentRecipe,onApply,isCurrent=()=>true,notify=()=>{},confirm=async()=>false,onIcons=()=>{},download,store=createComfyWorkflowStore()}={}) {
  const view={rows:[],usage:null,search:'',archived:false,draft:null,busy:false,error:''};
  let host=null,namespace='',disposed=false,loaded=false,entry=0,operationEntry=0,verifiedEntry=-1;const scrolls={list:0,editor:0};
  const visible=()=>!disposed&&host?.isConnected&&isCurrent()&&(!view.busy||operationEntry===entry);
  const scroller=()=>host?.closest('.sd-storyboard-scroll');
  const remember=()=>{scrolls[view.draft?'editor':'list']=scroller()?.scrollTop||0;};
  const restore=()=>{const node=scroller();if(node)node.scrollTop=scrolls[view.draft?'editor':'list'];};
  const changed=()=>{if(!visible())return;
    if(verifiedEntry!==entry){host.innerHTML=`<div role="status">${escape(view.error||'正在读取工作流库')}${view.error?'<button type="button" class="sd-btn" data-comfy-action="refresh">重试</button>':''}</div>`;bind();return;}
    host.innerHTML=renderComfyLibrary(view);bind();onIcons(host);};
  const authorize=async()=>{const expected=entry,value=await resolveNamespace();if(!visible()||entry!==expected)throw Error('页面已切换，操作未继续');
    if(namespace&&namespace!==value){namespace=value;loaded=false;view.rows=[];view.draft=null;view.usage=null;verifiedEntry=entry;throw Error('账户已切换，请刷新工作流库');}namespace=value;verifiedEntry=entry;return value;};
  const loadList=async()=>{const rows=await store.list(namespace,{archived:view.archived}),usage=await store.usage(namespace);if(!visible())return;view.rows=rows;view.usage=usage;loaded=true;};
  const guarded=async work=>{
    if(view.busy||!visible())return;operationEntry=entry;view.busy=true;view.error='';changed();
    try{await authorize();await work();}catch(error){if(visible()){view.error=error.message||'工作流操作失败';notify(view.error,'warning');}}
    finally{const departed=operationEntry!==entry;view.busy=false;changed();if(departed&&visible())void guarded(loadList);}
  };
  const newDraft=(name,document,head={})=>{remember();view.draft={id:head.id||'',name,document:clone(document),revision:head.revision||'',version:head.version||0,versions:head.versions||[],dirty:false};scrolls.editor=0;changed();restore();};
  const returnList=()=>{remember();view.draft=null;changed();restore();};
  const exportDocument=(name,document)=>{const contents=JSON.stringify(exportComfyLibraryDocument(name,document),null,2);download(new Blob([contents],{type:'application/json'}),`${(name||'Comfy-workflow').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_')}.qianmu.json`);};
  const loadDocument=async row=>{const document=await store.load(namespace,row.id,row.revision);if(!document)throw Error('此版本已不存在，请刷新列表');return document;};
  async function action(name,id) {
    if(name==='import'){if(!view.busy)host.querySelector('[data-comfy-file]')?.click();return;}
    await guarded(async()=>{
      const row=view.rows.find(row=>row.id===id);
      if(name==='refresh'){await loadList();return;}
      if(name==='archived'){view.archived=!view.archived;await loadList();return;}
      if(name==='new'){newDraft('',emptyDocument());return;}
      if(name==='from-current'){const current=getCurrentRecipe();newDraft(current.name||'',current.document);return;}
      if(name==='cancel'){
        if(view.draft?.dirty&&!await confirm('放弃尚未保存的工作流编辑？'))return;
        if(!visible())return;returnList();await loadList();return;
      }
      if(name==='inspect'){normalizeComfyLibraryDocument(view.draft.document);return;}
      if(name==='export-draft'){exportDocument(view.draft.name,view.draft.document);return;}
      if(name==='apply-version'){
        const draft=view.draft;if(!draft?.id)return;if(draft.dirty)throw Error('请先保存或取消当前编辑，再应用已保存版本');
        const document=await loadDocument(draft);await authorize();await onApply({id:draft.id,revision:draft.revision,name:draft.name,version:draft.version,document});return;
      }
      if(name==='save'||name==='save-copy'){
        const draft=view.draft;if(!draft)return;
        await store.save(namespace,{id:name==='save'?draft.id:'',expectedRevision:name==='save'?draft.revision:'',name:draft.name,document:draft.document});
        if(!visible())return;notify('方案已保存，尚未应用','success');returnList();view.archived=false;await loadList();return;
      }
      if(!row)return;
      if(name==='edit'||name==='copy'){
        const document=await loadDocument(row),versions=name==='edit'?await store.versions(namespace,row.id):[];
        if(!visible())return;newDraft(name==='copy'?`${row.name} 副本`.slice(0,80):row.name,document,name==='edit'?{...row,versions}:{});return;
      }
      if(name==='export'){const document=await loadDocument(row);await authorize();exportDocument(row.name,document);return;}
      if(name==='apply'){
        const document=await loadDocument(row);await authorize();
        await onApply({id:row.id,revision:row.revision,name:row.name,version:row.version,document});return;
      }
      if(name==='archive'||name==='restore'){await store.archive(namespace,row.id,row.revision,name==='archive');await loadList();return;}
      if(name==='purge'){
        if(!await confirm(`永久清理「${row.name}」的全部 ${row.version} 个版本？此操作不可撤回；需要保留时请先取消并导出。当前已应用配方和生成记录不受影响。`))return;
        await authorize();await store.purge(namespace,row.id,row.revision);await loadList();notify('已清理归档方案的全部版本；无法撤回','success');
      }
    });
  }
  function bind() {
    const mounted=host,mountedEntry=entry;
    host.querySelectorAll('[data-comfy-action]').forEach(button=>button.addEventListener('click',()=>void action(button.dataset.comfyAction,button.closest('[data-comfy-id]')?.dataset.comfyId)));
    host.querySelector('[data-comfy-search]')?.addEventListener('input',event=>{view.search=event.target.value;host.querySelectorAll('[data-comfy-name]').forEach(row=>{row.hidden=!row.dataset.comfyName.includes(view.search.toLocaleLowerCase());});});
    host.querySelectorAll('[data-comfy-draft]').forEach(field=>field.addEventListener('input',()=>{if(!view.draft)return;const key=field.dataset.comfyDraft;view.draft.dirty=true;if(key==='name')view.draft.name=field.value;else view.draft.document[key]=field.value;}));
    host.querySelectorAll('[data-comfy-parameter]').forEach(field=>field.addEventListener('input',()=>{view.draft.dirty=true;view.draft.document.parameters[field.dataset.comfyParameter]=field.value;}));
    host.querySelector('[data-comfy-version]')?.addEventListener('change',event=>{const revision=event.target.value;void guarded(async()=>{
      const draft=view.draft;if(draft.dirty&&!await confirm('切换版本会放弃未保存的编辑，继续？'))return;
      await authorize();const row=draft.versions.find(item=>item.revision===revision);if(!row)return;
      const document=await loadDocument(row);if(visible())newDraft(row.name,document,{...row,versions:draft.versions});
    });});
    host.querySelector('[data-comfy-file]')?.addEventListener('change',event=>{
      const file=event.target.files?.[0];event.target.value='';if(!file||host!==mounted||entry!==mountedEntry)return;
      void guarded(async()=>{
        if(file.size>3*1024*1024)throw Error('方案文件须小于 3 MB');
        const contents=await file.text();await authorize();const imported=importComfyLibraryDocument(contents);
        if(view.draft?.dirty&&!await confirm('导入会替换未保存的编辑，继续？'))return;
        await authorize();newDraft(imported.name||file.name.replace(/(?:\.qianmu)?\.json$/i,''),imported.document);view.draft.dirty=true;
        if(imported.removedFields.length)notify('导入时已移除工作流内的凭据字段，请核对后保存','warning');
      });
    });
  }
  return Object.freeze({
    mount(element){const was=host;host=element;if(was!==element)entry++;changed();if(!loaded||was!==element)void guarded(loadList);},
    detach(){remember();host=null;entry++;},
    dispose(){disposed=true;host=null;view.draft=null;entry++;store.close();},
  });
}
