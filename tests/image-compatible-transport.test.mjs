import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMAGE_PROTOCOL_BINDING_VERSION, IMAGE_NATIVE_PROTOCOLS, resolveImageProtocolBinding } from '../qianmu-image-models.js';
import { prepareImageTransportRequest } from '../qianmu-image-transport.js';
import { generateDirectImage, checkDirectImageConnection, listDirectImageModels, isDirectImageTransportError } from '../qianmu-image-direct.js';
import { generateImage, sanitizeImageRequest, checkImageConnection, listImageModels, imageGatewayCapabilities } from '../qianmu-image-gateway.js';
import { probeQianmuImageCapabilities, checkQianmuImageProtocolBinding, checkQianmuImageModelBinding } from '../qianmu-service-capabilities.js';
import { buildStoryboardProviderPlan, resolveStoryboardModelBinding } from '../qianmu-storyboard.js';

const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
const reference = () => ({ data:png.toString('base64'), mime:'image/png', name:'offline.png' });
const request = (provider='banana', extra={}) => ({provider, modelFamily:provider, protocol:'openai-images', imageProtocolVersion:1,
  baseUrl:'https://relay.example/v1', apiKey:'test-only', model:'models/relay-vendor/exact.image.name', prompt:'a quiet garden', negativePrompt:'text and watermark',
  parameters:{count:2,size:'1536x1024',quality:'high'}, ...extra});
const resolveHost = async () => [{address:'93.184.216.34',family:4}];
const response = () => Response.json({id:'offline-image',data:[{b64_json:png.toString('base64')}]});
const generation = {direct:generateDirectImage,gateway:generateImage};
const checks = {direct:checkDirectImageConnection,gateway:checkImageConnection};
const catalogs = {direct:listDirectImageModels,gateway:listImageModels};

test('cross-family support is explicit, versioned and still blocked by unfinished front-end plan/snapshot callers', () => {
  for (const provider of ['banana','seedream']) {
    const input=request(provider);
    assert.deepEqual(resolveImageProtocolBinding(provider,input,{allowCompatible:true}),{modelFamily:provider,protocol:'openai-images'});
    assert.throws(()=>resolveImageProtocolBinding(provider,input),{code:'model_protocol_mismatch'});
    assert.throws(()=>resolveStoryboardModelBinding(provider,input),{code:'model_protocol_mismatch'});
    assert.throws(()=>buildStoryboardProviderPlan({providerId:provider,prompt:'garden',connection:input}),{code:'model_protocol_mismatch'});
  }
  for (const provider of ['novel','comfy']) assert.throws(()=>resolveImageProtocolBinding(provider,request(provider),{allowCompatible:true}),{code:'model_protocol_mismatch'});
});

test('native inputs are returned unchanged without guessing endpoints or family from a remote ID', () => {
  for (const [provider,protocol] of Object.entries(IMAGE_NATIVE_PROTOCOLS)) {
    const input={provider,model:'models/remote-alias',baseUrl:'https://relay.example',parameters:{seed:0,arbitrary:123}};
    assert.equal(prepareImageTransportRequest(input),input);
    assert.equal(prepareImageTransportRequest({...input,protocol}).protocol,protocol);
  }
});

for (const [name,run] of Object.entries({...Object.fromEntries(Object.entries(generation).map(([key,value])=>[`generate ${key}`,value])),
  ...Object.fromEntries(Object.entries(checks).map(([key,value])=>[`check ${key}`,value])),
  ...Object.fromEntries(Object.entries(catalogs).map(([key,value])=>[`catalog ${key}`,value]))})) {
  test(`${name}: invalid declarations reject before network, DNS or discovery-off shortcut`, async () => {
    let calls=0;
    const options={resolveHost:async()=>{calls++;return resolveHost();},fetchImpl:async()=>{calls++;return response();}};
    for (const extra of [{imageProtocolVersion:undefined},{imageProtocolVersion:'1'},{imageProtocolVersion:2},{imageProtocolVersion:null},
      {modelFamily:'novel'},{protocol:'gemini-images',modelFamily:'seedream'},{protocol:'comfy-workflow'}]) {
      await assert.rejects(run(request('banana',{...extra,compatibility:{modelDiscovery:'off'}}),options),error=>{
        assert.ok(['model_protocol_mismatch','model_family_mismatch'].includes(error.code));
        assert.equal(isDirectImageTransportError(error),false);
        assert.doesNotMatch(error.message,/test-only|relay\.example/);
        return true;
      });
    }
    assert.equal(calls,0);
  });
}

