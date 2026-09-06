import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createImageServiceClient, createImageServiceClientStore } from '../qianmu-image-service-client.js';
import { normalizeStoryboardState, sanitizeStoryboardSnapshot } from '../qianmu-storyboard.js';
import { confirmImageAttemptResult, claimImageAttempt, beginImageAttempt } from '../qianmu-image-attempts.js';

const capability = { ok: true, schemaVersion: 1, taskLocatorVersion: 1, accountBindingVersion: 1, scope: 'coordinated-endpoints-only', providers: ['novel'], protocols: ['novelai'], resultRetrieval: true, resultAcknowledgement: true };
const request = { provider: 'novel', protocol: 'novelai', apiKey: 'mock-only-key', model: 'nai-diffusion-5-full', prompt: 'garden' };
const job = (extra = {}) => ({ id: 'job-a', source: 'novel', logId: 'log-a', prompt: 'garden', target: 'gallery', chatKey: 'chat-a', automatic: false,
  profile: { model: request.model }, payload: { prompt: 'garden', parameters: { count: 1 } }, connection: { credentialId: 'mock-credential', baseUrl: 'https://image.invalid', imageTransport: 'service' },
  imageAdmission: { namespace: 'st-user:alice' }, ...extra });
const image = attemptId => ({ ok: true, images: [{ data: 'aW1hZ2U=', mime: 'image/png' }], serviceTask: { attemptId, resultStored: true, receipt: 'a'.repeat(64) } });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => { let resolve; return { promise: new Promise(yes => { resolve = yes; }), resolve: value => resolve(value) }; };
function setup(options = {}) {
  const rows = new Map(), calls = [], held = new Map(); let namespace = 'st-user:alice';
  const key = (ns, attempt) => `${ns}/${attempt}`;
  const store = {
    async get(ns, attempt) { return structuredClone(rows.get(key(ns, attempt)) || null); },
    async list(ns) { return [...rows.values()].filter(row => row.namespace === ns).map(row => structuredClone(row)); },
    async put(row) { rows.set(key(row.namespace, row.attemptId), structuredClone(row)); },
    async remove(ns, attempt) { rows.delete(key(ns, attempt)); }, close() {},
  };
  const locks = { async request(name, options, work) {
    const current = held.get(name);
    if (current && (current.mode !== 'shared' || options.mode !== 'shared')) return work(null);
    const entry = current || {mode:options.mode,count:0}; entry.count++; held.set(name,entry);
    try { return await work({name}); } finally { if (--entry.count === 0) held.delete(name); }
  } };
  const account = async () => namespace;
  const fetchImpl = async (url, init) => {
    const action = url.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null;
    calls.push({ action, body, init });
    if (options.fetch) return options.fetch(action, body, init);
    return response(action === 'capabilities' ? capability : action === 'submit' || action === 'result' ? image(body.attemptId)
      : action === 'query' ? { ok: true, task: { resultAvailable: true } } : { ok: true });
  };
  const client = createImageServiceClient({ store, locks, account, fetchImpl, headers: () => ({ 'X-CSRF-Token': 'test', 'Content-Type': 'application/json' }), confirm: options.confirm });
  return { client, rows, calls, store, locks, account, fetchImpl, changeAccount: value => { namespace = value; } };
}
const submit = (s, extra = {}) => s.client.submit(job(), request, { beforeSubmit: async () => {}, deliver: async () => true, ...extra });

