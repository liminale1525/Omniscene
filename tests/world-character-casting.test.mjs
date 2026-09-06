import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as casting from '../qianmu-character-casting.js';
import * as world from '../qianmu-world-shot.js';
import * as core from '../qianmu-storyboard.js';
import * as decisions from '../qianmu-director-decision.js';
import * as orders from '../qianmu-director-work-order.js';
import {normalizeQianmuProductionPacket} from '../qianmu-production-packet.js';
import {newCharacterArchive,normalizeCharacterArchive} from '../qianmu-character-archive.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
export function worldEnvironment() {
  const namespace='st-user:world',reads=[];
  const document=(name,category,aliases=[])=>normalizeCharacterArchive({...newCharacterArchive(category),name,aliases,
    imagegen:{appearance:`${name} silver hair`,negative:`${name} incorrect face`,sensitiveAppearance:'PRIVATE-QUALIFICATION',reference:null}});
  const docs=new Map([['alice',document('Alice','char',['阿莉'])],['player',document('Player','user')],
    ['gardener',document('Gardener','other',['园丁'])],['one',document('岚','other')],['absent',document('Absent','other')]]);
  const subjects=[{name:'Alice',category:'char',subjectKey:'char:alice.png'},{name:'Player',category:'user',subjectKey:'user:player.png'}];
  const bindings=subjects.map((row,index)=>({...row,scope:'default',chatKey:'',archiveId:index?'player':'alice'}));
  const head=(id,doc)=>({id,name:doc.name,aliases:doc.aliases,category:doc.category,version:3,revision:'revision-3'});
  const store={list:async()=>[...docs].map(([id,doc])=>head(id,doc)),bindings:async()=>bindings,
    load:async(ns,id)=>{assert.equal(ns,namespace);reads.push(id);const doc=docs.get(id);return doc?{head:head(id,doc),document:doc}:null;}};
  return {namespace,reads,docs,subjects,bindings,store,prepare:options=>casting.prepareCharacterCasting({store,namespace,subjects,chatKey:'chat-a',...options})};
}
const characters=[{id:'alice-source',name:'Alice',temporaryState:['blue dyed hair, no coat, stirs soup']}];
const input=(cast=characters)=>({id:'world-shot',characters:cast,subject:'厨房',narrativePurpose:'只属于导演视角的可能场景',
  promptAtoms:{global:['厨房内人物正在做饭']},productionContext:{packetId:'packet-a',track:'second_camera',canonLevel:'director',autoInsert:false},
  continuityUpdates:{outfit:{'alice-source':'no coat'}}});
const fields=shot=>({characters:shot.characters.map(row=>({id:row.id,identity:row.identity.join('\n'),temporaryState:row.temporaryState.join('\n')})),referenceChoice:'__none__',sensitive:false});

