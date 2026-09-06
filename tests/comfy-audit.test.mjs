import test from 'node:test';
import assert from 'node:assert/strict';
import { auditComfyWorkflow, normalizeComfyExecution, requireComfyExecution, inspectComfyImageExecution } from '../qianmu-comfy-audit.js';
import { collectComfyStillResults } from '../qianmu-comfy-results.js';
import { generateDirectImage, isDirectImageTransportError } from '../qianmu-image-direct.js';
import { generateImage, imageGatewayCapabilities, imageGatewayErrorPayload } from '../qianmu-image-gateway.js';
import { probeQianmuImageCapabilities, checkQianmuComfyExecutionBinding } from '../qianmu-service-capabilities.js';

const policy = extra => ({version:1,automatic:false,outputNodeIds:[],maxImages:8,allowUnverified:false,...extra});
const automatic = () => policy({automatic:true,maxImages:1});
const node = (class_type,inputs={}) => ({class_type,inputs});
const graph = (batch=1) => ({
  checkpoint:node('CheckpointLoaderSimple',{ckpt_name:'test.safetensors'}),
  positive:node('CLIPTextEncode',{text:'%qianmu_prompt%',clip:['checkpoint',1]}),
  negative:node('CLIPTextEncode',{text:'noise',clip:['checkpoint',1]}),
  latent:node('EmptyLatentImage',{width:512,height:512,batch_size:batch}),
  sampler:node('KSampler',{model:['checkpoint',0],positive:['positive',0],negative:['negative',0],latent_image:['latent',0]}),
  decode:node('VAEDecode',{samples:['sampler',0],vae:['checkpoint',2]}),
  save:node('SaveImage',{images:['decode',0]}),
});
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const image = filename => ({filename,type:'output'});
const history = outputs => ({task:{status:{completed:true,status_str:'success'},outputs}});
const input = (workflow,comfyExecution=policy()) => ({provider:'comfy',baseUrl:'https://comfy.example',model:'comfy-workflow',prompt:'garden',
  parameters:{workflow,count:1,pollIntervalMs:250,timeoutMs:15000},comfyExecution});
const inspect = (workflow,execution=policy()) => auditComfyWorkflow(workflow,execution);

test('native single still has a versioned explicit final-output and quantity contract', () => {
  const value=graph(), before=structuredClone(value), report=inspect(value,automatic());
  assert.equal(report.verified,true);assert.equal(report.selectedImages,1);assert.equal(report.savedImages,1);
  assert.equal(report.maxSamplerBatch,1);assert.equal(report.automaticSafe,true);assert.equal(report.samplingStages,1);
  assert.deepEqual(requireComfyExecution(report,automatic()).outputNodeIds,['save']);assert.deepEqual(value,before);
  assert.ok(Object.isFrozen(requireComfyExecution(report,automatic())));
});

test('contract rejects invalid or future versions, duplicate IDs and automatic overrides', () => {
  for(const extra of [{version:2},{outputNodeIds:['save','save']},{outputNodeIds:['../save']},{maxImages:9},{allowUnverified:1},
    {automatic:true,maxImages:8},{automatic:true,maxImages:1,allowUnverified:true}]) {
    assert.throws(()=>normalizeComfyExecution(policy(extra)),{code:'comfy_execution_contract',submissionState:'not_submitted'});
  }
});

test('batch before a one-image slice is accounted for even when only one file is saved', () => {
  const value=graph(4);value.slice=node('LatentFromBatch',{samples:['sampler',0],batch_index:0,length:1});value.decode.inputs.samples=['slice',0];
  const report=inspect(value);assert.equal(report.selectedImages,1);assert.equal(report.maxSamplerBatch,4);
  assert.throws(()=>requireComfyExecution(report,automatic()),{code:'comfy_automatic_unverified'});
});