for (const family of ['banana','seedream']) {
  test(`${family}: actual OpenAI JSON path/auth/options/opaque model are equivalent across transports`, async () => {
    const sent=[];
    for (const run of Object.values(generation)) {
      const input=request(family,{compatibility:{endpoints:{generation:'custom/generate'},customHeaderNames:['X-Route'],providerOptionKeys:['input_fidelity','imageProtocolVersion']},
        customHeaders:{'X-Route':'image-route',Authorization:'must-not-overwrite'},
        parameters:{width:1536,height:1024,count:2,quality:'high',background:'opaque',outputFormat:'PNG',providerOptions:{input_fidelity:'high',imageProtocolVersion:'must-not-leak'}}});
      const result=await run(input,{resolveHost,fetchImpl:async(url,init)=>{sent.push({url:String(url),headers:init.headers,body:JSON.parse(init.body)});return response();}});
      assert.equal(result.ok,true);
      if (result.provider) assert.equal(result.provider,family);
    }
    assert.deepEqual(sent[0],sent[1]);
    assert.equal(sent[0].url,'https://relay.example/v1/custom/generate');
    assert.deepEqual(sent[0].headers,{'Content-Type':'application/json',Authorization:'Bearer test-only','X-Route':'image-route'});
    assert.deepEqual(sent[0].body,{input_fidelity:'high',model:'models/relay-vendor/exact.image.name',prompt:'a quiet garden\n\nExclude from the image: text and watermark',
      n:2,size:'1536x1024',quality:'high',background:'opaque',output_format:'png'});
  });

  test(`${family}: multiple references really use multipart edit; no single-image truncation or protocol metadata`, async () => {
    const sent=[];
    for (const run of Object.values(generation)) {
      await run(request(family,{referenceImages:[reference(),{...reference(),name:'second.png'}],
        compatibility:{endpoints:{edit:'custom/edit'},referenceField:'image[]'}}),{resolveHost,fetchImpl:async(url,init)=>{
        const fields=[];
        for (const [key,value] of init.body.entries()) fields.push([key,typeof value==='string'?value:{name:value.name,type:value.type,data:Buffer.from(await value.arrayBuffer()).toString('base64')}]);
        sent.push({url:String(url),headers:init.headers,fields});return response();
      }});
    }
    assert.deepEqual(sent[0],sent[1]);
    assert.equal(sent[0].url,'https://relay.example/v1/custom/edit');
    assert.equal(sent[0].headers['Content-Type'],undefined);
    assert.equal(sent[0].fields.filter(([name])=>name==='image[]').length,2);
    assert.doesNotMatch(JSON.stringify(sent),/imageProtocolVersion|modelFamily|capabilityModelId|negative_prompt/);
  });

  test(`${family}: model catalogs use protocol-specific headers/path and keep name prefixes`, async () => {
    for (const run of Object.values(catalogs)) {
      const sent=[];
      const result=await run(request(family,{compatibility:{endpoints:{models:'custom/catalog'},customHeaderNames:['X-Route']},customHeaders:{'X-Route':'catalog'}}),
        {resolveHost,fetchImpl:async(url,init)=>{sent.push({url:String(url),headers:init.headers});return Response.json({models:[{name:'models/vendor/private-model'},{id:'models/explicit-name'}],nextPageToken:'gemini-token-must-not-trigger-retry'});}});
      assert.equal(sent.length,1);
      assert.equal(sent[0].url,'https://relay.example/v1/custom/catalog');
      assert.deepEqual(sent[0].headers,{Authorization:'Bearer test-only','X-Route':'catalog'});
      assert.equal(result.provider,family);
      assert.deepEqual(result.models.map(x=>x.id).sort(),['models/explicit-name','models/vendor/private-model']);
    }
  });

  test(`${family}: connection checks use models endpoint and distinguish optional/off/required/auth errors`, async () => {
    for (const run of Object.values(checks)) {
      let calls=0;
      const options={resolveHost,fetchImpl:async(url,init)=>{
        calls++;assert.equal(String(url),'https://relay.example/v1/custom/catalog');
        assert.deepEqual(init.headers,{Authorization:'Bearer test-only'});return new Response('',{status:404});
      }};
      const input=request(family,{compatibility:{endpoints:{models:'custom/catalog'}}});
      assert.equal((await run(input,options)).message,'地址可达，请以生图验证');
      assert.equal(calls,1);
      await assert.rejects(run({...input,compatibility:{...input.compatibility,modelDiscovery:'required'}},options));
      assert.equal(calls,2);
      assert.equal((await run({...input,compatibility:{modelDiscovery:'off'}},options)).verified,false);
      assert.equal(calls,2);
      await assert.rejects(run(input,{resolveHost,fetchImpl:async()=>new Response('',{status:401})}));
    }
  });
}

