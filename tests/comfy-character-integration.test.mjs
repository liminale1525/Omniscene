import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {generateImage} from '../qianmu-image-gateway.js';
import * as roles from '../qianmu-comfy-character-plan.js';
import * as storyboard from '../qianmu-storyboard.js';
import * as references from '../qianmu-comfy-references.js';
import * as direct from '../qianmu-image-direct.js';
import {checkComfyCharacterReadiness} from '../qianmu-comfy-character-readiness.js';
import {comfyCharacterEditorRecipe,renderComfyCharacterEditor,saveComfyCharacterEditor} from '../qianmu-comfy-character-view.js';
import {renderComfyWorkbench} from '../qianmu-comfy-workbench.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {graph,definitions,namespace,identity,implementation,job,recipe} from './helpers/comfy-character-fixture.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const fetchDefinitions=(calls=[],defs=definitions)=>async(url,options)=>{
  calls.push({url,options});const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));return json({[name]:defs[name]});
};
function harness({readReference}={}){
  const calls=[],warnings=[],state=storyboard.createStoryboardDefaults();state.enabled=true;state.source='comfy';let account=namespace,readinessError='';
  const context=vm.createContext({...storyboard,clone:structuredClone,storyboardAdmissionEpoch:1,storyboardState:()=>state,
    storyboardResolveApiKey:async(...args)=>{calls.push(['key',args]);return 'SECRET';},storyboardRequestHeaders:()=>({'x-csrf-token':'CSRF'}),
    featureRuntime:{load:async key=>key==='comfyCharacters'?roles:key==='comfyReferences'?{...references,...(readReference?{readComfyReferenceImages:options=>references.readComfyReferenceImages({...options,fetchImpl:readReference})}:{})}:key==='imageAdmission'?{resolveImageAccountNamespace:async()=>account}
      :key==='comfyCharacterReadiness'?{checkComfyCharacterReadiness:async(request,options)=>{calls.push(['readiness',copy(request)]);if(readinessError)throw Error(readinessError);return checkComfyCharacterReadiness(request,{...options,fetchImpl:fetchDefinitions()});}}:Promise.reject(Error(`unexpected ${key}`))},
    toast:message=>warnings.push(message),directImageRuntime:async()=>direct,
    resolveStoryboardJobModelIdentity:()=>({modelFamily:'comfy',remoteModelId:'comfy-workflow',protocol:'comfy'}),resolveStoryboardConnectionBinding:()=>({}),
    confirmDialog:async(title,message)=>{calls.push(['confirm',message]);return true;},
  });
  vm.runInContext(['storyboardPrepareComfyCharacterJob','storyboardComfyReferenceMetadata','storyboardParseWorkflow','storyboardGatewayRequest','storyboardConfirmComfyExecution','storyboardPrepareGatewayAssets'].map(section).join('\n'),context);
  return {context,calls,warnings,state,setAccount:value=>account=value,setReadinessError:value=>readinessError=value};
}

test('editor offers connected neutral targets, preserves escaped text and rejects disconnected bindings',()=>{
  const r=comfyCharacterEditorRecipe(recipe);assert.deepEqual(r.targets.referenceSlots,[1]);assert.deepEqual(r.targets.conditioning.map(row=>row.nodeId),['person','negative']);
  const editor={recipe:r,implementation:copy(implementation)};assert.deepEqual(saveComfyCharacterEditor(editor),implementation);
  editor.implementation.name='<script>x</script>';assert.doesNotMatch(renderComfyCharacterEditor(editor,()=>''),/<script>/);
  const broken=copy(graph);broken.save.inputs.images=['reference',0];assert.throws(()=>roles.validateComfyCharacterOutput(broken,implementation,'save'),/未接入/);
  assert.throws(()=>roles.validateComfyCharacterOutput(graph,implementation,''),/最终输出/);
});

test('single-person automatic role workflow passes quantity auditing without a false pending-upload warning',async()=>{
  const h=harness(),j=job();j.automatic=true;
  assert.equal(await h.context.storyboardConfirmComfyExecution(j,()=>true),true);
  assert.equal(h.calls.some(row=>row[0]==='confirm'),false);assert.equal(j.comfyExecution.automatic,true);
});

