import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as refs from '../qianmu-comfy-references.js';
import { normalizeComfyReferenceSelection, comfyReferencePath } from '../qianmu-comfy-reference-contract.js';
import { normalizeStoryboardState, normalizeStoryboardParameterProfile, sanitizeStoryboardSnapshot, createStoryboardDefaults } from '../qianmu-storyboard.js';
import { prepareComfyReadiness, inspectComfyDefinitions } from '../qianmu-comfy-readiness.js';
import { checkComfyConfiguration } from '../qianmu-comfy-preflight.js';
import { inspectComfyImageExecution, auditComfyWorkflow } from '../qianmu-comfy-audit.js';
import { comfyReferenceStillMime } from '../qianmu-comfy-results.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { renderComfyReferenceControls } from '../qianmu-comfy-workbench.js';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage, imageGatewayCapabilities } from '../qianmu-image-gateway.js';
import { probeQianmuImageCapabilities, checkQianmuComfyExecutionBinding } from '../qianmu-service-capabilities.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
const namespace = 'st-user:alice', path = '/user/images/Qianmu-References/fixture.png';
const graph = () => ({ text: {class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}}, image:{class_type:'LoadImage',inputs:{image:'%qianmu_reference%'}},save:{class_type:'SaveImage',inputs:{images:['image',0]}} });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const selection = async (workflow = graph()) => ({version:1,enabled:true,namespace,workflowHash:await refs.comfyWorkflowReferenceHash(workflow),items:[{name:'Alice',url:path,mime:'image/png',bytes:png.length,sha256:sha256(png)}]});
const execution = {version:1,automatic:true,outputNodeIds:['save'],maxImages:1,allowUnverified:false};

test('reference manifests are bounded receipts, reject external/unsafe locations and do not preserve credentials or bytes', async () => {
  const value = await selection(); value.apiKey='private'; value.items[0].data=png.toString('base64');
  const saved = normalizeComfyReferenceSelection(value); assert.equal(saved.apiKey,undefined); assert.equal(saved.items[0].data,undefined);
  for (const url of ['https://other.test/a.png','data:image/png;base64,x','/api/secret.png','//other.test/a.png','/user/images/../a.png','/user/images/%2e%2e/a.png','/user/images/%252e%252e/a.png','/user/images/a.png?k=x']) assert.throws(()=>comfyReferencePath(url));
  assert.equal(comfyReferencePath('user/images/a.png'),'/user/images/a.png');
  assert.throws(()=>normalizeComfyReferenceSelection({...value,items:Array(17).fill(value.items[0])}));
  assert.throws(()=>normalizeComfyReferenceSelection({...value,items:Array(4).fill({...value.items[0],bytes:16*1024*1024})}));
});

test('selection belongs to an account and exact graph, while harmless JSON formatting does not change its binding', async () => {
  const workflow=graph(), saved=await selection(workflow);
  assert.equal((await refs.checkComfyReferenceSelection({workflow:JSON.stringify(workflow,null,2),selection:saved,namespace})).length,1);
  await assert.rejects(refs.checkComfyReferenceSelection({workflow,selection:saved,namespace:'st-user:bob'}),/另一 ST 账户/);
  workflow.text.inputs.text += ' changed';
  await assert.rejects(refs.checkComfyReferenceSelection({workflow,selection:saved,namespace}),/工作流已变化/);
  const current=graph(); assert.deepEqual(await refs.checkComfyReferenceSelection({workflow:current,selection:{...saved,enabled:false},namespace}),[]);
});

test('explicit local upload saves one content-addressed ST file and leaves no image bytes in the profile', async () => {
  const files = [new File([png],'look.png',{type:'image/png'})], writes=[];
  const saved = await refs.saveComfyReferenceFiles(files,{workflow:graph(),namespace,save:async file=>{writes.push(file);return path;}});
  assert.equal(writes.length,1); assert.equal(writes[0].filename,`qianmu_reference_${sha256(png)}`);
  assert.equal(saved.items[0].sha256,sha256(png)); assert.equal(saved.items[0].bytes,png.length);
  assert.ok(!JSON.stringify(saved).includes(png.toString('base64')));
  await assert.rejects(refs.saveComfyReferenceFiles([new File(['<svg/>'],'wrong.png')],{workflow:graph(),namespace,save:()=>assert.fail('invalid image must not upload')}));
});

test('a stale upload cannot write files or assign a selection after its guard changes', async () => {
  const file={size:png.length,name:'a.png',arrayBuffer:async()=>{current=false;return png.buffer.slice(png.byteOffset,png.byteOffset+png.length);}}; let current=true;
  await assert.rejects(refs.saveComfyReferenceFiles([file],{workflow:graph(),namespace,guard:async()=>{if(!current)throw Error('changed');},save:()=>assert.fail('stale write')}),/changed/);
});

