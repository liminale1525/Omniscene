import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeComfyCharacterImplementation,normalizeComfyCharacterSettings,normalizeComfyCharacterSnapshot} from '../qianmu-comfy-character-contract.js';
import {inspectComfyCharacterTargets,prepareComfyCharacterPlan} from '../qianmu-comfy-character-plan.js';
import {comfyWorkflowReferenceHash} from '../qianmu-comfy-references.js';
import {prepareComfyWorkflow} from '../qianmu-comfy-workflow.js';
import {newCharacterArchive,normalizeCharacterArchive,exportCharacterArchive,importCharacterArchive,characterIdentityProjection} from '../qianmu-character-archive.js';
import {prepareCharacterCasting,applyCharacterCasting,normalizeCharacterCastingSnapshot,characterCastingInput} from '../qianmu-character-casting.js';
import {normalizeStoryboardShotSpec,sanitizeStoryboardSnapshot} from '../qianmu-storyboard.js';

const copy = value=>JSON.parse(JSON.stringify(value));
const receipt = {url:'/user/images/alice.png',name:'Alice',mime:'image/png',bytes:70,sha256:'a'.repeat(64)};
// Deliberately a local mapping fixture, not a remotely executable or output-audited workflow.
const workflow = {
  prompt:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%',clip:['base',1]}},
  base:{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'model.safetensors'}},
  lora:{class_type:'LoraLoader',inputs:{model:['base',0],clip:['base',1],lora_name:'neutral.safetensors',strength_model:0,strength_clip:0}},
  positive:{class_type:'CLIPTextEncode',inputs:{clip:['lora',1],text:''}},
  negative:{class_type:'CLIPTextEncode',inputs:{clip:['lora',1],text:''}},
  image:{class_type:'LoadImage',inputs:{image:'%qianmu_reference_1%'}},
};
const identity = {id:'wf',revision:'revision-1',version:1,hash:await comfyWorkflowReferenceHash(workflow)};
const implementation = {
  version:1,name:'Alice portrait',workflow:identity,referenceSlot:1,
  loras:[{nodeId:'lora',classType:'LoraLoader',loraName:'characters/alice.safetensors',strengthModel:0.7,strengthClip:0}],
  conditioning:[{nodeId:'positive',kind:'positive',text:'alice trigger'},{nodeId:'negative',kind:'negative',text:'alice exclusion'}],
};
const snapshot = (impl=implementation,extra={})=>({version:1,namespace:'st-user:test',implementations:impl?[copy(impl)]:[],reference:copy(receipt),...extra});
const character = (id='alice',snap=snapshot())=>({id:`archive:${id}`,name:id,archiveSnapshot:{subjectId:`archive:${id}`,archiveId:id,archiveVersion:1,name:id,comfyImplementation:snap}});
const plan = (options={})=>prepareComfyCharacterPlan({workflow,workflowIdentity:identity,namespace:'st-user:test',shot:{characters:[character()]},...options});
const rejects = (fn,pattern)=>assert.rejects(fn,error=>error.submissionState==='not_submitted' && pattern.test(error.message));

test('Comfy recipes normalize exact workflow versions, local model names, neutral zero and native node types',()=>{
  const result=normalizeComfyCharacterImplementation(implementation); assert.deepEqual(result,implementation);
  result.loras[0].strengthModel=-1;assert.equal(normalizeComfyCharacterImplementation(result).loras[0].strengthModel,-1);
  result.loras[0].classType='LoraLoaderModelOnly';result.loras[0].strengthClip=null;
  assert.equal(normalizeComfyCharacterImplementation(result).loras[0].strengthClip,null);
  assert.deepEqual(normalizeComfyCharacterSettings({version:1,implementations:[]}),{version:1,implementations:[]});
  assert.throws(()=>normalizeComfyCharacterSettings({version:1,implementations:[implementation,implementation]}),/同一角色/);
});

