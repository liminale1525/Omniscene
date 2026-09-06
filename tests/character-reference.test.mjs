import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import * as reference from '../qianmu-character-reference.js';
import * as storyboard from '../qianmu-storyboard.js';
import {normalizeCharacterCastingSnapshot} from '../qianmu-character-casting.js';
import {normalizeCharacterArchive,newCharacterArchive,exportCharacterArchive,importCharacterArchive} from '../qianmu-character-archive.js';
import {buildStoryboardPlanContractRequest,parseStoryboardContractResponse,STORYBOARD_PLAN_RESPONSE_SCHEMA} from '../qianmu-storyboard-contract.js';
import {readStaticReferenceImages} from '../qianmu-comfy-references.js';
import {generateDirectImage} from '../qianmu-image-direct.js';
import {generateImage} from '../qianmu-image-gateway.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
const namespace='st-user:test',model='nai-diffusion-4-5-full';
const receipt={url:'/user/images/Qianmu-References/a.png',name:'Alice',bytes:png.length,mime:'image/png',sha256:createHash('sha256').update(png).digest('hex')};
const imageReference=()=>({version:1,namespace,reference:{...receipt},strength:0.4,fidelity:0});
const character=(id='alice')=>({id:`archive:${id}`,name:id,identity:['brown hair'],archiveSnapshot:{schema:'qianmu.character.casting.v1',archiveId:id,archiveVersion:1,
  subjectId:`archive:${id}`,category:'char',match:'id',sourceCharacterId:id,name:id,negativeScope:'model_interface',negative:'',imageReference:imageReference()}});
const shot=(characters=[character()])=>storyboard.normalizeStoryboardShotSpec({scene:'garden',characters,primarySubjectId:characters[0]?.id || '',promptAtoms:{global:['garden']}});
const plan=(value=shot(),options={})=>reference.planCharacterReference({source:'novel',enabled:true,capabilities:storyboard.getStoryboardCapabilities('novel',model),shot:value,...options});
const job=()=>{const spec=shot();return {source:'novel',profile:{model,characterReferenceEnabled:true},connection:{modelFamily:'novel',protocol:'novelai'},imageAdmission:{namespace},
  shotSpec:spec,payload:{shotSpec:spec,characterReference:plan(spec),selectedVibeIds:[],parameters:{}}};};
