// Manual world-camera preparation only. No inference, archive mutation or media submission.
import {applyCharacterCasting,characterCastingInput} from './qianmu-character-casting.js';
import {normalizeStoryboardShotSpec} from './qianmu-storyboard.js';
import {applyCharacterReferenceChoice,renderCharacterReferencePicker} from './qianmu-character-reference.js';
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw Object.assign(new Error(message),{code:'world_shot_preparation'}); };
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

function parts(values,count,length,label) {
  const rows=[];
  for (const value of values) {
    if (typeof value !== 'string') fail(`${label}格式无效`);
    for (let row of value.split(/\r?\n/).map(text=>text.trim()).filter(Boolean)) {
      while (row.length > length) {
        let end = Math.max(row.lastIndexOf(' ',length),row.lastIndexOf(',',length),row.lastIndexOf('，',length));
        if (end < length/2) end=length;
        // Do not split a surrogate pair when no word boundary is available.
        if (/^[\uDC00-\uDFFF]$/.test(row[end])) end--;
        rows.push(row.slice(0,end)); row=row.slice(end).trim();
        if (rows.length > count) fail(`${label}过长，请精简后重试`);
      }
      if (row) rows.push(row);
      if (rows.length > count) fail(`${label}过长，请精简后重试`);
    }
  }
  return rows;
}

export function prepareWorldCharacterShot(input,prepared) {
  characterCastingInput(prepared);
  const visible=(input.characters || []).filter(row=>row.visible!==false);
  if (visible.length > 12 || visible.some(row=>!row.id || !row.name)
    || new Set(visible.map(row=>row.id)).size!==visible.length) fail('出镜人物过多或身份重复，请先核对导演素材');
  const bound=applyCharacterCasting({...copy(input),characters:visible},prepared);
  const byId=new Map((prepared?.entries||[]).map(row=>[row.identity.subjectId,row.identity]));
  const characters=bound.shot.characters.map(row=>({...row,
    // World orders have not passed the prose extractor. Keep base identity and current state separate,
    // and present both for manual review instead of guessing how to reconcile contradictory text.
    identity:parts(row.identity?.length ? row.identity : [byId.get(row.id)?.appearance || ''],30,500,'人物形象'),
    temporaryState:parts(row.temporaryState || [],20,500,'当前状态'),
  }));
  const shot={...bound.shot,characters,promptAtoms:{...bound.shot.promptAtoms,
    global:parts(bound.shot.promptAtoms?.global || [],40,800,'画面描述')}};
  return {shot:normalizeStoryboardShotSpec(shot),warnings:bound.warnings};
}

export function captureWorldShotConfirmation(shot,{characters,referenceChoice,sensitive},useReference=false) {
  if (!Array.isArray(characters) || characters.length!==shot.characters.length
    || characters.some((row,index)=>row.id!==shot.characters[index].id)) fail('出镜人物已变化，请重新确认');
  const next=copy(shot);
  next.characters=characters.map((row,index)=>({...next.characters[index],
    identity:parts([row.identity],30,500,'人物形象'),temporaryState:parts([row.temporaryState],20,500,'当前状态')}));
  next.sensitive=Boolean(shot.sensitive || sensitive);
  return useReference ? applyCharacterReferenceChoice(next,referenceChoice) : next;
}

export function renderWorldShotConfirmation(shot,{title='',model='',useReference=false,warnings=[],fields,message=''}={}) {
  return `<div class="sd-world-shot-dialog"><h3>造物之眼</h3><b>${escape(title)}</b><p>${escape(shot.promptAtoms?.global?.join('\n') || shot.narrativePurpose)}</p>
    <small>导演视角 · ${escape(model)} · 确认后生成，不自动写入正文或推演事实。</small>
    <div class="sd-world-shot-people">${shot.characters.map((row,index)=>{
      const field=fields?.characters?.[index],warning=warnings.find(item=>item.characterId===row.id || item.characterId===row.archiveSnapshot?.sourceCharacterId);
      return `<details data-world-person="${index}" ${shot.characters.length===1?'open':''}><summary><b>${escape(row.name)}</b><small>${row.archiveSnapshot?`${escape(row.archiveSnapshot.name)} · v${row.archiveSnapshot.archiveVersion}`:warning?'匹配冲突，未绑定档案':'未绑定档案'}</small></summary>
        <div class="sd-world-shot-fields"><label><span>本镜基础形象</span><textarea class="text_pole" data-world-field="identity" rows="3">${escape(field?.identity ?? row.identity.join('\n'))}</textarea></label>
        <label><span>本镜当前状态</span><textarea class="text_pole" data-world-field="temporaryState" rows="3">${escape(field?.temporaryState ?? row.temporaryState.join('\n'))}</textarea></label></div></details>`;
    }).join('')}</div>
    ${shot.characters.length?'<small>请核对基础形象是否与本镜状态冲突；这里只改本镜，不修改角色库。未绑定人物按本镜文字生成。</small>':''}
    ${useReference?`${renderCharacterReferencePicker(shot)}<small>参考图可能额外计费，与 Vibe 不可同时使用。</small>`:''}
    <label class="sd-world-shot-sensitive"><input type="checkbox" data-world-sensitive ${(shot.sensitive || fields?.sensitive)?'checked':''} ${shot.sensitive?'disabled':''}><span>画面含敏感情节，需按渠道能力适配</span></label>
    <p role="status">${escape(message)}</p></div>`;
}

export async function openWorldShotConfirmation({shot,context,guard=async()=>{},...options}) {
  let fields,message='',expanded=[],scrollTop=0;
  for (;;) {
    await guard();
    const wrap=document.createElement('div');wrap.innerHTML=renderWorldShotConfirmation(shot,{...options,fields,message});
    for (const [index,open] of expanded) wrap.querySelector(`[data-world-person="${index}"]`).open=open;
    const picker=wrap.querySelector('.sd-character-reference-picker');if (picker && fields) picker.value=fields.referenceChoice;
    const clearStatus=()=>{wrap.querySelector('[role=status]').textContent='';};
    wrap.addEventListener('input',clearStatus);wrap.addEventListener('change',clearStatus);
    let result,frame;
    try {
      const opening=new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:'确认生成',cancelButton:'取消'}).show();
      frame=requestAnimationFrame(()=>{if(wrap.isConnected)wrap.querySelector('.sd-world-shot-dialog').scrollTop=scrollTop;});
      result=await opening;
    } finally {if(frame!==undefined)cancelAnimationFrame(frame);}
    await guard(); if(!result)return null;
    fields={characters:shot.characters.map((row,index)=>{const element=wrap.querySelector(`[data-world-person="${index}"]`);
      return {id:row.id,identity:element.querySelector('[data-world-field=identity]').value,temporaryState:element.querySelector('[data-world-field=temporaryState]').value};}),
      referenceChoice:picker?.value,sensitive:wrap.querySelector('[data-world-sensitive]').checked};
    expanded=[...wrap.querySelectorAll('[data-world-person]')].map(row=>[row.dataset.worldPerson,row.open]);scrollTop=wrap.querySelector('.sd-world-shot-dialog').scrollTop;
    try {return captureWorldShotConfirmation(shot,fields,options.useReference);}catch(error){message=error.message;}
  }
}
