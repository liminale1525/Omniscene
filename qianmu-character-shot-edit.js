// Explicit per-image edits. Never read today's library during redraw or automatic generation.
import {normalizeStoryboardShotSpec,normalizeStoryboardCharacterVisualState,compileStoryboardPrompt,getStoryboardCapabilities,
  resolveStoryboardProfileBinding,STORYBOARD_SPATIAL_REGIONS,STORYBOARD_CROPS,synchronizeStoryboardCaptionBase} from './qianmu-storyboard.js';
import {assertCharacterCastingSnapshots,normalizeCharacterCastingSnapshot} from './qianmu-character-casting.js';
import {normalizeCharacterReferenceSnapshot,planCharacterReference} from './qianmu-character-reference.js';
import {normalizeComfyCharacterSnapshot} from './qianmu-comfy-character-contract.js';
import {normalizeCharacterArchive} from './qianmu-character-archive.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw Object.assign(new Error(message),{code:'character_shot_edit'});};
const limits={identity:[30,500],outfit:[20,500],temporaryState:[20,500],expression:[12,300],pose:[12,500],action:[12,500],gaze:[8,300],props:[20,300]};
export const CHARACTER_SHOT_FIELDS={identity:'本镜形象',outfit:'服装',temporaryState:'临时状态',expression:'表情',pose:'姿态',action:'动作',gaze:'视线',props:'持物'};
export function captureCharacterShotFields(character,fields) {
  const next=clone(character);
  if(typeof fields.name!=='string'||!fields.name.trim()||fields.name.length>120)fail('人物称呼须为 1～120 字');
  next.name=fields.name.trim();
  for(const [key,[count,length]] of Object.entries(limits)){
    const rows=String(fields[key]??'').split(/\r?\n/).map(row=>row.trim()).filter(Boolean);
    if(rows.length>count||rows.some(row=>row.length>length))fail(`${CHARACTER_SHOT_FIELDS[key]}最多 ${count} 行，每行 ${length} 字`);
    next[key]=rows;
  }
  const spatial=fields.spatial||{},center=[Number(spatial.x),Number(spatial.y)];
  if(!STORYBOARD_SPATIAL_REGIONS.includes(spatial.region)||!STORYBOARD_CROPS.includes(spatial.crop)
    ||center.some((value,index)=>!String(index?spatial.y:spatial.x).trim()||!Number.isFinite(value)||value<.02||value>.98))fail('人物位置须在 0.02～0.98 之间，并选择有效区域与裁切');
  next.spatial={...next.spatial,region:spatial.region,crop:spatial.crop,center};
  if(fields.negative!==undefined){
    if(typeof fields.negative!=='string'||fields.negative.length>6000)fail('人物负面词须在 6000 字以内');
    if(Object.hasOwn(character,'negative')||fields.negative.trim()!==(character.archiveSnapshot?.negative||''))next.negative=fields.negative.trim();
  }
  return normalizeStoryboardCharacterVisualState(next);
}

function appearanceParts(text){
  const rows=[];
  for(let row of text.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)){
    while(row.length>500){let end=Math.max(row.lastIndexOf(' ',500),row.lastIndexOf(',',500),row.lastIndexOf('，',500));if(end<250)end=500;rows.push(row.slice(0,end));row=row.slice(end).trim();}
    if(row)rows.push(row);
  }
  if(rows.length>30)fail('最新档案形象过长，请先精简再应用到本镜');return rows;
}
export async function readLatestCharacterForShot(character,{namespace,includeReference=false,includeComfy=false,store,guard=async()=>{}}={}) {
  const original=clone(character);assertCharacterCastingSnapshots({characters:[original]});const archived=original.archiveSnapshot;
  if(!archived)fail('本镜人物未绑定档案，不能猜测最新档案');
  if(!/^st-user:.+/.test(namespace||''))fail('未确认当前 ST 账户');
  for(const saved of [archived.imageReference,archived.comfyImplementation])if(saved&&saved.namespace!==namespace)fail('此人物档案属于另一 ST 账户');
  let owned=false;
  if(!store){await guard();const module=await import('./qianmu-character-archive-store.js');store=module.createCharacterArchiveStore();owned=true;}
  try{
    await guard();const record=await store.load(namespace,archived.archiveId);await guard();
    if(!record||record.head.id!==archived.archiveId)fail('原角色档案已不存在；本镜旧快照仍可使用');
    const doc=normalizeCharacterArchive(record.document);if(doc.category!==archived.category)fail('原角色档案分类已变化，请先核对角色库');
    const snapshot=normalizeCharacterCastingSnapshot({...archived,archiveVersion:record.head.version,name:doc.name,negative:doc.imagegen.negative,
      ...(includeReference||archived.imageReference?{imageReference:normalizeCharacterReferenceSnapshot({version:1,namespace,reference:doc.imagegen.reference,...doc.imagegen.novelReference})}:{}),
      ...(includeComfy||archived.comfyImplementation?{comfyImplementation:normalizeComfyCharacterSnapshot({version:1,namespace,implementations:doc.comfy?.implementations||[],reference:doc.comfy?.implementations?.some(row=>row.referenceSlot!==null)?doc.imagegen.reference:null})}:{}),
    });
    if(snapshot.invalid)fail('最新档案版本无效，未替换本镜');
    // The user explicitly adopts base appearance. Never overwrite this scene's clothes/actions/state.
    return {...original,identity:appearanceParts(doc.imagegen.appearance),negative:doc.imagegen.negative,archiveSnapshot:snapshot};
  }finally{if(owned)store.close();}
}

const compile=(snapshot,shot)=>compileStoryboardPrompt({providerId:snapshot.source,remoteModelId:snapshot.profile.model,capabilityModelId:snapshot.profile.capabilityModelId,
  connection:snapshot.connection||{},workflow:snapshot.source==='comfy'?snapshot.profile.comfyWorkflow:undefined,shot});
