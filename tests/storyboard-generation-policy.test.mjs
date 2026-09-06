import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as board from '../qianmu-storyboard.js';
import {buildStoryboardPlanContractRequest} from '../qianmu-storyboard-contract.js';
import {createStoryboardFormFixture,storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
test('new installations get 1-3/2 while disabled legacy shot groups keep their original single-image behavior',()=>{
  assert.deepEqual(board.createStoryboardDefaults().generationPolicy,{version:1,minImages:1,maxImages:3,concurrency:2});
  for(const enabled of [false,true]){
    const state=board.normalizeStoryboardState({schemaVersion:24,routing:{enabled,maxShotsPerFloor:4,providerConcurrency:3}});
    assert.deepEqual(state.generationPolicy,{version:1,minImages:1,maxImages:enabled?4:1,concurrency:3});
    assert.equal(state.routing.maxShotsPerFloor,undefined);assert.equal(state.routing.providerConcurrency,undefined);
    const before=structuredClone(state.generationPolicy);board.normalizeStoryboardState(state);assert.deepEqual(state.generationPolicy,before);
  }
  const fixedLegacy=board.normalizeStoryboardState({schemaVersion:24,routing:{enabled:true,maxShotsPerFloor:4},compositionPolicy:{groupStrategy:'single'}});
  assert.equal(fixedLegacy.generationPolicy.maxImages,1,'fixing the old shared-frame bug must not increase automatic spending on upgrade');
});
test('policy is canonical even if obsolete routing budget reappears and min never exceeds max',()=>{
  const state=board.normalizeStoryboardState({schemaVersion:24,generationPolicy:{minImages:4,maxImages:2,concurrency:99},routing:{enabled:true,maxShotsPerFloor:4,providerConcurrency:1}});
  assert.deepEqual(state.generationPolicy,{version:1,minImages:2,maxImages:2,concurrency:4});
  for(const value of [-100,0,NaN,Infinity,'no',undefined,null,4.8]){
    const p=board.normalizeStoryboardGenerationPolicy({minImages:value,maxImages:value,concurrency:value});
    assert.ok(p.minImages>=1&&p.minImages<=p.maxImages&&p.maxImages<=4&&p.concurrency>=1&&p.concurrency<=4);
  }
});
test('actual workbench owns one budget card and one collapsed manual variant control',()=>{
  const {content}=createStoryboardFormFixture();
  assert.equal((content.match(/data-storyboard-card="generation"/g)||[]).length,1);
  assert.equal((content.match(/data-generation-field=/g)||[]).length,3);
  assert.equal((content.match(/data-storyboard-field="count"/g)||[]).length,1);
  assert.ok(content.indexOf('data-storyboard-card="generation"')>content.indexOf('data-storyboard-card="params"'));
  assert.ok(content.indexOf('data-storyboard-card="generation"')<content.indexOf('data-storyboard-card="composition"'));
  assert.match(content,/<details class="sd-storyboard-variants">/);
  assert.doesNotMatch(fn('renderStoryboardRouting'),/sd-storyboard-route-(?:max|concurrency)/);
});
test('shared-frame composition does not silently cap the number of grounded, distinct scenes to one',()=>{
  const shots=['garden','river','forest'].map((scene,i)=>({id:scene,subject:scene,scene,location:scene,narrativePurpose:`establish ${scene}`,sourceParagraphIds:[`p${i}`]}));
  const result=board.prepareStoryboardShotGroup({shots,policy:{groupStrategy:'single'},maxShots:2});
  assert.equal(result.shots.length,2);assert.equal(result.skipped[0].reason,'coverage_budget');
  const duplicate=board.prepareStoryboardShotGroup({shots:[shots[0],shots[0]],maxShots:4});
  assert.equal(duplicate.shots.length,1);assert.equal(duplicate.skipped[0].reason,'duplicate_coverage');
});
test('compiler constraints use same budget without requiring a shot group; minimum is a target, supplement stays one',()=>{
  const state=board.createStoryboardDefaults();state.generationPolicy={minImages:2,maxImages:4,concurrency:2};
  const context=vm.createContext({...board});vm.runInContext(fn('storyboardCompilerRequestConfig'),context);
  for(const enabled of [false,true]){
    state.routing.enabled=enabled;
    const config=context.storyboardCompilerRequestConfig(state,{model:'nai-diffusion-5-full'});
    assert.equal(config.minShots,2);assert.equal(config.maxShots,4);
    if(!enabled)assert.equal(config.groupInstruction,'');
    for(const manualSupplement of [false,true]){
      const request=buildStoryboardPlanContractRequest({paragraphs:['garden']},{...config,manualSupplement});
      const constraints=JSON.parse(request.messages[1].content).constraints;
      assert.equal(constraints.max_shots,manualSupplement?1:4);assert.equal(constraints.min_shots_target,manualSupplement?1:2);
    }
  }
});
test('real policy handlers keep min/max coherent and reject detached old-page edits',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const start=source.indexOf("  root.querySelectorAll('[data-generation-field]')");
  const end=source.indexOf("  root.querySelector('.sd-storyboard-route-template')",start);
  assert.ok(start>0&&end>start);
  const state=board.createStoryboardDefaults(),callbacks={};
  const fields=['minImages','maxImages','concurrency'].map(key=>({dataset:{generationField:key},value:'',addEventListener:(_name,cb)=>callbacks[key]=cb}));
  const root={isConnected:true,querySelectorAll:()=>fields};let saves=0,pumps=0;
  const context=vm.createContext({...board,state,root,storyboardState:()=>state,saveSettings:()=>saves++,renderModal:()=>{},storyboardQueue:[{}],storyboardPumpQueue:()=>pumps++});
  vm.runInContext(source.slice(start,end),context);
  fields[0].value='4';callbacks.minImages();assert.deepEqual(plain(state.generationPolicy),{version:1,minImages:4,maxImages:4,concurrency:2});
  fields[1].value='2';callbacks.maxImages();assert.equal(state.generationPolicy.minImages,2);
  fields[2].value='3';callbacks.concurrency();assert.equal(pumps,1);
  root.isConnected=false;fields[1].value='4';callbacks.maxImages();assert.equal(saves,3);assert.equal(state.generationPolicy.maxImages,2);
});
test('actual queue reads only the unified concurrency and keeps NAI globally serial within this page',()=>{
  const state=board.createStoryboardDefaults();state.generationPolicy.concurrency=3;state.routing.providerConcurrency=1;
  const queue=[{id:'n1',source:'novel'},{id:'n2',source:'novel'},{id:'a',source:'openai'},{id:'b',source:'banana'}],active=new Map(),started=[];
  const context=vm.createContext({...board,storyboardState:()=>state,storyboardQueue:queue,storyboardActiveJobs:active,storyboardBusy:false,renderModal:()=>{},storyboardRunQueuedJob:job=>started.push(job.id)});
  vm.runInContext(fn('storyboardPumpQueue'),context);context.storyboardPumpQueue();
  assert.deepEqual(started,['n1','a','b']);assert.equal(queue[0].id,'n2');
  state.generationPolicy.concurrency=1;active.delete('n1');context.storyboardPumpQueue();assert.equal(started.length,3);
  active.clear();context.storyboardPumpQueue();assert.equal(started.at(-1),'n2');
});

