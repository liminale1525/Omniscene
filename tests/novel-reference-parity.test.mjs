import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage } from '../qianmu-image-gateway.js';
import { getStoryboardCapabilities } from '../qianmu-storyboard.js';

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('image')]);
const reference = { data: png.toString('base64'), mime: 'image/png' };
const base = { provider:'novel', apiKey:'test-key', model:'thirdparty/NAI', capabilityModelId:'nai-diffusion-4-5-full',baseUrl:'https://relay.example',prompt:'landscape',parameters:{count:1} };
async function sent(run, override = {}) {
  let body;
  await run({...base,...override}, {resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return new Response(png,{headers:{'content-type':'image/png'}});}});
  return body;
}
for(const type of ['character','style','character&style']) {
  test(`both transports preserve precise ${type} reference fields including zero`,async()=>{
    const override={referenceImages:[{...reference,referenceType:type,strength:0,information:0,fidelity:0}]};
    const direct=await sent(generateDirectImage,override), gateway=await sent(generateImage,override);
    const keys=Object.keys(gateway.parameters).filter(key=>key.startsWith('director_reference'));
    assert.equal(keys.length,5);
    for(const key of keys) assert.deepEqual(direct.parameters[key],gateway.parameters[key]);
    assert.deepEqual(direct.parameters.director_reference_strength_values,[0]);
    assert.deepEqual(direct.parameters.director_reference_secondary_strength_values,[1]);
    assert.equal(direct.parameters.director_reference_descriptions[0].caption.base_caption,type);
    assert.equal(direct.model,'thirdparty/NAI');
  });
}
test('data URL references and metadata defaults match both paths',async()=>{
  const refs=[{...reference,data:`data:image/png;base64,${reference.data}`,type:'style',strength:.7,fidelity:.75},reference];
  const a=await sent(generateDirectImage,{references:refs}),b=await sent(generateImage,{references:refs});
  for(const key of Object.keys(b.parameters).filter(key=>key.startsWith('director_reference'))) assert.deepEqual(a.parameters[key],b.parameters[key]);
});
for(const [name,override,code] of [
  ['V3 reference',{capabilityModelId:'nai-diffusion-3',referenceImages:[reference]},'novel_precise_reference_unsupported'],
  ['V4 reference',{capabilityModelId:'nai-diffusion-4-full',referenceImages:[reference]},'novel_precise_reference_unsupported'],
  ['V5 reference',{capabilityModelId:'nai-diffusion-5-full',referenceImages:[reference]},'novel_v5_reference_unsupported'],
  ['Vibe with precise',{referenceImages:[reference],vibes:[reference]},'novel_reference_conflict'],
  ['disabled precise with images',{referenceImages:[reference],parameters:{providerOptions:{precise_reference:false}}},'novel_reference_disabled'],
  ['raw mixed options',{parameters:{providerOptions:{director_reference_images:[reference.data],reference_image_multiple:[reference.data]}}},'novel_reference_conflict'],
]) {
  test(`${name} fails before a generation request in both transports`,async()=>{
    for(const run of [generateDirectImage,generateImage]) {
      let requests=0;
      await assert.rejects(()=>run({...base,...override},{resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>{requests++;throw new Error('must not send');}}),{code});
      assert.equal(requests,0);
    }
  });
}
test('V4 no longer advertises a precise reference capability while V4.5 retains it',()=>{
  assert.equal(getStoryboardCapabilities('novel','nai-diffusion-4-full').preciseReference,false);
  assert.equal(getStoryboardCapabilities('novel','nai-diffusion-4-curated-preview').preciseReference,false);
  assert.equal(getStoryboardCapabilities('novel','nai-diffusion-4-5-full').preciseReference,true);
});
test('precise_reference control flag is local metadata, not a native model parameter',async()=>{
  for(const run of [generateDirectImage,generateImage]) {
    const body=await sent(run,{referenceImages:[reference],parameters:{providerOptions:{precise_reference:true}}});
    assert.equal(Object.hasOwn(body.parameters,'precise_reference'),false);
    assert.equal(body.parameters.director_reference_images.length,1);
  }
});