test('sequential single-frame refinement is allowed, independent hidden sampling branches are not automatic', () => {
  const value=graph();value.refine=node('KSamplerAdvanced',{...value.sampler.inputs,latent_image:['sampler',0]});value.decode.inputs.samples=['refine',0];
  let report=inspect(value);assert.equal(report.samplingStages,2);assert.equal(report.singleSamplingChain,true);assert.equal(report.automaticSafe,true);
  value.branch=node('KSampler',{...value.sampler.inputs});value.branchDecode=node('VAEDecode',{samples:['branch',0],vae:['checkpoint',2]});
  value.preview=node('PreviewImage',{images:['branchDecode',0]});
  report=inspect(value);assert.equal(report.samplingStages,3);assert.equal(report.savedImages,1);assert.equal(report.singleSamplingChain,false);
  assert.throws(()=>requireComfyExecution(report,automatic()),{code:'comfy_automatic_unverified'});
});

test('repeat latent and image batches, merging and negative-index slices preserve real cardinality', () => {
  const value=graph(2);value.repeat=node('RepeatLatentBatch',{samples:['latent',0],amount:3});value.sampler.inputs.latent_image=['repeat',0];
  value.repeatImage=node('RepeatImageBatch',{image:['decode',0],amount:2});value.save.inputs.images=['repeatImage',0];
  assert.equal(inspect(value).savedImages,12);assert.equal(inspect(value).maxSamplerBatch,6);
  assert.throws(()=>requireComfyExecution(inspect(value),policy()),{code:'comfy_audit_output_limit'});
  value.slice=node('ImageFromBatch',{image:['repeatImage',0],batch_index:-2,length:9});value.save.inputs.images=['slice',0];
  assert.equal(inspect(value).savedImages,2);
  value.merge=node('ImageBatch',{image1:['slice',0],image2:['slice',0]});value.save.inputs.images=['merge',0];
  assert.equal(inspect(value).selectedImages,4);
});

test('large temporary or pre-sampling batches cannot hide behind one saved image',()=>{
  const value=graph();value.repeat=node('RepeatImageBatch',{image:['decode',0],amount:20});value.preview=node('PreviewImage',{images:['repeat',0]});
  const report=inspect(value);assert.equal(report.maxSamplerBatch,1);assert.equal(report.maxIntermediateBatch,20);assert.equal(report.savedImages,1);
  assert.throws(()=>requireComfyExecution(report,automatic()),{code:'comfy_automatic_unverified'});
  value.save.inputs.images=['preview',0];assert.throws(()=>inspect(value),{code:'comfy_audit_link'});
});

test('runtime image input remains uncertain, never assumed to be one still', () => {
  const value=graph();value.load=node('LoadImage',{image:'some-existing-file.png'});value.encode=node('VAEEncode',{pixels:['load',0],vae:['checkpoint',2]});
  value.sampler.inputs.latent_image=['encode',0];const report=inspect(value);
  assert.equal(report.verified,false);assert.equal(report.selectedImages,null);assert.equal(report.maxSamplerBatch,null);
  assert.throws(()=>requireComfyExecution(report,policy()),{code:'comfy_manual_confirmation_required'});
  assert.equal(requireComfyExecution(report,policy({allowUnverified:true})).expectedImages,null);
});

test('unknown nodes remain uncertain including disconnected custom output nodes', () => {
  const value=graph();value.custom=node('ArbitraryCustomNode',{});const report=inspect(value);
  assert.equal(report.selectedImages,1);assert.equal(report.savedImages,null);assert.equal(report.verified,false);
  assert.throws(()=>requireComfyExecution(report,automatic()),{code:'comfy_automatic_unverified'});
  assert.equal(requireComfyExecution(report,policy({allowUnverified:true})).expectedImages,1);
});

test('custom-only final output requires explicit selection and one-time manual consent', () => {
  const value={custom:node('CustomSaveImage',{text:'%qianmu_prompt%'})};
  assert.throws(()=>inspect(value),{code:'comfy_output_selection'});
  const execution=policy({outputNodeIds:['custom'],allowUnverified:true});const report=inspect(value,execution);
  assert.deepEqual(requireComfyExecution(report,execution).outputNodeIds,['custom']);assert.equal(report.selectedImages,null);
});