test('client is lazy; capability probe is read-only and sends no provider key', async () => {
  let opened = 0;
  createImageServiceClientStore({ indexedDB: { open() { opened++; } } });
  const s = setup(); assert.equal(opened, 0); assert.equal(s.calls.length, 0);
  await s.client.probe(); assert.equal(s.calls.length, 1); assert.equal(s.calls[0].init.method, 'GET'); assert.equal(s.calls[0].body, null);
});
test('unsupported backend fails before local dispatch and generation', async () => {
  for (const body of [{ ok: false }, { ...capability, taskLocatorVersion: 0 }, { ...capability, resultAcknowledgement: false }]) {
    const s = setup({ fetch: () => response(body) });
    await assert.rejects(submit(s), /增强服务/); assert.equal(s.calls.length, 1); assert.equal(s.rows.size, 0);
  }
});
test('request is persisted before authorization and ACK follows confirmed local archive', async () => {
  const s = setup(), order = [];
  const result = await submit(s, { beforeSubmit: async () => { order.push('authorized'); assert.equal((await s.client.list())[0].status, 'prepared'); },
    deliver: async (_data, row, checkpoint) => { assert.equal(s.calls.some(call => call.action === 'acknowledge'), false); order.push('archive'); await checkpoint([{ id: 'image-a', url: '/user/images/a.png' }]); return true; } });
  assert.deepEqual(order, ['authorized', 'archive']); assert.equal(result.archived, true); assert.equal(s.rows.size, 0);
  assert.deepEqual(s.calls.map(call => call.action), ['capabilities', 'submit', 'acknowledge']);
  assert.equal(s.calls[2].body.apiKey, undefined); assert.match(s.calls[2].body.taskLocator.channelKey, /^[a-f0-9]{64}$/);
});
test('storage refusal occurs before generation and never triggers alternate transport', async () => {
  const s = setup(); s.store.put = async () => { throw new Error('quota'); };
  await assert.rejects(submit(s), /quota/); assert.equal(s.calls.some(call => call.action === 'submit'), false);
});
test('lost submit response is kept for retrieval and never replayed', async () => {
  const s = setup({ fetch: (action, body) => { if (action === 'submit') throw new TypeError('lost'); return response(action === 'capabilities' ? capability : action === 'query' ? { ok: true, task: { resultAvailable: true } } : action === 'result' ? image(body.attemptId) : { ok: true }); } });
  await assert.rejects(submit(s), { submissionState: 'unknown' });
  await assert.rejects(submit(s), /原服务请求已存在/);
  const next = createImageServiceClient({ ...s, fetchImpl: s.fetchImpl });
  assert.equal((await next.retrieve('job-a', async () => true)).archived, true);
  assert.equal(s.calls.filter(call => call.action === 'submit').length, 1);
});
test('saving failure after a paid response preserves accepted state and original cache', async () => {
  const s = setup();
  await assert.rejects(submit(s, { deliver: async () => { throw new Error('disk full'); } }), { submissionState: 'accepted' });
  assert.equal(s.calls.some(call => call.action === 'acknowledge'), false); assert.equal(s.rows.size, 1);
  assert.equal((await s.client.list())[0].status, 'available');
});
test('partial or foreign delivery retains service image without ACK', async () => {
  const s = setup(); const result = await submit(s, { deliver: async (_data, _row, checkpoint) => { await checkpoint([{ id: 'saved', url: '/user/images/a.png' }]); return false; } });
  assert.equal(result.archived, false); assert.equal(s.rows.size, 1); assert.equal(s.calls.some(call => call.action === 'acknowledge'), false);
  let count = 0;
  await s.client.retrieve('job-a', async (_data, row) => { assert.equal(row.archiveRecords[0].id, 'saved'); count++; return true; });
  assert.equal(count, 1); assert.equal(s.calls.filter(call => call.action === 'submit').length, 1);
});
test('failed ACK retries only ACK and does not rearchive or regenerate', async () => {
  let acknowledgements = 0;
  const s = setup({ fetch: (action, body) => { if (action === 'acknowledge' && ++acknowledgements === 1) throw Error('lost ack'); return response(action === 'capabilities' ? capability : action === 'submit' ? image(body.attemptId) : { ok: true }); } });
  assert.equal((await submit(s)).archived, true); assert.equal((await s.client.list())[0].status, 'archived');
  await s.client.retrieve('job-a', () => assert.fail('already archived'));
  assert.deepEqual(s.calls.map(call => call.action), ['capabilities','submit','acknowledge','acknowledge']); assert.equal(s.rows.size, 0);
});
test('account switch after result cannot deliver or clean another account', async () => {
  const s = setup({ fetch: (action, body) => { if (action === 'submit') s.changeAccount('st-user:bob'); return response(action === 'capabilities' ? capability : image(body.attemptId)); } });
  await assert.rejects(submit(s, { deliver: () => assert.fail('account changed') }), /账户/);
  assert.equal((await s.client.list()).length, 0);
  await assert.rejects(s.client.retrieve('job-a', () => true), /未找到/);
  assert.equal(s.calls.some(call => call.action === 'acknowledge'), false);
});
test('second page cannot retrieve while the original service task is live', async t => {
  const gate = deferred(), begun = deferred();
  t.after(gate.resolve);
  const s = setup({ fetch: async (action, body) => { if (action === 'submit') { begun.resolve(); await gate.promise; } return response(action === 'capabilities' ? capability : image(body.attemptId)); } });
  const pending = submit(s, { deliver: async () => false }); await begun.promise;
  const other = createImageServiceClient({ ...s });
  await assert.rejects(other.retrieve('job-a', () => true), /正在处理/); gate.resolve(); await pending;
});
test('pending query cannot turn into another generation request', async () => {
  const s = setup({ fetch: (action, body) => response(action === 'capabilities' ? capability : action === 'submit' ? image(body.attemptId) : { ok: true, task: { live: true, resultAvailable: false } }) });
  await submit(s, { deliver: async () => false }); await assert.rejects(s.client.retrieve('job-a', () => true), /仍在生成/);
  assert.equal(s.calls.filter(call => call.action === 'submit').length, 1); assert.equal(s.calls.some(call => call.action === 'result'), false);
});
test('only explicit manual pre-submission confirmation allows a second submit', async () => {
  for (const approved of [false, true]) {
    let count = 0;
    const s = setup({ confirm: async () => approved, fetch: (action, body) => {
      if (action === 'submit' && ++count === 1) return response({ ok: false, code: 'image_service_confirmation_required', confirmation: 'a'.repeat(64), submissionState: 'not_submitted' }, 409);
      return response(action === 'capabilities' ? capability : action === 'submit' ? image(body.attemptId) : { ok: true });
    } });
    if (approved) await submit(s); else await assert.rejects(submit(s));
    assert.equal(count, approved ? 2 : 1);
  }
});
test('request snapshot is frozen across asynchronous preparation and excludes credentials', async () => {
  const s = setup(), value = job(), input = structuredClone(request);
  await s.client.submit(value, input, { beforeSubmit: async () => { input.prompt = 'changed'; value.payload.prompt = 'changed'; }, deliver: async (_data, row) => {
    assert.equal(row.snapshot.payload.prompt, 'garden'); assert.equal(JSON.stringify(row).includes('mock-only-key'), false); return false;
  } });
  assert.equal(s.calls.find(call => call.action === 'submit').body.request.prompt, 'garden');
});
test('connection mode and recovery locator persist in normalized snapshots', () => {
  const state = normalizeStoryboardState({ logs: [{ id: 'log-a', snapshot: { ...job(), serviceTask: { version: 1, attemptId: 'job-a' } } }],
    connections: { novel: { presets: [{ id: 'preset-a', options: { imageTransport: 'service' } }], draft: { options: { imageTransport: 'service' } } } } });
  assert.equal(state.connections.novel.draft.options.imageTransport, 'service');
  assert.equal(state.logs[0].snapshot.connection.imageTransport, 'service');
  assert.equal(state.logs[0].snapshot.serviceTask.attemptId, 'job-a');
});
test('exact recovered result settles old admission without granting a new dispatch', () => {
  const scope = { namespace: 'alice', chatKey: 'chat', messageKey: 'message', revisionId: 'rev' };
  let value = claimImageAttempt(null, scope, { attemptId: 'job', logicalShotId: 'shot', operationKey: 'shot', ownerId: 'old-page', kind: 'automatic', maxAutomatic: 1, imageCount: 1 }, 100).ledger;
  value = beginImageAttempt(value, scope, { attemptId: 'job', ownerId: 'old-page' }, 101).ledger;
  assert.equal(confirmImageAttemptResult(value, scope, { attemptId: 'job', logicalShotId: 'other' }, 102).ok, false);
  const result = confirmImageAttemptResult(value, scope, { attemptId: 'job', logicalShotId: 'shot' }, 102);
  assert.equal(result.ledger.entries[0].status, 'succeeded'); assert.equal(result.automaticUsed, 1);
});

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) { const found = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source); assert.ok(found, name); const tail = source.slice(found.index), next = tail.slice(1).search(/^(?:async )?function /m); return next < 0 ? tail : tail.slice(0,next+1); }
function deliverySetup({ foreign = false, failSave = false } = {}) {
  const gallery = [], rows = [], log = {}, notices = []; let writes = 0, saved = 0;
  const context = vm.createContext({ clone: structuredClone, sanitizeStoryboardSnapshot, storyboardPlanForJob: () => null, storyboardValidatedAnchor: () => ({ valid: !foreign, floor: foreign ? null : 2, linkState: foreign ? 'foreign' : 'active' }),
    storyboardSetPlanStatus() {}, storyboardPipelineStage() {}, storyboardFinishLog: (_log, status) => { log.status = status; },
    storyboardPersistGatewayImage: async () => { writes++; return '/user/images/a.png'; }, storyboardCreateRecord: (job, _log, url, index) => ({ id: 'new', taskId: job.id, imageIndex: index, url }),
    getChatKey: () => foreign ? 'other' : 'chat-a', ctx: () => ({ saveMetadata() {} }), storyboardGalleryRecords: () => gallery,
    saveMetadata: async () => { saved++; if (failSave && saved === 1) throw Error('metadata failed'); }, storyboardArchiveGallerySnapshots: async () => {},
    storyboardStoreDeferredDelivery: async (_job, records) => { rows.push(...records); return 'pending_chat'; }, toast: message => notices.push(message),
  });
  vm.runInContext(section('storyboardDeliverGatewayResult'), context);
  return { context, gallery, rows, log, notices, get writes() { return writes; } };
}
test('shared archival helper retries checkpointed records without duplicate images', async () => {
  const s = deliverySetup({ failSave: true }); let records = [];
  const options = () => ({ service: true, archiveRecords: records, checkpoint: async value => { records = structuredClone(value); } });
  await assert.rejects(s.context.storyboardDeliverGatewayResult(job(), {}, image('job-a'), options()), /metadata failed/);
  await s.context.storyboardDeliverGatewayResult(job(), {}, image('job-a'), options());
  assert.equal(s.writes, 1); assert.equal(s.gallery.length, 1); assert.equal(s.gallery[0].id, 'service-job-a-0');
});
test('shared archival helper defers a foreign chat and does not authorize ACK', async () => {
  const s = deliverySetup({ foreign: true });
  assert.equal(await s.context.storyboardDeliverGatewayResult(job(), {}, image('job-a'), { service: true }), false);
  assert.equal(s.gallery.length, 0); assert.equal(s.rows.length, 1);
});
test('multi-image recovery checkpoints each file and resumes only the unfinished image', async () => {
  const s=deliverySetup();let records=[],calls=0;
  s.context.storyboardPersistGatewayImage=async(_image,_job,index)=>{calls++;if(calls===2)throw Error('second save failed');return `/user/images/${index}.png`;};
  const data={...image('job-a'),images:[...image('job-a').images,...image('job-a').images]};
  const options=()=>({service:true,archiveRecords:records,checkpoint:async value=>{records=structuredClone(value);}});
  await assert.rejects(s.context.storyboardDeliverGatewayResult(job(),{},data,options()),/second save failed/);
  assert.equal(records.length,1);assert.equal(records[0].snapshot,undefined);
  await s.context.storyboardDeliverGatewayResult(job(),{},data,options());
  assert.equal(calls,3);assert.equal(s.gallery.length,2);assert.equal(s.gallery[0].snapshot.payload.prompt,'garden');
});
test('service UI keeps generation and original retrieval as distinct explicit actions', () => {
  assert.match(section('renderStoryboardModelCard'), /sd-storyboard-service-mode[\s\S]*浏览器优先[\s\S]*增强服务协调/);
  assert.match(section('storyboardRunJob'), /service\.submit/); assert.match(section('storyboardReceiveServiceImage'), /service\.retrieve/);
  assert.doesNotMatch(section('storyboardReceiveServiceImage'), /storyboardQueueJob|storyboardGenerate|generateDirectImage/);
  assert.match(section('renderStoryboardLogs'), /sd-storyboard-open-service-inbox/);
});