test('invalid mappings, future versions, path escapes, template text and excessive fields fail closed',()=>{
  const mutate = change=>{const value=copy(implementation);change(value);return value;};
  const cases=[
    x=>x.version=2,x=>x.workflow.hash='bad',x=>x.workflow.version=0,x=>x.workflow.revision='',x=>x.referenceSlot=0,
    x=>x.referenceSlot='1',x=>x.referenceSlot=17,x=>x.referenceSlot=undefined,x=>x.loras[0].strengthClip='',
    x=>x.loras[0].strengthModel=Infinity,x=>x.loras[0].strengthModel=101,x=>x.loras[0].classType='CustomLoRA',
    x=>x.loras[0].nodeId='__proto__',x=>x.conditioning[0].nodeId='lora',x=>x.conditioning[0].kind='regional',
    x=>x.conditioning[0].text='%qianmu_reference_1%',x=>x.conditioning[0].text='x'.repeat(6001),
    x=>x.loras=Array(9).fill(x.loras[0]),
    ...['../x','/x','https://x/a','C:\\x','a//b','a/%2e%2e/b','a\\b'].map(name=>x=>x.loras[0].loraName=name),
  ];
  for (const change of cases) assert.throws(()=>normalizeComfyCharacterImplementation(mutate(change)),error=>error.code==='comfy_character_binding');
});

test('target discovery offers only explicit standard reference slots and reports neutral nodes',()=>{
  const value={...workflow,custom:{class_type:'CustomImage',inputs:{image:'%qianmu_reference_2%'}},literal:{class_type:'LoadImage',inputs:{image:'private.png'}},
    modelonly:{class_type:'LoraLoaderModelOnly',inputs:{strength_model:1}},nonempty:{class_type:'CLIPTextEncode',inputs:{text:'keep'}}};
  const targets=inspectComfyCharacterTargets(value);
  assert.deepEqual(targets.referenceSlots,[1]);assert.equal(targets.loras.find(x=>x.nodeId==='modelonly').neutral,false);
  assert.equal(targets.conditioning.find(x=>x.nodeId==='nonempty').neutral,false);assert.equal(targets.conditioning.find(x=>x.nodeId==='positive').neutral,true);
});

test('preparation modifies a private graph, preserves native types and emits a newly hash-bound reference selection',async()=>{
  const original=JSON.stringify(workflow),result=await plan(),graph=JSON.parse(result.workflow);
  assert.equal(graph.lora.inputs.lora_name,'characters/alice.safetensors');assert.equal(graph.lora.inputs.strength_model,.7);
  assert.equal(graph.lora.inputs.strength_clip,0);assert.equal(graph.negative.inputs.text,'alice exclusion');
  assert.equal(graph.prompt.inputs.text,'%qianmu_prompt%');assert.equal(JSON.stringify(workflow),original);
  assert.equal(result.references.workflowHash,await comfyWorkflowReferenceHash(graph));assert.notEqual(result.references.workflowHash,identity.hash);
  assert.equal(result.originalHash,identity.hash);assert.equal(result.references.items[0].sha256,receipt.sha256);
  assert.ok(Object.isFrozen(result.references.items[0]));assert.ok(Object.isFrozen(result.participants[0].implementation));
  const submitted=prepareComfyWorkflow(result.workflow,{prompt:'actual scene',referenceCount:1}).bind(['uploaded.png']);
  assert.equal(submitted.prompt.inputs.text,'actual scene');assert.equal(submitted.image.inputs.image,'uploaded.png');
  assert.equal(result.remoteExecutionVerified,false);assert.equal(result.spatialIsolationVerified,false);
});

test('workflow content, version, revision and account mismatches do not reuse old role bindings',async()=>{
  await rejects(()=>plan({workflowIdentity:{...identity,hash:'b'.repeat(64)}}),/内容已变化/);
  await rejects(()=>plan({workflowIdentity:{...identity,revision:'new'}}),/未绑定当前工作流/);
  await rejects(()=>plan({workflowIdentity:{...identity,version:2}}),/未绑定当前工作流/);
  await rejects(()=>plan({namespace:'st-user:other'}),/另一 ST 账户/);
  await rejects(()=>plan({namespace:'invalid'}),/账户/);
  const old=character();delete old.archiveSnapshot.comfyImplementation;
  await rejects(()=>plan({shot:{characters:[old]}}),/旧镜头/);
});

