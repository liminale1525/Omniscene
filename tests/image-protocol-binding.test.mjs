import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_NATIVE_PROTOCOLS, resolveImageProtocolBinding } from '../qianmu-image-models.js';
import { buildStoryboardProviderPlan, resolveStoryboardModelBinding, STORYBOARD_PROVIDER_REGISTRY } from '../qianmu-storyboard.js';
import { generateDirectImage, checkDirectImageConnection, listDirectImageModels, isDirectImageTransportError } from '../qianmu-image-direct.js';
import { generateImage, sanitizeImageRequest, checkImageConnection, listImageModels, imageGatewayErrorPayload } from '../qianmu-image-gateway.js';

const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
const request = (provider, extra = {}) => ({ provider, baseUrl:'https://relay.example', apiKey:'offline-test-key', prompt:'garden', model:STORYBOARD_PROVIDER_REGISTRY[provider].defaultModel, ...extra });
const endpoints = { generateDirectImage, checkDirectImageConnection, listDirectImageModels, generateImage, checkImageConnection, listImageModels };

test('native protocol binding has one canonical result and preserves legacy omitted declarations', () => {
  assert.ok(Object.isFrozen(IMAGE_NATIVE_PROTOCOLS));
  for (const [family, protocol] of Object.entries(IMAGE_NATIVE_PROTOCOLS)) {
    assert.equal(STORYBOARD_PROVIDER_REGISTRY[family].protocol, protocol);
    for (const input of [{}, {protocol:''}, {modelFamily:family, protocol}]) {
      const result = resolveImageProtocolBinding(family, input);
      assert.deepEqual(result, {modelFamily:family, protocol});
      assert.ok(Object.isFrozen(result));
    }
  }
  assert.equal(resolveImageProtocolBinding('banana', {protocol:'gemini'}).protocol, 'gemini-images');
  assert.equal(resolveImageProtocolBinding('comfy', {protocol:'comfyui'}).protocol, 'comfy-workflow');
});

test('invalid declarations reject without reflecting arbitrary input or guessing by URL', () => {
  for (const family of ['constructor','__proto__','toString','unknown',null,123]) {
    assert.throws(() => resolveImageProtocolBinding(family), {code:'invalid_model_family'});
  }
  for (const protocol of [null,false,0,{},[],' ','openai-images\n','x'.repeat(41),'https://key-should-not-appear.example']) {
    assert.throws(() => resolveImageProtocolBinding('openai',{protocol}), error => error.code === 'model_protocol_mismatch' && !error.message.includes('key-should-not-appear'));
  }
  const result = resolveImageProtocolBinding('banana', {baseUrl:'https://api.openai.com/v1', model:'gpt-image-2'});
  assert.equal(result.protocol,'gemini-images');
});

test('plans carry canonical declarations; conflicting top-level or connection declarations cannot be erased', () => {
  for (const [family, protocol] of Object.entries(IMAGE_NATIVE_PROTOCOLS)) {
    const plan = buildStoryboardProviderPlan({providerId:family, prompt:'garden', protocol, connection:{modelFamily:family, protocol}});
    assert.equal(plan.gatewayRequest.modelFamily, family);
    assert.equal(plan.gatewayRequest.protocol, protocol);
    const wrong = protocol === 'openai-images' ? 'novelai' : 'openai-images';
    assert.throws(() => buildStoryboardProviderPlan({providerId:family, prompt:'garden', protocol:wrong}), {code:'model_protocol_mismatch'});
    assert.throws(() => buildStoryboardProviderPlan({providerId:family, prompt:'garden', connection:{protocol:wrong}}), {code:'model_protocol_mismatch'});
  }
  assert.equal(resolveStoryboardModelBinding('banana',{protocol:'gemini'}).protocol,'gemini-images');
});

for (const [name, run] of Object.entries(endpoints)) {
  test(`${name} rejects protocol/family conflicts before DNS, requests, static-list shortcuts or configured-only returns`, async () => {
    let network = 0;
    const options = {resolveHost:async()=>{network++; throw new Error('DNS must not run');},fetchImpl:async()=>{network++; throw new Error('fetch must not run');}};
    for (const [family, protocol] of Object.entries(IMAGE_NATIVE_PROTOCOLS)) {
      const wrong = protocol === 'openai-images' ? 'gemini-images' : 'openai-images';
      const input = request(family, {baseUrl:family === 'novel' ? 'https://image.novelai.net' : 'https://relay.example', compatibility:{modelDiscovery:'off'}});
      for (const extra of [{protocol:wrong}, {protocol:'unexpected'}, {protocol:null}, {modelFamily:family === 'novel' ? 'openai' : 'novel'}]) {
        const expected = Object.hasOwn(extra,'modelFamily') ? 'model_family_mismatch' : 'model_protocol_mismatch';
        await assert.rejects(run({...input,...extra},options), error => {
          assert.equal(error.code,expected);
          if (name.includes('Direct')) assert.equal(isDirectImageTransportError(error),false);
          return true;
        });
      }
    }
    assert.equal(network,0);
  });
}

test('gateway conflict errors retain a safe concise error code and no credentials', () => {
  let error;
  try { sanitizeImageRequest(request('openai',{protocol:'gemini-images'})); } catch (caught) { error=caught; }
  assert.equal(error.status,400);
  const payload=imageGatewayErrorPayload(error);
  assert.equal(payload.body.code,'model_protocol_mismatch');
  assert.doesNotMatch(JSON.stringify(payload),/offline-test-key|relay\.example/);
});

test('invalid gateway providers keep their existing public error code and cannot use prototype entries', async () => {
  let network=0;
  const options={resolveHost:async()=>{network++;},fetchImpl:async()=>{network++;}};
  for (const provider of ['missing','__proto__','constructor']) {
    for (const run of [generateImage,checkImageConnection,listImageModels]) {
      await assert.rejects(run({provider},options),{code:'unsupported_provider'});
    }
  }
  assert.equal(network,0);
});

test('Comfy native workflow declaration validates without modifying workflow or opening network permissions', () => {
  const input=request('comfy',{parameters:{workflow:{'1':{inputs:{text:'%qianmu_prompt%'}}}}});
  const original=sanitizeImageRequest(input);
  for (const protocol of ['comfy-workflow','comfyui']) {
    const result=sanitizeImageRequest({...input,protocol,modelFamily:'comfy'});
    assert.deepEqual(result,original);
    assert.equal(result.allowPrivateNetwork,false);
  }
});

for (const family of ['novel','openai','banana','seedream']) {
  test(`${family} native marked and legacy requests send identical upstream bodies without metadata`, async () => {
    const input=request(family), protocol=IMAGE_NATIVE_PROTOCOLS[family];
    for (const run of [generateDirectImage,generateImage]) {
      const bodies=[];
      const options={resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async(_url,init)=>{
        bodies.push(JSON.parse(init.body));
        if(family==='novel') return new Response(png,{headers:{'content-type':'image/png'}});
        return Response.json(family==='banana'?{candidates:[{content:{parts:[{inlineData:{data:png.toString('base64'),mimeType:'image/png'}}]}}]}:{data:[{b64_json:png.toString('base64')}]});
      }};
      const parameters=family==='novel'?{seed:42}:{};
      await run({...input,parameters},options);
      await run({...input,parameters,protocol,modelFamily:family},options);
      assert.deepEqual(bodies[0],bodies[1]);
      for(const body of bodies) for(const field of ['modelFamily','protocol','capabilityModelId','connectionPresetId']) assert.equal(Object.hasOwn(body,field),false);
    }
  });
}
