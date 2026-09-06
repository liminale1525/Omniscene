import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as runtime from '../qianmu-image-direct.js';
import * as capabilities from '../qianmu-service-capabilities.js';
import * as storyboard from '../qianmu-storyboard.js';
import {renderComfyLibrary} from '../qianmu-comfy-library-view.js';
import { imageGatewayCapabilities } from '../qianmu-image-gateway.js';
import { createStoryboardFormFixture, storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const workflow = () => ({image:{class_type:'EmptyImage',inputs:{width:512,height:512,batch_size:1}},
  prompt:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}},save:{class_type:'SaveImage',inputs:{images:['image',0]}}});
function harness({ automatic = false, uncertain = false, batch = 1, choice = 'accept', output = '' } = {}) {
  const graph=workflow();graph.image.inputs.batch_size=batch;if(uncertain)graph.custom={class_type:'CustomNode',inputs:{}};
  const job={source:'comfy',automatic,profile:{model:'comfy-workflow',comfyOutputNodeId:output},connection:{baseUrl:'https://comfy.example'},target:'gallery',
    payload:{prompt:'garden',parameters:{workflow:graph,count:1}}};
  const state={enabled:true,automation:{autoCapture:true,autoGenerate:true},logs:[]},waiting=[],notices=[],confirmations=[],admissions=[];
  let chat='a';
  const context=vm.createContext({
    ...storyboard,clone:structuredClone,storyboardState:()=>state,getChatKey:()=>chat,storyboardQueue:waiting,storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:8,
    storyboardValidatedAnchor:()=>({valid:true}),getStoryboardGenerationPolicy:()=>({maxImages:1}),storyboardGalleryRecords:()=>[],
    resolveStoryboardJobModelIdentity:()=>({modelFamily:'comfy',remoteModelId:'comfy-workflow',protocol:'comfy'}),
    resolveStoryboardConnectionBinding:()=>({}),directImageRuntime:async()=>runtime,
    storyboardImageAdmissionRuntime:async()=>({admit:async job=>{admissions.push(job.id||'job');}}),
    storyboardStartLog:job=>{const log={id:'log',snapshot:structuredClone(job)};state.logs.push(log);return log;},
    storyboardPlanForJob:()=>null,storyboardSetPlanStatus:()=>{},saveSettings:()=>{},renderModal:()=>{},storyboardPumpQueue:()=>{},
    storyboardSettleImageAdmission:async()=>{},toast:message=>{notices.push(message);return false;},
    confirmDialog:async(title,message)=>{
      confirmations.push({title,message});if(choice==='chat')chat='b';if(choice==='disabled')state.enabled=false;
      if(choice==='mutation')job.payload.parameters.workflow.image.inputs.batch_size=7;
      return choice!=='cancel';
    },
  });
  vm.runInContext(['storyboardComfyReferenceMetadata','storyboardParseWorkflow','storyboardGatewayRequest','storyboardConfirmComfyExecution','storyboardQueueJob'].map(section).join('\n'),context);
  return{job,state,context,waiting,notices,confirmations,admissions};
}

test('actual workbench queue rejects unknown automatic graphs before admission or confirmation',async()=>{
  const h=harness({automatic:true,uncertain:true});assert.equal(await h.context.storyboardQueueJob(h.job),false);
  assert.equal(h.admissions.length,0);assert.equal(h.waiting.length,0);assert.equal(h.confirmations.length,0);assert.match(h.notices[0],/一镜一张/);
});

test('verified automatic workflow freezes selected outputs through queue snapshot and provider request',async()=>{
  const h=harness({automatic:true,output:'save'});assert.equal(await h.context.storyboardQueueJob(h.job),true);
  assert.equal(h.confirmations.length,0);assert.equal(h.admissions.length,1);assert.equal(h.job.comfyExecution.automatic,true);
  assert.deepEqual([...h.job.comfyExecution.outputNodeIds],['save']);assert.equal(h.state.logs[0].snapshot.comfyAudit.selectedImages,1);
  const request=h.context.storyboardGatewayRequest(h.job,'mock',{references:[],vibes:[]});assert.equal(request.comfyExecution.version,1);
  h.job.profile.comfyOutputNodeId='other';assert.deepEqual([...request.comfyExecution.outputNodeIds],['save']);
});

for(const choice of ['accept','cancel','chat','mutation','disabled'])test(`manual unverified workflow confirmation: ${choice}`,async()=>{
  const h=harness({uncertain:true,choice});assert.equal(await h.context.storyboardQueueJob(h.job),choice==='accept');
  assert.equal(h.confirmations.length,1);assert.match(h.confirmations[0].message,/未确定/);
  assert.equal(h.admissions.length,choice==='accept'?1:0);assert.equal(h.waiting.length,choice==='accept'?1:0);
  if(choice==='accept')assert.equal(h.job.comfyExecution.allowUnverified,true);
});

