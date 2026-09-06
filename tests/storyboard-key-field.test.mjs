import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import { checkDirectImageConnection } from '../qianmu-image-direct.js';
import { checkImageConnection } from '../qianmu-image-gateway.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function environment({ typed = 'typed-test-key', check = async () => ({ ok:true, verified:true }), read = null, write = null } = {}) {
  const state = storyboard.createStoryboardDefaults();
  const group = state.connections.novel;
  group.presets = ['a', 'b'].map(id => ({id, name:id, providerId:'novel', baseUrl:`https://${id}.example`, credentialId:`key-${id}`}));
  group.activePresetId = 'a'; group.draft = {...group.presets[0], id:'', name:'当前编辑'};
  const keys = new Map([['key-a','preset-a-key'],['key-b','preset-b-key']]);
  const input = {value:typed,type:'password'}, attrs = {}, icon = {};
  const button = {setAttribute:(name,value)=>{attrs[name]=value;},querySelector:()=>icon};
  const root = {isConnected:true, querySelectorAll:()=>[input], querySelector:selector=>selector.includes('visibility') ? button : input};
  const notices = [], persisted = [], icons = [];
  const context = vm.createContext({ ...storyboard, clone:structuredClone, URL,
    storyboardState:()=>state, storyboardConnectionLoadRevision:0, storyboardKeyInputRevision:0,
    storyboardConnectionCheckRevision:0, getChatKey:()=> 'chat-a',
    storyboardDraftApiKeys:new Map(), storyboardConnectionStatus:new Map(),
    storyboardCaptureWorkbench:()=>({profile:state.profiles.novel,workflowResult:{ok:true,removedFields:[]}}),
    storyboardProviderProfile:()=>({...state.profiles.novel,baseUrl:group.draft.baseUrl}),
    storyboardCredentialId:(_provider,id)=>`credential-${id}`,
    storyboardRememberApiKey:async(provider,value,id)=>{ keys.set(id,value); if(write) await write(provider,value,id); },
    storyboardResolveApiKey:async(provider,id)=>read ? read(provider,id) : keys.get(id || group.draft.credentialId) || '',
    saveSettings:()=>persisted.push(JSON.stringify(state)), renderModal:()=>{},
    promptInput:async()=> 'Saved connection', confirmDialog:async()=>true, uid:()=> 'new-preset',
    toast:message=>notices.push(message), directImageRuntime:async()=>({checkDirectImageConnection:check,isDirectImageTransportError:()=>false}),
    refreshQianmuIcon:(_icon,value)=>icons.push(value),
  });
  vm.runInContext(['storyboardConnectionState','storyboardSaveConnection','storyboardCheckConnection','storyboardSaveConnectionPreset','storyboardLoadConnectionPreset','storyboardToggleKeyVisibility'].map(section).join('\n'),context);
  return {state,group,input,root,context,keys,attrs,notices,persisted,icons};
}

