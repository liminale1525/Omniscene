import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as casting from '../qianmu-character-casting.js';
import * as storyboard from '../qianmu-storyboard.js';
import * as contract from '../qianmu-storyboard-contract.js';
import {newCharacterArchive,normalizeCharacterArchive} from '../qianmu-character-archive.js';
import {buildStoryboardPlanContractRequest,buildStoryboardSafetyContractRequest,adaptStoryboardSafetyContract,STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID} from '../qianmu-storyboard-contract.js';
import {generateDirectImage} from '../qianmu-image-direct.js';
import {generateImage} from '../qianmu-image-gateway.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const doc=(name,category='char',aliases=[])=>normalizeCharacterArchive({...newCharacterArchive(category),name,aliases,
  imagegen:{appearance:`${name} base appearance`,negative:`${name} unwanted trait`,sensitiveAppearance:'SENSITIVE-DO-NOT-PROJECT',
    reference:{url:'/user/images/private.png',name:'private',bytes:70,sha256:'a'.repeat(64),mime:'image/png'}}});
function environment() {
  const documents=new Map([['alice',doc('Alice','char',['阿莉'])],['bob',doc('Bob','char')],['user',doc('Player','user')],
    ['other',doc('Gardener','other',['园丁'])],['absent',doc('Absent','other')],['unused',doc('Unused','char')]]);
  const versions=new Map(),reads=[],bindings=[
    {category:'char',subjectKey:'char:alice.png',scope:'default',chatKey:'',archiveId:'alice'},
    {category:'char',subjectKey:'char:bob.png',scope:'default',chatKey:'',archiveId:'bob'},
    {category:'user',subjectKey:'user:one.png',scope:'default',chatKey:'',archiveId:'user'},
  ];
  const subjects=[{category:'char',subjectKey:'char:alice.png',name:'Alice'},{category:'char',subjectKey:'char:bob.png',name:'Bob'},
    {category:'user',subjectKey:'user:one.png',name:'Player'}];
  const head=(id,document)=>({id,revision:`revision-${versions.get(id)||1}`,version:versions.get(id)||1,name:document.name,aliases:document.aliases,category:document.category});
  const store={list:async()=>[...documents].map(([id,document])=>head(id,document)),bindings:async()=>bindings,
    load:async(namespace,id)=>{assert.equal(namespace,'st-user:test');reads.push(id);const document=documents.get(id);return document?{head:head(id,document),document}:null;}};
  return {documents,versions,reads,bindings,subjects,store,prepare:options=>casting.prepareCharacterCasting({store,namespace:'st-user:test',subjects,chatKey:'chat-a',text:'Alice met 园丁',...options})};
}
const visual=(id='C1',name='Alice',x=.2)=>({id,name,identity:['current dyed hair'],outfit:['no coat'],action:['holds a spoon'],spatial:{center:[x,.5]}});
const shot=(characters=[visual()])=>storyboard.normalizeStoryboardShotSpec({id:'shot',scene:'kitchen',characters,sceneFingerprint:{castIds:characters.map(c=>c.id)},
  continuityUpdates:{outfit:{C1:'no coat'},facts:[{id:'f',category:'outfit',subject:'C1',value:'no coat'}]}});

