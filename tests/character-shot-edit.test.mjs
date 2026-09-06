import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import {newCharacterArchive} from '../qianmu-character-archive.js';
import {captureCharacterShotFields,readLatestCharacterForShot,prepareCharacterShotEdit} from '../qianmu-character-shot-edit.js';
import {renderCharacterShotEditor} from '../qianmu-character-shot-view.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {job as comfyJob,namespace} from './helpers/comfy-character-fixture.mjs';
import {snapshot} from './helpers/character-shot-fixture.mjs';
import {generateDirectImage} from '../qianmu-image-direct.js';
import {generateImage} from '../qianmu-image-gateway.js';
const copy=structuredClone;
const fields=row=>({name:row.name,...Object.fromEntries(['identity','outfit','temporaryState','expression','pose','action','gaze','props'].map(key=>[key,row[key].join('\n')])),negative:row.negative??row.archiveSnapshot?.negative??'',spatial:{region:row.spatial.region,crop:row.spatial.crop,x:row.spatial.center[0],y:row.spatial.center[1]}});

test('per-person capture preserves identity IDs and zero-copy fields; rejects truncation and invalid coordinates',()=>{
  const row=snapshot().shotSpec.characters[0],draft=fields(row);assert.deepEqual(captureCharacterShotFields(row,draft),row);
  draft.action='opens a door';draft.negative='';const edited=captureCharacterShotFields(row,draft);
  assert.equal(edited.id,row.id);assert.equal(edited.negative,'');assert.equal(edited.archiveSnapshot.negative,row.archiveSnapshot.negative);assert.deepEqual(row.action,['cuts carrots']);
  assert.throws(()=>captureCharacterShotFields(row,{...draft,identity:'x'.repeat(501)}),/每行/);
  assert.throws(()=>captureCharacterShotFields(row,{...draft,spatial:{...draft.spatial,x:''}}),/位置/);
});

test('NAI edits replace only the relevant native character and per-person negative, keeping global artist/quality text',async()=>{
  const old=snapshot(),before=copy(old),characters=copy(old.shotSpec.characters);characters[0].action=['washes dishes'];characters[0].negative='';
  const {snapshot:next,mode}=await prepareCharacterShotEdit(old,characters,{namespace});
  assert.equal(mode,'native_characters');assert.equal(next.payload.prompt,old.payload.prompt);assert.equal(next.payload.negative,old.payload.negative);
  const params=next.payload.parameters.providerOptions;assert.match(params.v4_prompt.caption.char_captions[0].char_caption,/washes dishes/);assert.doesNotMatch(params.v4_prompt.caption.char_captions[0].char_caption,/cuts carrots/);
  assert.deepEqual(params.v4_prompt.caption.char_captions[1],old.payload.parameters.providerOptions.v4_prompt.caption.char_captions[1]);
  assert.equal(params.v4_negative_prompt.caption.char_captions[0].char_caption,'');assert.equal(params.v4_negative_prompt.caption.char_captions[1].char_caption,'no bob red hair');
  assert.deepEqual(next.shotSpec,next.payload.shotSpec);assert.equal(next.promptLocked,true);assert.deepEqual(old,before);
});

test('editing Alice preserves untouched native Bob overrides and original coordinate/order policy',async()=>{
  const old=snapshot(),options=old.payload.parameters.providerOptions;
  options.v4_prompt.use_coords=false;options.v4_prompt.use_order=false;options.v4_prompt.caption.char_captions[1].char_caption='independently edited Bob';
  options.v4_negative_prompt.caption.char_captions[1].char_caption='independently edited Bob exclusion';
  const characters=copy(old.shotSpec.characters);characters[0].action=['waves'];
  const next=(await prepareCharacterShotEdit(old,characters,{namespace})).snapshot.payload.parameters.providerOptions;
  assert.equal(next.v4_prompt.caption.char_captions[1].char_caption,'independently edited Bob');assert.equal(next.v4_negative_prompt.caption.char_captions[1].char_caption,'independently edited Bob exclusion');
  assert.equal(next.v4_prompt.use_coords,false);assert.equal(next.v4_prompt.use_order,false);assert.match(next.v4_prompt.caption.char_captions[0].char_caption,/waves/);
});