test('actual send reads only frozen local files, checks content digest and never sends an upstream credential', async () => {
  const saved=await selection(), calls=[];
  const images=await refs.readComfyReferenceImages({workflow:graph(),selection:saved,namespace,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(png);}});
  assert.equal(images[0].data,png.toString('base64'));assert.equal(calls[0].url,path);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.headers,undefined);
  const changed=Buffer.from(png);changed[40]^=1;
  await assert.rejects(refs.readComfyReferenceImages({workflow:graph(),selection:saved,namespace,fetchImpl:async()=>new Response(changed)}),/内容已变化/);
  await assert.rejects(refs.readComfyReferenceImages({workflow:graph(),selection:saved,namespace,fetchImpl:async()=>new Response('',{status:404})}),/不可读取/);
  await assert.rejects(refs.readComfyReferenceImages({workflow:graph(),selection:saved,namespace,fetchImpl:async()=>new Response(png,{headers:{'content-length':String(17*1024*1024)}})}),/16 MB/);
});

test('new profile snapshots retain file receipts only for Comfy and preserve malformed bindings as errors', async () => {
  const saved=await selection(), raw={comfyWorkflow:JSON.stringify(graph()),comfyReferences:saved};
  assert.equal(normalizeStoryboardParameterProfile(raw,'comfy').comfyReferences.items[0].sha256,saved.items[0].sha256);
  assert.equal(normalizeStoryboardParameterProfile(raw,'novel').comfyReferences,undefined);
  const state=normalizeStoryboardState({profiles:{comfy:raw}});assert.equal(state.profiles.comfy.comfyReferences.version,1);
  const old=sanitizeStoryboardSnapshot({source:'comfy',profile:raw}); saved.items[0].name='Changed';assert.equal(old.profile.comfyReferences.items[0].name,'Alice');
  const invalid=normalizeStoryboardParameterProfile({...raw,comfyReferences:{version:99}},'comfy');assert.equal(invalid.comfyReferences.invalid,true);
  const context=vm.createContext({createStoryboardDefaults,clone:structuredClone});vm.runInContext(storyboardFunctionSource('storyboardProfileSnapshot'),context);
  assert.equal(context.storyboardProfileSnapshot(raw,'comfy').comfyReferences.version,1);
});

test('actual asset preparation delivers frozen references and leaves NAI Vibe paths independent', async () => {
  const saved=await selection(), job={source:'comfy',profile:{comfyReferences:saved},payload:{parameters:{workflow:graph()}},imageAdmission:{namespace}};
  const context=vm.createContext({storyboardAdmissionEpoch:1,storyboardState:()=>({vibeLibrary:[]}),
    featureRuntime:{load:async name=>name==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:{...refs,readComfyReferenceImages:input=>refs.readComfyReferenceImages({...input,fetchImpl:async()=>new Response(png)})}}});
  vm.runInContext(storyboardFunctionSource('storyboardPrepareGatewayAssets'),context);
  const assets=await context.storyboardPrepareGatewayAssets(job);assert.equal(assets.references[0].data,png.toString('base64'));assert.equal(assets.vibes.length,0);
  job.imageAdmission.namespace='st-user:bob';await assert.rejects(context.storyboardPrepareGatewayAssets(job),/会话已变化/);
});

test('known single-frame reference slots participate in automatic output counts; unrelated disk inputs remain uncertain', () => {
  const input={workflow:graph(),parameters:{},model:'comfy-workflow',outputNodeId:'save',automatic:true,referenceCount:1};
  const result=checkComfyConfiguration(input);assert.equal(result.report.selectedImages,1);assert.equal(result.report.verified,true);
  const inspected=inspectComfyImageExecution({parameters:{workflow:graph()},prompt:'garden',referenceImages:[{}],comfyExecution:execution});assert.equal(inspected.selectedImages,1);
  const disk=graph();disk.image.inputs.image='unverified-local.png';const report=auditComfyWorkflow(disk,execution);assert.equal(report.verified,false);
  assert.throws(()=>checkComfyConfiguration({...input,referenceCount:0}),/参考图/);
});

