import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage } from '../qianmu-image-gateway.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return tail.slice(0, next + 1);
}
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('image')]);
function environment(items, read = async () => ({ data: png.toString('base64'), mime: 'image/png' })) {
  const state = { vibeLibrary: items };
  const ctx = vm.createContext({ storyboardState: () => state, storyboardSafeUrl: value => /^https:\/\//.test(value) ? value : '', storyboardReadImageReference: read });
  vm.runInContext(section('storyboardVibeAmount') + section('storyboardPrepareGatewayAssets'), ctx);
  return { state, prepare: () => ctx.storyboardPrepareGatewayAssets({ payload: { selectedVibeIds: items.map(item => item.id) } }) };
}
for (const [value, strength, information] of [[0,0,0],['0',0,0],['',.6,1],[undefined,.6,1],[Infinity,.6,1]]) {
  test(`Vibe preparation preserves zero and defaults missing values (${String(value)} ${typeof value})`, async () => {
    const { prepare } = environment([{ id:'v', previewUrl:'https://image.example/a.png', strength:value, informationExtracted:value }]);
    const result = await prepare();
    assert.equal(result.vibes[0].strength,strength); assert.equal(result.vibes[0].information,information);
  });
}
test('Vibe source/amounts are captured before any asynchronous image read', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const rows = [{id:'a',previewUrl:'https://image.example/a.png',strength:0,informationExtracted:0},
    {id:'b',previewUrl:'https://image.example/b.png',strength:.2,informationExtracted:.3}];
  const urls = [];
  const { prepare, state } = environment(rows, async url => { urls.push(url); if(urls.length===1) await gate; return {data:'image'}; });
  const work=prepare();
  rows[0].strength=.9; rows[1].previewUrl='https://other.example/replaced.png';rows[1].informationExtracted=1;
  state.vibeLibrary=[]; finish();
  const assets=await work;
  assert.deepEqual(urls,['https://image.example/a.png','https://image.example/b.png']);
  assert.equal(assets.vibes[0].strength,0);assert.equal(assets.vibes[1].information,.3);
});
test('actual prepared zero values reach both NAI transports unchanged', async () => {
  const { prepare } = environment([{id:'zero',previewUrl:'https://image.example/a.png',strength:0,informationExtracted:0}]);
  const assets=await prepare();
  const input={provider:'novel',model:'vendor/NAI',capabilityModelId:'nai-diffusion-3',apiKey:'test-key',baseUrl:'https://relay.example',prompt:'landscape',vibes:assets.vibes,parameters:{count:1}};
  for (const run of [generateDirectImage,generateImage]) {
    let body;
    await run(input,{resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return new Response(png,{headers:{'content-type':'image/png'}});}});
    assert.deepEqual(body.parameters.reference_strength_multiple,[0]);
    assert.deepEqual(body.parameters.reference_information_extracted_multiple,[0]);
  }
});
test('the library display uses the same zero-preserving formatter as the sending path', () => {
  assert.match(source,/强度 \$\{storyboardVibeAmount\(item.strength, 0.6\).toFixed\(2\)\}/);
  assert.match(source,/信息 \$\{storyboardVibeAmount\(item.informationExtracted, 1\).toFixed\(2\)\}/);
});
