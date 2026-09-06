import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import * as service from '../qianmu-service-capabilities.js';
import { normalizeOpenAIImageCompatibility, parseOpenAICompatibleHeaders } from '../qianmu-openai-image-compat.js';
import { generateImage, imageGatewayCapabilities } from '../qianmu-image-gateway.js';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { createStoryboardFormFixture, storyboardFunctionSource as fn } from './helpers/storyboard-form-fixture.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const compatible = (extra={}) => ({id:'relay-a',protocol:'openai-images',imageProtocolVersion:1,baseUrl:'https://relay.example/v1',credentialId:'local-secret-ref',
  compatibility:normalizeOpenAIImageCompatibility({endpoints:{models:'custom/models',generation:'custom/images'}}),...extra});
const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
function stateFor(family='banana') {
  const state=storyboard.createStoryboardDefaults();
  Object.assign(state,{source:family,enabled:true,target:'gallery',prompt:'quiet garden',negative:'words'});
  Object.assign(state.profiles[family],{model:storyboard.STORYBOARD_PROVIDER_REGISTRY[family].defaultModel,loaded:true,width:'1024',height:'1024',count:'2',imageSize:'2K',seed:'42',seedreamGuidanceScale:'3',watermark:true,openaiQuality:'high'});
  state.connections[family].draft=compatible();
  return state;
}
function harness(state=stateFor(),extra={}) {
  const notices=[],persisted=[],rendered=[];
  const context=vm.createContext({...storyboard,...service,normalizeOpenAIImageCompatibility,parseOpenAICompatibleHeaders,
    clone:structuredClone,URL,JSON,storyboardState:()=>state,STORYBOARD_SOURCES:storyboard.STORYBOARD_PROVIDER_REGISTRY,
    ctx:()=>({chat:[]}),getChatKey:()=> 'chat-a',uid:(()=>{let n=0;return()=>`unit-${++n}`;})(),hashText:()=> 'hash',
    storyboardDraftApiKeys:new Map([[state.source,'typed-local-key']]),storyboardConnectionStatus:new Map(),
    storyboardConnectionLoadRevision:0,storyboardKeyInputRevision:0,storyboardConnectionCheckRevision:0,
    storyboardProductionDeliveryPolicy:(_shot,policy)=>policy,storyboardAnchorForMessage:()=>null,
    storyboardSelectedArtistPreset:()=>null,storyboardProviderPromptDefaults:()=>({positive:'quality',negative:'blur'}),
    storyboardCredentialId:(family,id)=>`${family}-${id}`,storyboardGatewayCapabilityPromise:null,
    storyboardRequestHeaders:()=>({'Content-Type':'application/json'}),saveSettings:()=>persisted.push(plain(state)),renderModal:()=>rendered.push(true),toast:message=>notices.push(message),
    ...extra,
  });
  const names=['storyboardConnectionState','storyboardProviderProfile','storyboardProfileSnapshot','storyboardGenerationPayload','storyboardResolveRoutingProfile',
    'storyboardCreateJob','storyboardGatewayRequest','storyboardJobFromLog','storyboardRestoreSnapshotConnection','storyboardLoadLogToWorkbench',
    'storyboardConfirmGatewayProtocolBinding','storyboardConfirmGatewayModelBinding','storyboardChangeConnectionProtocol','storyboardSaveConnectionPreset','storyboardCheckConnection'];
  vm.runInContext(names.map(fn).join('\n'),context);
  return {state,context,notices,persisted,rendered};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};

