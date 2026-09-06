import {CHARACTER_SHOT_FIELDS,captureCharacterShotFields,readLatestCharacterForShot,prepareCharacterShotEdit} from './qianmu-character-shot-edit.js';
import {STORYBOARD_SPATIAL_REGIONS,STORYBOARD_CROPS} from './qianmu-storyboard.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const regions={far_left:'最左',left:'左侧',center_left:'偏左',center:'中央',center_right:'偏右',right:'右侧',far_right:'最右',background:'背景'};
const crops={full:'全身',knees:'膝部以上',waist:'腰部以上',chest:'胸部以上',shoulders:'肩部以上',face:'面部',detail:'局部特写'};
const select=(name,label,values,value,labels={})=>`<label><span>${label}</span><select class="text_pole" data-shot-character-field="${name}">${values.map(id=>`<option value="${id}" ${id===value?'selected':''}>${labels[id]||id}</option>`).join('')}</select></label>`;
export function renderCharacterShotEditor(characters,{source,rebuild=false,message=''}={}){
  return `<div class="sd-character-shot-dialog"><p>只修改本镜，不改角色库。应用后返回提示词预览；保存不自动生图。</p><fieldset>
    ${characters.map((row,index)=>`<details class="sd-character-shot-person" data-shot-person="${index}" ${characters.length===1?'open':''}><summary><b>${escape(row.name)}</b>${row.archiveSnapshot?`<small>v${row.archiveSnapshot.archiveVersion}</small>`:''}</summary><div class="sd-character-shot-fields">
      <label><span>本镜称呼</span><input class="text_pole" data-shot-character-field="name" value="${escape(row.name)}" maxlength="120"></label>
      ${row.archiveSnapshot?'<button type="button" class="sd-btn sd-character-shot-latest">使用最新档案</button>':''}
      ${Object.entries(CHARACTER_SHOT_FIELDS).map(([key,label])=>`<label><span>${label}</span><textarea class="text_pole" data-shot-character-field="${key}" rows="2">${escape((row[key]||[]).join('\n'))}</textarea></label>`).join('')}
      ${source!=='comfy'?`<label class="sd-character-shot-wide"><span>仅此人物的负面词</span><textarea class="text_pole" data-shot-character-field="negative" rows="2" maxlength="6000">${escape(Object.hasOwn(row,'negative')?row.negative:row.archiveSnapshot?.negative||'')}</textarea></label>`:''}
      ${select('region','画面区域',STORYBOARD_SPATIAL_REGIONS,row.spatial.region,regions)}${select('crop','可见范围',STORYBOARD_CROPS,row.spatial.crop,crops)}
      ${['x','y'].map((key,i)=>`<label><span>${key==='x'?'横向':'纵向'}中心</span><input class="text_pole" type="number" min="0.02" max="0.98" step="0.01" data-shot-character-field="${key}" value="${row.spatial.center[i]}"></label>`).join('')}
    </div></details>`).join('')}
    <label class="sd-check"><input type="checkbox" class="sd-character-shot-rebuild" ${rebuild?'checked':''}><span>无法拆分时重建正面词</span></label>
    <small>重建可能替换手写词及额外前缀，请在返回后的预览中核对。使用最新档案会替换本镜形象与专属配置，但保留动作、服装和位置。</small>
    </fieldset><p class="sd-character-shot-status" role="status">${escape(message)}</p></div>`;
}
export function captureCharacterShotEditor(host,characters){
  return characters.map((row,index)=>{
    const element=host.querySelector(`[data-shot-person="${index}"]`),fields={spatial:{}};
    if(!element)throw Error('人物编辑页已变化');
    for(const field of element.querySelectorAll('[data-shot-character-field]')){
      const name=field.dataset.shotCharacterField;
      if(['region','crop','x','y'].includes(name))fields.spatial[name]=field.value;else fields[name]=field.value;
    }
    return captureCharacterShotFields(row,fields);
  });
}
export async function openCharacterShotEditor({snapshot,context,namespace,guard=async()=>{},loadLatest=readLatestCharacterForShot}={}){
  let characters=clone(snapshot.payload?.shotSpec?.characters||snapshot.shotSpec?.characters||[]),rebuild=false,
    message=snapshot.payload?.parameters?.providerOptions?.v4_prompt?.use_coords===false?'本镜关闭了原生坐标定位；修改位置不会自动打开它。':'',rawInputs=[],openRows=[],scrollTop=0;
  if(!characters.length)throw Error('本镜没有可编辑的人物结构');
  for(;;){
    await guard();const wrap=document.createElement('div');wrap.innerHTML=renderCharacterShotEditor(characters,{source:snapshot.source,rebuild,message});
    for(const row of rawInputs){const field=wrap.querySelector(`[data-shot-person="${row.index}"] [data-shot-character-field="${row.name}"]`);if(field)field.value=row.value;}
    for(const row of openRows){const details=wrap.querySelector(`[data-shot-person="${row.index}"]`);if(details)details.open=row.open;}
    const status=wrap.querySelector('.sd-character-shot-status');let closed=false,pending=false;
    const current=async()=>{await guard();if(closed||!wrap.isConnected)throw Error('人物编辑已关闭');};
    for(const button of wrap.querySelectorAll('.sd-character-shot-latest'))button.addEventListener('click',async event=>{
      event.preventDefault();if(pending||closed)return;pending=true;
      try{
        characters=captureCharacterShotEditor(wrap,characters);const index=Number(button.closest('[data-shot-person]').dataset.shotPerson);
        wrap.querySelector('fieldset').disabled=true;status.textContent='正在读取原档案的最新版本…';
        const updated=await loadLatest(characters[index],{namespace,includeReference:snapshot.source==='novel'&&snapshot.profile.characterReferenceEnabled===true,
          includeComfy:snapshot.source==='comfy'&&Boolean(snapshot.profile.comfyCharacterActivation),guard:current});await current();
        characters[index]=updated;
        const person=wrap.querySelector(`[data-shot-person="${index}"]`);
        person.querySelector('[data-shot-character-field=identity]').value=updated.identity.join('\n');
        const negative=person.querySelector('[data-shot-character-field=negative]');if(negative)negative.value=updated.negative;
        person.querySelector('summary small').textContent=`v${updated.archiveSnapshot.archiveVersion}`;
        status.textContent='最新档案已载入本镜草稿，尚未保存。';
      }catch(error){if(!closed)status.textContent=error.message;}finally{pending=false;if(!closed)wrap.querySelector('fieldset').disabled=false;}
    });
    let result,frame;
    try{
      const opening=new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:'应用并返回',cancelButton:'取消'}).show();
      frame=requestAnimationFrame(()=>{if(!closed&&wrap.isConnected)wrap.querySelector('.sd-character-shot-dialog').scrollTop=scrollTop;});
      result=await opening;
    }finally{closed=true;if(frame!==undefined)cancelAnimationFrame(frame);}
    await guard();if(!result)return null;
    rawInputs=[...wrap.querySelectorAll('[data-shot-character-field]')].map(field=>({index:Number(field.closest('[data-shot-person]').dataset.shotPerson),name:field.dataset.shotCharacterField,value:field.value}));
    openRows=[...wrap.querySelectorAll('[data-shot-person]')].map(details=>({index:Number(details.dataset.shotPerson),open:details.open}));
    scrollTop=wrap.querySelector('.sd-character-shot-dialog').scrollTop;rebuild=wrap.querySelector('.sd-character-shot-rebuild').checked;
    if(pending){message='档案仍在读取，未应用修改，请重试。';continue;}
    try{
      characters=captureCharacterShotEditor(wrap,characters);
      return await prepareCharacterShotEdit(snapshot,characters,{namespace,rebuild,guard});
    }catch(error){message=error.message;}
  }
}