test('actual workbench job uses service transport and the shared archival helper exclusively', async () => {
  const s = setup(), d = deliverySetup(); let authorized = 0, acquired = 0;
  Object.assign(d.context, {
    storyboardState: () => ({enabled:true,automation:{autoCapture:true,autoGenerate:true}}),
    storyboardAdmission:{beforeSubmit:async()=>{authorized++;}}, storyboardSettleImageAdmission:async()=>{},
    storyboardResolveApiKey:async()=>request.apiKey, resolveStoryboardJobModelIdentity:()=>({modelFamily:'novel',protocol:'novelai'}),
    storyboardImageServiceRuntime:async()=>s.client, storyboardImageChannelRuntime:async()=>({run:async(_input,work)=>work({beforeSubmit:async()=>{acquired++;}})}),
    storyboardPrepareGatewayAssets:async()=>({}), storyboardGatewayRequest:()=>structuredClone(request),
    storyboardMarkLogGenerating(){}, saveSettings(){}, confirmDialog:async()=>false, MODULE_NAME:'test', console:{error(){},warn(){}},
    storyboardPipelineForLog:()=>null, directImageRuntime:()=>assert.fail('service mode must not call direct transport'),
  });
  vm.runInContext(section('storyboardRunJob'),d.context);
  const log={snapshot:job()}; await d.context.storyboardRunJob(job(),log);
  assert.equal(authorized,1,JSON.stringify(d.notices)); assert.equal(acquired,1); assert.equal(d.writes,1);
  assert.equal(d.gallery.length,1); assert.equal(d.log.status,'success'); assert.equal(log.snapshot.serviceTask.attemptId,'job-a');
  assert.deepEqual(s.calls.map(call=>call.action),['capabilities','submit','acknowledge']);
});
test('closed service client never completes a late archive or sends ACK', async () => {
  const s=setup();
  await assert.rejects(submit(s,{deliver:async(_data,_row,_checkpoint,guard)=>{s.client.close();await guard();assert.fail('closed');}}),{submissionState:'accepted'});
  assert.equal(s.calls.some(call=>call.action==='acknowledge'),false);
});
test('automatic work does not display or accept service uncertainty confirmation', async () => {
  const s=setup({confirm:()=>assert.fail('automatic consent'),fetch:action=>response(action==='capabilities'?capability:{ok:false,code:'image_service_confirmation_required',submissionState:'not_submitted',confirmation:'a'.repeat(64)},action==='capabilities'?200:409)});
  await assert.rejects(s.client.submit(job({automatic:true}),request,{beforeSubmit:async()=>{},deliver:()=>true}));
  assert.equal(s.calls.filter(call=>call.action==='submit').length,1);
});
test('UI mutations during capability probing do not alter stored or sent request', async () => {
  const gate=deferred(),begun=deferred();
  const s=setup({fetch:async(action,body)=>{if(action==='capabilities'){begun.resolve();await gate.promise;}return response(action==='capabilities'?capability:action==='submit'?image(body.attemptId):{ok:true});}});
  const value=job(),input=structuredClone(request);
  const running=s.client.submit(value,input,{beforeSubmit:async()=>{},deliver:async(_data,row)=>{assert.equal(row.snapshot.payload.prompt,'garden');return true;}});
  await begun.promise; input.prompt='different';value.payload.prompt='different';gate.resolve();await running;
  assert.equal(s.calls.find(call=>call.action==='submit').body.request.prompt,'garden');
});
test('removing a local receipt requires explicit consent and never clears server data', async () => {
  for(const accepted of [false,true]){
    const s=setup({confirm:async()=>accepted});await submit(s,{deliver:async()=>false});const count=s.calls.length;
    await s.client.dismiss('job-a');assert.equal(s.rows.size,accepted?0:1);assert.equal(s.calls.length,count);
  }
});
test('checkpoint retains exact redraw snapshot even after log pruning', async () => {
  const s=setup();
  const nested={...job(),profile:{model:request.model,steps:'28'},payload:{prompt:'garden',parameters:{sampler:'k_euler_ancestral',v4_prompt:{caption:{base_caption:'exact'}}}}};
  await submit(s,{deliver:async(_data,_row,checkpoint)=>{await checkpoint([{id:'saved',url:'/user/images/a.png',snapshot:nested}]);return false;}});
  await s.client.retrieve('job-a',async(_data,row)=>{assert.equal(row.archiveRecords[0].snapshot.payload.parameters.v4_prompt.caption.base_caption,'exact');return true;});
});
test('bulk local receipt cleanup cannot interleave with a live generation', async t => {
  const gate=deferred(),begun=deferred();t.after(gate.resolve);
  const s=setup({fetch:async(action,body)=>{if(action==='submit'){begun.resolve();await gate.promise;}return response(action==='capabilities'?capability:image(body.attemptId));}});
  const pending=submit(s,{deliver:async()=>false});await begun.promise;
  await assert.rejects(s.client.manage({remove:true}),/仍有生成或领取/);assert.equal(s.rows.size,1);
  gate.resolve();await pending;
  const count=s.calls.length;const stats=await s.client.manage({remove:true});
  assert.equal(stats.count,1);assert.ok(stats.bytes>0);assert.equal(s.rows.size,0);assert.equal(s.calls.length,count);
});