test('world preparation nominates exact visible identities including one-character OTHER, not incidental prose or absent bindings',async()=>{
  const e=worldEnvironment();e.bindings[1].archiveId='missing-but-not-visible';
  const prepared=await e.prepare({text:'Player Absent Gardener',visibleCharacters:[...characters,{id:'x',name:'岚'},{id:'z',name:'Gardener',visible:false}]});
  assert.deepEqual(e.reads,['alice','one']);assert.equal(prepared.entries.length,2);
  assert.doesNotMatch(JSON.stringify(prepared),/PRIVATE-QUALIFICATION/);
  e.reads.length=0;await e.prepare({visibleCharacters:[]});assert.deepEqual(e.reads,[]);
  await assert.rejects(()=>e.prepare({visibleCharacters:null}),/出镜人物/);
});
test('world binding preserves current state, provenance and source ids while adding frozen base appearance only where missing',async()=>{
  const e=worldEnvironment(),prepared=await e.prepare({visibleCharacters:characters});
  const original=input(),{shot}=world.prepareWorldCharacterShot(original,prepared);
  assert.equal(shot.characters[0].id,'archive:alice');assert.equal(shot.characters[0].archiveSnapshot.archiveVersion,3);
  assert.deepEqual(shot.characters[0].identity,['Alice silver hair']);assert.deepEqual(shot.characters[0].temporaryState,characters[0].temporaryState);
  assert.equal(shot.continuityUpdates.outfit['archive:alice'],'no coat');assert.equal(shot.productionContext.autoInsert,false);
  assert.equal(original.characters[0].id,'alice-source');assert.equal(original.characters[0].archiveSnapshot,undefined);
  const explicit=world.prepareWorldCharacterShot(input([{...characters[0],identity:['explicit current blue hair']}]),prepared).shot;
  assert.deepEqual(explicit.characters[0].identity,['explicit current blue hair']);
  e.docs.get('alice').imagegen.appearance='later change';assert.equal(shot.characters[0].identity[0],'Alice silver hair');
});
test('ambiguous aliases cannot lend either archive negative or private engine implementation',async()=>{
  const e=worldEnvironment();e.docs.get('gardener').aliases=['Alice'];
  const prepared=await e.prepare({visibleCharacters:characters,includeReferences:true,includeComfy:true});
  const {shot,warnings}=world.prepareWorldCharacterShot(input(),prepared);
  assert.equal(warnings[0].reason,'ambiguous_name');assert.equal(shot.characters[0].archiveSnapshot,undefined);
  assert.equal(shot.characters[0].identity.length,0);
  assert.match(world.renderWorldShotConfirmation(shot,{warnings}),/匹配冲突/);
});
test('explicit visibility survives packet, decision and work-order boundaries without upgrading truth or authorizing voice/film',()=>{
  const p=normalizeQianmuProductionPacket({packetId:'packet-a',eventId:'event-a',timelineAnchor:{chatKey:'chat-a'},
    characterState:[{id:'a',name:'Alice',visible:false},{id:'b',name:'Gardener',state:'no coat'}],visualIntent:{subject:'kitchen'}});
  const candidate={candidateId:'candidate-a',owner:{chatKey:'chat-a'},entryId:'entry-a',sourceKind:'simulation',recommendation:'manual_review',
    gates:{sourceValid:true,factConsistency:true,spoilerSafe:false,shotDistinct:true}};
  const result=decisions.createDirectorDecision(candidate,p,{chatKey:'chat-a',ledgerEntryId:'entry-a',explicitApproval:true,approvedAt:1,outputs:{storyboard:true}});
  assert.equal(result.ok,true);const dispatch=orders.createDirectorWorkOrder(result.decision,'storyboard','chat-a');
  const shot=orders.directorWorkOrderToStoryboardShot(dispatch.workOrder,'chat-a');assert.deepEqual(shot.characters.map(row=>row.name),['Gardener']);
  assert.equal(shot.narrativeLayer,'imagined');assert.equal(decisions.canConsumeDirectorDecision(result.decision,'voice','chat-a'),false);
  assert.deepEqual(core.adaptProductionPacketToStoryboardShotSpec(p).characters.map(row=>row.name),['Gardener']);
});
test('long declared state and appearance preserve their tail; invalid or oversized edits fail without touching the source',async()=>{
  const e=worldEnvironment();e.docs.get('alice').imagegen.appearance='a'.repeat(1100)+'tail';
  const prepared=await e.prepare({visibleCharacters:characters}),raw=input([{...characters[0],temporaryState:['x'.repeat(800)+'state-tail']}]);
  const {shot}=world.prepareWorldCharacterShot(raw,prepared);assert.ok(shot.characters[0].identity.join('').endsWith('tail'));
  assert.ok(shot.characters[0].temporaryState.join('').endsWith('state-tail'));
  const edit=fields(shot);edit.characters[0].identity='z'.repeat(16000);assert.throws(()=>world.captureWorldShotConfirmation(shot,edit),/过长/);
  assert.throws(()=>world.prepareWorldCharacterShot(input([...characters,...characters]),prepared),/身份重复/);
  assert.ok(shot.characters[0].identity.join('').endsWith('tail'));
});
test('confirmation edits only this image; explicit reference choice stays on a visible id and does not change the library',async()=>{
  const e=worldEnvironment(),prepared=await e.prepare({visibleCharacters:characters,includeReferences:true});
  const {shot}=world.prepareWorldCharacterShot(input(),prepared),edit=fields(shot);edit.characters[0].identity='blue hair';edit.sensitive=true;
  const changed=world.captureWorldShotConfirmation(shot,edit,true);assert.equal(changed.characterReferenceDisabled,true);assert.equal(changed.sensitive,true);
  assert.equal(shot.characters[0].identity[0],'Alice silver hair');assert.equal(changed.characters[0].temporaryState[0],characters[0].temporaryState[0]);
  assert.throws(()=>world.captureWorldShotConfirmation(shot,{...edit,referenceChoice:'archive:someone-else'},true),/主参考人物/);
  const compiled=core.compileStoryboardPrompt({providerId:'novel',remoteModelId:'nai-diffusion-4-5-full',shot:changed});
  assert.match(compiled.providerOptions.v4_prompt.caption.char_captions[0].char_caption,/blue hair/);
  assert.match(compiled.providerOptions.v4_negative_prompt.caption.char_captions[0].char_caption,/incorrect face/);
  assert.doesNotMatch(compiled.providerOptions.v4_prompt.caption.base_caption,/silver hair|blue hair/);
  assert.equal(world.captureWorldShotConfirmation({...shot,sensitive:true},{...edit,sensitive:false}).sensitive,true);
});

