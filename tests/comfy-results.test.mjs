import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectComfyStillResults, comfyStillMime, comfyTaskId, readComfyImageBytes } from '../qianmu-comfy-results.js';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { generateImage, imageGatewayErrorPayload } from '../qianmu-image-gateway.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
const descriptor = (filename='final.png',extra={}) => ({filename,type:'output',...extra});
const envelope = (outputs={saved:{images:[descriptor()]}},status={completed:true,status_str:'success'}) => ({task:{outputs,status}});
const workflow = {text:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}},preview:{class_type:'PreviewImage',inputs:{images:['text',0]}}};
const request = {provider:'comfy',baseUrl:'https://comfy.test',prompt:'scene',parameters:{workflow,pollIntervalMs:250,timeoutMs:15000}};
const take = (data,options={}) => collectComfyStillResults(data,'task',options);

test('partial history and bare outputs cannot masquerade as successful completion',()=>{
  for(const data of [{},envelope(undefined,{completed:false}),envelope(undefined,{}),envelope(undefined,{completed:'true'}),{task:{outputs:{saved:{images:[descriptor()]}}}}]) assert.equal(take(data),null);
  assert.equal(take(envelope()).length,1);
});
test('foreign task envelopes and invalid identities are refused',()=>{
  assert.equal(take({other:envelope().task}),null);
  assert.throws(()=>take({prompt_id:'other',...envelope().task}),{code:'comfy_history_mismatch'});
  assert.throws(()=>take({task:{...envelope().task,prompt_id:'other'}}),{code:'comfy_history_mismatch'});
  assert.equal(take({prompt_id:'task',...envelope().task}).length,1);
  for(const id of ['../other','line\nnext','x'.repeat(241),123])assert.equal(comfyTaskId(id),'');
});
test('failed and ambiguous completion states are never archived',()=>{
  assert.throws(()=>take(envelope(undefined,{status_str:'error',completed:false})),{code:'comfy_execution_failed'});
  assert.throws(()=>take(envelope(undefined,{status_str:'running',completed:true})),{code:'comfy_invalid_history'});
  assert.throws(()=>take({task:{status:{completed:true}}}),{code:'comfy_missing_final_image'});
});
test('temporary, input, preview nodes and video outputs do not consume still result slots',()=>{
  const data=envelope({preview:{images:[descriptor('mislabelled.png')]},temps:{images:[descriptor('temp.png',{type:'temp'}),descriptor('source.png',{type:'input'})]},motion:{gifs:[descriptor('clip.webm')]},saved:{images:[descriptor('final.png'),descriptor('clip.gif')]}});
  assert.deepEqual(take(data,{workflow}),[{filename:'final.png',subfolder:'',type:'output'}]);
  assert.throws(()=>take(envelope({only:{gifs:[descriptor('movie.mp4')]}})),{code:'comfy_missing_final_image'});
});
test('missing types and malformed paths are not guessed or fetched',()=>{
  assert.throws(()=>take(envelope({saved:{images:[{filename:'unknown.png'}]}})),{code:'comfy_unclassified_output'});
  for(const item of [descriptor('../x.png'),descriptor('x.png',{subfolder:'../secret'}),descriptor('x.png',{subfolder:'/root'}),descriptor('x.png',{subfolder:'dir\\file'}),descriptor('https://x.test/a.png')])assert.throws(()=>take(envelope({saved:{images:[item]}})),{code:'comfy_invalid_output_path'});
  assert.equal(take(envelope({saved:{images:[descriptor('图.png',{subfolder:'章节/01'})]}}))[0].subfolder,'章节/01');
});
test('duplicate file references collapse but different folders and multiple save nodes are retained',()=>{
  const data=envelope({one:{images:[descriptor()]},two:{images:[descriptor(),descriptor('final.png',{subfolder:'chapter'})]}}),before=structuredClone(data);
  const rows=take(data);assert.equal(rows.length,2);rows[0].filename='changed';assert.deepEqual(data,before);
});
test('more than eight real outputs are explicitly rejected, never silently sliced',()=>{
  const images=Array.from({length:9},(_,i)=>descriptor(`${i}.png`));
  assert.throws(()=>take(envelope({saved:{images}})),{code:'comfy_output_limit'});
  assert.equal(take(envelope({saved:{images:images.slice(0,8)}})).length,8);
  assert.throws(()=>take(envelope(),{maxImages:9}),{code:'comfy_invalid_output_limit'});
});
test('malformed history payloads fail with controlled errors, not fallback-triggering TypeErrors',()=>{
  for(const data of [null,[],{task:[]},envelope([]),envelope({saved:null}),envelope({saved:{images:'bad'}}),envelope({saved:{images:[null]}})])assert.throws(()=>take(data),e=>/^comfy_/.test(e.code)&&e.name!=='TypeError');
});
test('PNG byte validation accepts an actual static container and rejects incomplete or animated bytes',()=>{
  assert.equal(comfyStillMime(png),'image/png');
  assert.throws(()=>comfyStillMime(png.subarray(0,33)),{code:'comfy_invalid_image'});
  const animatedChunk=Buffer.concat([Buffer.from([0,0,0,0]),Buffer.from('acTL'),Buffer.alloc(4)]);
  assert.throws(()=>comfyStillMime(Buffer.concat([png.subarray(0,33),animatedChunk,png.subarray(33)])),{code:'comfy_animated_output'});
  for(const bytes of [Buffer.from('<html>error</html>'),Buffer.from('GIF89a'),Buffer.from([137,80,78,71])])assert.throws(()=>comfyStillMime(bytes),{code:'comfy_invalid_image'});
});
test('WebP container with animation flags is rejected even under a static filename',()=>{
  const webp=Buffer.alloc(22);webp.write('RIFF');webp.writeUInt32LE(14,4);webp.write('WEBP',8);webp.write('VP8L',12);webp.writeUInt32LE(1,16);webp[20]=1;
  assert.equal(comfyStillMime(webp),'image/webp');
  const animated=Buffer.from(webp);animated.write('VP8X',12);animated[20]=2;assert.throws(()=>comfyStillMime(animated),{code:'comfy_animated_output'});
  assert.throws(()=>comfyStillMime(webp.subarray(0,21)),{code:'comfy_invalid_image'});
});
test('Comfy byte reader bounds both advertised and streamed payloads',async()=>{
  assert.deepEqual(await readComfyImageBytes(new Response(png),png.length),new Uint8Array(png));
  await assert.rejects(readComfyImageBytes(new Response(png,{headers:{'content-length':png.length}}),10),{code:'comfy_image_too_large'});
  await assert.rejects(readComfyImageBytes(new Response(png),10),{code:'comfy_image_too_large'});
  let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(11));},cancel(){cancelled=true;}});
  await assert.rejects(readComfyImageBytes(new Response(stream),10),{code:'comfy_image_too_large'});assert.equal(cancelled,true);
});