test('original-only recovery archives an image without invented recipe, prompt or paragraph binding',async()=>{
  const s=deliverySetup();let records=[];
  const original={...job(),originalOnly:true,target:'gallery',inlineByDefault:false};
  assert.equal(await s.context.storyboardDeliverGatewayResult(original,null,image(original.id),{service:true,checkpoint:async value=>{records=structuredClone(value);}}),true);
  const record=s.gallery[0];assert.equal(record.recipeUnavailable,true);assert.equal(record.origin,'service_recovered');assert.equal(record.inline,false);assert.equal(record.floor,null);
  for(const key of ['prompt','finalPrompt','snapshot','snapshotRef','sampler','steps','seed','connection','imageAdmission'])assert.equal(record[key],undefined,key);
  assert.equal(records[0].recipeUnavailable,true);assert.equal(s.writes,1);
});
test('original-only records cannot masquerade as precise-redraw recipes in any common entry',async()=>{
  const notices=[],context=vm.createContext({toast:message=>{notices.push(message);}});
  for(const name of ['storyboardSnapshotForRecord','storyboardReadSnapshotForRecord','storyboardLoadRecordToWorkbench','storyboardRedrawRecord','storyboardEditPrompt'])vm.runInContext(section(name),context);
  const record={recipeUnavailable:true,snapshot:{profile:{model:'invented'}}};
  assert.equal(context.storyboardSnapshotForRecord(record),null);assert.equal(await context.storyboardReadSnapshotForRecord(record),null);
  await context.storyboardLoadRecordToWorkbench(record);await context.storyboardRedrawRecord(record);await context.storyboardEditPrompt({record});
  assert.equal(notices.length,3);assert.ok(notices.every(item=>item.includes('未保留')));
});
test('old server without catalog gives an actionable update message and never submits',async()=>{
  const s=setup({fetch:()=>new Response('Not found',{status:404})});
  await assert.rejects(s.client.catalog(),/服务目录未就绪，请更新后端并重启 ST/);assert.deepEqual(s.calls.map(item=>item.action),['catalog']);
});