function comfyState(mode = 'browser') {
  const state = stateFor('comfy');
  state.connections.comfy.draft = { baseUrl: 'https://comfy.example', credentialId: 'comfy-key', options: { comfyTransport: mode } };
  state.profiles.comfy.comfyWorkflow = JSON.stringify({ image: { class_type: 'EmptyImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    text: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } }, save: { class_type: 'SaveImage', inputs: { images: ['image', 0] } } });
  return state;
}

test('Comfy named connection saves requester and delayed save cannot capture a changed route', async () => {
  for (const change of [false, true]) {
    const gate = deferred(), e = harness(comfyState('gateway'), {
      storyboardCaptureWorkbench: () => ({ profile: e.state.profiles.comfy, workflowResult: { ok: true, removedFields: [] } }),
      promptInput: () => gate.promise, storyboardRememberApiKey: async () => {},
    });
    const root = { isConnected: true, querySelector: () => ({ value: 'typed-key' }) };
    const pending = e.context.storyboardSaveConnectionPreset(root);
    if (change) e.state.connections.comfy.draft.options.comfyTransport = 'browser';
    gate.resolve('Comfy endpoint'); await pending;
    assert.equal(e.state.connections.comfy.presets.length, change ? 0 : 1);
    if (!change) assert.equal(storyboard.requireStoryboardComfyTransport(e.state.connections.comfy.presets[0]), 'gateway');
  }
});

test('Comfy actual create, group override, sanitized history, repeat and workbench restore retain the frozen requester', () => {
  const e = harness(comfyState('browser'));
  e.state.connections.comfy.presets = [{ id: 'other', baseUrl: 'https://comfy.example', credentialId: 'comfy-key', options: { comfyTransport: 'gateway' } }];
  const plainJob = e.context.storyboardCreateJob(e.state, e.state.profiles.comfy);
  const grouped = e.context.storyboardCreateJob(e.state, e.state.profiles.comfy, { connectionPresetId: 'other' });
  assert.equal(plainJob.connection.comfyTransport, 'browser'); assert.equal(grouped.connection.comfyTransport, 'gateway');
  const snapshot = storyboard.sanitizeStoryboardSnapshot(grouped);
  e.state.connections.comfy.draft.options.comfyTransport = 'browser'; e.state.connections.comfy.presets[0].options.comfyTransport = 'browser';
  const repeated = e.context.storyboardJobFromLog({ snapshot, attempt: 1 }); assert.equal(repeated.connection.comfyTransport, 'gateway');
  e.context.storyboardRestoreSnapshotConnection(e.state, snapshot, 'comfy');
  assert.equal(e.state.connections.comfy.activePresetId, '', 'same named preset with another request host is not identical');
  assert.equal(storyboard.requireStoryboardComfyTransport(e.state.connections.comfy.draft), 'gateway');
  const legacy = structuredClone(snapshot); delete legacy.connection.comfyTransport;
  e.context.storyboardRestoreSnapshotConnection(e.state, legacy, 'comfy');
  assert.equal(storyboard.requireStoryboardComfyTransport(e.state.connections.comfy.draft), 'legacy-auto');
});

test('Comfy actual connection check honors explicit requester and does not confuse reachability with generation success', async () => {
  for (const mode of ['browser', 'gateway', 'legacy-auto']) {
    const sent = [], e = harness(comfyState(mode), {
      storyboardSaveConnection: async () => {}, storyboardResolveApiKey: async () => 'saved-key',
      directImageRuntime: async () => { sent.push('load-browser'); return { checkDirectImageConnection: async () => { sent.push('browser'); throw Object.assign(new Error('network'), { code: 'direct_transport' }); }, isDirectImageTransportError: () => true }; },
      fetch: async url => { sent.push(url); return Response.json({ ok: true, verified: true }); },
    });
    const key = { value: 'saved-key' }, root = { isConnected: true, querySelector: () => key, querySelectorAll: () => [key] };
    await e.context.storyboardCheckConnection(root);
    if (mode === 'browser') { assert.deepEqual(sent, ['load-browser', 'browser']); assert.match(e.notices.at(-1), /检查失败/); }
    else {
      assert.equal(sent.filter(item => item === '/api/plugins/qianmu-tts/image/check').length, 1);
      assert.match(e.notices.at(-1), /ST 主机 · 地址可达，请以生图验证/);
      assert.equal(e.context.storyboardConnectionStatus.get('comfy').verified, false);
      if (mode === 'gateway') assert.ok(!sent.includes('load-browser'));
    }
    assert.equal(key.value, 'saved-key');
  }
});

test('NAI reachable-only probe retains its concise warning after introducing explicit Comfy requesters', async () => {
  const state = stateFor('novel'); state.connections.novel.draft = { baseUrl: 'https://nai.example' };
  const e = harness(state, { storyboardSaveConnection: async () => {}, storyboardResolveApiKey: async () => 'key',
    directImageRuntime: async () => ({ checkDirectImageConnection: async () => ({ ok: true, verified: false, transport: 'direct', message: '地址可达，请以生图验证' }) }) });
  const key = { value: 'key' }; await e.context.storyboardCheckConnection({ isConnected: true, querySelector: () => key, querySelectorAll: () => [key] });
  assert.equal(e.notices.at(-1), '地址可达，请以生图验证'); assert.equal(e.context.storyboardConnectionStatus.get('novel').verified, false);
});

test('Comfy actual model discovery uses its own preset requester and never fails over from explicit browser mode', async () => {
  for (const mode of ['browser', 'gateway', 'legacy-auto']) {
    let options; const sent = [], e = harness(comfyState(mode), { storyboardCredentialRevision: 0, AbortController, setTimeout, clearTimeout,
      storyboardCaptureWorkbench() {}, storyboardResolveApiKey: async () => 'key',
      directImageRuntime: async () => { sent.push('load-browser'); return { listDirectImageModels: async () => { sent.push('browser'); throw new Error('network'); }, isDirectImageTransportError: () => true }; },
      featureRuntime: { load: async () => ({ attachModelPicker: (_host, value) => { options = value; return { open() {}, isCurrent: value.isCurrent }; } }) },
      fetch: async url => { sent.push(url); return Response.json({ ok: true, models: [] }); },
    });
    const handlers = {}, host = { isConnected: true, dataset: { storyboardModelPicker: 'comfy' }, closest: () => null, querySelector: () => null, addEventListener: (name, handler) => { handlers[name] = handler; } };
    const root = { isConnected: true, querySelectorAll: () => [] };
    vm.runInContext(fn('bindStoryboardModelPicker'), e.context); e.context.bindStoryboardModelPicker(root, host, e.state); handlers.focusin({ target: { matches: () => true } });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'browser') { await assert.rejects(options.fetchModels()); assert.deepEqual(sent, ['load-browser', 'browser']); }
    else { await options.fetchModels(); assert.equal(sent.filter(item => item === '/api/plugins/qianmu-tts/image/models').length, 1); if (mode === 'gateway') assert.ok(!sent.includes('load-browser')); }
  }
});

test('state roundtrip preserves per-connection protocols, capabilities and headers without binding presets to a model',()=>{
  const state=stateFor(); const group=state.connections.banana;
  group.presets=[compatible({name:'Relay'}),{id:'native',name:'Native',baseUrl:'https://native.example',model:'gemini-3.1-flash-image'}];
  group.activePresetId='relay-a';
  group.draft.headers={'X-Route':'garden',Authorization:'must-not-persist'};
  group.draft.compatibility.customHeaderNames=['X-Route'];
  const next=storyboard.normalizeStoryboardState(structuredClone(state));
  assert.equal(next.connections.banana.draft.protocol,'openai-images');
  assert.equal(next.connections.banana.draft.imageProtocolVersion,1);
  assert.deepEqual(next.connections.banana.draft.headers,{'X-Route':'garden'});
  assert.equal(next.connections.banana.presets[1].protocol,undefined);
  assert.equal(next.profiles.banana.seed,'42');assert.equal(next.profiles.banana.imageSize,'2K');
});

test('invalid declarations survive normalization as blocked state, never convert into native or default-host requests',()=>{
  for (const fields of [{protocol:null},{protocol:{}},{protocol:'openai-images',imageProtocolVersion:0},{protocol:'openai-images'},{protocol:'unknown'},
    {protocol:'openai-images',imageProtocolVersion:1,modelFamily:'novel'}]) {
    const normalized=storyboard.normalizeStoryboardConnectionProfile({baseUrl:'',...fields},'banana');
    assert.throws(()=>storyboard.resolveStoryboardConnectionBinding('banana',normalized));
    assert.equal(normalized.baseUrl,'');
  }
});

test('capabilities are the current transport intersection and never a stale cached projection',()=>{
  const connection=compatible({compatibility:{allowedParameters:['size'],referenceField:'image'}});
  const native=storyboard.getStoryboardCapabilities('seedream');
  const first=storyboard.getStoryboardCapabilities('seedream','',undefined,connection);
  assert.equal(native.seed,true);assert.equal(first.seed,false);assert.equal(first.count,false);assert.equal(first.multipleReferences,false);
  assert.equal(first.supportsExclusionText,true);assert.equal(first.supportsNativeNegative,false);assert.equal(first.supportsArtistSyntax,false);
  connection.compatibility={allowedParameters:['n','quality'],referenceField:'image[]'};
  const second=storyboard.getStoryboardCapabilities('seedream','',undefined,connection);
  assert.equal(second.count,true);assert.equal(second.size,false);assert.equal(second.ratio,false);assert.equal(second.quality,true);
  assert.equal(first.size,true);assert.equal(first.count,false);
});

test('disabled dimensions and composition do not leak hidden prior ratio instructions into compatible generation',()=>{
  const connection=compatible({compatibility:{allowedParameters:[]}});
  const result=storyboard.resolveStoryboardComposition({providerId:'banana',connection,policy:{mode:'fixed',fixedRatioId:'16:9'},width:1024,height:1024,shot:{composition:{ratioId:'16:9'}}});
  assert.equal(result.source,'protocol');assert.equal(result.ratioId,'');assert.equal(result.dimensions.width,0);
  const compiled=storyboard.compileStoryboardPrompt({providerId:'banana',connection,shot:{scene:'garden',composition:{ratioId:'16:9'}}});
  assert.doesNotMatch(compiled.prompt,/16:9/);assert.equal(compiled.modelBinding.protocol,'openai-images');
});

for (const family of ['banana','seedream']) {
  test(`${family} actual page shows compatible controls, keeps native-only values in state, and renders native controls on return`,()=>{
    const a=createStoryboardFormFixture({family,connection:compatible()});
    assert.match(a.content,/sd-storyboard-protocol/);assert.match(a.content,/OpenAI Images 兼容/);
    assert.match(a.content,/data-storyboard-field="openaiQuality"/);
    assert.doesNotMatch(a.content,/data-storyboard-field="(?:imageSize|seedreamGuidanceScale|seedreamSequential|watermark|seed)"/);
    const b=createStoryboardFormFixture({family,connection:compatible({compatibility:{allowedParameters:[]}})});
    assert.doesNotMatch(b.content,/data-storyboard-field="(?:width|height|count|openaiQuality|openaiBackground|openaiOutputFormat)"/);
    const native=createStoryboardFormFixture({family});
    assert.match(native.content,new RegExp(`data-storyboard-field="${family==='banana'?'imageSize':'seedreamGuidanceScale'}"`));
  });

  test(`${family} real create -> history sanitize -> repeat -> wire uses its frozen protocol and model despite current changes`,async()=>{
    const e=harness(stateFor(family));
    e.state.connections[family].draft.compatibility.customHeaderNames=['X-Route','Authorization','X-Api-Key','Cookie'];
    e.state.connections[family].draft.headers={'X-Route':'garden',Authorization:'not-for-history','X-Api-Key':'not-for-history',Cookie:'not-for-history','X-Undeclared':'not-for-history'};
    const job=e.context.storyboardCreateJob(e.state,e.state.profiles[family]);
    const snapshot=storyboard.sanitizeStoryboardSnapshot(job);
    assert.deepEqual(snapshot.connection.headers,{'X-Route':'garden'});
    assert.doesNotMatch(JSON.stringify(snapshot),/not-for-history/);
    assert.equal(snapshot.modelIdentity.protocol,'openai-images');assert.equal(snapshot.connection.protocol,'openai-images');
    assert.equal(snapshot.connection.imageProtocolVersion,1);
    e.state.connections[family].draft={protocol:storyboard.STORYBOARD_PROVIDER_REGISTRY[family].protocol,baseUrl:'https://new.example'};
    e.state.profiles[family].seed='99';e.state.profiles[family].model='changed';
    const repeated=e.context.storyboardJobFromLog({snapshot,attempt:1});
    const wire=e.context.storyboardGatewayRequest(repeated,'mock-key',{references:[],vibes:[]});
    assert.deepEqual(plain(wire.customHeaders),{'X-Route':'garden'});
    assert.ok(wire.compatibility.customHeaderNames.includes('X-Route'));
    assert.equal(wire.protocol,'openai-images');assert.equal(wire.imageProtocolVersion,1);assert.equal(wire.baseUrl,'https://relay.example/v1');
    assert.equal(wire.model,storyboard.STORYBOARD_PROVIDER_REGISTRY[family].defaultModel);
    for(const name of ['seed','imageSize','watermark','sequential','guidanceScale','aspectRatio','workflow']) assert.equal(Object.hasOwn(wire.parameters,name),false);
    assert.equal(wire.parameters.quality,'high');assert.equal(wire.parameters.count,2);
    const bodies=[];
    for(const run of [generateDirectImage,generateImage]) await run(wire,{resolveHost:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async(url,init)=>{
      assert.equal(init.headers['X-Route'],'garden');
      assert.equal(String(url),'https://relay.example/v1/custom/images');bodies.push(JSON.parse(init.body));return Response.json({data:[{b64_json:png.toString('base64')}]});
    }});
    assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies[0].n,2);
    assert.equal(repeated.profile.seed,'42'); // Saved native setting is retained but not sent.
  });
}

test('a shot group uses its explicit connection protocol, not the main workbench draft',()=>{
  for(const reverse of [false,true]){
    const e=harness();
    const native={id:'native-route',baseUrl:'https://native.example',protocol:'gemini-images',credentialId:'native-key'};
    const route=reverse?compatible({id:'cross-route'}):native;
    if(reverse)e.state.connections.banana.draft=native;
    e.state.connections.banana.presets=[route];
    const job=e.context.storyboardCreateJob(e.state,e.state.profiles.banana,{connectionPresetId:route.id});
    assert.equal(job.modelIdentity.protocol,route.protocol);assert.equal(job.connection.baseUrl,route.baseUrl);
    assert.equal(job.payload.parameters.imageSize,reverse?undefined:'2K');
    assert.equal(job.connection.credentialId,route.credentialId);
  }
});

test('historical conflicting or incomplete protocol declarations refuse generation before either transport',()=>{
  const e=harness(), job=e.context.storyboardCreateJob(e.state,e.state.profiles.banana);
  for(const change of [s=>{s.connection.protocol='gemini-images';},s=>{delete s.connection.imageProtocolVersion;},s=>{delete s.modelIdentity.imageProtocolVersion;},s=>{s.modelIdentity.protocol='gemini-images';}]){
    const altered=structuredClone(job);change(altered);
    assert.throws(()=>e.context.storyboardGatewayRequest(altered,'mock-key',{references:[],vibes:[]}));
  }
  const broken=storyboard.sanitizeStoryboardSnapshot({...job,connection:{...job.connection,baseUrl:''}});
  assert.equal(broken.connection.baseUrl,'');assert.equal(e.context.storyboardJobFromLog({snapshot:broken}),null);
});

test('loading an old picture into workbench restores its address/protocol/credential reference, not another preset with the same ID',()=>{
  const e=harness(),job=e.context.storyboardCreateJob(e.state,e.state.profiles.banana),snap=storyboard.sanitizeStoryboardSnapshot(job);
  e.state.connections.banana.presets=[compatible({baseUrl:'https://changed.example'})];
  e.state.connections.banana.activePresetId='relay-a';
  e.context.storyboardLoadLogToWorkbench({snapshot:snap,source:'banana'});
  const group=e.state.connections.banana;
  assert.equal(group.draft.protocol,'openai-images');assert.equal(group.draft.baseUrl,'https://relay.example/v1');
  assert.equal(group.activePresetId,'');assert.equal(group.draft.credentialId,'local-secret-ref');
  assert.equal(e.context.storyboardDraftApiKeys.has('banana'),false);
});

test('protocol switching preserves model/native values/key and does not start extraction, generation or network',()=>{
  const e=harness(undefined,{storyboardCaptureWorkbench:()=>{}}),root={isConnected:true};
  const before=plain(e.state.profiles.banana);
  e.context.storyboardChangeConnectionProtocol(root,'gemini-images');
  assert.equal(e.state.connections.banana.draft.protocol,'gemini-images');
  assert.equal(e.state.connections.banana.draft.imageProtocolVersion,undefined);
  e.context.storyboardChangeConnectionProtocol(root,'openai-images');
  assert.equal(e.state.connections.banana.draft.imageProtocolVersion,1);
  assert.deepEqual(plain(e.state.profiles.banana),before);
  assert.equal(e.context.storyboardDraftApiKeys.get('banana'),'typed-local-key');
  e.state.connections.banana.draft.baseUrl=storyboard.STORYBOARD_PROVIDER_REGISTRY.banana.defaultBaseUrl;
  e.context.storyboardChangeConnectionProtocol(root,'openai-images');
  assert.equal(e.state.connections.banana.draft.baseUrl,'');
});

test('named preset saves protocol without a model change; delayed name confirmation cannot save a different connection',async()=>{
  for(const change of [false,true]){
    const gate=deferred(),e=harness(undefined,{storyboardCaptureWorkbench:()=>({profile:e.state.profiles.banana,workflowResult:{ok:true,removedFields:[]}}),
      promptInput:()=>gate.promise,storyboardRememberApiKey:async()=>{}});
    const root={isConnected:true,querySelector:()=>({value:'typed-local-key'})};
    const work=e.context.storyboardSaveConnectionPreset(root);
    if(change)e.state.connections.banana.draft.protocol='gemini-images';
    gate.resolve('My connection');await work;
    assert.equal(e.state.connections.banana.presets.length,change?0:1);
    if(!change){assert.equal(e.state.connections.banana.presets[0].protocol,'openai-images');assert.equal(e.state.connections.banana.presets[0].imageProtocolVersion,1);}
  }
});

test('fresh compatible gateway confirmation is required for each independent request; native protocols do not probe',async()=>{
  let calls=0;
  const e=harness(undefined,{featureRuntime:{load:async()=>({...service,probeQianmuImageCapabilities:async()=>{
    calls++;return service.probeQianmuImageCapabilities({fetchImpl:async()=>Response.json(imageGatewayCapabilities())});
  }})}});
  const job=e.context.storyboardCreateJob(e.state,e.state.profiles.banana);
  assert.equal(await e.context.storyboardConfirmGatewayModelBinding(job),0);assert.equal(calls,1);
  await e.context.storyboardConfirmGatewayModelBinding(job);assert.equal(calls,2);
  const native=structuredClone(job);native.connection.protocol='gemini-images';delete native.modelIdentity;
  await e.context.storyboardConfirmGatewayModelBinding(native);assert.equal(calls,2);
  e.context.featureRuntime={load:async()=>({...service,probeQianmuImageCapabilities:async()=>({status:'ready',protocolBinding:{version:0}})})};
  await assert.rejects(e.context.storyboardConfirmGatewayModelBinding(job),{code:'image_protocol_incompatible'});
});

test('actual connection check requires compatible-service confirmation before POST, retains key and ignores late results',async()=>{
  for(const mode of ['ready','old','stale']) {
    const gate=deferred(),sent=[],e=harness(undefined,{
      storyboardSaveConnection:async()=>true,storyboardResolveApiKey:async()=> 'typed-local-key',
      directImageRuntime:async()=>({checkDirectImageConnection:async()=>{await gate.promise;throw new Error('cors');},isDirectImageTransportError:()=>true}),
      featureRuntime:{load:async()=>({...service,probeQianmuImageCapabilities:async()=>service.probeQianmuImageCapabilities({fetchImpl:async()=>Response.json(mode==='old'?{ok:true,plugin:'qianmu-tts',version:3,modelBinding:{version:1}}:imageGatewayCapabilities())})})},
      fetch:async(url,init)=>{sent.push([url,JSON.parse(init.body)]);return Response.json({ok:true,verified:false});},
    });
    const input={value:'typed-local-key'},root={isConnected:true,querySelector:()=>input,querySelectorAll:()=>[input]};
    const work=e.context.storyboardCheckConnection(root);
    if(mode==='stale') {e.context.storyboardKeyInputRevision++;input.value='newer-key';}
    gate.resolve();await work;
    assert.equal(sent.length,mode==='ready'?1:0);
    if(mode==='ready') {assert.equal(sent[0][1].protocol,'openai-images');assert.equal(sent[0][1].imageProtocolVersion,1);assert.equal(e.notices.at(-1),'地址可达，请以生图验证');}
    if(mode==='old')assert.match(e.notices.at(-1),/增强服务/);
    if(mode==='stale'){assert.equal(e.notices.length,0);assert.equal(e.rendered.length,0);}
    assert.equal(input.value,mode==='stale'?'newer-key':'typed-local-key');
  }
});

test('actual model-picker gateway discovery uses compatible declaration and will not post to an old gateway',async()=>{
  for(const ready of [false,true]){
    let options,posts=0;
    const e=harness(undefined,{storyboardCredentialRevision:0,AbortController,setTimeout,clearTimeout,
      storyboardCaptureWorkbench:()=>{},storyboardResolveApiKey:async()=> 'key',
      directImageRuntime:async()=>({listDirectImageModels:async()=>{throw new Error('cors');},isDirectImageTransportError:()=>true}),
      featureRuntime:{load:async id=>id==='modelPicker'?{attachModelPicker:(_host,value)=>{options=value;return{open(){},isCurrent:value.isCurrent};}}:
        {...service,probeQianmuImageCapabilities:async()=>service.probeQianmuImageCapabilities({fetchImpl:async()=>Response.json(ready?imageGatewayCapabilities():{ok:true,plugin:'qianmu-tts',version:3,modelBinding:{version:1}})})}},
      fetch:async(_url,init)=>{posts++;const packet=JSON.parse(init.body);assert.equal(packet.modelFamily,'banana');assert.equal(packet.protocol,'openai-images');assert.equal(packet.imageProtocolVersion,1);return Response.json({ok:true,models:[]});},
    });
    const handlers={},host={isConnected:true,dataset:{storyboardModelPicker:'banana'},closest:()=>null,querySelector:()=>null,addEventListener:(name,handler)=>{handlers[name]=handler;}},root={isConnected:true,querySelectorAll:()=>[]};
    vm.runInContext(fn('bindStoryboardModelPicker'),e.context);
    e.context.bindStoryboardModelPicker(root,host,e.state);handlers.focusin({target:{matches:()=>true}});
    await new Promise(resolve=>setImmediate(resolve));
    if(ready)await options.fetchModels();else await assert.rejects(options.fetchModels(),{code:'image_protocol_incompatible'});
    assert.equal(posts,ready?1:0);
  }
});

test('provider plan projects compatible controls and preserves opaque aliases; no native metadata enters provider options',()=>{
  const model='vendor/precise-alias',capability=storyboard.STORYBOARD_PROVIDER_REGISTRY.seedream.defaultModel;
  const input={providerId:'seedream',remoteModelId:model,capabilityModelId:capability,prompt:'garden',connection:compatible(),
    params:{width:1024,height:1024,seed:0,watermark:true,imageSize:'2K',openaiQuality:'high',providerOptions:{imageProtocolVersion:1}}};
  const result=storyboard.buildStoryboardProviderPlan(input);
  assert.equal(result.gatewayRequest.model,model);assert.equal(result.gatewayRequest.imageProtocolVersion,1);
  assert.equal(result.gatewayRequest.parameters.quality,'high');assert.equal(result.gatewayRequest.parameters.seed,undefined);
  assert.deepEqual(result.gatewayRequest.parameters.providerOptions,{});
  assert.throws(()=>storyboard.buildStoryboardProviderPlan({...input,protocol:'ark-images'}),{code:'connection_protocol_mismatch'});
  assert.throws(()=>storyboard.buildStoryboardProviderPlan({...input,modelFamily:'novel'}),{code:'model_family_mismatch'});
});