for(const [name,run] of [['direct',generateDirectImage],['gateway',generateImage]]){
  function fixture({histories=[envelope()],bytes=png,viewError=false}={}){
    const calls=[];let polls=0;
    return {calls,run:()=>run(structuredClone(request),{resolveHost:async()=>[{address:'8.8.8.8',family:4}],waitImpl:async()=>{},fetchImpl:async(url,init)=>{
      const parsed=new URL(url);calls.push({path:parsed.pathname,method:init.method,filename:parsed.searchParams.get('filename')});
      if(parsed.pathname==='/prompt')return Response.json({prompt_id:'task'});
      if(parsed.pathname==='/history/task')return Response.json(histories[Math.min(polls++,histories.length-1)]);
      if(parsed.pathname==='/view'){if(viewError)throw TypeError('simulated response loss');return new Response(bytes,{headers:{'content-type':'image/png'}});}
      assert.fail(`unexpected ${parsed.pathname}`);
    }})};
  }
  test(`${name}: waits past partial history, filters previews and downloads only unique final stills`,async()=>{
    const f=fixture({histories:[envelope({preview:{images:[descriptor('temp.png',{type:'temp'})]}},{completed:false}),envelope({preview:{images:[descriptor('ignored.png')]},saved:{images:[descriptor(),descriptor()]},film:{gifs:[descriptor('film.webm')]}})]});
    const result=await f.run();assert.equal(result.images.length,1);assert.equal(result.images[0].mime,'image/png');assert.equal(result.upstreamId,'task');
    assert.deepEqual(f.calls.map(x=>x.path),['/prompt','/history/task','/history/task','/view']);assert.equal(f.calls.at(-1).filename,'final.png');
  });
  test(`${name}: oversize result is not truncated or retried and retains original task identity`,async()=>{
    const f=fixture({histories:[envelope({saved:{images:Array.from({length:9},(_,i)=>descriptor(`${i}.png`))}})]});
    await assert.rejects(f.run(),error=>{assert.equal(error.code,'comfy_output_limit');assert.equal(error.submissionState,'accepted');assert.equal(error.upstreamId,'task');assert.equal(imageGatewayErrorPayload(error).body.upstreamId,'task');return true;});
    assert.deepEqual(f.calls.map(x=>x.path),['/prompt','/history/task']);
  });
  test(`${name}: static-looking filename with animation bytes does not enter the still archive`,async()=>{
    const f=fixture({bytes:Buffer.from('GIF89a')});await assert.rejects(f.run(),{code:'comfy_invalid_image',submissionState:'accepted',upstreamId:'task'});
    assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
  });
  test(`${name}: download disconnect preserves original task and never resubmits prompt`,async()=>{
    const f=fixture({viewError:true});await assert.rejects(f.run(),error=>{assert.equal(error.upstreamId,'task');assert.ok(['unknown','accepted'].includes(error.submissionState));return true;});
    assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
  });
}
test('shared result implementation is shipped and final UI failure includes a safe original task ID',async()=>{
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));assert.ok(release.files.includes('qianmu-comfy-results.js'));
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(source,/ComfyUI 原任务/);
  assert.equal(imageGatewayErrorPayload({message:'failure',upstreamId:'https://private.example/secret'}).body.upstreamId,undefined);
});
