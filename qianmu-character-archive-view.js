import {CHARACTER_CATEGORIES,newCharacterArchive,normalizeCharacterArchive,selectCharacterBinding,exportCharacterArchive,importCharacterArchive} from './qianmu-character-archive.js';
import {createCharacterArchiveStore} from './qianmu-character-archive-store.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const clone=value=>JSON.parse(JSON.stringify(value));
const icon=(action,label,glyph,attrs='')=>`<button type="button" class="sd-icon-btn" data-archive-action="${action}" title="${escape(label)}" aria-label="${escape(label)}" ${attrs}><i data-qm-icon="qm-regular-${({upload:'upload-simple',download:'download-simple'})[glyph]||glyph}"></i></button>`;
const safeImage=value=>{
  if(typeof value!=='string'||!/^\/(?:user\/images\/|characters\/|User(?:%20| )Avatars\/)/.test(value)||/[\u0000-\u001f\\?#]/.test(value))return '';
  try{for(const part of value.split('/').slice(1)){const decoded=decodeURIComponent(part);if(!decoded||decoded==='.'||decoded==='..'||/[\\/%\u0000-\u001f\u007f]/.test(decoded))return '';}}catch(_){return '';}
  return value;
};
const status=view=>`<p class="sd-character-status" role="status">${escape(view.error||'参考图须在支持的镜头台启用；性征暂不参与生成')}</p>`;
const field=(name,label,value,max,textarea=false)=>`<label><span>${label}</span>${textarea?`<textarea class="text_pole" data-archive-field="${name}" maxlength="${max}">${escape(value)}</textarea>`:`<input class="text_pole" data-archive-field="${name}" maxlength="${max}" value="${escape(value)}">`}</label>`;

export async function saveCharacterReference(file,{save,guard,createBitmap=globalThis.createImageBitmap,createCanvas=()=>document.createElement('canvas')}={}) {
  if(typeof createBitmap!=='function')throw Error('当前浏览器不能生成档案封面，请更换浏览器后上传');
  const {saveStaticReferenceFile}=await import('./qianmu-comfy-references.js');await guard();
  const reference=await saveStaticReferenceFile(file,{save,guard});
  const bitmap=await createBitmap(file);let previewFile;
  try{
    await guard();if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>32000000)throw Error('参考图像素过大，请缩小至 3200 万像素以内');
    const canvas=createCanvas(),scale=Math.min(1,256/Math.max(bitmap.width,bitmap.height));
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('封面处理超时，请重试')),10000);canvas.toBlob(value=>{clearTimeout(timer);value?resolve(value):reject(Error('封面处理失败'));},'image/webp',0.8);});
    if(blob.size>256*1024)throw Error('档案封面过大，请换图后重试');previewFile=new File([blob],'preview.webp',{type:blob.type});
  }finally{bitmap.close();}
  await guard();const preview=await saveStaticReferenceFile(previewFile,{save,guard});return {reference,preview:{...preview,sourceSha256:reference.sha256}};
}