test('actual portable export/import preserves the policy and imports old packages with conservative counts',async()=>{
  const state=board.createStoryboardDefaults(),store={};state.generationPolicy={version:1,minImages:2,maxImages:4,concurrency:3};
  let exported=null;const noop=()=>{};
  const context=vm.createContext({...board,Blob,clone:structuredClone,storyboardState:()=>state,STORYBOARD_SOURCES:board.STORYBOARD_PROVIDER_REGISTRY,
    isPlainObject:v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)),confirmDialog:async()=>true,getChatKey:()=> 'chat-a',getChatStore:()=>store,
    storyboardHydratePipelineArchive:noop,storyboardHydrateGallerySnapshots:noop,storyboardPlansForPortableExport:async x=>x,
    storyboardGalleryRecords:()=>[],storyboardGalleryCollections:()=>[],storyboardUtilsModule:async()=>({}),
    saveSettings:noop,saveMetadata:noop,storyboardSchedulePlanArchive:noop,storyboardArchiveGallerySnapshots:noop,
    storyboardScheduleInlineRender:noop,renderModal:noop,toast:noop,fileStamp:()=> 'test',
    URL:{createObjectURL:blob=>{exported=blob;return 'blob:test';},revokeObjectURL:noop},
    document:{createElement:()=>({click:noop,remove:noop}),body:{appendChild:noop}},
  });
  vm.runInContext(['storyboardExportPackage','storyboardMergeById','storyboardImportPackage'].map(fn).join('\n'),context);
  await context.storyboardExportPackage();const text=await exported.text();
  assert.deepEqual(JSON.parse(text).settings.generationPolicy,{version:1,minImages:2,maxImages:4,concurrency:3});
  state.generationPolicy={version:1,minImages:1,maxImages:1,concurrency:1};
  await context.storyboardImportPackage({text:async()=>text});
  assert.deepEqual(plain(state.generationPolicy),{version:1,minImages:2,maxImages:4,concurrency:3});
  for(const enabled of [false,true]){
    const legacy=JSON.parse(text);delete legacy.settings.generationPolicy;legacy.settings.routing={enabled,maxShotsPerFloor:2,providerConcurrency:1};
    await context.storyboardImportPackage({text:async()=>JSON.stringify(legacy)});
    assert.deepEqual(plain(state.generationPolicy),{version:1,minImages:1,maxImages:enabled?2:1,concurrency:1});
  }
});