test('known batch work requires explicit consent; known overlimit work cannot be confirmed',async()=>{
  const h=harness({batch:4});assert.equal(await h.context.storyboardQueueJob(h.job),true);assert.equal(h.confirmations.length,1);assert.match(h.confirmations[0].message,/保存 4 张/);
  const bad=harness({batch:9});assert.equal(await bad.context.storyboardQueueJob(bad.job),false);assert.equal(bad.confirmations.length,0);assert.equal(bad.admissions.length,0);
});

test('retry never inherits previous manual uncertainty consent',async()=>{
  const h=harness({uncertain:true});assert.equal(await h.context.storyboardQueueJob(h.job),true);
  h.waiting.length=0;assert.equal(await h.context.storyboardQueueJob(h.job),true);assert.equal(h.confirmations.length,2);
});

test('workflow library editor exposes saved output nodes; daily workbench and other families do not duplicate them',()=>{
  const comfy=createStoryboardFormFixture({family:'comfy',workflow:workflow()});
  const editor=renderComfyLibrary({draft:{name:'Example',document:{workflow:JSON.stringify(workflow()),outputNodeId:'save',parameters:{}}}});
  assert.match(comfy.content,/sd-comfy-open-library/);assert.match(editor,/data-comfy-draft="outputNodeId"/);assert.match(editor,/value="save"[^>]*>save · SaveImage/);
  const novel=createStoryboardFormFixture({family:'novel'});assert.doesNotMatch(novel.content,/comfyOutputNodeId/);
});

test('selected output survives profiles, saved parameter presets and log normalization',()=>{
  const state=storyboard.createStoryboardDefaults();state.source='comfy';state.profiles.comfy.comfyWorkflow=JSON.stringify(workflow());state.profiles.comfy.comfyOutputNodeId='save';
  state.logs=[{id:'log',source:'comfy',status:'failed',snapshot:{source:'comfy',profile:{...state.profiles.comfy},comfyExecution:{version:1,outputNodeIds:['save'],automatic:false,maxImages:8,allowUnverified:false}}}];
  const restored=storyboard.normalizeStoryboardState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.profiles.comfy.comfyOutputNodeId,'save');assert.equal(restored.logs[0].snapshot.profile.comfyOutputNodeId,'save');
  assert.deepEqual(restored.logs[0].snapshot.comfyExecution.outputNodeIds,['save']);
  assert.equal(storyboard.normalizeStoryboardParameterProfile(state.profiles.comfy,'comfy').comfyOutputNodeId,'save');
});

test('changing JSON cannot silently replace a missing or invalid selected output with all outputs',()=>{
  const context=vm.createContext({ ...storyboard, htmlEscape: value=>String(value??'').replaceAll('"','&quot;').replaceAll('<','&lt;') });
  vm.runInContext(['storyboardParseWorkflow','storyboardComfyOutputOptions'].map(section).join('\n'),context);
  for(const value of ['{',JSON.stringify(workflow()),JSON.stringify({...workflow(),missing:{class_type:'PreviewImage',inputs:{images:['image',0]}}})]){
    const html=context.storyboardComfyOutputOptions({comfyWorkflow:value,comfyOutputNodeId:'missing'});
    assert.match(html,/value="missing" selected/);
  }
});

test('actual gateway handshake blocks old service and accepts current service before image POST',async()=>{
  for(const current of [false,true]){
    const body=imageGatewayCapabilities();if(!current)delete body.comfyExecution;let probes=0;
    const context=vm.createContext({
      resolveStoryboardJobModelIdentity:()=>({modelFamily:'comfy',protocol:'comfy'}),storyboardConfirmGatewayProtocolBinding:async()=>{},
      storyboardGatewayCapabilityPromise:null,storyboardRequestHeaders:()=>({'Content-Type':'application/json'}),
      featureRuntime:{load:async()=>({...capabilities,probeQianmuImageCapabilities:async()=>{probes++;return capabilities.probeQianmuImageCapabilities({fetchImpl:async()=>new Response(JSON.stringify(body))});}})},
    });
    vm.runInContext(section('storyboardConfirmGatewayModelBinding'),context);
    const call=()=>context.storyboardConfirmGatewayModelBinding({comfyExecution:{version:1}});
    if(current)assert.equal(await call(),0);else await assert.rejects(call,{code:'comfy_execution_incompatible',submissionState:'not_submitted'});
    assert.equal(probes,1);
    await assert.rejects(()=>context.storyboardConfirmGatewayModelBinding({}),{code:'comfy_execution_missing'});assert.equal(probes,1);
  }
});