test('reference-aware readiness does not upload a file or mistake a placeholder for a missing remote filename', () => {
  const prepared=prepareComfyReadiness({workflow:graph(),referenceCount:1,model:'comfy-workflow',parameters:{}});
  const definitions={CLIPTextEncode:{input:{required:{text:['STRING']}},output:['CONDITIONING']},LoadImage:{input:{required:{image:[['existing.png']]}},output:['IMAGE','MASK']},SaveImage:{input:{required:{images:['IMAGE']}},output:[],output_node:true}};
  const report=inspectComfyDefinitions(prepared.graph,definitions,prepared);
  assert.equal(report.errors,0);assert.ok(report.issues.some(row=>row.code==='reference_pending_upload'));assert.equal(report.actualGenerationVerified,false);
});

test('reference containers reject animation, fake images and multi-picture JPEG rather than declaring a single frame', () => {
  assert.equal(comfyReferenceStillMime(png),'image/png');
  const apng=Buffer.from(png);apng.write('acTL',12);assert.throws(()=>comfyReferenceStillMime(apng));
  assert.throws(()=>comfyReferenceStillMime(new Uint8Array([255,216,255,217])));
  const mpo=new Uint8Array([255,216,255,226,0,6,77,80,70,0,255,217]);assert.throws(()=>comfyReferenceStillMime(mpo));
});

test('reference controls are scoped to supported workflows, numbered and escaped, without implicit avatar selection', async () => {
  assert.equal(renderComfyReferenceControls({},{}),'');const saved=await selection();saved.items[0].name='<img src=x>';
  const html=renderComfyReferenceControls({comfyReferences:saved},{reference:true});assert.match(html,/&lt;img/);assert.match(html,/参考 1/);assert.match(html,/sd-comfy-reference-file/);
  assert.match(renderComfyReferenceControls({comfyReferences:{invalid:true}},{}),/移除全部选择/);
});

for (const [channel,run] of [['direct',generateDirectImage],['gateway',generateImage]]) {
  test(`${channel}: static reference uploads before exactly one automatic prompt and resolves the original slot`, async () => {
    const calls=[], input={provider:'comfy',baseUrl:'https://comfy.test',model:'comfy-workflow',prompt:'garden',
      referenceImages:[{data:png.toString('base64'),mime:'image/jpeg'}],parameters:{workflow:graph()},comfyExecution:execution};
    const result=await run(input,{resolveHost:async()=>[{address:'8.8.8.8',family:4}],waitImpl:async()=>{},fetchImpl:async(url,init={})=>{
      const pathname=new URL(url).pathname;calls.push({pathname,method:init.method||'GET'});
      if(pathname==='/upload/image'){assert.equal(init.body.get('image').type,'image/png');return new Response(JSON.stringify({name:'uploaded.png',subfolder:'references',type:'input'}));}
      if(pathname==='/prompt'){const body=JSON.parse(init.body);assert.equal(body.prompt.image.inputs.image,'references/uploaded.png');return new Response(JSON.stringify({prompt_id:'reference-task'}));}
      if(pathname==='/history/reference-task')return new Response(JSON.stringify({'reference-task':{status:{completed:true,status_str:'success'},outputs:{save:{images:[{filename:'result.png',subfolder:'',type:'output'}]}}}}));
      if(pathname==='/view')return new Response(png,{headers:{'content-type':'image/png'}});
      assert.fail(`unexpected ${pathname}`);
    }});
    assert.equal(result.images.length,1);assert.equal(calls.filter(call=>call.pathname==='/prompt').length,1);assert.equal(calls[0].pathname,'/upload/image');
    assert.equal(input.parameters.workflow.image.inputs.image,'%qianmu_reference%');
  });
  test(`${channel}: animated references cannot use the single-frame contract or reach an upstream upload`, async () => {
    const animated=Buffer.from(png);animated.write('acTL',12);let requests=0;
    await assert.rejects(run({provider:'comfy',baseUrl:'https://comfy.test',model:'comfy-workflow',prompt:'garden',referenceImages:[{data:animated.toString('base64'),mime:'image/png'}],parameters:{workflow:graph()},comfyExecution:execution},
      {resolveHost:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async()=>{requests++;assert.fail('invalid reference submitted');}}));
    assert.equal(requests,0);
  });
}

test('reference tasks require the new server evidence contract, without raising requirements for old text-only workflows', async () => {
  const body=imageGatewayCapabilities(), probe=value=>probeQianmuImageCapabilities({fetchImpl:async()=>new Response(JSON.stringify(value))});
  assert.equal(checkQianmuComfyExecutionBinding(await probe(body),{references:true}).ok,true);
  delete body.comfyExecution.staticReferencesVersion;const previous=await probe(body);
  assert.equal(checkQianmuComfyExecutionBinding(previous,{references:true}).ok,false);
  assert.equal(checkQianmuComfyExecutionBinding(previous).ok,true);
});