test('edited NAI fields reach both actual request builders and survive persisted snapshot normalization',async()=>{
  const old=snapshot(),characters=copy(old.shotSpec.characters);characters[0].identity=['silver hair'];characters[0].negative='exclude red eyes';
  const edited=(await prepareCharacterShotEdit(old,characters,{namespace})).snapshot;
  const restored=storyboard.sanitizeStoryboardSnapshot(copy(edited));assert.deepEqual(restored.shotSpec.characters[0].identity,['silver hair']);assert.equal(restored.shotSpec.characters[0].negative,'exclude red eyes');
  const requests=[],fetchImpl=async(url,options)=>{requests.push(JSON.parse(options.body));return new Response('controlled fixture rejection',{status:400});};
  const request={provider:'novel',baseUrl:'https://image.novelai.net',apiKey:'fixture',model:old.profile.model,prompt:restored.payload.prompt,negativePrompt:restored.payload.negative,parameters:restored.payload.parameters};
  await assert.rejects(()=>generateDirectImage(request,{fetchImpl}));await assert.rejects(()=>generateImage(request,{fetchImpl,resolveHost:async()=>[{address:'93.184.216.34',family:4}]}));
  assert.equal(requests.length,2);for(const key of ['v4_prompt','v4_negative_prompt'])assert.deepEqual(requests[0].parameters[key],requests[1].parameters[key]);
  assert.match(requests[0].parameters.v4_prompt.caption.char_captions[0].char_caption,/silver hair/);assert.equal(requests[0].parameters.v4_negative_prompt.caption.char_captions[0].char_caption,'exclude red eyes');
});

test('latest NAI archive updates only the selected reference receipt and cannot be refreshed from another account',async()=>{
  const old=snapshot();Object.assign(old.profile,{model:'nai-diffusion-4-5-full',capabilityModelId:'nai-diffusion-4-5-full',characterReferenceEnabled:true});
  const doc={...newCharacterArchive('char'),name:'Alice'};doc.imagegen.appearance='silver hair';doc.imagegen.reference={url:'/user/images/new.png',mime:'image/png',bytes:70,sha256:'b'.repeat(64),name:'new'};doc.imagegen.novelReference={strength:.35,fidelity:0};
  const oldReference={version:1,namespace,reference:{...doc.imagegen.reference,url:'/user/images/old.png',sha256:'a'.repeat(64)},strength:.6,fidelity:1};
  for(const shot of [old.shotSpec,old.payload.shotSpec]){shot.primarySubjectId=shot.characters[0].id;shot.characters[0].archiveSnapshot.imageReference=copy(oldReference);}
  let reads=0;const store={load:async(_,id)=>{reads++;return {head:{id,version:2},document:doc};}},characters=copy(old.shotSpec.characters);
  characters[0]=await readLatestCharacterForShot(characters[0],{namespace,store,includeReference:true});
  const next=(await prepareCharacterShotEdit(old,characters,{namespace})).snapshot;
  assert.equal(next.payload.characterReference.reference.url,'/user/images/new.png');assert.equal(next.payload.characterReference.fidelity,0);assert.equal(next.payload.characterReference.subjectId,'archive:alice');
  assert.equal(old.payload.shotSpec.characters[0].archiveSnapshot.imageReference.reference.url,'/user/images/old.png');
  await assert.rejects(()=>readLatestCharacterForShot(characters[0],{namespace:'st-user:other',store}),/另一 ST 账户/);assert.equal(reads,1);
});

test('named engines replace exact frozen character blocks without duplicating old traits or erasing user prefixes',async()=>{
  const old=snapshot('openai'),characters=copy(old.shotSpec.characters);old.payload.prompt=`custom style, ${old.payload.prompt}, handmade ending`;characters[0].identity=['silver hair'];
  const {snapshot:next,mode}=await prepareCharacterShotEdit(old,characters,{namespace});
  assert.equal(mode,'named_character_blocks');assert.match(next.payload.prompt,/^custom style/);assert.match(next.payload.prompt,/handmade ending$/);assert.doesNotMatch(next.payload.prompt,/black hair/);
  assert.match(next.payload.prompt,/silver hair/);assert.match(next.payload.prompt,/Bob, red hair/);assert.match(next.payload.prompt,/Undesired traits for "Alice" only/);
  assert.equal(next.payload.parameters.providerOptions.v4_prompt,undefined);
});

test('handwritten/unpartitionable prompts require explicit rebuild and unchanged viewing does not rewrite them',async()=>{
  const old=snapshot('openai');old.payload.prompt='handwritten scene';const characters=copy(old.shotSpec.characters);
  assert.equal((await prepareCharacterShotEdit(old,characters,{namespace})).mode,'unchanged');
  characters[0].identity=['silver hair'];await assert.rejects(()=>prepareCharacterShotEdit(old,characters,{namespace}),{code:'character_shot_rebuild_required'});
  const {snapshot:next,mode}=await prepareCharacterShotEdit(old,characters,{namespace,rebuild:true});assert.equal(mode,'explicit_rebuild');assert.match(next.payload.prompt,/silver hair/);assert.equal(next.payload.negative,'keep global negatives');
  assert.equal(old.payload.prompt,'handwritten scene');
});