test('invalid graph links, types, cycles and counts never become confirmable uncertainty', () => {
  const cases=[
    value=>{value.save.inputs.images=['missing',0];}, value=>{value.save.inputs.images=['checkpoint',0];},
    value=>{value.save.inputs.images=['decode',2];},value=>{value.decode.inputs.samples=['decode',0];},
    value=>{value.latent.inputs.batch_size=0;},value=>{value.latent.inputs.batch_size=1.3;},
    value=>{value.latent.inputs.batch_size=65537;},value=>{value.save.inputs.images=['decode',0,1];},
  ];
  for(const change of cases){const value=graph();change(value);assert.throws(()=>inspect(value,policy({allowUnverified:true})),error=>error.code.startsWith('comfy_audit_'));}
  assert.throws(()=>inspect(Object.fromEntries(Array.from({length:513},(_,i)=>[String(i),node('EmptyImage',{batch_size:1})]))),{code:'comfy_audit_graph'});
});

test('dynamic batch value cannot be converted into a guessed numeric default', () => {
  const value=graph('4');const report=inspect(value);assert.equal(report.verified,false);assert.equal(report.selectedImages,null);
  assert.throws(()=>requireComfyExecution(report,automatic()),{code:'comfy_automatic_unverified'});
});

test('native SaveImage outputs are selected without altering internal work or ignoring other saves', () => {
  const value=graph();value.extra=node('SaveImage',{images:['decode',0]});const execution=policy({outputNodeIds:['save']});
  const report=inspect(value,execution);assert.equal(report.selectedImages,1);assert.equal(report.savedImages,2);
  assert.throws(()=>requireComfyExecution(report,automatic()),{code:'comfy_automatic_unverified'});
  for(const id of ['checkpoint','decode','missing'])assert.throws(()=>inspect(value,policy({outputNodeIds:[id]})),{code:'comfy_output_selection'});
  value.preview=node('PreviewImage',{images:['decode',0]});assert.throws(()=>inspect(value,policy({outputNodeIds:['preview']})),{code:'comfy_output_selection'});
});

test('prompt/count slots are bound before audit; no mutation of reusable workflow', () => {
  const value=graph('%qianmu_count%'), request=input(value);request.parameters.count=3;
  assert.equal(inspectComfyImageExecution(request).selectedImages,3);assert.equal(value.latent.inputs.batch_size,'%qianmu_count%');
});

test('collector downloads only selected nodes and still verifies all saved output limits', () => {
  const value=graph();value.extra=node('SaveImage',{images:['decode',0]});const execution=requireComfyExecution(inspect(value,policy({outputNodeIds:['save']})),policy());
  const data=history({extra:{images:[image('extra.png')]},save:{images:[image('final.png')]}});
  assert.deepEqual(collectComfyStillResults(data,'task',{workflow:value,execution}).map(row=>row.filename),['final.png']);
  data.task.outputs.extra.images=[image('final.png')];assert.equal(collectComfyStillResults(data,'task',{workflow:value,execution}).length,1);
  data.task.outputs.extra.images=Array.from({length:9},(_,i)=>image(`${i}.png`));assert.throws(()=>collectComfyStillResults(data,'task',{workflow:value,execution}),{code:'comfy_output_limit'});
});

test('collector rejects missing selected output, runtime count changes and malformed policy', () => {
  const execution=requireComfyExecution(inspect(graph()),policy()), data=history({other:{images:[image('other.png')]}});
  assert.throws(()=>collectComfyStillResults(data,'task',{execution}),{code:'comfy_missing_final_image'});
  data.task.outputs.save={images:[image('a.png'),image('b.png')]};assert.throws(()=>collectComfyStillResults(data,'task',{execution}),{code:'comfy_output_count_changed'});
  assert.throws(()=>collectComfyStillResults(data,'task',{execution:{version:1,maxImages:99,outputNodeIds:['save']}}),{code:'comfy_execution_contract'});
});

