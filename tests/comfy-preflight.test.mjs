import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import * as preflight from '../qianmu-comfy-preflight.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const graph=()=>({p:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}},image:{class_type:'EmptyImage',inputs:{width:'%qianmu_width%',height:'%qianmu_height%',batch_size:1}},save:{class_type:'SaveImage',inputs:{images:['image',0]}}});
const config=()=>({workflow:graph(),parameters:{width:'832',height:'1216',count:'1'},model:'comfy-workflow',outputNodeId:'save'});
test('local preflight is pure and never claims a real node/model execution was verified',()=>{
  const input=config(),before=structuredClone(input);const result=preflight.checkComfyConfiguration(input);
  assert.equal(result.localConfigurationReady,true);assert.equal(result.remoteExecutionVerified,false);assert.equal(result.requiresManualQuantityReview,false);assert.deepEqual(input,before);
});
for(const [name,change,code] of [
  ['missing workflow',c=>c.workflow='','missing_workflow'],
  ['missing prompt',c=>c.workflow.p.inputs.text='fixed','comfy_prompt_slot_missing'],
  ['invalid width',c=>c.parameters.width='1','comfy_invalid_parameter'],
  ['missing sampler',c=>c.workflow.p.inputs.sampler='%qianmu_sampler%','comfy_parameter_missing'],
  ['model placeholder',c=>c.workflow.p.inputs.model='%qianmu_model%','comfy_model_slot_unbound'],
  ['missing reference',c=>c.workflow.p.inputs.image='%qianmu_reference%','comfy_reference_missing'],
  ['preview selection',c=>c.outputNodeId='p','comfy_output_selection'],
  ['deleted output',c=>c.outputNodeId='deleted','comfy_output_selection'],
])test(`configuration error before LLM: ${name}`,()=>{const c=config();change(c);assert.throws(()=>preflight.checkComfyConfiguration(c),{code});});
test('manual custom graphs retain per-attempt review; automatic unknown/multibatch fails locally',()=>{
  const unknown=config();unknown.workflow.custom={class_type:'UserNode',inputs:{}};
  assert.equal(preflight.checkComfyConfiguration(unknown).requiresManualQuantityReview,true);
  assert.throws(()=>preflight.checkComfyConfiguration({...unknown,automatic:true}),{code:'comfy_automatic_unverified'});
  const batch=config();batch.workflow.image.inputs.batch_size=4;assert.equal(preflight.checkComfyConfiguration(batch).report.savedImages,4);
  assert.throws(()=>preflight.checkComfyConfiguration({...batch,automatic:true}),{code:'comfy_audit_output_limit'});
});
function environment({automatic=false}={}) {
  const state=storyboard.createStoryboardDefaults();state.source='comfy';state.enabled=true;
  Object.assign(state.profiles.comfy,{model:'comfy-workflow',comfyWorkflow:JSON.stringify(graph()),comfyOutputNodeId:'save',width:'832',height:'1216'});
  const plan={origin:'automatic',autoGenerate:automatic,status:'screening'},calls=[],notices=[];let current=true;
  const guard={assertCurrent:()=>{if(!current)throw Object.assign(Error('changed'),{code:'storyboard_input_changed'});},isCurrent:()=>current,ownsCurrentContext:()=>current,dispose:()=>{}};
  const context=vm.createContext({...storyboard,STORYBOARD_SHOT_TYPE_LABELS:{portrait:'',group:'',environment:'',object:'',action:'',closeup:'',custom:''},
    storyboardState:()=>state,storyboardCompilerBusy:false,storyboardCaptureWorkbench:()=>({state,profile:state.profiles[state.source]}),
    storyboardTargetFloor:()=>0,ctx:()=>({chat:[{mes:'story'}]}),storyboardCreatePreparationGuard:()=>guard,
    storyboardSetPlanStatus:(p,status,extra={})=>Object.assign(p||{}, {status,...extra}),renderModal:()=>{},saveSettings:()=>{},
    storyboardScheduleAutomaticCapture:()=>{},storyboardScheduleInlineRender:()=>{},storyboardSchedulePlanArchive:()=>{},
    storyboardResolveRoutingProfile:(s,route)=>({...s.profiles[route.providerId],...(s.parameterPresets.find(p=>p.id===route.parameterPresetId)?.profile||{})}),
    storyboardCompilerContext:async()=>{calls.push('context');return {floor:0,messages:[],worldRows:[]};},
    featureRuntime:{load:async key=>{calls.push(key);return key==='comfyPreflight'?preflight:{buildStoryboardPlanContractRequest:()=>({messages:[],schema:{},schemaId:'test'})};}},
    storyboardCompilerRequestConfig:()=>({}),storyboardCallCompiler:async()=>{calls.push('llm');return '{}';},
    storyboardCompilerResult:async()=>({shouldGenerate:false,skipReason:'no shot'}),sanitizeStoryboardDiagnosticData:value=>value,
    uid:()=> 'test-id',toast:message=>notices.push(message),MODULE_NAME:'test',console:{error:()=>{}},
  });
  vm.runInContext(['storyboardWorkflowIssue','storyboardCertainCompilerRoute','storyboardPreflightComfyForCompiler','storyboardCompilePrompt'].map(section).join('\n'),context);
  return {state,plan,calls,notices,context,guard,invalidate:()=>current=false};
}
const target=(providerId='comfy',parameterPresetId='')=>({providerId,modelId:providerId==='comfy'?'comfy-workflow':'nai-diffusion-5-full',parameterPresetId});
test('actual compiler stops missing Comfy before context/LLM and marks the original plan failed',async()=>{
  const e=environment();e.state.profiles.comfy.comfyWorkflow='';assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),false);
  assert.equal(e.calls.includes('context'),false);assert.equal(e.calls.includes('llm'),false);assert.equal(e.plan.status,'failed');assert.match(e.notices.at(-1),/^Comfy 配置未就绪：.*API Workflow/);assert.equal(e.context.storyboardCompilerBusy,false);
});
test('automatic image mode rejects unknown quantity before LLM, extract-only mode remains available',async()=>{
  for(const automatic of [false,true]){const e=environment({automatic}),g=graph();g.custom={class_type:'Custom',inputs:{}};e.state.profiles.comfy.comfyWorkflow=JSON.stringify(g);
    await e.context.storyboardCompilePrompt(null,{plan:e.plan,automatic});assert.equal(e.calls.includes('llm'),!automatic);}
});
test('manual extraction does not inherit an old plan automatic-generation flag',async()=>{
  const e=environment({automatic:true}),g=graph();g.custom={class_type:'Custom',inputs:{}};e.state.profiles.comfy.comfyWorkflow=JSON.stringify(g);
  await e.context.storyboardCompilePrompt(null,{plan:e.plan});assert.ok(e.calls.includes('llm'));
});