export function renderCharacterArchive(view,{identity=()=>''}={}) {
  const disabled=view.busy?'disabled':'';
  if(view.draft){
    const draft=view.draft,doc=draft.document,cover=safeImage(doc.imagegen.reference?.url),bindings=view.bindings.filter(row=>row.archiveId===draft.id);
    return `<div class="sd-character-library sd-character-editor" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>
      <div class="sd-character-tools">${icon('cancel','取消编辑','x')}<b>${doc.category.toUpperCase()}${draft.version?` · v${draft.version}`:''}</b><span class="sd-character-spacer"></span>${icon('copy','复制档案','copy')}${icon('export','导出档案','download')}${draft.id?icon('delete','删除档案','trash'):''}${icon('save','保存档案','floppy-disk')}</div>
      <section class="sd-card"><div class="sd-storyboard-card-body sd-character-detail-grid">
        <div class="sd-character-cover-field"><label class="sd-character-cover-upload" aria-label="上传参考图">${cover?`<img src="${escape(cover)}" alt="参考图">`:'<i data-qm-icon="qm-regular-image"></i>'}<input type="file" data-archive-image accept="image/png,image/jpeg,image/webp" class="sd-reader-native-file"></label>${cover?icon('clear-image','移除参考图选择','x'):''}</div>
        <div class="sd-character-main-fields">${field('name','档案名',doc.name,80)}${field('appearance','角色形象',doc.imagegen.appearance,12000,true)}${field('sensitiveAppearance','性征',doc.imagegen.sensitiveAppearance,6000,true)}</div>
        <div class="sd-character-full">${field('negative','模型接口专属负面',doc.imagegen.negative,6000,true)}</div>
      </div></section>
      <details class="sd-card"><summary><b>NAI 参考设置</b></summary><div class="sd-storyboard-card-body"><div class="sd-character-reference-settings">
        <label><span>强度</span><input class="text_pole" type="number" min="0" max="1" step="0.05" data-archive-field="referenceStrength" value="${escape(doc.imagegen.novelReference?.strength ?? 0.6)}"></label>
        <label><span>保真度</span><input class="text_pole" type="number" min="0" max="1" step="0.05" data-archive-field="referenceFidelity" value="${escape(doc.imagegen.novelReference?.fidelity ?? 1)}"></label>
      </div></div></details>
      <details class="sd-card"><summary><b>绑定与识别</b></summary><div class="sd-storyboard-card-body">
        ${field('aliases','别名 / 称呼',doc.aliases.join('，'),1943)}
        <label><span>年龄状态</span><select class="text_pole" data-archive-field="ageStatus">${[['unknown','未确认'],['adult','已确认成年'],['minor','未成年']].map(([id,label])=>`<option value="${id}" ${doc.ageStatus===id?'selected':''}>${label}</option>`).join('')}</select></label>
        ${draft.id?`<p class="sd-character-identifier">${escape(`archive:${draft.id}`)}</p>`:''}
        ${bindings.slice(0,view.bindingShown||24).map((row,index)=>`<div class="sd-character-binding-row"><span>${escape(row.category.toUpperCase())} · ${escape(row.scope==='chat'?'当前聊天级':'角色默认')}<small>${escape(row.subjectKey)}${row.chatKey?` · ${escape(row.chatKey)}`:''}</small></span>${icon('unbind','解除此绑定','x',`data-binding-index="${index}"`)}</div>`).join('')}
        ${bindings.length>(view.bindingShown||24)?'<button type="button" class="sd-btn" data-archive-action="more-bindings">更多绑定</button>':''}
      </div></details>
      ${status(view)}
    </fieldset></div>`;
  }
  const picker=view.bindingEditor;
  return `<div class="sd-character-library" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>
    <section class="sd-card sd-character-current"><div class="sd-storyboard-card-body">${view.subjects.map((subject,index)=>{
      const binding=selectCharacterBinding(view.bindings,subject,view.chatKey),bound=view.rows.find(row=>row.id===binding?.archiveId);
      return `<div class="sd-character-current-person">${identity(subject.category.toUpperCase(),subject.name,safeImage(subject.avatar),subject.category==='user'?'fa-user':'fa-circle-user')}<button type="button" class="sd-character-binding-name" data-archive-action="binding" data-subject-index="${index}" ${subject.subjectKey?'':'disabled'}>${escape(bound?.name||'未绑定')}</button></div>`;
    }).join('')}</div></section>
    ${picker?`<section class="sd-card"><div class="sd-storyboard-card-body sd-character-picker">
      <b>${escape(picker.subject.name)}</b><label><span>绑定范围</span><select class="text_pole" data-archive-binding="scope"><option value="chat" ${picker.scope==='chat'?'selected':''} ${view.chatKey?'':'disabled'}>当前聊天</option><option value="default" ${picker.scope==='default'?'selected':''}>该角色默认</option></select></label>
      <label><span>角色档案</span><select class="text_pole" data-archive-binding="archiveId"><option value="">不绑定</option>${view.rows.filter(row=>row.category===picker.subject.category).map(row=>`<option value="${escape(row.id)}" ${picker.archiveId===row.id?'selected':''}>${escape(row.name)}</option>`).join('')}</select></label>
      <div class="sd-character-tools">${icon('binding-cancel','取消绑定选择','x')}<button type="button" class="sd-btn" data-archive-action="inherit" ${picker.scope==='chat'?'':'disabled'}>沿用默认</button><span class="sd-character-spacer"></span>${icon('binding-save','保存绑定','floppy-disk')}</div>
    </div></section>`:''}
    <div class="sd-character-tools"><input class="text_pole" type="search" data-archive-search value="${escape(view.search)}" aria-label="搜索角色档案">${icon('refresh','刷新角色库','arrows-clockwise')}${icon('import','导入角色档案','upload')}</div>
    ${CHARACTER_CATEGORIES.map(category=>{
      const query=view.search.toLocaleLowerCase(),rows=view.rows.filter(row=>row.category===category&&(!query||[row.name,...row.aliases].join(' ').toLocaleLowerCase().includes(query))),shown=rows.slice(0,view.shown[category]||24);
      return `<details class="sd-card sd-character-category is-${category}" data-archive-category="${category}" ${view.collapsed[category]?'':'open'}><summary><b>${category.toUpperCase()}</b><span>${rows.length}</span>${icon('new',`新建 ${category.toUpperCase()} 档案`,'plus',`data-category="${category}"`)}</summary>
        <div class="sd-character-grid">${shown.map(row=>{
          const subject=view.subjects.find(subject=>selectCharacterBinding(view.bindings,subject,view.chatKey)?.archiveId===row.id),cover=safeImage(row.cover)||safeImage(subject?.avatar);
          return `<button type="button" class="sd-character-file ${subject?'is-bound':''}" data-archive-action="edit" data-archive-id="${escape(row.id)}"><span class="sd-character-file-image">${cover?`<img src="${escape(cover)}" alt="" loading="lazy" decoding="async">`:'<i data-qm-icon="qm-regular-user"></i>'}</span><b>${escape(row.name)}</b></button>`;
        }).join('')}${rows.length>shown.length?`<button type="button" class="sd-btn sd-character-more" data-archive-action="more" data-category="${category}">更多</button>`:''}</div></details>`;
    }).join('')}
    ${status(view)}
  </fieldset><input type="file" data-archive-file accept=".json,application/json" hidden></div>`;
}