function harness({confirm=async options=>options.shot,family='novel'}={}) {
  const e=worldEnvironment(),{state,context}=createStoryboardFormFixture({family});
  state.directorBridge.worldSideShotsEnabled=true;state.prompt='original';state.promptDraft.shots=[{id:'old-shot',prompt:'original'}];
  const packet=normalizeQianmuProductionPacket({packetId:'packet-a',eventId:'event-a',timelineAnchor:{chatKey:'chat-a'},
    characterState:[{id:'alice-source',name:'Alice',state:'blue hair, no coat'}],visualIntent:{subject:'厨房',description:'Alice stirs soup'}});
  const ledger={entryId:'entry-a',source:{recordId:'packet-a'}},candidate={candidateId:'candidate-a',owner:{chatKey:'chat-a'},entryId:'entry-a',sourceKind:'simulation',recommendation:'manual_review',
    gates:{sourceValid:true,factConsistency:true,spoilerSafe:false,shotDistinct:true}};
  let account=e.namespace,chat='chat-a';const calls=[],notices=[],chatData=[{mes:'unrelated prose'}];
  Object.assign(context,{storyboardAdmissionEpoch:0,storyboardCredentialRevision:0,storyboardGenerationPreparing:new Set(),directorNarrativeBridgeEpoch:1,
    directorProductionPacketState:{chatKey:chat,packets:[packet]},directorCandidatePoolState:{chatKey:chat,ledger:{entries:[ledger]},pool:{candidates:[candidate]}},
    getChatKey:()=>chat,storyboardTargetFloor:()=>0,ctx:()=>({chat:chatData,Popup:class{},POPUP_TYPE:{CONFIRM:1}}),
    getCharacterDescription:()=>'',getPersonaDescription:()=>'',storyboardCharacterArchiveContext:async()=>({chatKey:chat,subjects:e.subjects}),
    storyboardCaptureWorkbench:()=>{calls.push('capture');return {state,profile:state.profiles[state.source]};},
    storyboardResolveRoutingProfile:(_,route)=>context.storyboardProviderProfile(state,route.providerId),
    featureRuntime:{load:async key=>{
      calls.push(key);
      return {directorDecision:decisions,directorWorkOrders:orders,imageAdmission:{resolveImageAccountNamespace:async()=>account},
        characterCasting:{...casting,readCharacterCasting:options=>casting.prepareCharacterCasting({...options,store:e.store})},
        worldShot:{...world,openWorldShotConfirmation:async options=>{await options.guard();calls.push('confirm');return confirm(options);}}}[key];
    }},saveSettings:()=>calls.push('save'),sanitizeStoryboardDiagnosticData:value=>value,toast:(text)=>{notices.push(text);return false;},
    storyboardGenerate:async(root,options)=>{options.productionGuard.assertCurrent();context.lastProductionOptions=options;calls.push('generate');assert.equal(root,null);assert.equal(options.automatic,false);return true;},
  });
  vm.runInContext(['storyboardCreatePreparationGuard','storyboardCompilerCharacterCasting','storyboardGenerateProductionPacket'].map(section).join('\n'),context);
  return {...e,state,context,calls,notices,packet,candidate,run:()=>context.storyboardGenerateProductionPacket({isConnected:true},'packet-a'),setAccount:value=>{account=value;},setChat:value=>{chat=value;}};
}
test('real entry awaits explicit confirmation, uses shared visible casting and hands one approved draft to the normal pipeline',async()=>{
  const e=harness();e.state.pendingCompilerStages=[{type:'prompt_compiler',input:'previous prose'}];assert.equal(await e.run(),true);assert.deepEqual(e.reads,['alice']);
  assert.ok(e.calls.indexOf('confirm')<e.calls.indexOf('generate'));assert.equal(e.calls.filter(x=>x==='generate').length,1);
  assert.equal(e.state.promptDraft.shots[0].shotSpec.characters[0].id,'archive:alice');
  assert.equal(e.state.promptDraft.shots[0].shotSpec.directorDecision.outputs.film,false);assert.equal(e.context.storyboardGenerationPreparing.size,0);
  assert.equal(e.state.pendingCompilerStages[0].type,'world_confirmation');assert.doesNotMatch(JSON.stringify(e.state.pendingCompilerStages),/previous prose|PRIVATE-QUALIFICATION/);
});
test('cancel preserves the prior prose draft and never compiles, saves it, or generates',async()=>{
  const e=harness({confirm:async()=>null}),before=copy(e.state.promptDraft);assert.equal(await e.run(),false);
  assert.deepEqual(copy(e.state.promptDraft),before);assert.equal(e.state.prompt,'original');assert.ok(!e.calls.includes('save'));assert.ok(!e.calls.includes('generate'));
});
test('chat, account, candidate rejection, epoch, draft and engine changes during confirmation cannot consume stale approval',async()=>{
  for (const change of [e=>e.setChat('chat-b'),e=>e.setAccount('st-user:other'),e=>e.candidate.recommendation='reject',
    e=>e.context.directorNarrativeBridgeEpoch++,e=>e.state.prompt='new prose',e=>e.state.source='banana']) {
    let e;e=harness({confirm:async options=>{change(e);return options.shot;}});assert.equal(await e.run(),false);
    assert.ok(!e.calls.includes('generate'));assert.equal(e.state.promptDraft.shots[0].id,'old-shot');assert.equal(e.context.storyboardGenerationPreparing.size,0);
  }
});
test('duplicate clicks open one confirmation and release the lock after cancellation',async()=>{
  let release,opened;const ready=new Promise(resolve=>{opened=resolve;});const e=harness({confirm:async()=>{opened();return new Promise(resolve=>{release=resolve;});}});
  const running=e.run();await ready;assert.equal(await e.run(),false);release(null);await running;
  assert.equal(e.calls.filter(x=>x==='confirm').length,1);assert.equal(e.context.storyboardGenerationPreparing.size,0);
});
test('the final routed engine determines private casting fields, not the visible workbench mode',async()=>{
  const e=harness();e.state.routing.enabled=true;e.state.profiles.comfy.comfyCharacterEnabled=true;
  e.context.routeStoryboardShot=()=>({providerId:'comfy',modelId:'comfy-workflow'});
  assert.equal(await e.run(),true);const snapshot=e.state.promptDraft.shots[0].shotSpec.characters[0].archiveSnapshot;
  assert.ok(snapshot.comfyImplementation);assert.equal(snapshot.imageReference,undefined);
});
test('upstream source revocation remains part of actual preparation guards through the normal queue handoff',()=>{
  const e=harness();let valid=true;const guard=e.context.storyboardCreatePreparationGuard(e.state,{upstreamGuard:{isCurrent:()=>valid}});
  assert.equal(guard.isCurrent(),true);valid=false;assert.equal(guard.isCurrent(),false);assert.throws(()=>guard.assertCurrent(),/变化/);guard.dispose();
  assert.match(section('storyboardGenerate'),/upstreamGuard:productionGuard/g);
});