test('unsupported fields, incomplete/conflicting dimensions and unbound options fail before first paid request', async () => {
  const invalid=[{aspectRatio:'16:9'},{imageSize:'2K'},{seed:0},{guidanceScale:0},{watermark:false},{sequential:false},
    {width:1024},{width:12,height:1024},{width:1024,height:1024,size:'2K'},{count:0},{count:5},{count:1.5},
    {quality:{}},{providerOptions:{unlisted:1}},{providerOptions:{input_fidelity:{nested:true}}},{providerOptions:{input_fidelity:Infinity}}];
  let calls=0;
  for (const run of Object.values(generation)) for (const parameters of invalid) {
    await assert.rejects(run(request('banana',{parameters}),{resolveHost:async()=>{calls++;return resolveHost();},fetchImpl:async()=>{calls++;return response();}}),error=>{
      assert.equal(error.code,'image_protocol_parameters');assert.equal(isDirectImageTransportError(error),false);return true;
    });
  }
  assert.equal(calls,0);
});

test('projection rejects disabled standard fields instead of silently ignoring controls', () => {
  for (const parameters of [{count:2},{size:'2K'},{quality:'high'},{background:'auto'},{outputFormat:'png'}]) {
    assert.throws(()=>prepareImageTransportRequest(request('seedream',{parameters,compatibility:{allowedParameters:[]}})),{code:'image_protocol_parameters'});
  }
  assert.equal(prepareImageTransportRequest(request('seedream',{parameters:{count:1},compatibility:{allowedParameters:[]}})).parameters.count,1);
  assert.equal(prepareImageTransportRequest(request('seedream',{parameters:{size:'2K'}})).parameters.size,'2K');
});

test('unknown generation/config options cannot overwrite reserved wire or metadata fields', () => {
  for (const name of ['n','size','model','prompt','url','headers','negative_prompt','constructor','baseurl']) {
    assert.throws(()=>prepareImageTransportRequest(request('seedream',{parameters:{providerOptions:{[name]:'overwrite'}},compatibility:{providerOptionKeys:[name]}})),{code:'image_protocol_parameters'});
  }
  const result=prepareImageTransportRequest(request('seedream',{parameters:{providerOptions:{image_protocol_version:99,protocol:'novelai'}}}));
  assert.deepEqual(result.parameters.providerOptions,{});
});

test('references enforce count, bytes, MIME, predecode all inputs and reject unsupported media before DNS/POST', async () => {
  const invalid=[{referenceImages:[reference(),reference()],compatibility:{referenceField:'image'}},
    {referenceImages:Array.from({length:17},reference)},{referenceImages:[{}]},
    {referenceImages:[reference(),{...reference(),data:'!!!!'}]},{referenceImages:[{...reference(),mime:'image/jpeg'}]},
    {referenceImages:[{...reference(),data:Buffer.from('not image').toString('base64')}]},
    {vibes:[reference()]},{mask:reference()},{maskImage:reference()},{parameters:'invalid'}, {modelBindingVersion:1}];
  let calls=0;
  for (const run of Object.values(generation)) for (const extra of invalid) await assert.rejects(run(request('banana',extra),{
    resolveHost:async()=>{calls++;return resolveHost();},fetchImpl:async()=>{calls++;return response();},
  }),error=>{assert.match(error.code,/^image_protocol_/);assert.equal(isDirectImageTransportError(error),false);return true;});
  assert.equal(calls,0);
  const result=prepareImageTransportRequest(request('banana',{referenceImages:[{data:`data:image/png;base64,${reference().data}`}]}));
  assert.equal(result.referenceImages[0].data,reference().data);
});