test('role-specific reference settings are validated, portable as text, and never authorize imported file paths',()=>{
  const doc=normalizeCharacterArchive({...newCharacterArchive(),name:'Alice',imagegen:{reference:receipt,novelReference:{strength:0,fidelity:1}}});
  assert.deepEqual(doc.imagegen.novelReference,{strength:0,fidelity:1});
  const imported=importCharacterArchive(JSON.stringify(exportCharacterArchive(doc))).document;
  assert.equal(imported.imagegen.reference,null);assert.deepEqual(imported.imagegen.novelReference,doc.imagegen.novelReference);
  for(const value of [-1,1.01,'0.5',NaN])assert.throws(()=>reference.normalizeCharacterReferenceSettings({strength:value}));
});
test('single primary reference never borrows another character image or merges multiple people',()=>{
  const spec=shot([character('alice'),character('bob')]);spec.primarySubjectId='archive:bob';
  spec.characters[1].archiveSnapshot.imageReference.reference.url='/user/images/b.png';
  assert.equal(plan(spec).reference.url,'/user/images/b.png');
  spec.characters[1].archiveSnapshot.imageReference.reference=null;assert.equal(plan(spec).status,'no_reference');
  spec.characters[1].archiveSnapshot=undefined;assert.equal(plan(spec).status,'no_reference');
  delete spec.primarySubjectId;assert.throws(()=>plan(spec),/主视觉/);
  spec.primarySubjectId='not-visible';assert.throws(()=>plan(spec),/主视觉/);
  assert.equal(plan(shot([])).status,'no_subject');
});
test('references require capability, exclusivity and original safe eligibility before any file read',()=>{
  assert.throws(()=>plan(shot(),{hasVibes:true}),/Vibe/);
  assert.throws(()=>plan(shot(),{safetyAdapted:true}),/安全适配/);
  for(const id of ['nai-diffusion-5-full','nai-diffusion-4-full','nai-diffusion-3'])assert.throws(()=>plan(shot(),{capabilities:storyboard.getStoryboardCapabilities('novel',id)}));
  assert.throws(()=>plan(shot(),{source:'comfy'}));
  assert.equal(plan(shot(),{enabled:false}),null);
  assert.equal(plan({...shot(),characterReferenceDisabled:true},{hasVibes:true,safetyAdapted:true}),null);
});
test('old/corrupt archive snapshots cannot query a new library or silently drop reference requirements',()=>{
  const spec=shot();delete spec.characters[0].archiveSnapshot.imageReference;assert.throws(()=>plan(spec),/快照/);
  const broken=character().archiveSnapshot;broken.imageReference.version=8;
  assert.equal(normalizeCharacterCastingSnapshot(broken).invalid,true);
  assert.throws(()=>reference.normalizeCharacterReferenceSnapshot({...imageReference(),namespace:'unknown'}));
  assert.throws(()=>reference.normalizeCharacterReferenceSnapshot({...imageReference(),reference:{...receipt,url:'https://other.test/a.png'}}));
});
test('normalization and history keep reference binding and disabled intent without base64 or latest archive reads',()=>{
  const original=job(),history=storyboard.sanitizeStoryboardSnapshot({...original,payload:original.payload});
  assert.equal(history.payload.shotSpec.characters[0].archiveSnapshot.imageReference.reference.sha256,receipt.sha256);
  assert.equal(history.payload.characterReference.reference.url,receipt.url);
  assert.equal(history.payload.characterReference.reference.bytes,png.length);
  assert.equal(history.payload.shotSpec.characters[0].archiveSnapshot.imageReference.reference.bytes,png.length);
  const restored=JSON.parse(JSON.stringify(history));
  reference.assertCharacterReferencePlan(restored.payload.characterReference,plan(restored.payload.shotSpec));
  assert.equal(storyboard.sanitizeStoryboardDiagnosticData({reference:receipt}).reference.bytes,png.length);
  assert.equal(storyboard.sanitizeStoryboardSnapshot({payload:{reference:{bytes:[1,2,3]}}}).payload.reference.bytes,undefined);
  assert.equal(storyboard.normalizeStoryboardParameterProfile(original.profile,'novel').characterReferenceEnabled,true);
  assert.equal(storyboard.normalizeStoryboardParameterProfile(original.profile,'comfy').characterReferenceEnabled,undefined);
  assert.equal(storyboard.normalizeStoryboardShotSpec({...shot(),characterReferenceDisabled:true}).characterReferenceDisabled,true);
  assert.doesNotMatch(JSON.stringify(history),/base64|apiKey/);
  const context=vm.createContext({...storyboard,clone:structuredClone});vm.runInContext(section('storyboardProfileSnapshot'),context);
  assert.equal(context.storyboardProfileSnapshot(original.profile,'novel').characterReferenceEnabled,true);
});
test('only enabled reference extraction extends the return contract, without mutating the ordinary schema',()=>{
  const request=buildStoryboardPlanContractRequest({paragraphs:['Alice walks'],characterCasting:{schema:'qianmu.character.casting.v1',entries:[],referenceMode:'novel-primary'}});
  assert.equal(request.requirePrimarySubject,true);assert.ok(request.schema.properties.shots.items.required.includes('primary_subject_id'));
  assert.equal(STORYBOARD_PLAN_RESPONSE_SCHEMA.properties.shots.items.properties.primary_subject_id,undefined);
  assert.equal(buildStoryboardPlanContractRequest({paragraphs:['Alice walks']}).requirePrimarySubject,false);
  // The actual returned example must satisfy the same strict/local contract.
  const text=request.messages[0].content;const start=text.indexOf('{"schema":');
  const example=JSON.parse(text.slice(start));
  assert.equal(parseStoryboardContractResponse(JSON.stringify(example),{requirePrimarySubject:true}).ok,true);
  example.shots[0].primary_subject_id='absent';assert.equal(parseStoryboardContractResponse(JSON.stringify(example),{requirePrimarySubject:true}).ok,false);
  example.shots[0].characters=[];example.shots[0].prompt_atoms.character_ids=[];example.shots[0].primary_subject_id='';
  assert.equal(parseStoryboardContractResponse(JSON.stringify(example),{requirePrimarySubject:true}).ok,true);
});
test('reader verifies account, immutable bytes and per-role settings, without credentials or implicit URLs',async()=>{
  let calls=0;
  const fetchImpl=async(url,options)=>{calls++;assert.equal(url,receipt.url);assert.equal(options.credentials,'same-origin');assert.equal(options.headers,undefined);return new Response(png);};
  const images=await reference.readCharacterReferenceImages(plan(),{namespace,fetchImpl});
  assert.equal(calls,1);assert.equal(images.length,1);assert.equal(images[0].data,png.toString('base64'));assert.equal(images[0].referenceType,'character');
  assert.equal(images[0].strength,.4);assert.equal(images[0].fidelity,0);
  await assert.rejects(reference.readCharacterReferenceImages(plan(),{namespace:'st-user:other',fetchImpl}));assert.equal(calls,1);
  await assert.rejects(readStaticReferenceImages([receipt],{fetchImpl:async()=>new Response('changed')}),/变化|静态/);
  let guardCalls=0;await assert.rejects(reference.readCharacterReferenceImages(plan(),{namespace,fetchImpl,guard:async()=>{if(++guardCalls===2)throw Error('changed account');}}));assert.equal(calls,1);
});
test('actual asset bridge rechecks the frozen recipe and cannot bypass disabled state or capability by editing payload metadata',async()=>{
  const input=job();let reads=0;
  const context=vm.createContext({...storyboard,storyboardAdmissionEpoch:0,storyboardState:()=>({vibeLibrary:[]}),
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:{readCharacterReferenceImages:async(value,options)=>{
      await options.guard();reads++;assert.equal(value.reference.sha256,receipt.sha256);return [{data:png.toString('base64')}];}}}});
  vm.runInContext(['storyboardCharacterReferencePlan','storyboardPrepareGatewayAssets'].map(section).join('\n'),context);
  assert.equal((await context.storyboardPrepareGatewayAssets(input)).references.length,1);assert.equal(reads,1);
  input.payload.characterReference.strength=.9;await assert.rejects(context.storyboardPrepareGatewayAssets(input),/不一致/);assert.equal(reads,1);
  input.payload.characterReference=plan(input.shotSpec);input.profile.characterReferenceEnabled=false;
  await assert.rejects(context.storyboardPrepareGatewayAssets(input),/不一致/);assert.equal(reads,1);
});
test('direct and enhanced NAI transports receive the same single-character reference with zero fidelity preserved',async()=>{
  const images=await reference.readCharacterReferenceImages(plan(),{namespace,fetchImpl:async()=>new Response(png)}),requests=[];
  const fetchImpl=async(url,options)=>{requests.push(JSON.parse(options.body));return new Response('fixture rejection',{status:400});};
  const input={provider:'novel',baseUrl:'https://image.novelai.net',apiKey:'fake-test-key',model,prompt:'garden',referenceImages:images,parameters:{width:832,height:1216,count:1}};
  await assert.rejects(generateDirectImage(input,{fetchImpl}));await assert.rejects(generateImage(input,{fetchImpl,resolveHost:async()=>[{address:'93.184.216.34',family:4}]}));
  assert.equal(requests.length,2);
  for(const key of Object.keys(requests[0].parameters).filter(key=>key.startsWith('director_reference_')))assert.deepEqual(requests[0].parameters[key],requests[1].parameters[key]);
  assert.equal(requests[0].parameters.director_reference_images.length,1);assert.deepEqual(requests[0].parameters.director_reference_secondary_strength_values,[1]);
});
test('workbench reference control follows capability, remembers unsupported enabled state for explicit repair, and stays out of Comfy',()=>{
  const fixture=createStoryboardFormFixture();Object.assign(fixture.state.profiles.novel,{model,capabilityModelId:model});
  assert.match(fixture.context.renderStoryboardCreate(fixture.state),/data-storyboard-field="characterReferenceEnabled"/);
  Object.assign(fixture.state.profiles.novel,{model:'nai-diffusion-5-full',capabilityModelId:'nai-diffusion-5-full'});
  assert.doesNotMatch(fixture.context.renderStoryboardCreate(fixture.state),/data-storyboard-field="characterReferenceEnabled"/);
  fixture.state.profiles.novel.characterReferenceEnabled=true;assert.match(fixture.context.renderStoryboardCreate(fixture.state),/当前模型不支持/);
  assert.doesNotMatch(createStoryboardFormFixture({family:'comfy'}).content,/characterReferenceEnabled/);
});
test('inline picker selects only visible people, can explicitly disable, and does not mutate an archived shot',()=>{
  const spec=shot([character(),character('bob')]),before=structuredClone(spec);
  assert.match(reference.renderCharacterReferencePicker(spec),/不使用参考/);
  const changed=reference.applyCharacterReferenceChoice(spec,'archive:bob');assert.equal(plan(changed).subjectId,'archive:bob');assert.deepEqual(spec,before);
  assert.equal(plan(reference.applyCharacterReferenceChoice(spec,'__none__')),null);
  assert.throws(()=>reference.applyCharacterReferenceChoice(spec,'invisible'));
  spec.characters[0].name='<script>';assert.doesNotMatch(reference.renderCharacterReferencePicker(spec),/<script>/);
});
test('actual inline edit only saves the selected frozen reference; it neither fetches archives nor auto-generates',async()=>{
  for(const choice of ['archive:bob','__none__','switch-account','read-failure']){
    const state=storyboard.createStoryboardDefaults(),original=job(),spec=shot([character(),character('bob')]);
    original.shotSpec=spec;original.payload.shotSpec=spec;original.payload.characterReference=plan(spec);original.payload.prompt='original exact';
    let saved,generated=0,account=namespace,accountReads=0;const notices=[],record={id:'old',prompt:'original exact',floor:0};
    const fields={'.sd-storyboard-edit-positive':{value:''},'.sd-storyboard-edit-negative':{value:''},'.sd-character-reference-picker':{value:''}};
    const context=vm.createContext({...storyboard,clone:structuredClone,getChatKey:()=> 'chat',storyboardState:()=>state,
      storyboardReadSnapshotForRecord:async()=>structuredClone(original),storyboardStoreSnapshotForRecord:async(r,snapshot)=>{saved=snapshot;},
      featureRuntime:{load:async key=>{assert.equal(key,'imageAdmission');return {resolveImageAccountNamespace:async()=>{if(++accountReads===2&&choice==='read-failure')throw Error('账户暂不可读取');return account;}};}},
      document:{createElement:()=>({querySelector:selector=>fields[selector],insertAdjacentHTML(){}})},
      ctx:()=>({POPUP_TYPE:{CONFIRM:'confirm'},Popup:class{async show(){fields['.sd-character-reference-picker'].value=choice;if(choice==='switch-account')account='st-user:other';return 2;}}}),
      toast:message=>notices.push(message),synchronizeStoryboardCaptionBase(){},saveMetadata:async()=>{},storyboardRenderInlineImages(){},storyboardRedrawRecord:()=>generated++,
    });
    vm.runInContext(section('storyboardEditPrompt'),context);await context.storyboardEditPrompt({record});
    assert.equal(generated,0);
    if(choice==='switch-account'||choice==='read-failure'){assert.equal(saved,undefined);assert.equal(record.promptLocked,undefined);assert.match(notices.at(-1),/账户/);}
    else if(choice==='__none__'){assert.equal(saved.payload.characterReference,null);assert.equal(saved.payload.shotSpec.characterReferenceDisabled,true);}
    else {assert.equal(saved.payload.characterReference.subjectId,'archive:bob');assert.equal(saved.payload.prompt,'original exact');assert.equal(saved.promptLocked,true);}
  }
});
test('actual enqueue and last-moment submit both reject changed reference receipts before admission',async()=>{
  let admissions=0;const notices=[],context=vm.createContext({...storyboard,toast:message=>notices.push(message),
    storyboardState:()=>({enabled:true}),storyboardValidatedAnchor:()=>({valid:true}),storyboardAdmission:{beforeSubmit:async()=>admissions++}});
  vm.runInContext(['storyboardCharacterReferencePlan','storyboardQueueJob'].map(section).join('\n'),context);
  const changed=job();changed.payload.prompt='garden';changed.payload.characterReference.reference.sha256='f'.repeat(64);
  assert.equal(await context.storyboardQueueJob(changed),false);assert.match(notices[0],/不一致/);
  const source=section('storyboardRunJob'),start=source.indexOf('  const beforeSubmit = async () => {'),end=source.indexOf('\n  try {',start);
  vm.runInContext(`async function check(job){let channelTicket=null,admissionOutcome='not_submitted';const log=null;${source.slice(start,end)}await beforeSubmit();}`,context);
  await assert.rejects(context.check(changed),/不一致/);
  const foreign=job();foreign.imageAdmission.namespace='st-user:other';await assert.rejects(context.check(foreign),/账户/);
  assert.equal(admissions,0);
});