test('invalid fixed Comfy requester stops before context/LLM without changing the connection', async () => {
  const e = environment(); e.state.connections.comfy.draft.options = { comfyTransport: 'unsupported' };
  await e.context.storyboardCompilePrompt(null, { plan: e.plan });
  assert.ok(!e.calls.includes('llm')); assert.equal(e.state.connections.comfy.draft.options.comfyTransport, 'unsupported');
});
test('a catch-all model route does not load/validate the unused broken Comfy workbench',async()=>{
  const e=environment();e.state.profiles.comfy.comfyWorkflow='';e.state.routing.enabled=true;e.state.routing.rules=[{id:'all',enabled:true,shotTypes:[],target:target('novel')}];
  await e.context.storyboardCompilePrompt(null,{plan:e.plan});assert.ok(e.calls.includes('llm'));assert.ok(!e.calls.includes('comfyPreflight'));
});
test('the actual highest-priority reachable route is checked, not a shadowed broken Comfy rule',async()=>{
  const e=environment();e.state.source='novel';e.state.profiles.comfy.comfyWorkflow='';e.state.routing.enabled=true;
  e.state.routing.rules=[{id:'high',priority:10,enabled:true,shotTypes:[],target:target('novel')},{id:'low',enabled:true,shotTypes:[],target:target()}];
  assert.equal(e.context.storyboardCertainCompilerRoute(e.state,e.state.profiles.novel).providerId,'novel');
  await e.context.storyboardCompilePrompt(null,{plan:e.plan});assert.ok(e.calls.includes('llm'));assert.ok(!e.calls.includes('comfyPreflight'));
});
test('a catch-all Comfy route checks its explicit parameter recipe, not the current other engine',async()=>{
  const e=environment();e.state.source='novel';e.state.routing.enabled=true;e.state.parameterPresets=[{id:'broken',profile:{comfyWorkflow:''}}];
  e.state.routing.rules=[{id:'all',enabled:true,shotTypes:[],target:target('comfy','broken')}];
  await e.context.storyboardCompilePrompt(null,{plan:e.plan});assert.equal(e.calls.includes('llm'),false);assert.equal(e.plan.status,'failed');
});
test('unmatched types use current workbench fallback; genuinely conditional routes are not prematurely guessed',()=>{
  const e=environment();e.state.routing.enabled=true;e.state.routing.single=target('novel');
  assert.equal(e.context.storyboardCertainCompilerRoute(e.state,e.state.profiles.comfy).providerId,'comfy');
  e.state.routing.rules=[{id:'portrait',enabled:true,shotTypes:['portrait'],target:target('novel')}];assert.equal(e.context.storyboardCertainCompilerRoute(e.state,e.state.profiles.comfy),null);
});
test('configuration changed while lazy preflight loaded cannot continue to the LLM',async()=>{
  const e=environment();e.context.featureRuntime.load=async()=>{e.invalidate();return preflight;};
  await e.context.storyboardCompilePrompt(null,{plan:e.plan});assert.equal(e.calls.includes('llm'),false);assert.equal(e.calls.includes('context'),false);
});