test('duplicate people, slot conflicts and missing references cannot borrow another person or static image',async()=>{
  await rejects(()=>plan({shot:{characters:[character(),character()]}}),/人物重复/);
  await rejects(()=>plan({shot:{characters:[character(),character('bob')]}}),/参考槽.*冲突/);
  await rejects(()=>plan({shot:{characters:[character('alice',snapshot(implementation,{reference:null}))]}}),/未保存参考图/);
  await rejects(()=>plan({staticSelection:{version:1,namespace:'st-user:test',workflowHash:identity.hash,enabled:true,items:[receipt]}}),/参考槽.*冲突/);
  await assert.rejects(()=>plan({shot:{characters:[]}}),/缺少第 1 张参考图/);
  await assert.rejects(()=>plan({shot:{characters:[{...character(),visible:false}]}}),/缺少第 1 张参考图/);
});

test('role references can follow explicit static slots but never leave an unbound hole',async()=>{
  const value=copy(workflow);value.background={class_type:'LoadImage',inputs:{image:'%qianmu_reference_1%'}};value.image.inputs.image='%qianmu_reference_2%';
  const bound={...identity,hash:await comfyWorkflowReferenceHash(value)},impl={...implementation,workflow:bound,referenceSlot:2};
  const options={workflow:value,workflowIdentity:bound,shot:{characters:[character('alice',snapshot(impl))]}};
  await rejects(()=>plan(options),/空缺/);
  const result=await plan({...options,staticSelection:{version:1,namespace:'st-user:test',workflowHash:bound.hash,enabled:true,items:[{...receipt,name:'background',sha256:'c'.repeat(64)}]}});
  assert.equal(result.references.items[0].name,'background');assert.equal(result.references.items[1].name,'Alice');
});

test('two identities cannot overwrite one node and non-neutral source values are not silently replaced',async()=>{
  const a=copy(implementation);a.referenceSlot=null;a.conditioning=[];
  const b=copy(a);b.name='Bob';
  await rejects(()=>plan({shot:{characters:[character('alice',snapshot(a)),character('bob',snapshot(b))]}}),/同一角色节点/);
  const value=copy(workflow);value.lora.inputs.strength_model=.1;
  const bound={...identity,hash:await comfyWorkflowReferenceHash(value)};
  await rejects(()=>plan({workflow:value,workflowIdentity:bound,shot:{characters:[character('alice',snapshot({...implementation,workflow:bound}))]}}),/原始强度为 0/);
  value.lora.inputs.strength_model=0;value.positive.inputs.text='keep existing text';bound.hash=await comfyWorkflowReferenceHash(value);
  await rejects(()=>plan({workflow:value,workflowIdentity:bound,shot:{characters:[character('alice',snapshot({...implementation,workflow:bound}))]}}),/原始内容为空/);
});

test('reference-only and no-implementation snapshots do not import NAI settings or claim spatial isolation',async()=>{
  const result=await plan({shot:{characters:[character('alice',snapshot({...implementation,loras:[],conditioning:[]}))]}});
  assert.equal(result.workflow,JSON.stringify(workflow));assert.equal(result.spatialIsolationVerified,false);
  const value=copy(workflow);delete value.image;const bound={...identity,hash:await comfyWorkflowReferenceHash(value)};
  const empty=await plan({workflow:value,workflowIdentity:bound,shot:{characters:[character('alice',snapshot(null,{reference:null}))]}});
  assert.equal(empty.participants.length,0);assert.equal(empty.references,null);assert.doesNotMatch(JSON.stringify(empty),/director_reference|novelReference/);
});

test('safety adaptation, incomplete qualification and a changed async session cannot carry unreviewed role assets',async()=>{
  await rejects(()=>plan({safetyAdapted:true}),/安全资格/);await rejects(()=>plan({shot:{characters:[character()],sensitive:true}}),/安全资格/);
  let checks=0;await assert.rejects(()=>plan({guard:async()=>{if(++checks===3)throw Error('session changed');}}),/session changed/);
  const mutable=copy(workflow),subject=character();
  const result=await plan({workflow:mutable,shot:{characters:[subject]},guard:async()=>{mutable.lora.inputs.strength_model=100;subject.archiveSnapshot.comfyImplementation.reference.sha256='f'.repeat(64);}});
  assert.equal(JSON.parse(result.workflow).lora.inputs.strength_model,.7);assert.equal(result.references.items[0].sha256,receipt.sha256);
});