test('automatic selected output cannot conceal unexpected saved files from another runtime node',()=>{
  const execution=requireComfyExecution(inspect(graph(),automatic()),automatic());
  assert.throws(()=>collectComfyStillResults(history({save:{images:[image('final.png')]},unexpected:{images:[image('extra.png')]}}),'task',{execution}),{code:'comfy_output_count_changed'});
});

test('service capability handshake distinguishes old services from static accounting support', async () => {
  const current=imageGatewayCapabilities();assert.equal(current.comfyExecution.version,1);
  const probe=body=>probeQianmuImageCapabilities({fetchImpl:async()=>new Response(JSON.stringify(body))});
  assert.equal(checkQianmuComfyExecutionBinding(await probe(current)).ok,true);
  delete current.comfyExecution;assert.equal(checkQianmuComfyExecutionBinding(await probe(current)).ok,false);
  assert.equal(checkQianmuComfyExecutionBinding({status:'ready',comfyExecution:{version:1}}).ok,false);
});

for(const channel of ['direct','gateway']){
  const run=(request,options)=>channel==='direct'?generateDirectImage(request,{waitImpl:async()=>{},...options}):generateImage(request,{resolveHost:async()=>[{address:'8.8.8.8',family:4}],...options});
  test(`${channel}: invalid / over-limit / uncertain automatic execution performs no DNS, upload, probe or submit`,async()=>{
    const uncertain=graph();uncertain.custom=node('Unknown',{});
    const requests=[input(graph(),policy({version:2})),input(graph(9)),input(graph(4),automatic()),input(uncertain,automatic())];
    for(const request of requests){let calls=0;await assert.rejects(()=>run(request,{probeTransport:true,resolveHost:async()=>{calls++;return[{address:'8.8.8.8',family:4}];},fetchImpl:async()=>{calls++;throw Error('unexpected network');}}),error=>{
      assert.ok(error.code.startsWith('comfy_'));assert.equal(error.submissionState,'not_submitted');assert.equal(isDirectImageTransportError(error),false);
      if(channel==='gateway')assert.equal(imageGatewayErrorPayload(error).status,400);return true;
    });assert.equal(calls,0);}
  });
  test(`${channel}: final-output selection and verified count reach real adapter history/view path`,async()=>{
    const workflow=graph();workflow.extra=node('SaveImage',{images:['decode',0]});const calls=[];
    const result=await run(input(workflow,policy({outputNodeIds:['save']})),{fetchImpl:async(url,options)=>{
      const parsed=new URL(url);calls.push(parsed.pathname+parsed.search);
      if(parsed.pathname==='/prompt'){const body=JSON.parse(options.body);assert.ok(body.prompt.extra);return new Response(JSON.stringify({prompt_id:'task'}));}
      if(parsed.pathname==='/history/task')return new Response(JSON.stringify(history({extra:{images:[image('extra.png')]},save:{images:[image('final.png')]}})));
      assert.equal(parsed.pathname,'/view');assert.equal(parsed.searchParams.get('filename'),'final.png');return new Response(Buffer.from(png,'base64'),{headers:{'content-type':'image/png'}});
    }});
    assert.equal(result.images.length,1);assert.equal(calls.filter(path=>path.startsWith('/view')).length,1);assert.equal(result.upstreamId,'task');
  });
  test(`${channel}: post-submit quantity mismatch retains original task and cannot trigger fallback`,async()=>{
    let submissions=0;await assert.rejects(()=>run(input(graph(),automatic()),{fetchImpl:async url=>{
      if(new URL(url).pathname==='/prompt'){submissions++;return new Response(JSON.stringify({prompt_id:'task'}));}
      return new Response(JSON.stringify(history({save:{images:[image('a.png'),image('b.png')]}})));
    }}),error=>{assert.equal(error.upstreamId,'task',`${error.code}: ${error.message}`);assert.equal(error.submissionState,'accepted');assert.equal(isDirectImageTransportError(error),false);return true;});assert.equal(submissions,1);
  });
}