test('mapping does not truncate prompts or interpret model names; max combined prompt is shared', () => {
  assert.throws(()=>prepareImageTransportRequest(request('banana',{prompt:'a'.repeat(32000),negativePrompt:'no text'})),{code:'image_protocol_parameters'});
  assert.throws(()=>prepareImageTransportRequest(request('banana',{model:'alias\nsecret'})),{code:'missing_model'});
  const input=request('seedream',{parameters:{width:1024,height:1536,providerOptions:{input_fidelity:'high'}},referenceImages:[reference()]});
  const clone=structuredClone(input),result=prepareImageTransportRequest(input);
  assert.deepEqual(input,clone);
  input.parameters.providerOptions.input_fidelity='low';input.referenceImages[0].data='changed';
  assert.equal(result.parameters.providerOptions.input_fidelity,'high');
  assert.equal(result.referenceImages[0].data,reference().data);
});

test('gateway wire state is frozen before DNS; original family survives the compatible transport', async () => {
  const input=request('banana'),state=sanitizeImageRequest(input);
  assert.equal(state.provider,'banana');assert.equal(state.protocol,'openai-images');assert.equal(state.imageProtocolVersion,1);
  await generateImage(input,{resolveHost:async()=>{input.model='changed';input.prompt='changed';input.parameters.size='changed';return resolveHost();},fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body);assert.equal(body.model,'models/relay-vendor/exact.image.name');assert.equal(body.size,'1536x1024');assert.ok(body.prompt.startsWith('a quiet garden'));return response();
  }});
});

test('gateway support is a separate explicit handshake; old NAI binding remains usable but does not authorize cross protocols', async () => {
  const identity={modelFamily:'banana',protocol:'openai-images',imageProtocolVersion:IMAGE_PROTOCOL_BINDING_VERSION};
  const body=imageGatewayCapabilities('offline-version');
  const probe=async(value)=>probeQianmuImageCapabilities({fetchImpl:async(url,init)=>{
    assert.equal(url,'/api/plugins/qianmu-tts/image/capabilities');assert.equal(init.method,'GET');assert.equal(init.cache,'no-store');
    assert.equal(init.headers.Authorization,undefined);return Response.json(value);
  }});
  const ready=await probe(body);
  assert.equal(checkQianmuImageProtocolBinding(ready,identity).ok,true);
  const old={...body};delete old.protocolBinding;
  const oldResult=await probe(old);
  assert.equal(oldResult.status,'ready');
  assert.equal(checkQianmuImageProtocolBinding(oldResult,identity).ok,false);
  assert.equal(checkQianmuImageModelBinding(oldResult,{modelFamily:'novel',protocol:'novelai',capabilityModelId:'nai-diffusion-4-5-full'}).ok,true);
  for (const protocolBinding of [{version:2,providers:body.protocolBinding.providers},{version:1,providers:{banana:['gemini-images']}},{}]) {
    assert.equal(checkQianmuImageProtocolBinding(await probe({...body,protocolBinding}),identity).ok,false);
  }
  for (const status of ['missing','unauthorized','timeout','error','incompatible']) assert.equal(checkQianmuImageProtocolBinding({status},identity).ok,false);
  assert.equal(checkQianmuImageProtocolBinding(ready,{...identity,imageProtocolVersion:undefined}).ok,false);
});

test('cross-protocol dependency is in the release allowlist, not a hidden server-only file', () => {
  const release=JSON.parse(readFileSync(new URL('../release-files.json',import.meta.url)));
  assert.ok(release.files.includes('qianmu-image-transport.js'));
});

test('compatible requests require their own explicit address, never default to native hosts or carry embedded credentials', async () => {
  let calls=0;
  for (const run of [...Object.values(generation),...Object.values(checks),...Object.values(catalogs)]) {
    for (const baseUrl of ['',undefined,'not-a-url','file:///test','https://user:secret@relay.example','https://relay.example?key=secret','https://relay.example#secret']) {
      await assert.rejects(run(request('banana',{baseUrl}),{resolveHost:async()=>{calls++;return resolveHost();},fetchImpl:async()=>{calls++;return response();}}),error=>{
        assert.equal(error.code,'invalid_base_url');assert.equal(isDirectImageTransportError(error),false);assert.doesNotMatch(error.message,/secret/);return true;
      });
    }
  }
  assert.equal(calls,0);
});

test('reference byte budgets and advanced parameter byte budgets are checked before transport', () => {
  const large=Buffer.concat([png,Buffer.alloc(16*1024*1024)]).toString('base64');
  assert.throws(()=>prepareImageTransportRequest(request('banana',{referenceImages:[{...reference(),data:large}]})),{code:'image_protocol_references'});
  assert.throws(()=>prepareImageTransportRequest(request('banana',{parameters:{providerOptions:{input_fidelity:'词'.repeat(23000)}}})),{code:'image_protocol_parameters'});
});
