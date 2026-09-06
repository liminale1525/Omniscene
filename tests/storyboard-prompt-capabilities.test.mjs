import test from 'node:test';
import assert from 'node:assert/strict';
import { getStoryboardCapabilities, STORYBOARD_PROVIDER_REGISTRY, compileStoryboardPrompt, buildStoryboardProviderPlan } from '../qianmu-storyboard.js';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage } from '../qianmu-image-gateway.js';

const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]).toString('base64');
const shot = {id:'scene',scene:'moonlit garden',promptAtoms:{negative:['watermark']},characters:[
  {id:'a',name:'Alice',identity:['red hair'],action:['reading'],spatial:{center:[.2,.5]}},
  {id:'b',name:'Bob',identity:['blue hair'],action:['waiting'],spatial:{center:[.8,.5]}},
]};
test('capabilities distinguish native negatives, text exclusions and NAI-only syntax',()=>{
  const nai=getStoryboardCapabilities('novel','nai-diffusion-4-5-full');
  assert.equal(nai.supportsNativeNegative,true);assert.equal(nai.supportsExclusionText,false);
  assert.equal(nai.supportsArtistSyntax,true);assert.equal(nai.supportsVibe,true);
  assert.equal(nai.referenceMode,'precise');assert.deepEqual(nai.referenceExclusions,['vibe']);
  for(const family of ['banana','openai','seedream']) {
    const c=getStoryboardCapabilities(family);
    assert.equal(c.supportsNativeNegative,false);assert.equal(c.supportsExclusionText,true);
    assert.equal(c.supportsArtistSyntax,false);assert.equal(c.supportsVibe,false);assert.equal(c.referenceMode,'image');
  }
  const v5=getStoryboardCapabilities('novel','nai-diffusion-5-full');
  assert.equal(v5.supportsVibe,false);assert.equal(v5.referenceMode,'none');
  assert.equal(getStoryboardCapabilities('comfy').referenceMode,'workflow');
});
test('effective registry capability objects are reused and immutable without alias caches',()=>{
  const c=getStoryboardCapabilities('novel','nai-diffusion-3');
  assert.equal(getStoryboardCapabilities('novel','nai-diffusion-3'),c);
  assert.ok(Object.isFrozen(c));assert.ok(Object.isFrozen(c.referenceExclusions));
  assert.equal(getStoryboardCapabilities('openai','vendor/a'),getStoryboardCapabilities('openai','vendor/b'));
});
test('GPT Image is only a family label change; compatible connections retain their identity',()=>{
  const p=STORYBOARD_PROVIDER_REGISTRY.openai;
  assert.equal(p.label,'GPT Image');assert.equal(p.id,'openai');assert.equal(p.protocol,'openai-images');assert.equal(p.customModelId,true);
});
for(const provider of ['banana','openai','seedream']) {
  test(`${provider} compiler ignores NAI artist layers while retaining its own description/exclusions`,()=>{
    const before=structuredClone(shot),model=STORYBOARD_PROVIDER_REGISTRY[provider].defaultModel;
    const result=compileStoryboardPrompt({providerId:provider,modelId:model,shot,artistString:'artist: should-not-send',artistPositive:'NAI-only-positive',artistNegative:'NAI-only-negative',modelPositive:'soft light',modelNegative:'blur'});
    assert.doesNotMatch(result.prompt,/should-not-send|NAI-only/);assert.doesNotMatch(result.negative,/NAI-only/);
    assert.match(result.prompt,/soft light/);assert.match(result.prompt,/Alice.*red hair.*Bob.*blue hair/);
    assert.match(result.negative,/blur.*watermark.*mixed identities/);assert.doesNotMatch(result.negative,/distinct character traits|correct character actions|no mixed/);
    assert.deepEqual(shot,before);
  });
  test(`${provider} exclusions reach both real adapters once as text, not as a negative parameter`,async()=>{
    const model=STORYBOARD_PROVIDER_REGISTRY[provider].defaultModel;
    const compiled=compileStoryboardPrompt({providerId:provider,remoteModelId:'vendor/raw-model',capabilityModelId:model,shot,modelNegative:'blur'});
    const plan=buildStoryboardProviderPlan({providerId:provider,remoteModelId:'vendor/raw-model',capabilityModelId:model,connection:{baseUrl:'https://relay.example'},prompt:compiled.prompt,negative:compiled.negative});
    assert.equal(plan.droppedParameters.includes('negative'),false);
    for(const run of [generateDirectImage,generateImage]) {
      let body;
      await run({...plan.gatewayRequest,apiKey:'offline-test-key'},{resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async(_url,init)=>{
        body=JSON.parse(init.body);
        return Response.json(provider==='banana'?{candidates:[{content:{parts:[{inlineData:{data:png,mimeType:'image/png'}}]}}]}:{data:[{b64_json:png}]});
      }});
      const sentText=body.prompt || body.contents?.[0]?.parts?.[0]?.text;
      assert.equal(sentText,compiled.prompt+'\n\nExclude from the image: '+compiled.negative);
      assert.equal(Object.hasOwn(body,'negative_prompt'),false);assert.equal(Object.hasOwn(body,'negativePrompt'),false);
      assert.equal(Object.hasOwn(body,'v4_negative_prompt'),false);
    }
  });
}
test('NAI still receives artist/quality before the scene and a separate native negative caption',async()=>{
  const compiled=compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-4-5-full',shot,artistString:'artist: chosen',artistPositive:'quality',artistNegative:'noise'});
  assert.match(compiled.prompt,/^artist: chosen, quality/);assert.match(compiled.negative,/^noise, watermark/);
  const plan=buildStoryboardProviderPlan({providerId:'novel',model:'nai-diffusion-4-5-full',connection:{baseUrl:'https://relay.example'},prompt:compiled.prompt,negative:compiled.negative,params:{providerOptions:compiled.providerOptions}});
  for(const run of [generateDirectImage,generateImage]) {
    let body;
    await run({...plan.gatewayRequest,apiKey:'offline-test-key'},{resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return new Response(Buffer.from(png,'base64'),{headers:{'content-type':'image/png'}});}});
    assert.equal(body.parameters.negative_prompt,compiled.negative);
    assert.equal(body.parameters.v4_negative_prompt.caption.base_caption,compiled.negative);
    assert.doesNotMatch(body.input,/Exclude from the image/);
  }
});