test('preparation reads bound identities and named OTHER only, excluding absent/unbound archives',async()=>{
  const e=environment(),prepared=await e.prepare();
  assert.deepEqual(e.reads,['alice','bob','user','other']);assert.ok(!e.reads.includes('unused'));assert.ok(!e.reads.includes('absent'));
  assert.ok(Object.isFrozen(prepared.entries[0].identity));
  assert.doesNotMatch(JSON.stringify(prepared),/SENSITIVE|user\/images|sha256|reference/);
  const payload=JSON.parse(buildStoryboardPlanContractRequest({paragraphs:['Alice met 园丁'],characterCasting:prepared}).messages[1].content);
  assert.equal(payload.character_archive.catalogue_is_cast,false);assert.equal(payload.character_archive.candidates.length,4);
  assert.doesNotMatch(JSON.stringify(payload),/unwanted trait|SENSITIVE|private.png|st-user/);
  assert.equal(payload.character_archive.candidates[0].base_appearance,'Alice base appearance');
});
test('OTHER name matching respects Latin word boundaries and does not nominate short ambiguous names',async()=>{
  const e=environment();e.documents.set('other',doc('Al','other'));await e.prepare({text:'Alice'});assert.ok(!e.reads.includes('other'));
  e.reads.length=0;e.documents.set('other',doc('Q','other'));await e.prepare({text:'Q'});assert.ok(!e.reads.includes('other'));
});
test('chat unbinding masks defaults and prevents borrowing OTHER with the same display name',async()=>{
  const e=environment();e.bindings.push({...e.bindings[0],scope:'chat',chatKey:'chat-a',archiveId:''});e.documents.set('other',doc('Alice','other'));
  const prepared=await e.prepare();assert.ok(!e.reads.includes('alice'));
  const result=casting.applyCharacterCasting(shot(),prepared);assert.equal(result.shot.characters[0].archiveSnapshot,undefined);assert.equal(result.warnings[0].reason,'ambiguous_name');
});
test('only actual structured cast gets a frozen archive version; extracted wardrobe/action wins',async()=>{
  const e=environment(),prepared=await e.prepare(),original=shot(),result=casting.applyCharacterCasting(original,prepared);
  assert.equal(result.shot.characters.length,1);const character=result.shot.characters[0];assert.equal(character.id,'archive:alice');
  assert.equal(character.archiveSnapshot.archiveVersion,1);assert.deepEqual(character.identity,['current dyed hair']);assert.deepEqual(character.outfit,['no coat']);
  assert.deepEqual(character.action,['holds a spoon']);assert.ok(!JSON.stringify(result.shot).includes('base appearance'));
  assert.deepEqual(result.shot.sceneFingerprint.castIds,['archive:alice']);assert.equal(result.shot.continuityUpdates.outfit['archive:alice'],'no coat');
  assert.equal(result.shot.continuityUpdates.facts[0].subject,'archive:alice');assert.equal(original.characters[0].id,'C1');
  assert.equal(casting.applyCharacterCasting(shot([]),prepared).shot.characters.length,0);
});
test('ambiguous aliases, conflicting IDs and duplicate character matches retain unbound prose',async()=>{
  const e=environment();e.documents.set('bob',doc('Bob','char',['Alice']));let prepared=await e.prepare();
  for(const id of ['C1','archive:alice'])assert.equal(casting.applyCharacterCasting(shot([visual(id)]),prepared).warnings[0].reason,'ambiguous_name');
  e.documents.set('bob',doc('Bob'));prepared=await e.prepare();
  assert.equal(casting.applyCharacterCasting(shot([visual('archive:bob','Alice')]),prepared).warnings[0].reason,'identity_conflict');
  const repeated=casting.applyCharacterCasting(shot([visual(),visual('C2','阿莉',.8)]),prepared);
  assert.equal(repeated.warnings.length,2);assert.ok(repeated.shot.characters.every(c=>!c.archiveSnapshot));
});
test('generated unknown snapshot fields cannot masquerade as archived authority',async()=>{
  const prepared=await environment().prepare(),input=shot([visual('X','Unlisted')]);input.characters[0].archiveSnapshot={archiveId:'alice',negative:'FORGED'};
  const result=casting.applyCharacterCasting(input,prepared);assert.equal(result.shot.characters[0].archiveSnapshot,undefined);assert.doesNotMatch(JSON.stringify(result),/FORGED/);
});
test('history keeps actual visual state and version after library edits/deletion and normalization',async()=>{
  const e=environment(),prepared=await e.prepare(),cast=casting.applyCharacterCasting(shot(),prepared).shot;
  e.documents.get('alice').imagegen.negative='NEW NEGATIVE';e.versions.set('alice',2);e.documents.delete('alice');
  const restored=storyboard.normalizeStoryboardShotSpec(JSON.parse(JSON.stringify(cast)));
  assert.equal(restored.characters[0].archiveSnapshot.archiveVersion,1);assert.equal(restored.characters[0].archiveSnapshot.negative,'Alice unwanted trait');
  const state=storyboard.normalizeStoryboardState({...storyboard.createStoryboardDefaults(),plans:[{id:'plan',floor:0,shots:[{id:'one',shotSpec:restored,prompt:'scene'}]}]});
  assert.equal(state.plans[0].shots[0].shotSpec.characters[0].archiveSnapshot.archiveVersion,1);
  const snapshot=storyboard.sanitizeStoryboardSnapshot({source:'novel',shotSpec:restored,payload:{prompt:'old scene',shotSpec:restored}});
  assert.equal(snapshot.shotSpec.characters[0].archiveSnapshot.archiveVersion,1);
  assert.equal(snapshot.payload.shotSpec.characters[0].archiveSnapshot.negative,'Alice unwanted trait');
  assert.equal(e.reads.length,4);
});
test('corrupt/future snapshots are retained as invalid and cannot silently generate',async()=>{
  const cast=casting.applyCharacterCasting(shot(),await environment().prepare()).shot;
  cast.characters[0].archiveSnapshot.schema='future';const normalized=storyboard.normalizeStoryboardShotSpec(cast);
  assert.equal(normalized.characters[0].archiveSnapshot.invalid,true);
  assert.throws(()=>storyboard.compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-5-full',shot:normalized}),{code:'character_archive_snapshot'});
});
test('NAI character negatives stay in matching regions, not global or another character',async()=>{
  const prepared=await environment().prepare(),cast=casting.applyCharacterCasting(shot([visual(),visual('C2','Bob',.8)]),prepared).shot;
  const result=storyboard.compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-5-full',shot:cast,artistString:'artist',modelNegative:'quality'});
  const negative=result.providerOptions.v4_negative_prompt.caption;
  assert.equal(negative.char_captions[0].char_caption,'Alice unwanted trait');assert.equal(negative.char_captions[1].char_caption,'Bob unwanted trait');
  assert.deepEqual(negative.char_captions[0].centers,[{x:.2,y:.5}]);assert.doesNotMatch(negative.base_caption,/unwanted trait/);
  assert.doesNotMatch(result.prompt,/current dyed hair|unwanted trait/);assert.ok(result.prompt.startsWith('artist'));
});
test('natural-language engines scope exclusions; Comfy never inherits model-interface exclusions',async()=>{
  const cast=casting.applyCharacterCasting(shot(),await environment().prepare()).shot;
  const result=storyboard.compileStoryboardPrompt({providerId:'banana',modelId:'gemini-2.5-flash-image',shot:cast});
  assert.match(result.characterBlocks[0],/Undesired traits for "Alice" only: Alice unwanted trait/);assert.doesNotMatch(result.negative,/Alice unwanted trait/);
  const workflow={p:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}}};
  const comfy=storyboard.compileStoryboardPrompt({providerId:'comfy',modelId:'comfy-workflow',shot:cast,workflow});
  assert.doesNotMatch(comfy.prompt+comfy.negative,/unwanted trait/);assert.ok(comfy.validation.warnings.some(message=>message.includes('不参与工作流')));
  assert.throws(()=>storyboard.compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-3',shot:cast}),{code:'character_archive_negative_capability'});
});
test('safety adaptation keeps provenance without reading or reintroducing private archive fields',async()=>{
  const cast=casting.applyCharacterCasting(shot(),await environment().prepare()).shot;
  assert.doesNotMatch(JSON.stringify(buildStoryboardSafetyContractRequest(cast)),/SENSITIVE|private.png|unwanted trait/);
  const safe=adaptStoryboardSafetyContract({schema:STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID,replacement_visual:'garden',character_updates:[],prompt_atoms:{}},cast);
  assert.equal(safe.characters[0].archiveSnapshot.archiveId,'alice');
});
test('late document changes, missing bound archives and oversized relevant catalogues stop before LLM',async()=>{
  const e=environment();let guards=0;await assert.rejects(e.prepare({guard:async()=>{if(++guards===2)e.versions.set('alice',2);}}),{code:'character_archive_conflict'});
  e.documents.delete('alice');await assert.rejects(e.prepare(),{code:'character_archive_binding'});
  const large=environment();for(const [id,document] of large.documents)document.imagegen.appearance='图'.repeat(12000);
  await assert.rejects(large.prepare(),{code:'character_archive_casting_size'});
});
test('actual account/context bridge does not use stale identity after an await',async()=>{
  let namespace='st-user:one',loaded=0;
  const context=vm.createContext({getChatKey:()=> 'chat',storyboardCharacterArchiveContext:async()=>({chatKey:'chat',subjects:[]}),
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:{applyCharacterCasting:casting.applyCharacterCasting,
      readCharacterCasting:async options=>{loaded++;await options.guard();return {schema:casting.CHARACTER_CASTING_SCHEMA,entries:[]};}}}});
  vm.runInContext(section('storyboardCompilerCharacterCasting'),context);const prepared=await context.storyboardCompilerCharacterCasting('text',{assertCurrent:()=>{}});
  assert.equal(loaded,1);namespace='st-user:two';await assert.rejects(prepared.assertCurrent(),{code:'storyboard_input_changed'});
});

