import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createImageService } from '../qianmu-image-service.js';
import { imageServiceChannelKey } from '../qianmu-image-service-queue.js';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const actor=()=>({user:{profile:{handle:'alice',enabled:true}}});
const request={provider:'novel',apiKey:'mock-lifecycle-key',model:'nai-diffusion-5-full',prompt:'scene'};
const input=id=>({schemaVersion:1,attemptId:id,automatic:true,request});
const query=id=>({schemaVersion:1,attemptId:id,apiKey:request.apiKey});
const output=()=>({ok:true,provider:'novel',model:request.model,images:[{data:PNG}]});
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve:()=>resolve()};};
async function fixture(t){const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-lifecycle-test-'));
  t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);assert.match(path.basename(real),/^qianmu-lifecycle-test-/);await fs.rm(real,{recursive:true});});return root;}

test('graceful stop cancels queued tasks but awaits the paid original and persists it before returning',async t=>{
  const root=await fixture(t),gate=deferred(),started=deferred();let calls=0;t.after(gate.resolve);
  const service=createImageService({dataRoot:root,generate:async(_body,{beforeSubmit})=>{await beforeSubmit();calls++;started.resolve();await gate.promise;return output();}});
  const first=service.submit(actor(),input('paid'));await started.promise;
  const queued=service.submit(actor(),input('waiting'));const rejected=assert.rejects(queued,{submissionState:'not_submitted'});
  let stopped=false;const stopping=service.close().then(()=>{stopped=true;});
  await rejected;assert.equal(stopped,false);await assert.rejects(service.submit(actor(),input('after-stop')),/正在停止/);
  gate.resolve();const generated=await first;await stopping;assert.equal(generated.images[0].data,PNG);assert.equal(calls,1);
  const reopened=createImageService({dataRoot:root,generate:()=>assert.fail('no replay')});t.after(()=>reopened.close());
  const row=await reopened.query(actor(),query('paid'));assert.equal(row.task.status,'succeeded');assert.equal(row.task.resultStored,true);
  assert.equal((await reopened.result(actor(),query('paid'))).images[0].data,PNG);
});
test('stopping before upstream dispatch releases only the never-sent task',async t=>{
  const root=await fixture(t),gate=deferred(),started=deferred();let calls=0;t.after(gate.resolve);
  const service=createImageService({dataRoot:root,generate:async(_body,{beforeSubmit})=>{started.resolve();await gate.promise;await beforeSubmit();calls++;return output();}});
  const pending=service.submit(actor(),input('not-sent'));const refused=assert.rejects(pending,{submissionState:'not_submitted'});await started.promise;
  const stopping=service.close();gate.resolve();await refused;await stopping;assert.equal(calls,0);
  const reopened=createImageService({dataRoot:root});t.after(()=>reopened.close());const row=await reopened.query(actor(),query('not-sent'));
  assert.equal(row.task.status,'released');assert.equal(row.task.resultAvailable,false);
});
test('an actual process exit after authorization never auto-replays on the next service instance',async t=>{
  const root=await fixture(t),url=new URL('../qianmu-image-service.js',import.meta.url).href;
  const script=`import {createImageService} from ${JSON.stringify(url)};const service=createImageService({dataRoot:${JSON.stringify(root)},generate:async(_body,{beforeSubmit})=>{await beforeSubmit();process.exit(77);}});await service.submit(${JSON.stringify(actor())},${JSON.stringify(input('crashed'))});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostic='';child.stderr.on('data',data=>{diagnostic+=data;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,77,diagnostic);
  let calls=0;const reopened=createImageService({dataRoot:root,generate:()=>{calls++;return output();}});t.after(()=>reopened.close());
  const row=await reopened.query(actor(),query('crashed'));assert.equal(row.task.status,'submitting');assert.equal(row.task.live,false);assert.equal(calls,0);
  await assert.rejects(reopened.submit(actor(),input('must-not-replay')),{code:'image_service_busy',submissionState:'not_submitted'});assert.equal(calls,0);
  const listed=await reopened.catalog(actor(),{schemaVersion:1,expectedAccount:`st-user:${imageServiceChannelKey('alice')}`});
  assert.equal(listed.originals.length,1);assert.equal(listed.originals[0].canDiscard,false);
});