for(const [channel,run] of [['direct',direct.generateDirectImage],['gateway',generateImage]])test(`${channel}: actual frozen role assets reach one upload and one generation without copying NAI data`,async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
  let reads=0;const h=harness({readReference:async(url,options)=>{reads++;assert.equal(url,'/user/images/alice.png');assert.equal(options.credentials,'same-origin');return new Response(png);}}),j=job();
  for(const spec of [j.shotSpec,j.payload.shotSpec])Object.assign(spec.characters[0].archiveSnapshot.comfyImplementation.reference,{bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')});
  j.automatic=true;assert.equal(await h.context.storyboardConfirmComfyExecution(j,()=>true),true);
  const assets=await h.context.storyboardPrepareGatewayAssets(j),request=h.context.storyboardGatewayRequest(j,'SECRET',assets),calls=[];
  assert.equal(reads,1);assert.doesNotMatch(JSON.stringify(request),/NAI ONLY|archive:alice|comfyImplementation/);
  const result=await run(request,{resolveHost:async()=>[{address:'8.8.8.8',family:4}],waitImpl:async()=>{},fetchImpl:async(url,options={})=>{
    const path=new URL(url).pathname.replace(/^\/api/,'');calls.push(path);
    if(path==='/upload/image')return json({name:'uploaded.png',subfolder:'references',type:'input'});
    if(path==='/prompt'){
      const sent=JSON.parse(options.body).prompt;assert.equal(sent.reference.inputs.image,'references/uploaded.png');assert.equal(sent.person.inputs.text,'alice trigger');
      assert.equal(sent.negative.inputs.text,'alice exclusion');assert.equal(sent.lora.inputs.strength_clip,0);return json({prompt_id:'role-task'});
    }
    if(path==='/history/role-task')return json({'role-task':{status:{completed:true,status_str:'success'},outputs:{save:{images:[{filename:'result.png',subfolder:'',type:'output'}]}}}});
    assert.equal(path,'/view');return new Response(png,{headers:{'content-type':'image/png'}});
  }});
  assert.equal(result.images.length,1);assert.equal(calls.filter(path=>path==='/upload/image').length,1);assert.equal(calls.filter(path=>path==='/prompt').length,1);
  assert.equal(j.payload.parameters.workflow.reference.inputs.image,'%qianmu_reference_1%');
});

test('unknown or truncated readiness warnings never disappear behind a pending reference upload',async()=>{
  const request={workflow:graph,referenceCount:1};
  const base={schemaVersion:1,ok:true,ready:false,actualGenerationVerified:false,errors:0,warnings:2};
  const pending={severity:'warning',code:'reference_pending_upload',field:'image',nodeId:'reference'};
  for(const issues of [[],[pending],[pending,pending],[pending,{severity:'warning',code:'unknown',nodeId:'sampler'}]]){
    const result=await checkComfyCharacterReadiness(request,{transport:'gateway',fetchImpl:async()=>json({...base,issues})});
    assert.ok(result.unverifiedWarnings>=1);assert.equal(result.ready,false);
  }
  await assert.rejects(()=>checkComfyCharacterReadiness(request,{transport:'gateway',fetchImpl:async()=>json({...base,errors:1})}),/未通过/);
});

test('snapshot round trip preserves derived graph, exact role activation and matching cast; conflicting copies stop',async()=>{
  const h=harness(),j=job();await h.context.storyboardPrepareComfyCharacterJob(j,{prepare:true});
  const state=storyboard.createStoryboardDefaults();state.source='comfy';Object.assign(state.profiles.comfy,j.profile);
  state.logs=[{id:'role-log',source:'comfy',status:'failed',snapshot:j}];
  const restored=storyboard.normalizeStoryboardState(copy(state)).logs[0].snapshot;
  assert.equal((await roles.prepareComfyCharacterJob(restored,{namespace})).participants.length,1);
  await roles.assertComfyCharacterPlan(await roles.prepareComfyCharacterJob(restored,{namespace}),restored.payload);
  restored.payload.shotSpec.characters[0].archiveSnapshot.comfyImplementation.implementations[0].loras[0].strengthModel=.9;
  await assert.rejects(()=>roles.prepareComfyCharacterJob(restored,{namespace}),/快照不一致/);
});

test('profile and workbench keep a separate, default-off Comfy activation and malformed bindings remain visible',()=>{
  const original=job(),profile=storyboard.normalizeStoryboardParameterProfile(original.profile,'comfy');
  assert.deepEqual(profile.comfyCharacterActivation,original.profile.comfyCharacterActivation);assert.equal(profile.comfyCharacterEnabled,true);
  assert.equal(storyboard.normalizeStoryboardParameterProfile(original.profile,'novel').comfyCharacterEnabled,undefined);
  assert.deepEqual(storyboard.normalizeStoryboardParameterProfile({...original.profile,comfyCharacterActivation:{bad:true}},'comfy').comfyCharacterActivation,{invalid:true});
  const plain=renderComfyWorkbench({profile:{},capabilities:{}}),enabled=renderComfyWorkbench({profile,capabilities:{}});
  assert.match(plain,/data-comfy-character-action="toggle" aria-pressed="false"/);assert.match(enabled,/绑定当前方案/);assert.doesNotMatch(enabled,/NAI 参考设置/);
});

test('actual activation loads the explicitly saved recipe, keeps stale account/page changes off, and disabling performs no lookup',async()=>{
  for(const change of ['none','account','workflow','page']){
    const state=storyboard.createStoryboardDefaults();state.source='comfy';state.view='create';Object.assign(state.profiles.comfy,job().profile,{comfyCharacterEnabled:false});state.comfyLibrarySelection=copy(identity);
    const root={isConnected:true},notices=[];let account=namespace,saves=0,reads=0;
    const context=vm.createContext({...storyboard,clone:structuredClone,storyboardState:()=>state,storyboardAdmissionEpoch:1,toast:m=>notices.push(m),saveSettings:()=>saves++,renderModal(){},
      featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>account}:{readComfyCharacterRecipe:async options=>{
        reads++;await options.guard();assert.equal(options.binding.id,identity.id);assert.equal(options.expectedWorkflow,job().profile.comfyWorkflow);
        if(change==='account')account='st-user:other';if(change==='workflow')state.profiles.comfy.comfyWorkflow='{}';if(change==='page')root.isConnected=false;
        await options.guard();return recipe;
      }}},
    });
    vm.runInContext(['storyboardLoadCharacterComfyRecipe','storyboardToggleComfyCharacters'].map(section).join('\n'),context);
    await context.storyboardToggleComfyCharacters(root);assert.equal(state.profiles.comfy.comfyCharacterEnabled,change==='none');assert.equal(saves,change==='none'?1:0);assert.equal(root._sdComfyCharacterLoading,false);
    if(change==='none'){assert.equal(state.profiles.comfy.comfyCharacterActivation.workflow.hash,identity.hash);await context.storyboardToggleComfyCharacters(root);assert.equal(reads,1);assert.equal(state.profiles.comfy.comfyCharacterEnabled,false);assert.equal(saves,2);}
    else assert.match(notices.at(-1),/变化|切换/);
  }
});