export function createCharacterArchiveController({resolveNamespace,getContext,isCurrent=()=>true,onIcons=()=>{},identity,notify=()=>{},confirm=async()=>false,download,saveReference,
  onCollapse=()=>{},collapsed={},store=createCharacterArchiveStore()}={}) {
  const view={rows:[],bindings:[],subjects:[],chatKey:'',search:'',draft:null,bindingEditor:null,collapsed:{...collapsed},shown:{},bindingShown:24,busy:false,error:''};
  let host=null,namespace='',entry=0,disposed=false,verified=-1;const scrolls={list:0,editor:0};
  const visible=()=>!disposed&&host?.isConnected&&isCurrent();
  const position=()=>host?.closest('.sd-storyboard-scroll');
  const remember=()=>{scrolls[view.draft?'editor':'list']=position()?.scrollTop||0;};
  const restore=()=>{const node=position();if(node)node.scrollTop=scrolls[view.draft?'editor':'list'];};
  const draw=()=>{
    if(!visible())return;
    if(verified!==entry)host.innerHTML=`<div role="status">${escape(view.error||'正在读取角色库')}<button type="button" class="sd-btn" data-archive-action="refresh">重试</button></div>`;
    else host.innerHTML=renderCharacterArchive(view,{identity});
    bind();onIcons(host);
  };
  async function authorize(expected=entry) {
    const next=await resolveNamespace();
    if(!visible()||expected!==entry)throw Error('页面已切换，操作未继续');
    if(namespace&&next!==namespace){view.draft=null;view.rows=[];view.bindings=[];view.bindingEditor=null;verified=-1;namespace=next;throw Error('账户已切换，请刷新角色库');}
    namespace=next;
    const context=await getContext();
    if(!visible()||expected!==entry)throw Error('页面已切换，操作未继续');
    if(view.chatKey!==context.chatKey)view.bindingEditor=null;
    view.chatKey=context.chatKey;view.subjects=context.subjects;verified=entry;return next;
  }
  const loadList=async expected=>{const [rows,bindings]=await Promise.all([store.list(namespace),store.bindings(namespace)]);await authorize(expected);view.rows=rows;view.bindings=bindings;};
  const run=async work=>{
    if(view.busy||!visible())return;const expected=entry;view.busy=true;view.error='';draw();
    const guard=()=>authorize(expected);
    try{await guard();await work(guard,expected);}catch(error){if(visible()&&expected===entry){view.error=error.message||'角色库操作失败';notify(view.error,'warning');}}
    finally{view.busy=false;if(expected===entry)draw();else if(visible())void run((_guard,next)=>loadList(next));}
  };
  const edit=(document,head={})=>{remember();view.draft={id:head.id||'',revision:head.revision||'',version:head.version||0,document:clone(document),dirty:false};view.bindingEditor=null;view.bindingShown=24;scrolls.editor=0;};
  const toList=()=>{remember();view.draft=null;};
  const exportDocument=doc=>{const data=exportCharacterArchive(doc);download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`${doc.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_')}.character.qianmu.json`);if(data.referenceOmitted)notify('已导出文字档案，参考图请在目标环境重新选择','info');};
  const currentBinding=picker=>view.bindings.find(row=>row.category===picker.subject.category&&row.subjectKey===picker.subject.subjectKey&&row.scope===picker.scope&&row.chatKey===(picker.scope==='chat'?view.chatKey:''));
  async function act(action,button) {
    if(action==='import'){if(!view.busy)host.querySelector('[data-archive-file]')?.click();return;}
    await run(async(guard,expected)=>{
      const id=button?.dataset.archiveId,category=button?.dataset.category;
      if(action==='refresh'){await loadList(expected);return;}
      if(action==='new'){edit(newCharacterArchive(category));return;}
      if(action==='more'){view.shown[category]=(view.shown[category]||24)+24;return;}
      if(action==='more-bindings'){view.bindingShown+=24;return;}
      if(action==='edit'){const saved=await store.load(namespace,id);await guard();if(!saved)throw Error('档案已不存在，请刷新列表');edit(saved.document,saved.head);return;}
      if(action==='cancel'){if(view.draft?.dirty&&!await confirm('放弃尚未保存的档案修改？'))return;await guard();toList();await loadList(expected);return;}
      if(action==='copy'){const doc=normalizeCharacterArchive(view.draft.document);edit({...doc,name:`${doc.name.slice(0,74)} 副本`});view.draft.dirty=true;return;}
      if(action==='clear-image'){view.draft.document.imagegen.reference=null;view.draft.document.imagegen.preview=null;view.draft.dirty=true;return;}
      if(action==='export'){exportDocument(view.draft.document);return;}
      if(action==='save'){const draft=view.draft;await store.save(namespace,{id:draft.id,expectedRevision:draft.revision,document:draft.document});await guard();notify('档案已保存','success');toList();await loadList(expected);return;}
      if(action==='delete'){const draft=view.draft;if(!draft.id)return;if(!await confirm('删除此档案？档案文字不可恢复；参考图文件和历史成片不会删除。'))return;await guard();await store.remove(namespace,draft.id,draft.revision);await guard();toList();await loadList(expected);notify('档案已删除，参考文件保留','success');return;}
      if(action==='unbind'){
        const rows=view.bindings.filter(row=>row.archiveId===view.draft.id),row=rows[Number(button.dataset.bindingIndex)];if(!row)throw Error('绑定已变化');
        if(!await confirm('解除此绑定？当前聊天级解除后将沿用角色默认绑定。'))return;await guard();
        await store.bind(namespace,{target:row,expectedRevision:row.revision,inherit:true});await loadList(expected);return;
      }
      if(action==='binding'){
        const subject=view.subjects[Number(button.dataset.subjectIndex)];if(!subject?.subjectKey)return;
        const scope=view.chatKey?'chat':'default',row=selectCharacterBinding(view.bindings,subject,view.chatKey);
        view.bindingEditor={subject,scope,archiveId:row?.archiveId||''};return;
      }
      if(action==='binding-cancel'){view.bindingEditor=null;return;}
      if(action==='binding-save'||action==='inherit'){
        const picker=view.bindingEditor;if(!picker)return;
        const target={category:picker.subject.category,subjectKey:picker.subject.subjectKey,scope:picker.scope,chatKey:view.chatKey};
        await store.bind(namespace,{target,archiveId:picker.archiveId,expectedRevision:currentBinding(picker)?.revision||'',inherit:action==='inherit'});
        await guard();view.bindingEditor=null;await loadList(expected);notify('绑定已保存','success');return;
      }
    });restore();
  }
  function bind() {
    host.querySelectorAll('[data-archive-action]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void act(button.dataset.archiveAction,button);}));
    host.querySelectorAll('[data-archive-category]').forEach(details=>details.addEventListener('toggle',()=>{if(!visible()||!host.contains(details))return;const key=details.dataset.archiveCategory,next=!details.open;if(Boolean(view.collapsed[key])===next)return;view.collapsed[key]=next;onCollapse({...view.collapsed});}));
    host.querySelector('[data-archive-search]')?.addEventListener('input',event=>{const start=event.target.selectionStart;view.search=event.target.value;draw();const input=host.querySelector('[data-archive-search]');input?.focus();try{input?.setSelectionRange(start,start);}catch(_){}});
    host.querySelectorAll('[data-archive-field]').forEach(field=>field.addEventListener('input',()=>{
      if(!view.draft)return;const key=field.dataset.archiveField,doc=view.draft.document;view.draft.dirty=true;
      if(key==='name'||key==='ageStatus')doc[key]=field.value;
      else if(key==='aliases')doc.aliases=field.value.split(/[,，\n]/).map(value=>value.trim()).filter(Boolean);
      else if(['appearance','negative','sensitiveAppearance'].includes(key))doc.imagegen[key]=field.value;
      else if(key==='referenceStrength'||key==='referenceFidelity'){
        doc.imagegen.novelReference ||= {strength:0.6,fidelity:1};
        doc.imagegen.novelReference[key==='referenceStrength'?'strength':'fidelity']=field.value===''?'invalid':Number(field.value);
      }
    }));
    host.querySelectorAll('[data-archive-binding]').forEach(field=>field.addEventListener('change',()=>{if(!view.bindingEditor)return;view.bindingEditor[field.dataset.archiveBinding]=field.value;if(field.dataset.archiveBinding==='scope'){const row=currentBinding(view.bindingEditor);view.bindingEditor.archiveId=row?.archiveId||'';draw();}}));
    host.querySelector('[data-archive-file]')?.addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;void run(async guard=>{
      if(file.size>128*1024)throw Error('档案文件须小于 128 KB');const imported=importCharacterArchive(await file.text());await guard();edit(imported.document);view.draft.dirty=true;if(imported.referenceOmitted)notify('文字档案已载入，请重新选择参考图','info');
    });});
    host.querySelector('[data-archive-image]')?.addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;const draft=view.draft;void run(async guard=>{
      const result=await saveReference(file,guard);await guard();if(view.draft!==draft)throw Error('编辑页已变化，原档案未修改');draft.document.imagegen.reference=result.reference;draft.document.imagegen.preview=result.preview;draft.dirty=true;
    });});
  }
  return Object.freeze({
    mount(element){if(disposed)return;const changed=host!==element;host=element;if(changed)entry++;draw();if(changed||verified!==entry)void run((_guard,expected)=>loadList(expected));},
    detach(){remember();host=null;entry++;},
    dispose(){disposed=true;host=null;view.draft=null;entry++;store.close();},
  });
}