test('disabled and rejected candidates do no archive preparation or model work',async()=>{
  const e=harness();e.state.directorBridge.worldSideShotsEnabled=false;assert.equal(await e.run(),false);assert.equal(e.calls.length,0);
  e.state.directorBridge.worldSideShotsEnabled=true;e.candidate.recommendation='reject';assert.equal(await e.run(),false);assert.equal(e.calls.length,0);
});

test('world confirmation escapes imported names and all editable text, without rendering private references',async()=>{
  const e=worldEnvironment(),prepared=await e.prepare({visibleCharacters:characters});const {shot}=world.prepareWorldCharacterShot(input(),prepared);
  shot.characters[0].name='<img src=x onerror=alert(1)>';shot.characters[0].identity=['</textarea><script>alert(1)</script>'];
  const html=world.renderWorldShotConfirmation(shot,{title:'<script>bad</script>',model:'<svg/onload=alert(1)>'});
  assert.doesNotMatch(html,/<script|<img|<svg/);assert.match(html,/&lt;script/);assert.doesNotMatch(html,/PRIVATE-QUALIFICATION|sha256/);
});

for(const revoke of [false,'source','account'])test(`real normal pipeline ${revoke?`stops changed ${revoke}`:'freezes world casting in a gallery-only NAI job'}`,async()=>{
  const e=harness();assert.equal(await e.run(),true);const queued=[];
  Object.assign(e.context,{storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:100,
    storyboardQueueJob:async(job,isCurrent)=>{assert.equal(isCurrent(),true);queued.push(job);return true;},confirmDialog:async()=>true,
    storyboardCredentialId:()=> 'test-key-reference',storyboardAnchorForMessage:()=>null,
    sanitizeStoryboardDiagnosticData:value=>value,uniqueClean:items=>[...new Set(items.filter(Boolean))],
    storyboardAdaptShotForModel:async shot=>{if(revoke==='source')e.candidate.recommendation='reject';if(revoke==='account')e.setAccount('st-user:new');return shot;}});
  vm.runInContext(['storyboardPromptsForArtist','storyboardJoinPrompt','storyboardProfileSnapshot',
    'storyboardResolveRoutingProfile','storyboardGenerationPayload','storyboardCreateJob','storyboardGenerate'].map(section).join('\n'),e.context);
  assert.equal(await e.context.storyboardGenerate(null,e.context.lastProductionOptions),!revoke,e.notices.join(';'));
  assert.equal(queued.length,revoke?0:1);
  if(!revoke){const job=queued[0];assert.equal(job.target,'gallery');assert.equal(job.floor,null);assert.equal(job.inlineByDefault,false);
    assert.equal(job.automatic,false);assert.equal(job.payload.shotSpec.characters[0].archiveSnapshot.archiveId,'alice');
    assert.match(job.payload.parameters.providerOptions.v4_prompt.caption.char_captions[0].char_caption,/silver hair.*blue hair, no coat/);
    assert.equal(job.shotSpec.productionContext.truthMode,'speculative');assert.equal(job.shotSpec.directorDecision.outputs.film,false);
    assert.equal(await e.context.storyboardGenerate(null,{automatic:true}),false);assert.equal(queued.length,1);
    e.state.promptDraft.shots.push({id:'prose',prompt:'ordinary prose'});
    assert.equal(await e.context.storyboardGenerate(null,{automatic:false}),false);assert.equal(queued.length,1);
  }
});