function replaceBlocks(prompt,before,after){
  const positions=[];
  for(let i=0;i<before.length;i++){
    const text=before[i];if(!text||prompt.indexOf(text)<0||prompt.indexOf(text)!==prompt.lastIndexOf(text))return null;
    positions.push({start:prompt.indexOf(text),end:prompt.indexOf(text)+text.length,replacement:after[i]});
  }
  positions.sort((a,b)=>a.start-b.start);
  if(positions.some((row,index)=>index&&row.start<positions[index-1].end))return null;
  for(const row of positions.reverse())prompt=prompt.slice(0,row.start)+row.replacement+prompt.slice(row.end);
  return prompt;
}
export async function prepareCharacterShotEdit(snapshot,characters,{namespace,rebuild=false,guard=async()=>{}}={}) {
  const next=clone(snapshot),raw=next.payload?.shotSpec||next.shotSpec;
  if(!next.profile||!next.payload||!raw?.characters?.length)fail('旧图缺少人物结构，不能猜测拆分');
  assertCharacterCastingSnapshots(raw);
  if(characters.length!==raw.characters.length||characters.some((row,index)=>row.id!==raw.characters[index].id))fail('人物顺序或身份已变化，请重新打开本镜');
  assertCharacterCastingSnapshots({characters});
  const shot=normalizeStoryboardShotSpec({...raw,characters});
  if(JSON.stringify(shot.characters)===JSON.stringify(normalizeStoryboardShotSpec(raw).characters)){await guard();return {snapshot:next,mode:'unchanged',warnings:[]};}
  const previous=compile(next,raw),compiled=compile(next,shot);
  if(!compiled.validation.valid)fail(compiled.validation.errors[0]);
  const oldPrompt=String(next.payload.prompt||''),options=next.payload.parameters?.providerOptions;
  const native=Boolean(compiled.providerOptions.v4_prompt&&options?.v4_prompt?.caption?.char_captions?.length===raw.characters.length);
  let prompt=oldPrompt,mode='native_characters';
  if(!native){
    mode='named_character_blocks';prompt=replaceBlocks(oldPrompt,previous.characterBlocks,compiled.characterBlocks);
    if(prompt===null){
      if(!rebuild)throw Object.assign(new Error('原词无法可靠拆分人物。请勾选重建正面词，应用后核对预览；不会自动覆盖。'),{code:'character_shot_rebuild_required'});
      mode='explicit_rebuild';prompt=[next.payload.artistString||next.artistString||'',compiled.prompt].filter(Boolean).join(', ');
    }
  }
  if(!prompt.trim()||prompt.length>24000)fail('修改后的正面词为空或超过 24000 字，请精简后应用');
  next.payload.parameters ||= {};next.payload.parameters.providerOptions ||= {};
  if(native||compiled.providerOptions.v4_prompt&&rebuild){
    for(const key of ['v4_prompt','v4_negative_prompt']){
      const existing=next.payload.parameters.providerOptions[key]||{};
      const proposed=clone(compiled.providerOptions[key]),oldCaptions=existing.caption?.char_captions||[];
      if(native&&(oldCaptions.length||proposed.caption.char_captions.length)){
        const captionAt=(result,index)=>result.providerOptions[key]?.caption?.char_captions?.[index]||{char_caption:'',centers:[{x:result.validation.shot.characters[index].spatial.center[0],y:result.validation.shot.characters[index].spatial.center[1]}]};
        proposed.caption.char_captions=shot.characters.map((_,index)=>{
          const before=captionAt(previous,index),after=captionAt(compiled,index);
          return JSON.stringify(before)===JSON.stringify(after)&&oldCaptions[index]?clone(oldCaptions[index]):clone(after);
        });
      }
      next.payload.parameters.providerOptions[key]={...proposed,...existing,caption:{...existing.caption,...proposed.caption}};
    }
  }
  next.shotSpec=clone(shot);next.payload.shotSpec=clone(shot);next.prompt=prompt;next.payload.prompt=prompt;
  next.promptLocked=true;next.promptMode='manual';
  next.compiledPrompt={...compiled,prompt,negative:next.payload.negative||''};next.payload.compiledPrompt=clone(next.compiledPrompt);
  synchronizeStoryboardCaptionBase(next.payload);
  next.compiledPrompt.providerOptions=clone(next.payload.parameters.providerOptions);next.payload.compiledPrompt.providerOptions=clone(next.payload.parameters.providerOptions);
  if(next.source==='novel'&&next.profile.characterReferenceEnabled===true){
    const binding=resolveStoryboardProfileBinding(next.source,next.profile);
    const reference=planCharacterReference({source:next.source,enabled:true,shot,capabilities:getStoryboardCapabilities(next.source,binding.capabilityModelId),hasVibes:Boolean(next.payload.selectedVibeIds?.length),safetyAdapted:next.safetyAdapted===true});
    if(reference?.status==='selected'&&reference.namespace!==namespace)fail('参考图属于另一 ST 账户');next.payload.characterReference=reference;
  }
  if(next.source==='comfy'&&next.profile.comfyCharacterEnabled===true){
    const runtime=await import('./qianmu-comfy-character-plan.js');await guard();
    next.payload.parameters.workflow=JSON.parse(next.profile.comfyWorkflow);delete next.payload.comfyCharacterPlan;
    // Validate the new frozen cast locally. Actual remote readiness/admission still happens on generation.
    await runtime.prepareComfyCharacterJob({...next,automatic:false},{namespace,guard});await guard();
  }
  await guard();return {snapshot:next,mode,warnings:compiled.validation.warnings};
}
