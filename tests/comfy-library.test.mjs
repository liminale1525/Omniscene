import test from 'node:test';
import assert from 'node:assert/strict';
import {createComfyWorkflowStore,normalizeComfyLibraryDocument,inspectComfyLibraryDocument,importComfyLibraryDocument,exportComfyLibraryDocument,COMFY_LIBRARY_SCHEMA} from '../qianmu-comfy-library.js';
const graph={one:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}},two:{class_type:'SaveImage',inputs:{images:['one',0]}}};
const document={workflow:JSON.stringify(graph),outputNodeId:'two',parameters:{width:832,seed:-1},positivePrompt:'added',negativePrompt:'excluded'};
test('library documents copy only recipe fields, never connection credentials',()=>{
  const result=normalizeComfyLibraryDocument({...document,baseUrl:'https://private',apiKey:'secret',parameters:{...document.parameters,apiKey:'secret'}});
  assert.equal(result.parameters.width,'832');assert.equal(result.parameters.seed,'-1');assert.equal(result.outputNodeId,'two');
  assert.doesNotMatch(JSON.stringify(result),/secret|https:\/\/private|apiKey/);assert.notEqual(result.parameters,document.parameters);
});
test('native JSON and portable recipes round trip without changing prompt additions',()=>{
  const native=importComfyLibraryDocument(JSON.stringify(graph));assert.equal(native.name,'');assert.equal(native.document.positivePrompt,'');
  const portable=exportComfyLibraryDocument('My graph',document);assert.equal(portable.schema,COMFY_LIBRARY_SCHEMA);
  const restored=importComfyLibraryDocument(JSON.stringify(portable));assert.equal(restored.name,'My graph');assert.deepEqual(restored.document,normalizeComfyLibraryDocument(document));
});
test('credential fields are refused on save and explicitly reported on import',()=>{
  const workflow={one:{class_type:'Custom',inputs:{text:'%qianmu_prompt%',api_key:'do-not-leak'}}};
  assert.throws(()=>normalizeComfyLibraryDocument({workflow}),{code:'comfy_library_sensitive_fields'});
  const result=importComfyLibraryDocument(JSON.stringify(workflow));assert.ok(result.removedFields.length);assert.doesNotMatch(JSON.stringify(result),/do-not-leak/);
});
test('API document bounds reject canvas, empty, malformed and oversized workflows',()=>{
  for(const workflow of ['{','{}','[]','{"nodes":[]}',{a:{inputs:{}}},{a:{class_type:'X',inputs:[]}},Object.fromEntries(Array.from({length:513},(_,i)=>[i,graph.one]))])assert.throws(()=>normalizeComfyLibraryDocument({workflow}),{code:'comfy_library_document'});
  assert.throws(()=>importComfyLibraryDocument(' ' .repeat(3*1024*1024+1)),{code:'comfy_library_import'});
  assert.throws(()=>importComfyLibraryDocument(JSON.stringify({schema:'future'})),{code:'comfy_library_version'});
});
test('unsupported slots fail; missing prompt/output stays visibly unready, not falsely validated',()=>{
  assert.throws(()=>normalizeComfyLibraryDocument({workflow:{a:{class_type:'X',inputs:{text:'%qianmu_unsupported%'}}}}),{code:'comfy_library_document'});
  assert.match(inspectComfyLibraryDocument({...document,outputNodeId:'missing'}).issue,/缺失/);
  assert.match(inspectComfyLibraryDocument({workflow:{a:{class_type:'X',inputs:{text:'literal'}}}}).issue,/无法生效/);
  const inspected=inspectComfyLibraryDocument(document);assert.equal(inspected.nodes,2);assert.ok(inspected.slots.includes('prompt'));assert.ok(inspected.bytes>20);
});
test('bad field types or long additions are not silently truncated into changed recipes',()=>{
  for(const change of [{positivePrompt:'a'.repeat(12001)},{negativePrompt:{}},{parameters:{cfg:{}}}])assert.throws(()=>normalizeComfyLibraryDocument({...document,...change}),{code:'comfy_library_document'});
  assert.throws(()=>normalizeComfyLibraryDocument({...document,outputNodeId:'<bad>'}),{code:'comfy_library_output'});
});
test('lazy independent store does not open or migrate legacy databases during startup/disposal',()=>{
  let opens=0;const store=createComfyWorkflowStore({indexedDB:{open(){opens++;}}});assert.equal(opens,0);store.close();assert.equal(opens,0);
  for(const maxBytes of [0,NaN,Infinity,-1])assert.throws(()=>createComfyWorkflowStore({maxBytes}),{code:'comfy_library_capacity'});
});
test('invalid account or identifier fails before storage and failed open is retryable',async()=>{
  let opens=0;const store=createComfyWorkflowStore({indexedDB:{open(name,version){assert.equal(name,'qianmu-comfy-workflows');assert.equal(version,1);opens++;throw Error('unavailable');}}});
  for(const namespace of ['',null,'\u0000',' '.repeat(2)])await assert.rejects(()=>store.list(namespace),{code:'comfy_library_identity'});
  await assert.rejects(()=>store.versions('account',7),{code:'comfy_library_identity'});assert.equal(opens,0);
  await assert.rejects(()=>store.list('account'),{code:'comfy_library_storage'});await assert.rejects(()=>store.list('account'),{code:'comfy_library_storage'});assert.equal(opens,2);store.close();
});
test('invalid recipe fails before opening or modifying any stored version',async()=>{
  let opens=0;const store=createComfyWorkflowStore({indexedDB:{open(){opens++;}}});
  await assert.rejects(()=>store.save('account',{name:'',document}),{code:'comfy_library_name'});
  await assert.rejects(()=>store.save('account',{name:'name',document:{workflow:'broken'}}),{code:'comfy_library_document'});assert.equal(opens,0);store.close();
});
for(const scenario of ['blocked','timeout','closed'])test(`${scenario} opening cannot revive a late database handle`,async()=>{
  const pending={};let closes=0;const store=createComfyWorkflowStore({indexedDB:{open:()=>pending},timeoutMs:100});const loading=store.list('account');
  if(scenario==='blocked')pending.onblocked();if(scenario==='closed'){store.close();pending.result={close:()=>closes++};pending.onsuccess();}
  await assert.rejects(()=>loading,{code:`comfy_library_${scenario}`});
  if(scenario!=='closed'){pending.result={close:()=>closes++};pending.onsuccess();}assert.equal(closes,1);store.close();
});