test('latest archive refresh is explicit, updates one identity version and does not overwrite wardrobe/action or expose sensitive fields',async()=>{
  const row=snapshot().shotSpec.characters[0],doc={...newCharacterArchive('char'),name:'Alice latest'};doc.imagegen.appearance='silver hair';doc.imagegen.negative='updated exclusion';doc.imagegen.sensitiveAppearance='PRIVATE FIELD';
  let loads=0;const store={load:async(account,id)=>{loads++;assert.equal(account,namespace);assert.equal(id,'alice');return {head:{id,version:2},document:doc};}};
  const next=await readLatestCharacterForShot(row,{namespace,store});assert.equal(loads,1);assert.deepEqual(next.identity,['silver hair']);assert.deepEqual(next.outfit,['no coat']);assert.deepEqual(next.action,['cuts carrots']);assert.deepEqual(next.spatial,row.spatial);
  assert.equal(next.id,row.id);assert.equal(next.archiveSnapshot.archiveVersion,2);assert.equal(next.name,'Alice');assert.doesNotMatch(JSON.stringify(next),/PRIVATE FIELD/);assert.equal(row.archiveSnapshot.archiveVersion,1);
  await assert.rejects(()=>readLatestCharacterForShot(row,{namespace,store:{load:async()=>null}}),/已不存在/);
  await assert.rejects(()=>readLatestCharacterForShot(row,{namespace,store,guard:async()=>{throw Error('changed');}}),/changed/);assert.equal(loads,1);
});

test('Comfy edited identity keeps the private recipe isolated and refresh invalidation forces a new preparation receipt',async()=>{
  const old=comfyJob();const compiled=storyboard.compileStoryboardPrompt({providerId:'comfy',remoteModelId:'comfy-workflow',shot:old.shotSpec,workflow:old.profile.comfyWorkflow});old.payload.prompt=compiled.prompt;
  const characters=copy(old.shotSpec.characters);characters[0].action=['walks'];
  const {snapshot:next}=await prepareCharacterShotEdit(old,characters,{namespace});assert.match(next.payload.prompt,/walks/);assert.equal(next.payload.comfyCharacterPlan,undefined);assert.equal(next.payload.parameters.workflow.lora.inputs.strength_model,0);
  assert.doesNotMatch(next.payload.prompt,/NAI ONLY/);assert.equal(next.shotSpec.characters[0].archiveSnapshot.comfyImplementation.implementations[0].name,'Alice workflow');
  characters[0].archiveSnapshot.comfyImplementation.implementations[0].workflow.revision='changed';await assert.rejects(()=>prepareCharacterShotEdit(old,characters,{namespace}),/工作流版本/);
});

test('person display escapes markup, offers no fake Comfy negative input and never includes private files',()=>{
  const rows=snapshot().shotSpec.characters;rows[0].name='<img src=x>';const html=renderCharacterShotEditor(rows,{source:'comfy'});
  assert.doesNotMatch(html,/<img|data-shot-character-field="negative"|alice.png/);assert.match(html,/&lt;img/);assert.match(html,/使用最新档案/);assert.match(html,/重建正面词/);
});

for(const choice of ['save','cancel','generate','changed'])test(`actual prompt editor -> person draft -> preview ${choice} preserves explicit save/generate boundary`,async()=>{
  const state=storyboard.createStoryboardDefaults(),original=snapshot(),record={id:'image',floor:0,prompt:original.payload.prompt,finalPrompt:original.payload.prompt,negative:original.payload.negative};
  let saved=null,generated=0,round=0;const notices=[],draft=copy(original.shotSpec.characters);draft[0].action=['opens a door'];
  const updated=(await prepareCharacterShotEdit(original,draft,{namespace})).snapshot;
  const fields={'.sd-storyboard-edit-positive':{value:''},'.sd-storyboard-edit-negative':{value:''}};
  const context=vm.createContext({...storyboard,clone:copy,storyboardState:()=>state,getChatKey:()=> 'chat',storyboardReadSnapshotForRecord:async()=>copy(original),toast:m=>notices.push(m),
    storyboardStoreSnapshotForRecord:async(_,value)=>saved=copy(value),saveMetadata:async()=>{},storyboardRenderInlineImages(){},storyboardRedrawRecord:()=>{generated++;return true;},
    document:{createElement:()=>({querySelector:selector=>fields[selector],insertAdjacentHTML(){}})},
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:{openCharacterShotEditor:async()=>{if(choice==='changed')record.finalPrompt='other edit';return {snapshot:updated};}}},
    ctx:()=>({POPUP_TYPE:{CONFIRM:1},Popup:class{constructor(wrap,type,title,options){this.options=options;}async show(){round++;if(round===1){assert.ok(this.options.customButtons.some(row=>row.result===3));return 3;}assert.equal(fields['.sd-storyboard-edit-positive'].value,original.payload.prompt);return choice==='cancel'?0:choice==='generate'?1:2;}}}),
  });
  vm.runInContext(section('storyboardEditPrompt'),context);const result=await context.storyboardEditPrompt({record});
  assert.equal(Boolean(result),choice==='save'||choice==='generate');assert.equal(generated,choice==='generate'?1:0);
  if(choice==='save'||choice==='generate'){assert.deepEqual(saved.shotSpec.characters[0].action,['opens a door']);assert.equal(saved.payload.parameters.providerOptions.v4_prompt.caption.base_caption,saved.payload.prompt);}
  else assert.equal(saved,null);
});