function payloadRuntime(state) {
  const context=vm.createContext({...storyboard,clone:structuredClone,storyboardSelectedArtistPreset:()=>null,
    storyboardProviderPromptDefaults:()=>({positive:'quality',negative:'low quality'}),
    storyboardPromptsForArtist:(s,a,p,m,{prompt,negative})=>({prompt,negative})});
  vm.runInContext(section('storyboardGenerationPayload'),context);return context;
}
test('actual manual generation payload remains exact and never reloads current archive',async()=>{
  const e=environment(),cast=casting.applyCharacterCasting(shot(),await e.prepare()).shot,state=storyboard.createStoryboardDefaults();
  const runtime=payloadRuntime(state);state.promptDraft.userEditedCompiled=true;
  const payload=runtime.storyboardGenerationPayload(state,state.profiles.novel,{prompt:'manual exact',negative:'my negatives',shot:{shotSpec:cast}});
  assert.equal(payload.prompt,'manual exact');assert.equal(payload.negative,'my negatives');assert.equal(payload.parameters.providerOptions.v4_prompt,undefined);
  assert.equal(payload.shotSpec.characters[0].archiveSnapshot.archiveVersion,1);assert.equal(e.reads.length,4);
  cast.characters[0].archiveSnapshot.archiveVersion=-1;assert.throws(()=>runtime.storyboardGenerationPayload(state,state.profiles.novel,{shot:{shotSpec:cast}}),{code:'character_archive_snapshot'});
});
test('real browser and service request builders keep identical NAI per-person negative structures',async()=>{
  const cast=casting.applyCharacterCasting(shot(),await environment().prepare()).shot,state=storyboard.createStoryboardDefaults();
  const payload=payloadRuntime(state).storyboardGenerationPayload(state,state.profiles.novel,{shot:{shotSpec:cast}});
  const requests=[];const fetchImpl=async(url,options)=>{requests.push(JSON.parse(options.body));return new Response('bad request',{status:400});};
  const input={provider:'novel',baseUrl:'https://image.novelai.net',apiKey:'fake-test-key',model:'nai-diffusion-5-full',prompt:payload.prompt,negative:payload.negative,parameters:payload.parameters};
  await assert.rejects(generateDirectImage(input,{fetchImpl}));await assert.rejects(generateImage(input,{fetchImpl,resolveHost:async()=>[{address:'93.184.216.34',family:4}]}));
  assert.equal(requests.length,2);assert.deepEqual(requests[0].parameters.v4_negative_prompt,requests[1].parameters.v4_negative_prompt);
  assert.equal(requests[0].parameters.v4_negative_prompt.caption.char_captions[0].char_caption,'Alice unwanted trait');
});

