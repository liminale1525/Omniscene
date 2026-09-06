import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createImageService, imageServiceTaskErrorPayload } from '../qianmu-image-service.js';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceResults } from '../qianmu-image-service-results.js';
import { imageServiceChannelKey } from '../qianmu-image-service-queue.js';
import { createImageServiceClient } from '../qianmu-image-service-client.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const actor = (handle='alice') => ({user:{profile:{handle,enabled:true}}});
const namespace = handle => `st-user:${imageServiceChannelKey(handle)}`;
const catalog = (handle='alice',extra={}) => ({schemaVersion:1,expectedAccount:namespace(handle),...extra});
const input = (attemptId,apiKey='mock-catalog-key') => ({schemaVersion:1,attemptId,automatic:true,request:{provider:'novel',apiKey,model:'nai-diffusion-5-full',prompt:'private scene text'}});
const output = () => ({ok:true,provider:'novel',model:'nai-diffusion-5-full',images:[{data:PNG}]});
const deferred = () => {let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve:()=>resolve()};};
async function fixture(t, options={}) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-catalog-test-'));
  const store=createImageServiceStore({dataRoot:root}),cache=createImageServiceResults({dataRoot:root,store});let posts=0;
  const service=createImageService({dataRoot:root,store,results:cache,generate:async(_body,{beforeSubmit})=>{await beforeSubmit();posts++;return output();},...options});
  t.after(async()=>{await service.close();const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);assert.match(path.basename(real),/^qianmu-catalog-test-/);await fs.rm(real,{recursive:true});});
  return {root,store,cache,service,get posts(){return posts;}};
}
function client(service,{handle='alice',confirm=async()=>true}={}) {
  let current=handle;const rows=new Map(),actions=[];
  const key=(ns,id)=>JSON.stringify([ns,id]);
  const store={get:async(ns,id)=>structuredClone(rows.get(key(ns,id))||null),list:async ns=>[...rows.values()].filter(row=>row.namespace===ns).map(row=>structuredClone(row)),
    put:async row=>rows.set(key(row.namespace,row.attemptId),structuredClone(row)),remove:async(ns,id)=>rows.delete(key(ns,id)),close(){}};
  const api=createImageServiceClient({store,account:async()=>`st-user:${current}`,locks:{request:(_name,_options,work)=>work({})},confirm,
    fetchImpl:async(url,init)=>{const action=url.split('/').at(-1);actions.push(action);try{return Response.json(await service[action](actor(current),JSON.parse(init.body)));}
      catch(error){const payload=imageServiceTaskErrorPayload(error);return Response.json(payload.body,{status:payload.status});}}});
  return {api,rows,actions,change:value=>{current=value;}};
}

