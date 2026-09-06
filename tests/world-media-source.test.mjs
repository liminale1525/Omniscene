import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as sources from '../qianmu-world-source.js';
import * as packets from '../qianmu-production-packet.js';
import * as decisions from '../qianmu-director-decision.js';
import * as orders from '../qianmu-director-work-order.js';
import * as core from '../qianmu-storyboard.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const functionOnly = name => section(name).split(/\r?\n\}/)[0]+'\n}';
const copy=value=>JSON.parse(JSON.stringify(value));
const sample=()=>({story_status:{title:'夜雨'},npc_updates:[{name:'Alice',next_action:'reading a letter'}],world_updates:[{title:'雨',content:'rain'}]});
const owner={chatKey:'chat-a',revisionId:'generation-a'};
async function approved() {
  const plan=sample(),worldSourceIndex=await sources.buildWorldSourceIndex(plan,owner);
  const packet=packets.adaptDirectorPlanToProductionPackets(plan,{...owner,worldSourceIndex})[0];
  const candidate={candidateId:'c',owner:{chatKey:owner.chatKey},entryId:'e',recommendation:'manual_review',gates:{sourceValid:true,factConsistency:true,spoilerSafe:false,shotDistinct:true}};
  const result=decisions.createDirectorDecision(candidate,packet,{chatKey:owner.chatKey,ledgerEntryId:'e',approvedAt:1,explicitApproval:true,outputs:{storyboard:true}});
  assert.equal(result.ok,true);
  const order=orders.createDirectorWorkOrder(result.decision,'storyboard',owner.chatKey);
  assert.equal(order.ok,true);
  const shot=core.normalizeStoryboardShotSpec({...orders.directorWorkOrderToStoryboardShot(order.workOrder,owner.chatKey),directorDecision:result.decision});
  return {plan,packet,decision:result.decision,order:order.workOrder,shot};
}
test('world source distinguishes identical new generations, same names, fields and chats; object-key order is not identity',async()=>{
  const a=await sources.buildWorldSourceIndex(sample(),owner);
  const same=sample();same.npc_updates[0]={next_action:'reading a letter',name:'Alice'};
  assert.deepEqual(await sources.buildWorldSourceIndex(same,owner),a);
  for (const context of [{...owner,revisionId:'generation-b'},{...owner,chatKey:'chat-b'}]) {
    const other=await sources.buildWorldSourceIndex(sample(),context);
    assert.notEqual(other.revisionId,a.revisionId);assert.notEqual(other.entries[0].key,a.entries[0].key);
  }
  const edited=sample();edited.npc_updates[0].next_action='burning the letter';
  const other=await sources.buildWorldSourceIndex(edited,owner);
  assert.notEqual(other.revisionId,a.revisionId);assert.notEqual(other.entries[0].source.itemId,a.entries[0].source.itemId);
});
test('exact duplicate items remain distinct and display indexes never act as a cross-revision fallback',async()=>{
  const plan=sample();plan.npc_updates.push(copy(plan.npc_updates[0]));
  const result=await sources.buildWorldSourceIndex(plan,owner);
  assert.notEqual(result.entries[0].source.itemId,result.entries[1].source.itemId);
  assert.equal(result.entries[1].index,1);
  const empty=sample();empty.npc_updates.unshift({});
  const rows=packets.adaptDirectorPlanToProductionPackets(empty,{...owner,worldSourceIndex:await sources.buildWorldSourceIndex(empty,owner)});
  assert.equal(rows[0].sourceRef.index,1);assert.match(rows[0].packetId,/^packet-[a-f0-9]{64}-[a-f0-9]{64}$/);
});
test('untrusted or oversized source metadata cannot be truncated into a matching identity',async()=>{
  assert.equal(sources.worldSourceKey({field:'npc_updates',itemId:'Alice',revisionId:'0',chatKey:'chat-a'}),'');
  const good=(await sources.buildWorldSourceIndex(sample(),owner)).entries[0].source;
  assert.equal(sources.normalizeWorldSource({...good,chatKey:'x'.repeat(513)}),null);
  assert.equal(sources.normalizeWorldSource({...good,field:'__proto__'}),null);
  assert.equal(sources.normalizeWorldSource({...good,itemId:good.itemId+'x'}),null);
  await assert.rejects(()=>sources.buildWorldSourceIndex({text:'x'.repeat(2*1024*1024)},owner),/过大/);
  await assert.rejects(()=>sources.buildWorldSourceIndex(sample(),{chatKey:'chat-a'}),/版本/);
});
test('light media index is scoped, linear, deduplicated and never reads image or snapshot bodies',async()=>{
  const source=(await sources.buildWorldSourceIndex(sample(),owner)).entries[0].source;
  const record={id:'image-a',chatKey:owner.chatKey,productionContext:{worldSource:source}};
  Object.defineProperty(record,'snapshot',{get(){throw Error('heavy read');}});
  Object.defineProperty(record,'url',{get(){throw Error('image read');}});
  const records=[record,record,{id:'old',chatKey:owner.chatKey,productionContext:{packetId:'Alice'}},{...record,id:'other',chatKey:'chat-b'}];
  const index=sources.indexWorldMedia(records,owner.chatKey);
  assert.equal(index.size,1);assert.deepEqual(index.get(sources.worldSourceKey(source)),[record]);
  assert.equal(sources.indexWorldMedia(records,'chat-b').size,0);
  assert.equal(sources.indexWorldMedia(Array.from({length:10000},(_,i)=>({...record,id:`image-${i}`})),owner.chatKey).values().next().value.length,10000);
});
test('source survives packet→decision→work order→compiled shot→light delivery without upgrading canon',async()=>{
  const e=await approved(),key=sources.worldSourceKey(e.packet.sourceRef.worldSource);
  const compiled=core.compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-4-5-full',shot:e.shot});
  for(const source of [e.decision.source.worldSource,e.order.source.worldSource,e.shot.productionContext.worldSource,compiled.productionContext.worldSource,
    core.storyboardProductionContext({shotSpec:e.shot}).worldSource,core.storyboardDirectorDecisionSnapshot({shotSpec:e.shot}).source.worldSource]) assert.equal(sources.worldSourceKey(source),key);
  const policy=core.storyboardProductionDeliveryPolicy({shotSpec:e.shot},{inlineByDefault:true,floor:8});
  assert.equal(policy.requiresExplicitInsert,true);assert.equal(e.decision.truthMode,'speculative');
  assert.equal(decisions.canConsumeDirectorDecision(e.decision,'film',owner.chatKey),false);
});
test('actual delivery writes stable source into lightweight record so media indexing never needs its recipe',async()=>{
  const e=await approved();
  const context=vm.createContext({...core,Date,clone:copy,uid:()=> 'delivered-image',storyboardItemCollectionIds:()=>[],uniqueClean:items=>items,
    sanitizeStoryboardSnapshot:value=>copy(value),hashText:()=> 'unused'});
  vm.runInContext(functionOnly('storyboardCreateRecord'),context);
  const job={id:'world-job',chatKey:owner.chatKey,source:'novel',profile:{model:'nai-diffusion-4-5-full'},payload:{prompt:'world scene'},shotSpec:e.shot,target:'gallery',floor:null,inlineByDefault:false};
  const record=context.storyboardCreateRecord(job,{snapshot:job},'https://image.invalid/picture.png',0,{floor:null,message:null,valid:false},{});
  assert.equal(record.floor,null);assert.equal(record.inline,false);assert.equal(record.lastKnownFloor,null);
  assert.equal(sources.worldSourceKey(record.productionContext.worldSource),sources.worldSourceKey(e.packet.sourceRef.worldSource));
  delete record.snapshot;delete record.shotSpec;delete record.compiledPrompt;
  assert.equal(sources.indexWorldMedia([record],owner.chatKey).size,1);
});
function bridgeHarness() {
  const store={plan:sample(),directorPlanRevisionId:owner.revisionId},state=core.createStoryboardDefaults();state.enabled=true;state.directorBridge.worldSideShotsEnabled=true;
  let chatKey=owner.chatKey,loads=0,builds=0;
  const runtime={...packets,buildWorldSourceIndex:async(...args)=>{builds++;return sources.buildWorldSourceIndex(...args);}};
  const context=vm.createContext({console,Map,JSON,Date,activeTab:'castworld',getChatStore:()=>store,getChatKey:()=>chatKey,storyboardState:()=>state,
    featureRuntime:{load:async()=>{loads++;return runtime;}},refreshDirectorCandidatePool:async()=>{},storyboardGalleryRecords:()=>store.storyboardImages||[],rerenderIfOpen:()=>{},
    htmlEscape:value=>String(value),directorProductionPacketState:{packets:[]},directorCandidatePoolState:{},directorNarrativeBridgeEpoch:0,directorWorldSourceRefreshKey:'',directorWorldEntryLinks:new Map()});
  vm.runInContext(['directorWorldPlanRevision','directorWorldPlanSignature','resetDirectorNarrativeBridge','refreshDirectorProductionPackets','prepareDirectorWorldEntryLinks','renderDirectorWorldEntryLink','bindDirectorWorldEntryLinks'].map(functionOnly).join('\n'),context);
  return {store,state,context,runtime,setChat:key=>{chatKey=key;},counts:()=>({loads,builds}),refresh:()=>context.refreshDirectorProductionPackets(store.plan,{chatKey})};
}
test('actual bridge is dormant when disabled, refreshes on entry, and builds no media bytes',async()=>{
  const e=bridgeHarness();e.state.directorBridge.worldSideShotsEnabled=false;
  await e.refresh();e.context.prepareDirectorWorldEntryLinks();assert.deepEqual(e.counts(),{loads:0,builds:0});
  e.state.directorBridge.worldSideShotsEnabled=true;await e.refresh();e.context.prepareDirectorWorldEntryLinks();
  assert.match(e.context.renderDirectorWorldEntryLink('npc_updates',0),/核对并创作/);
  assert.equal(e.context.renderDirectorWorldEntryLink('npc_updates',9),'');
  const packet=e.context.directorProductionPacketState.packets[0];
  e.store.storyboardImages=[{id:'a',chatKey:owner.chatKey,productionContext:{worldSource:packet.sourceRef.worldSource}}];
  e.context.prepareDirectorWorldEntryLinks();assert.match(e.context.renderDirectorWorldEntryLink('npc_updates',0),/1 张画面/);
  assert.equal(e.counts().builds,1);
});
test('late source discovery cannot attach to another generation, edited plan or chat',async()=>{
  for (const mutate of [e=>e.store.directorPlanRevisionId='next',e=>e.store.plan.npc_updates[0].next_action='different',e=>e.setChat('other')]) {
    const e=bridgeHarness();let release;
    e.runtime.buildWorldSourceIndex=()=>new Promise(resolve=>{release=resolve;});
    const pending=e.refresh();await new Promise(resolve=>setImmediate(resolve));
    mutate(e);release(await sources.buildWorldSourceIndex(sample(),owner));await pending;
    assert.equal(e.context.directorProductionPacketState.packets.length,0);
  }
});
test('exact unique legacy history resolves to the same revision after explicit restoration, without modifying old data',async()=>{
  const e=bridgeHarness();delete e.store.directorPlanRevisionId;e.store.updatedAt='2026-09-01T00:00:00.000Z';
  e.store.history=[{id:'history-exact',createdAt:e.store.updatedAt,plan:copy(e.store.plan)}];
  const before=copy(e.store);await e.refresh();const key=e.context.directorProductionPacketState.packets[0].packetId;
  assert.deepEqual(e.store,before);
  e.store.plan=copy(e.store.history[0].plan);e.store.directorPlanRevisionId='history-exact';await e.refresh();
  assert.equal(e.context.directorProductionPacketState.packets[0].packetId,key);
  delete e.store.directorPlanRevisionId;e.store.history.push({...e.store.history[0],id:'ambiguous'});
  assert.equal(e.context.directorWorldPlanRevision(e.store),e.store.updatedAt);
});
test('entry rendering preserves original indexes through filtered relation and chain rows',()=>{
  const e=bridgeHarness(),seen=[];
  Object.assign(e.context,{snip:value=>String(value),htmlEscape:value=>String(value),renderDirectorWorldEntryLink:(field,index)=>{seen.push([field,index]);return '';}});
  vm.runInContext(['renderRelationUndercurrentsCard','renderChainReactionsCard'].map(functionOnly).join('\n'),e.context);
  e.context.renderRelationUndercurrentsCard({relation_undercurrents:[{}, {parties:'Alice/Bob',tension:'tense'}]});
  e.context.renderChainReactionsCard({chain_reactions:[{}, {spark:'rain',chain:'flood'}]});
  assert.deepEqual(seen,[['relation_undercurrents',1],['chain_reactions',1]]);
});
test('stale entry clicks are rejected; valid picture entry uses existing viewer and no generation',async()=>{
  const e=bridgeHarness();await e.refresh();e.context.prepareDirectorWorldEntryLinks();
  const link=[...e.context.directorWorldEntryLinks.values()][0];let click,viewed=0,generated=0,toasted=0;
  e.context.storyboardOpenLightbox=()=>{viewed++;};e.context.storyboardGenerateProductionPacket=()=>{generated++;};e.context.toast=()=>{toasted++;};
  const button={dataset:{worldPacket:link.packetId},addEventListener:(name,fn)=>{click=fn;}};
  e.context.bindDirectorWorldEntryLinks({querySelectorAll:()=>[button]});
  const event={preventDefault(){},stopPropagation(){}};click(event);assert.equal(generated,1);
  e.store.storyboardImages=[{id:'a',chatKey:owner.chatKey,productionContext:{worldSource:e.context.directorProductionPacketState.packets[0].sourceRef.worldSource}}];
  click(event);assert.equal(viewed,1);
  e.store.directorPlanRevisionId='next';click(event);assert.equal(toasted,1);assert.equal(viewed,1);assert.equal(generated,1);
});
async function redrawHarness() {
  const e=await approved(),state=core.createStoryboardDefaults();state.enabled=true;
  const compiled=core.compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-4-5-full',shot:e.shot});
  const snapshot={chatKey:owner.chatKey,source:'novel',profile:{model:'nai-diffusion-4-5-full',seed:42},connection:{baseUrl:'https://original.invalid',credentialId:'original-key'},
    payload:{prompt:compiled.prompt,negative:'old negative',shotSpec:e.shot},shotSpec:e.shot,compiledPrompt:compiled,prompt:compiled.prompt,negative:'old negative',target:'gallery',floor:null};
  const record={id:'original-image',chatKey:owner.chatKey,productionContext:e.shot.productionContext,source:'novel',snapshot,finalPrompt:compiled.prompt,floor:null,tags:['rain'],variantRootId:'original-group'};
  let chatKey=owner.chatKey,namespace='account-a',queued=[],messages=[];
  const context=vm.createContext({...core,console,Date,JSON,clone:copy,uid:()=>`job-${queued.length}`,storyboardAdmissionEpoch:1,storyboardState:()=>state,
    getChatKey:()=>chatKey,ctx:()=>({chat:[]}),storyboardGalleryRecords:()=>[record],storyboardReconcileGalleryLinks:()=>{},
    storyboardReadSnapshotForRecord:async()=>snapshot,storyboardLoadRecordToWorkbench:()=>{throw Error('world needs no prose workbench fallback');},
    storyboardRelinkRedrawSnapshot:()=>{throw Error('world must not invent an anchor');},storyboardGalleryGroupId:r=>r.variantRootId,
    storyboardItemCollectionIds:()=>['collection-a'],storyboardAssignCollectionIds:(job,ids)=>{job.collectionIds=ids;},uniqueClean:v=>v,
    storyboardQueueJob:job=>{queued.push(job);return job;},toast:message=>messages.push(message),
    featureRuntime:{load:async name=>name==='directorDecision'?decisions:{resolveImageAccountNamespace:async()=>namespace}}});
  vm.runInContext(['storyboardJobFromLog','storyboardRedrawRecord'].map(section).join('\n'),context);
  return {...e,context,state,snapshot,record,queued,messages,setChat:key=>{chatKey=key;},setAccount:key=>{namespace=key;},run:options=>context.storyboardRedrawRecord(record,options)};
}
test('actual world redraw reuses frozen recipe and shared queue, keeps original and creates gallery-only variant',async()=>{
  const e=await redrawHarness(),before=copy(e.record);
  e.state.source='comfy';await e.run();assert.equal(e.queued.length,1);
  const job=e.queued[0];assert.equal(job.source,'novel');assert.equal(job.connection.baseUrl,'https://original.invalid');assert.equal(job.profile.seed,42);
  assert.equal(job.floor,null);assert.equal(job.target,'gallery');assert.equal(job.inlineByDefault,false);assert.equal(job.messageRef,null);assert.equal(job.paragraphAnchor,null);
  assert.equal(job.variantRootId,'original-group');assert.equal(job.automatic,false);assert.deepEqual(copy(job.tags),['rain']);assert.deepEqual(e.record,before);
  assert.equal(sources.worldSourceKey(core.storyboardProductionContext(job).worldSource),sources.worldSourceKey(e.packet.sourceRef.worldSource));
});
test('world redraw refuses missing/revoked/mismatched approval and a foreign source',async()=>{
  for (const mutate of [e=>{e.snapshot.shotSpec.directorDecision=null;e.snapshot.compiledPrompt=null;},e=>{e.snapshot.shotSpec.directorDecision.status='revoked';},
    e=>{e.record.productionContext={...e.record.productionContext,packetId:'other'};},e=>{e.snapshot.chatKey='other';}]) {
    const e=await redrawHarness();mutate(e);await e.run();assert.equal(e.queued.length,0);assert.ok(e.messages.length);
  }
});
test('world redraw stops account/chat or saved-prompt changes while preparing',async()=>{
  for (const mutate of [e=>e.setChat('other'),e=>e.setAccount('account-b'),e=>{e.record.finalPrompt='edited concurrently';}]) {
    const e=await redrawHarness();await e.run({verify:async()=>mutate(e)});assert.equal(e.queued.length,0);assert.ok(e.messages.length);
  }
});