function compilerRuntime({changeAccount=false,ambiguous=false,references=false}={}) {
  const e=environment(),state=storyboard.createStoryboardDefaults(),plan={id:'plan',chatKey:'chat-a',floor:0,status:'screening'};
  state.enabled=true;state.source='novel';state.profiles.novel.model='nai-diffusion-5-full';if(ambiguous)e.documents.set('bob',doc('Bob','char',['Alice']));
  if (references) Object.assign(state.profiles.novel,{model:'nai-diffusion-4-5-full',characterReferenceEnabled:true});
  const calls=[],notices=[],errors=[];let namespace='st-user:test';
  const guard={assertCurrent(){},isCurrent:()=>true,ownsCurrentContext:()=>true,dispose(){}};
  const context=vm.createContext({...storyboard,clone:structuredClone,Date,JSON,Number,Object,Map,Set,
    storyboardCompilerBusy:false,storyboardCaptureWorkbench:()=>({state,profile:state.profiles.novel}),storyboardTargetFloor:()=>0,
    ctx:()=>({chatId:'chat-a',chat:[{mes:'Alice holds a spoon without a coat.'}]}),getChatKey:()=> 'chat-a',storyboardCreatePreparationGuard:()=>guard,
    storyboardCharacterArchiveContext:async()=>({chatKey:'chat-a',subjects:e.subjects}),
    storyboardCleanWithTagRules:value=>value,storyboardCleanMessageText:value=>value,cleanContextText:value=>value,resolveMacro:async value=>value,
    getCharacterDescription:()=> 'Alice',getPersonaDescription:()=> 'Player',storyboardMessageParagraphs:value=>[value],
    storyboardCompilerWorldText:async()=>({text:'',rows:[]}),storyboardProviderProfile:()=>state.profiles.novel,
    featureRuntime:{load:async key=>key==='characterCasting'?{...casting,readCharacterCasting:async options=>e.prepare(options)}:
      key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:contract},
    storyboardCompilerRequestConfig:()=>({providerId:'novel',modelId:'nai-diffusion-5-full',maxShots:1}),
    storyboardCallCompiler:async messages=>{
      calls.push(messages);if(changeAccount)namespace='st-user:other';
      return JSON.stringify({schema:contract.STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,should_generate:true,skip_reason:'',continuity_updates:[],decisions:[],shots:[{
        source_paragraph_ids:['P1'],insert_after:'P1',narrative_layer:'present',narrative_purpose:'action',shot_role:'action',shot_scale:'medium_shot',subject:'Alice holds a spoon',
        scene:{location:'kitchen',time:'day',lighting:[],environment:[]},characters:[{character_id:'C1',name:'Alice',fixed_identity:['current dyed hair'],
          current_state:{outfit:['no coat'],expression:[],pose:[],action:['holds a spoon'],gaze:[],props:['spoon']},spatial:{order:1,region:'center',center:{x:.5,y:.5},visible_crop:'waist'}}],
        shared_relations:[],composition:{ratio_id:'3:2',orientation:'landscape',camera_side:'axis-side-a',angle:'eye-level',focus:'spoon',negative_space:'',intent:'show action',continuity_key:'kitchen'},
        prompt_atoms:{global:['kitchen'],character_ids:['C1'],scene_negative:[]},sensitive:false,safety_notes:[],
        ...(references ? {primary_subject_id:'C1'} : {}),
      }]});
    },
    storyboardSetPlanStatus:(p,status,extra={})=>Object.assign(p,{status,...extra}),renderModal(){},saveSettings(){},
    storyboardScheduleAutomaticCapture(){},storyboardScheduleInlineRender(){},storyboardSchedulePlanArchive(){},
    sanitizeStoryboardDiagnosticData:value=>value,storyboardAnchorForMessage:()=>null,uid:()=> 'generated-id',toast:message=>notices.push(message),
    MODULE_NAME:'test',console:{error:(...args)=>errors.push(args)},
  });
  vm.runInContext(['storyboardUsesComfyCharacters','storyboardCompilerCharacterCasting','storyboardCompilerContext','storyboardCompilerResult','storyboardShotSpecForSelection','storyboardCompilePrompt'].map(section).join('\n'),context);
  return {e,state,plan,calls,notices,errors,context};
}
test('actual extraction context -> strict parser -> saved plan -> image payload carries the frozen visible identity',async()=>{
  const e=compilerRuntime();assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),true,JSON.stringify(e.errors));
  assert.equal(e.calls.length,1);const payload=JSON.parse(e.calls[0][1].content);assert.equal(payload.character_archive.candidates.length,3);
  assert.equal(e.plan.shots[0].shotSpec.characters.length,1);assert.equal(e.plan.shots[0].shotSpec.characters[0].archiveSnapshot.archiveId,'alice');
  assert.equal(e.state.promptDraft.shots[0].shotSpec.characters[0].archiveSnapshot.archiveVersion,1);
  const generation=payloadRuntime(e.state).storyboardGenerationPayload(e.state,e.state.profiles.novel,{shot:e.plan.shots[0]});
  assert.equal(generation.parameters.providerOptions.v4_negative_prompt.caption.char_captions[0].char_caption,'Alice unwanted trait');
  assert.deepEqual(Array.from(generation.shotSpec.characters[0].outfit),['no coat']);
});
test('reference-enabled extraction freezes only file receipts, remaps the primary ID and keeps all file data out of LLM input',async()=>{
  const e=compilerRuntime({references:true});assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),true,JSON.stringify(e.errors));
  assert.equal(e.calls.length,1);assert.doesNotMatch(JSON.stringify(e.calls[0]),/private.png|sha256|st-user|SENSITIVE/);
  const shot=e.plan.shots[0];assert.equal(shot.shotSpec.primarySubjectId,'archive:alice');
  const old=shot.shotSpec.characters[0].archiveSnapshot.imageReference;
  assert.equal(old.namespace,'st-user:test');assert.equal(old.reference.url,'/user/images/private.png');
  e.e.documents.get('alice').imagegen.reference.url='/user/images/new.png';
  const payload=payloadRuntime(e.state).storyboardGenerationPayload(e.state,e.state.profiles.novel,{shot});
  assert.equal(payload.characterReference.reference.url,'/user/images/private.png');
  assert.equal(payload.characterReference.subjectId,'archive:alice');assert.equal(payload.characterReference.status,'selected');
});
test('actual extraction reports ambiguity in user notices and logs without adding a guessed archive',async()=>{
  const e=compilerRuntime({ambiguous:true});assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),true,JSON.stringify(e.errors));
  assert.equal(e.plan.shots[0].shotSpec.characters[0].archiveSnapshot,undefined);assert.ok(e.notices.some(message=>message.includes('未匹配')));
  assert.equal(e.state.pendingCompilerStages[0].output.characterCastingWarnings[0].reason,'ambiguous_name');
});
test('actual extraction cannot publish a result into a changed ST account',async()=>{
  const e=compilerRuntime({changeAccount:true});assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),false);
  assert.equal(e.plan.status,'stale');assert.equal(e.plan.shots,undefined);assert.equal(e.calls.length,1);
});
test('corrupt history is rejected both on enqueue and by the actual pre-submit callback',async()=>{
  const cast=casting.applyCharacterCasting(shot(),await environment().prepare()).shot;cast.characters[0].archiveSnapshot.archiveVersion=0;
  let admissions=0;const notices=[];
  const context=vm.createContext({...storyboard,toast:message=>notices.push(message),storyboardState:()=>({enabled:true}),storyboardValidatedAnchor:()=>({valid:true}),
    storyboardAdmission:{beforeSubmit:async()=>{admissions++;}}});
  vm.runInContext(section('storyboardQueueJob'),context);
  assert.equal(await context.storyboardQueueJob({payload:{prompt:'scene'},shotSpec:cast}),false);assert.equal(notices.length,1);
  const code=section('storyboardRunJob'),start=code.indexOf('  const beforeSubmit = async () => {'),end=code.indexOf('\n  try {',start);
  assert.ok(start>0&&end>start);vm.runInContext(`async function check(job){let channelTicket=null,admissionOutcome='not_submitted';const log=null;\n${code.slice(start,end)}\nawait beforeSubmit();}`,context);
  await assert.rejects(context.check({shotSpec:cast,payload:{prompt:'scene'}}),{code:'character_archive_snapshot'});assert.equal(admissions,0);
});