test('empty server catalog is truly read-only and rejects account selection before IO',async t=>{
  const f=await fixture(t);const found=await f.service.catalog(actor(),catalog());
  assert.deepEqual(found.originals,[]);assert.deepEqual(found.tasks,[]);assert.equal(found.totals.tasks,0);assert.equal(f.posts,0);
  assert.deepEqual(await fs.readdir(f.root),[]);
  await assert.rejects(f.service.catalog(actor('bob'),catalog()),{status:401});
  await assert.rejects(f.service.catalog({},catalog()),{status:401});
  assert.deepEqual(await fs.readdir(f.root),[]);
});
test('directory and exact byte inventory are account-scoped without provider keys or narrative',async t=>{
  const f=await fixture(t);
  await f.service.submit(actor(),input('own-a'));await f.service.submit(actor(),input('own-b','another-private-key'));
  await f.service.submit(actor('bob'),input('other-account'));
  const found=await f.service.catalog(actor(),catalog());
  assert.equal(found.totals.count,2);assert.equal(found.totals.tasks,2);assert.equal(found.totals.imageBytes,2*Buffer.from(PNG,'base64').length);
  assert.ok(found.totals.metadataBytes>0);assert.equal(found.totals.reservedBytes,0);
  assert.equal(found.originals.length,2);assert.ok(found.originals.every(row=>row.resultAvailable&&row.canDiscard&&!row.live));
  assert.doesNotMatch(JSON.stringify(found),/other-account|mock-catalog-key|another-private-key|private scene text|sourceUrl|requestDigest|ownerId|fence|namespace/);
  assert.equal(f.posts,3);
});
test('task history pages cover each owned record exactly once across connections',async t=>{
  const f=await fixture(t);
  for(let index=0;index<7;index++)await f.service.submit(actor(),input(`task-${index}`,index%2?'first-key':'second-key'));
  await f.service.submit(actor('bob'),input('foreign','second-key'));
  const ids=[];let cursor=null;
  do {const page=await f.service.catalog(actor(),catalog('alice',{limit:2,cursor}));assert.equal(page.totals.tasks,7);assert.ok(page.tasks.length<=2);ids.push(...page.tasks.map(row=>row.attemptId));cursor=page.nextCursor;}while(cursor);
  assert.equal(new Set(ids).size,7);assert.equal(ids.length,7);assert.ok(!ids.includes('foreign'));
  await assert.rejects(f.service.catalog(actor(),catalog('alice',{limit:1000})),/分页/);
  await assert.rejects(f.service.catalog(actor(),catalog('alice',{cursor:{channelKey:'../../escape',attemptId:'a'}})),/分页/);
});
test('active slot reports reservation separately and rejects original deletion',async t=>{
  const gate=deferred(),started=deferred();t.after(gate.resolve);
  const f=await fixture(t,{generate:async(_body,{beforeSubmit})=>{await beforeSubmit();started.resolve();await gate.promise;return output();}});
  const work=f.service.submit(actor(),input('live'));await started.promise;
  const found=await f.service.catalog(actor(),catalog());const row=found.originals[0];
  assert.equal(row.live,true);assert.equal(row.canDiscard,false);assert.equal(row.resultAvailable,false);
  assert.equal(found.totals.imageBytes,0);assert.equal(found.totals.reservedBytes,48*1024*1024);
  await assert.rejects(f.service.discard(actor(),{...catalog(),attemptId:row.attemptId,taskLocator:row.taskLocator,confirmed:true,receipt:row.cacheReceipt}),/仍在运行/);
  gate.resolve();await work;
});
test('server catalog survives reopen and explicit cleanup preserves non-replayable ledger',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('restart'));await f.service.close();
  let posted=0;const next=createImageService({dataRoot:f.root,generate:()=>{posted++;throw Error('no re-generation');}});t.after(()=>next.close());
  const row=(await next.catalog(actor(),catalog())).originals[0];
  await next.discard(actor(),{...catalog(),attemptId:row.attemptId,taskLocator:row.taskLocator,confirmed:true,receipt:row.cacheReceipt});
  const after=await next.catalog(actor(),catalog());assert.equal(after.originals.length,0);assert.equal(after.totals.tasks,1);
  await assert.rejects(next.submit(actor(),input('restart')),/原图尚未暂存或已领取/);assert.equal(posted,0);
});
test('a fresh device discovers and receives the actual original without any provider resubmission',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('new-device'));
  const c=client(f.service),page=await c.api.catalog(),item={...page.originals[0],namespace:page.namespace};
  const remembered=await c.api.rememberOriginal(item,{chatKey:'chosen-chat'});
  assert.equal(remembered.originalOnly,true);assert.equal(remembered.version,2);assert.equal(remembered.snapshot.chatKey,'chosen-chat');assert.equal(remembered.snapshot.prompt,'');
  let saves=0;const received=await c.api.retrieve(item.attemptId,async(data,row,checkpoint)=>{
    assert.equal(data.images[0].data,PNG);assert.equal(row.originalOnly,true);assert.equal(row.snapshot.chatKey,'chosen-chat');
    saves++;await checkpoint([{id:'saved',url:'/user/images/recovered.png',recipeUnavailable:true}]);return true;
  },{namespace:page.namespace});
  assert.equal(received.archived,true);assert.equal(saves,1);assert.equal(c.rows.size,0);assert.equal(f.posts,1);
  assert.ok(!c.actions.includes('submit'));assert.equal((await f.service.catalog(actor(),catalog())).originals.length,0);
});
test('declined recovery or deletion retains original and creates no receipt',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('keep'));
  const c=client(f.service,{confirm:async()=>false}),page=await c.api.catalog(),item={...page.originals[0],namespace:page.namespace};
  assert.equal(await c.api.rememberOriginal(item,{chatKey:'chat'}),null);assert.equal(c.rows.size,0);
  assert.equal(await c.api.discardOriginal(item),false);assert.ok(!c.actions.includes('discard'));
  assert.equal((await f.service.catalog(actor(),catalog())).originals.length,1);
});
test('confirmed deletion removes only server originals, not local pending metadata or ledger',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('delete'));
  const c=client(f.service),page=await c.api.catalog(),item={...page.originals[0],namespace:page.namespace};
  await c.api.rememberOriginal(item,{chatKey:'chat'});assert.equal(await c.api.discardOriginal(item),true);
  assert.equal(c.rows.size,1);const after=await f.service.catalog(actor(),catalog());assert.equal(after.originals.length,0);assert.equal(after.totals.tasks,1);assert.equal(f.posts,1);
});
test('switching account after viewing a catalog cannot operate on stale selection',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('same'));await f.service.submit(actor('bob'),input('same'));
  const c=client(f.service),page=await c.api.catalog(),item={...page.originals[0],namespace:page.namespace};c.change('bob');const count=c.actions.length;
  await assert.rejects(c.api.rememberOriginal(item,{chatKey:'chat'}),/账户已变化/);await assert.rejects(c.api.discardOriginal(item),/账户已变化/);
  await assert.rejects(c.api.retrieve('same',()=>true,{namespace:page.namespace}),/账户已变化/);
  assert.equal(c.actions.length,count);assert.equal((await f.service.catalog(actor('bob'),catalog('bob'))).originals.length,1);
});
test('account identity is checked again after inventory finishes',async t=>{
  const f=await fixture(t),request=actor();await f.service.submit(request,input('owner'));
  const original=f.cache.inventory;f.cache.inventory=async(...args)=>{const value=await original(...args);request.user.profile.handle='bob';return value;};
  await assert.rejects(f.service.catalog(request,catalog()),{status:401});
});
test('catalog has bounded concurrency and never installs a startup polling loop',async t=>{
  const f=await fixture(t),gate=deferred(),begun=deferred();let calls=0;t.after(gate.resolve);
  const original=f.cache.inventory;f.cache.inventory=async(...args)=>{if(++calls===2)begun.resolve();await gate.promise;return original(...args);};
  const a=f.service.catalog(actor(),catalog()),b=f.service.catalog(actor(),catalog());await begun.promise;
  await assert.rejects(f.service.catalog(actor(),catalog()),/正在读取/);gate.resolve();await Promise.all([a,b]);assert.equal(f.posts,0);
});
test('corrupt result metadata cannot be silently omitted or deleted by inventory',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('corrupt'));
  const resultRoot=path.join(f.root,'.qianmu-service','image-results-v1'),[folder]=await fs.readdir(resultRoot);
  const target=path.join(resultRoot,folder,'manifest.json');await fs.writeFile(target,'null');
  await assert.rejects(f.service.catalog(actor(),catalog()),/身份无效/);assert.equal(await fs.readFile(target,'utf8'),'null');assert.equal(f.posts,1);
});
test('hard-linked manifests are rejected without modifying the linked file',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('linked'));
  const resultRoot=path.join(f.root,'.qianmu-service','image-results-v1'),[folder]=await fs.readdir(resultRoot);
  const target=path.join(resultRoot,folder,'manifest.json'),backup=path.join(f.root,'preserve.json'),original=await fs.readFile(target);
  await fs.link(target,backup);await assert.rejects(f.service.catalog(actor(),catalog()),/暂存清单无法核查/);
  assert.deepEqual(await fs.readFile(backup),original);assert.equal(f.posts,1);
});
test('existing local recipe wins over discovery and is never overwritten by an empty recovery snapshot',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('local-full'));
  const c=client(f.service,{confirm:()=>assert.fail('existing recipe must not ask original-only consent')}),page=await c.api.catalog(),item={...page.originals[0],namespace:page.namespace};
  const key=JSON.stringify([page.namespace,item.attemptId]),original={version:1,namespace:page.namespace,attemptId:item.attemptId,channelKey:item.taskLocator.channelKey,status:'submitted',originalOnly:false,
    createdAt:10,snapshot:{prompt:'saved local prompt',chatKey:'original-chat'},archiveRecords:[]};c.rows.set(key,original);
  const saved=await c.api.rememberOriginal(item,{chatKey:'different-chat'});assert.equal(saved.originalOnly,false);assert.equal(saved.snapshot.prompt,'saved local prompt');assert.equal(saved.snapshot.chatKey,'original-chat');
  item.taskLocator.channelKey='f'.repeat(64);await assert.rejects(c.api.rememberOriginal(item,{chatKey:'different-chat'}),/另一连接/);assert.deepEqual(c.rows.get(key),original);
});
test('retained remote URL appears only as availability, never as a signed address in inventory',async t=>{
  const f=await fixture(t,{generate:async(_body,{beforeSubmit})=>{await beforeSubmit();return {ok:true,provider:'novel',model:'nai-diffusion-5-full',images:[{url:'https://media.example.test/private.png?signature=secret'}]};},materialize:async()=>{throw Error('offline');}});
  await f.service.submit(actor(),input('remote'));
  const page=await f.service.catalog(actor(),catalog());assert.equal(page.originals[0].resultAvailable,true);assert.equal(page.originals[0].resultStored,false);
  assert.equal(page.totals.imageBytes,0);assert.equal(page.totals.reservedBytes,48*1024*1024);assert.doesNotMatch(JSON.stringify(page),/signature|secret|media.example/);
});
test('a late account switch at confirmation cannot discard the cached original',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('confirm-race'));
  let c;c=client(f.service,{confirm:async()=>{c.change('bob');return true;}});
  const page=await c.api.catalog(),item={...page.originals[0],namespace:page.namespace};
  await assert.rejects(c.api.discardOriginal(item),/账户已变化/);assert.ok(!c.actions.includes('discard'));assert.equal((await f.service.catalog(actor(),catalog())).originals.length,1);
});
test('cleanup and stale receipts cannot remove an original while it is being received',async t=>{
  const f=await fixture(t);await f.service.submit(actor(),input('receiving'));
  const page=await f.service.catalog(actor(),catalog()),row=page.originals[0],args={...catalog(),attemptId:row.attemptId,taskLocator:row.taskLocator};
  await assert.rejects(f.service.discard(actor(),{...args,confirmed:true,receipt:'0'.repeat(64)}),/已变化/);
  const gate=deferred(),started=deferred();t.after(gate.resolve);const original=f.cache.load;
  f.cache.load=async(...values)=>{started.resolve();await gate.promise;return original(...values);};
  const receiving=f.service.result(actor(),args);await started.promise;
  await assert.rejects(f.service.discard(actor(),{...args,confirmed:true,receipt:row.cacheReceipt}),/仍在运行/);
  gate.resolve();await receiving;assert.equal(f.posts,1);
});
test('installed plugin actually registers authenticated catalog and declares its capability',async t=>{
  const f=await fixture(t),plugin=await import('../server-plugin.js'),routes=new Map();
  await plugin.init({get:(name,callback)=>routes.set(`GET ${name}`,callback),post:(name,callback)=>routes.set(`POST ${name}`,callback)},{dataRoot:f.root});
  const response=()=>({headers:{},body:null,statusCode:200,set(name,value){this.headers[name]=value;return this;},status(value){this.statusCode=value;return this;},json(body){this.body=body;this.writableEnded=true;return this;}});
  try{
    const capability=response();await routes.get('GET /image/tasks/capabilities')(actor(),capability);
    assert.equal(capability.body.catalogVersion,1);assert.equal(capability.headers['Cache-Control'],'no-store');
    const listed=response();await routes.get('POST /image/tasks/catalog')({...actor(),body:catalog()},listed);
    assert.equal(listed.body.ok,true);assert.deepEqual(listed.body.originals,[]);assert.equal(listed.headers['X-Content-Type-Options'],'nosniff');
    assert.deepEqual(await fs.readdir(f.root),[]);assert.equal(f.posts,0);
  }finally{await plugin.exit();}
});