test('candidate preflight fills only potential reference coverage, without declaring candidates to be visible people',async()=>{
  const j=job(),snap=j.shotSpec.characters[0].archiveSnapshot.comfyImplementation;
  const prepared={entries:[{identity:{name:'Alice'},comfyImplementation:snap},{identity:{name:'Bob'},comfyImplementation:copy(snap)}]};
  assert.equal((await roles.checkComfyCharacterCandidates({profile:j.profile,prepared,namespace})).referenceCount,1);
  await assert.rejects(()=>roles.checkComfyCharacterCandidates({profile:j.profile,prepared,namespace:'st-user:other'}),/账户/);
  const bad=copy(prepared);bad.entries[0].comfyImplementation.reference=null;
  await assert.rejects(()=>roles.checkComfyCharacterCandidates({profile:j.profile,prepared:bad,namespace}),/参考图缺失/);
});

test('actual job bridge builds a private graph, validates real node descriptors and fixes metadata before admission',async()=>{
  const h=harness(),j=job(),before=j.profile.comfyWorkflow;
  const plan=await h.context.storyboardPrepareComfyCharacterJob(j,{prepare:true,readiness:true});
  assert.equal(j.payload.parameters.workflow.lora.inputs.lora_name,'alice.safetensors');assert.equal(j.payload.parameters.workflow.lora.inputs.strength_clip,0);
  assert.equal(j.profile.comfyWorkflow,before);assert.equal(j.payload.comfyCharacterPlan.references.items[0].name,'Alice');assert.equal(plan.definitionWarnings,0);
  const request=h.calls.find(row=>row[0]==='readiness')[1];assert.equal(request.apiKey,'SECRET');assert.equal(request.referenceCount,1);assert.equal(request.parameters.workflow,undefined);
  assert.doesNotMatch(JSON.stringify(j),/SECRET|CSRF/);
  assert.equal((await h.context.storyboardPrepareComfyCharacterJob(j)).participants.length,1);
});

test('actual bridge rejects foreign identity, changed original/derived recipe and disabled carryover before generation',async()=>{
  for(const kind of ['namespace','derived','binding','disabled']){
    const h=harness(),j=job();await h.context.storyboardPrepareComfyCharacterJob(j,{prepare:true});
    if(kind==='namespace')h.setAccount('st-user:other');if(kind==='derived')j.payload.parameters.workflow.person.inputs.text='changed';
    if(kind==='binding')j.profile.comfyCharacterActivation.workflow.revision='changed';if(kind==='disabled')j.profile.comfyCharacterEnabled=false;
    await assert.rejects(()=>h.context.storyboardPrepareComfyCharacterJob(j),/账户|变化|版本|关闭/);
  }
});