test('archive storage supports separate Comfy data while portable identity exports omit local permissions',()=>{
  const doc=normalizeCharacterArchive({...newCharacterArchive(),name:'Alice',comfy:{version:1,implementations:[implementation]},
    imagegen:{appearance:'ordinary appearance',negative:'NAI exclusion',reference:receipt,novelReference:{strength:.6,fidelity:1}}});
  assert.deepEqual(doc.comfy.implementations[0],implementation);assert.equal(doc.imagegen.novelReference.fidelity,1);
  assert.doesNotMatch(JSON.stringify(characterIdentityProjection('alice',1,doc)),/comfy|revision|safetensors|NAI exclusion|user\/images/);
  const exported=exportCharacterArchive(doc);assert.equal(exported.comfyOmitted,true);assert.equal(exported.document.comfy,undefined);
  const imported=importCharacterArchive(JSON.stringify({schema:doc.schema,document:doc}));assert.equal(imported.comfyOmitted,true);
  assert.equal(imported.document.comfy,undefined);assert.equal(imported.document.imagegen.reference,null);
  assert.throws(()=>normalizeCharacterArchive({...doc,comfy:{version:2,implementations:[]}}),/版本/);
});

test('opt-in casting captures engine data privately, old paths stay unchanged and history rejects corrupt versions',async()=>{
  const doc=normalizeCharacterArchive({...newCharacterArchive(),name:'Alice',imagegen:{appearance:'Alice appearance',negative:'NAI ONLY',reference:receipt},comfy:{version:1,implementations:[implementation]}});
  const head={id:'alice',revision:'role-1',version:1,name:'Alice',aliases:[],category:'char'};
  const store={list:async()=>[head],bindings:async()=>[{category:'char',subjectKey:'alice',scope:'default',chatKey:'',archiveId:'alice'}],load:async()=>({head,document:doc})};
  const args={store,namespace:'st-user:test',subjects:[{category:'char',subjectKey:'alice',name:'Alice'}]};
  const old=await prepareCharacterCasting(args);assert.equal(old.entries[0].comfyImplementation,undefined);
  const prepared=await prepareCharacterCasting({...args,includeComfy:true});
  assert.equal(prepared.entries[0].imageReference,undefined);assert.ok(Object.isFrozen(prepared.entries[0].comfyImplementation));
  assert.doesNotMatch(JSON.stringify(characterCastingInput(prepared)),/safetensors|namespace|reference|NAI ONLY|revision/);
  const result=applyCharacterCasting(normalizeStoryboardShotSpec({characters:[{id:'C1',name:'Alice',identity:['current blue hair']}]}),prepared);
  doc.comfy.implementations[0].loras[0].strengthModel=1;doc.imagegen.reference.sha256='f'.repeat(64);
  const roundtrip=JSON.parse(JSON.stringify(sanitizeStoryboardSnapshot({shotSpec:result.shot,payload:{shotSpec:result.shot}})));
  assert.deepEqual(roundtrip.shotSpec.characters[0].archiveSnapshot,roundtrip.payload.shotSpec.characters[0].archiveSnapshot);
  const saved=normalizeStoryboardShotSpec(roundtrip.shotSpec);
  const restored=saved.characters[0].archiveSnapshot;
  assert.equal(restored.comfyImplementation.reference.bytes,70);assert.equal(restored.comfyImplementation.reference.sha256,'a'.repeat(64));
  assert.equal(restored.comfyImplementation.implementations[0].loras[0].strengthModel,.7);
  assert.equal((await plan({shot:saved})).references.items[0].sha256,'a'.repeat(64));
  const corrupt=copy(restored);corrupt.comfyImplementation.version=2;assert.equal(normalizeCharacterCastingSnapshot(corrupt).invalid,true);
  assert.throws(()=>normalizeComfyCharacterSnapshot({...snapshot(),namespace:'st-user:test\n'}),/快照/);
});