test('saving a loaded connection retains typed key without overwriting the saved preset credential', async()=>{
  const e=environment();
  await e.context.storyboardSaveConnection(e.root);
  assert.equal(e.input.value,'typed-test-key');
  assert.equal(e.context.storyboardDraftApiKeys.get('novel'),'typed-test-key');
  assert.equal(e.keys.get('key-a'),'preset-a-key');
  assert.equal(e.keys.get(e.group.draft.credentialId),'typed-test-key');
  assert.ok(e.persisted.every(value=>!value.includes('typed-test-key')));
});
for(const [label,result,error] of [['success',{ok:true,verified:true},false],['reachable',{ok:true,verified:false,message:'old verbose hint'},false],['failure',null,true]]) {
  test(`connection test ${label} keeps the key and reports concise status`,async()=>{
    const e=environment({check:async()=>{if(error) throw new Error('network refused');return result;}});
    await e.context.storyboardCheckConnection(e.root);
    assert.equal(e.input.value,'typed-test-key');
    assert.equal(e.context.storyboardDraftApiKeys.get('novel'),'typed-test-key');
    assert.equal(e.context.storyboardConnectionStatus.get('novel').ok,!error);
    if(label==='reachable') assert.equal(e.notices.at(-1),'地址可达，请以生图验证');
    assert.ok(e.notices.every(value=>!value.includes('typed-test-key')));
  });
}
test('a failed in-flight test cannot restore its old key over newer typing',async()=>{
  const gate=deferred(),e=environment({check:async()=>{await gate.promise;throw new Error('offline');}});
  const work=e.context.storyboardCheckConnection(e.root);
  await new Promise(resolve=>setImmediate(resolve));
  e.input.value='newer-key'; e.context.storyboardDraftApiKeys.set('novel','newer-key');
  gate.resolve();await work;
  assert.equal(e.input.value,'newer-key');assert.equal(e.context.storyboardDraftApiKeys.get('novel'),'newer-key');
});
test('saving a named preset retains the filled key through rerender',async()=>{
  const e=environment();await e.context.storyboardSaveConnectionPreset(e.root);
  assert.equal(e.context.storyboardDraftApiKeys.get('novel'),'typed-test-key');
  assert.equal(e.keys.get('key-a'),'typed-test-key');
  assert.ok(e.persisted.every(value=>!value.includes('typed-test-key')));
});
test('loading a preset populates the masked field session with that preset key',async()=>{
  const e=environment();await e.context.storyboardLoadConnectionPreset('b');
  assert.equal(e.group.draft.baseUrl,'https://b.example');
  assert.equal(e.context.storyboardDraftApiKeys.get('novel'),'preset-b-key');
  assert.equal(e.context.storyboardConnectionStatus.has('novel'),false);
  assert.ok(e.persisted.every(value=>!value.includes('preset-b-key')));
});
test('missing preset credentials are explained and never borrow the previous field value',async()=>{
  const e=environment({read:async()=>''});e.context.storyboardDraftApiKeys.set('novel','old-field-key');
  await e.context.storyboardLoadConnectionPreset('b');
  assert.equal(e.context.storyboardDraftApiKeys.has('novel'),false);
  assert.match(e.context.storyboardConnectionStatus.get('novel').message,/未找到.*API Key/);
});
test('late preset A cannot overwrite a newer selection B',async()=>{
  const gate=deferred(),e=environment({read:async(_provider,id)=>id==='key-a'?gate.promise:'new-b-key'});
  const a=e.context.storyboardLoadConnectionPreset('a');
  await e.context.storyboardLoadConnectionPreset('b');
  gate.resolve('old-a-key');await a;
  assert.equal(e.context.storyboardDraftApiKeys.get('novel'),'new-b-key');
  assert.equal(e.group.activePresetId,'b');
});
for(const value of ['fresh-typed-key','']) {
  test(`typing or clearing during preset loading wins (${value ? 'typing':'clearing'})`,async()=>{
    const gate=deferred(),e=environment({read:async()=>gate.promise});
    const work=e.context.storyboardLoadConnectionPreset('b');
    e.context.storyboardKeyInputRevision++;
    if(value) e.context.storyboardDraftApiKeys.set('novel',value);else e.context.storyboardDraftApiKeys.delete('novel');
    gate.resolve('late-key');await work;
    assert.equal(e.context.storyboardDraftApiKeys.get('novel') || '',value);
  });
}
test('switching family during a secret read cannot populate the other panel',async()=>{
  const gate=deferred(),e=environment({read:async()=>gate.promise});
  const work=e.context.storyboardLoadConnectionPreset('b'); e.state.source='openai';
  gate.resolve('late-key');await work;
  assert.equal(e.context.storyboardDraftApiKeys.size,0);
});
test('eye button only changes local display and uses bundled icons',()=>{
  const e=environment();e.context.storyboardToggleKeyVisibility(e.root);
  assert.equal(e.input.type,'text');assert.equal(e.attrs['aria-pressed'],'true');assert.equal(e.attrs['aria-label'],'隐藏 API Key');
  e.context.storyboardToggleKeyVisibility(e.root);
  assert.equal(e.input.type,'password');assert.equal(e.attrs['aria-pressed'],'false');
  assert.deepEqual(e.icons,['fa-eye-slash','fa-eye']);assert.equal(e.input.value,'typed-test-key');
  assert.equal(e.persisted.length,0);assert.equal(e.notices.length,0);
});
test('API card removes loaded annotation and always begins with a masked field',()=>{
  const card=section('renderStoryboardModelCard');
  assert.match(card,/<span>API 预设<\/span>/);assert.doesNotMatch(card,/已载入/);
  assert.match(card,/id="sd-storyboard-key-input"[^>]+type="password"/);
  assert.match(card,/aria-pressed="false" aria-controls="sd-storyboard-key-input"/);
});
for(const provider of ['novel','openai']) {
  test(`${provider} direct/gateway 404 reachability share the short message`,async()=>{
    const input={provider,apiKey:'test-key',baseUrl:'https://relay.example',model:'model'};
    for(const run of [checkDirectImageConnection,checkImageConnection]) {
      const result=await run(input,{resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>new Response('{}',{status:404})});
      assert.equal(result.verified,false);assert.equal(result.message,'地址可达，请以生图验证');
    }
  });
}
test('disabled discovery must not falsely claim the address was reached',async()=>{
  for(const run of [checkDirectImageConnection,checkImageConnection]) {
    let calls=0;
    const result=await run({provider:'openai',apiKey:'test-key',baseUrl:'https://relay.example',compatibility:{modelDiscovery:'off'}},
      {resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>{calls++;throw new Error('no request');}});
    assert.equal(calls,0);assert.equal(result.transport,'configured');assert.equal(result.message,'未执行连接探测，请以生图验证');
  }
});