test('automatic multi-person role application stops, while manual execution combines quantity and role warning in one confirmation',async()=>{
  const h=harness(),j=job();j.payload.shotSpec.characters.push({id:'unbound:bob',name:'Bob',visible:true});
  j.automatic=true;await assert.rejects(()=>h.context.storyboardConfirmComfyExecution(j,()=>true),/多人/);assert.equal(h.calls.some(row=>row[0]==='confirm'),false);
  j.automatic=false;assert.equal(await h.context.storyboardConfirmComfyExecution(j,()=>true),true);
  assert.equal(h.calls.filter(row=>row[0]==='confirm').length,1);assert.match(h.calls.find(row=>row[0]==='confirm')[1],/人物分区/);
  assert.equal(j.comfyExecution.automatic,false);assert.deepEqual([...j.comfyExecution.outputNodeIds],['save']);
});

test('actual execution audit sees the transformed graph; missing model or stale page cannot admit a role job',async()=>{
  const h=harness(),j=job();h.setReadinessError('LoRA 不在模型清单内');
  await assert.rejects(()=>h.context.storyboardConfirmComfyExecution(j,()=>true),/模型清单/);assert.equal(j.comfyExecution,undefined);
  const other=harness();await assert.rejects(()=>other.context.storyboardPrepareComfyCharacterJob(job(),{prepare:true,valid:()=>false}),/变化/);
  assert.equal(other.calls.length,0);
});

test('readonly readiness keeps browser and ST routes distinct, strips implicit fallbacks on auth failures, and bounds responses',async()=>{
  const j=job(),plan=await roles.prepareComfyCharacterJob(j,{namespace}),request={workflow:plan.workflow,model:j.profile.model,referenceCount:1,baseUrl:j.connection.baseUrl,apiKey:'SECRET'};
  const calls=[],checked=await checkComfyCharacterReadiness(request,{transport:'browser',fetchImpl:fetchDefinitions(calls)});
  assert.equal(checked.ready,false);assert.equal(checked.pendingReferenceUploads,1);assert.equal(checked.unverifiedWarnings,0);
  assert.ok(calls.every(({options})=>options.method==='GET'&&!options.body));
  let posts=0;await assert.rejects(()=>checkComfyCharacterReadiness(request,{transport:'legacy-auto',fetchImpl:async(url)=>{if(url.startsWith('/'))posts++;return new Response('',{status:401});}}),/权限|拒绝/);assert.equal(posts,0);
  const report={schemaVersion:1,ok:true,ready:true,actualGenerationVerified:false,errors:0,warnings:0};
  assert.equal((await checkComfyCharacterReadiness(request,{transport:'gateway',headers:{'x-csrf-token':'CSRF'},fetchImpl:async(url,options)=>{assert.equal(url,'/api/plugins/qianmu-tts/image/comfy/readiness');assert.equal(options.credentials,'same-origin');return json(report);}})).ready,true);
  await assert.rejects(()=>checkComfyCharacterReadiness(request,{transport:'gateway',fetchImpl:async()=>new Response('x'.repeat(256*1024+1))}),/返回过大/);
});

test('actual inline editing can disable only this image role recipe without changing global settings or auto-generating',async()=>{
  const h=harness(),j=job();await h.context.storyboardPrepareComfyCharacterJob(j,{prepare:true});let saved,generated=0;
  const record={id:'old',prompt:'garden',floor:0},fields={'.sd-storyboard-edit-positive':{value:''},'.sd-storyboard-edit-negative':{value:''},'.sd-comfy-character-inline':{checked:true}};
  Object.assign(h.context,{getChatKey:()=> 'chat',storyboardReadSnapshotForRecord:async()=>copy(j),storyboardStoreSnapshotForRecord:async(_,value)=>saved=value,
    document:{createElement:()=>({querySelector:selector=>fields[selector],insertAdjacentHTML(){}})},ctx:()=>({POPUP_TYPE:{CONFIRM:1},Popup:class{async show(){fields['.sd-comfy-character-inline'].checked=false;return 2;}}}),
    synchronizeStoryboardCaptionBase(){},saveMetadata:async()=>{},storyboardRenderInlineImages(){},storyboardRedrawRecord:()=>generated++});
  vm.runInContext(section('storyboardEditPrompt'),h.context);assert.equal(await h.context.storyboardEditPrompt({record}),true);
  assert.equal(saved.profile.comfyCharacterEnabled,false);assert.equal(saved.payload.comfyCharacterPlan,undefined);
  assert.equal(saved.payload.parameters.workflow.lora.inputs.strength_model,0);assert.equal(j.profile.comfyCharacterEnabled,true);assert.equal(generated,0);
});
