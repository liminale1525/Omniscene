import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as storyboard from '../qianmu-storyboard.js';
import * as comfyView from '../qianmu-comfy-workbench.js';
import { createStoryboardFormFixture, storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
const graph={node:{class_type:'TestNode',inputs:{text:'%qianmu_prompt%',width:'%qianmu_width%',cfg:'%qianmu_cfg%'}}};

test('Comfy daily UI separates connection/workflow and only exposes real bound controls',()=>{
  const {content}=createStoryboardFormFixture({family:'comfy',workflow:graph});
  assert.match(content,/sd-comfy-workbench/);assert.match(content,/data-storyboard-engine="model"/);assert.match(content,/data-storyboard-engine="comfy"/);
  assert.match(content,/<b>连接<\/b>/);assert.match(content,/data-storyboard-card="comfy-workflow"/);assert.match(content,/sd-comfy-import-workflow/);
  assert.match(content,/data-storyboard-field="width"/);assert.match(content,/data-storyboard-field="cfg"/);
  assert.doesNotMatch(content,/data-storyboard-field="(?:height|sampler|scheduler|novelSm)"|sd-storyboard-model-picker|sd-storyboard-provider|sd-storyboard-tag-quick|sd-storyboard-open-artist-library|sd-storyboard-param-vibes/);
  assert.equal((content.match(/class="text_pole sd-storyboard-workflow"/g)||[]).length,1);
  assert.equal((content.match(/data-storyboard-field="comfyOutputNodeId"/g)||[]).length,1);
});

test('workflow settings default collapsed; blank/invalid documents remain repairable and markup is escaped',()=>{
  const base={profile:{comfyWorkflow:JSON.stringify(graph)},capabilities:{},workflowNodes:1};
  const collapsed=comfyView.renderComfyWorkbench(base);assert.doesNotMatch(collapsed, /data-storyboard-card="comfy-workflow" open/);
  for(const variant of [{profile:{comfyWorkflow:''}},{workflowNotice:'bad <script>'},{collapsed:{'comfy-workflow':false}}])assert.match(comfyView.renderComfyWorkbench({...base,...variant}),/data-storyboard-card="comfy-workflow" open/);
  const html=comfyView.renderComfyWorkbench({...base,profile:{comfyWorkflow:'{"value":"</textarea><script>bad()</script>"}'},promptLayer:{positive:'</textarea><script>bad()</script>'}});
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});

test('model interface does not list Comfy as another model family but keeps its API controls',()=>{
  const {content}=createStoryboardFormFixture({family:'novel'});
  assert.doesNotMatch(content,/<option value="comfy"/);assert.match(content,/sd-storyboard-provider/);assert.match(content,/sd-model-picker-input-row/);
  assert.doesNotMatch(content,/sd-comfy-workflow-card/);
});

test('engine changes save the old form and restore independent scroll without touching queued snapshots',()=>{
  const state=storyboard.createStoryboardDefaults();state.source='banana';const saved=[],renders=[];let loading=false;
  const root={isConnected:true,querySelector:()=>loading?{}:null};const queued=structuredClone(state.profiles),before=structuredClone(queued);
  const context=vm.createContext({...storyboard,storyboardState:()=>state,storyboardPageScrolls:new Map([['create',71],['create:comfy',192]]),storyboardPendingRestoreScroll:0,
    storyboardCaptureWorkbench:()=>saved.push(state.source),storyboardRememberPageScroll:()=>{},saveSettings:()=>{},renderModal:()=>renders.push(state.source)});
  vm.runInContext(['storyboardPageKey','storyboardChangeWorkbenchEngine'].map(section).join('\n'),context);
  context.storyboardChangeWorkbenchEngine(root,'comfy');assert.equal(state.source,'comfy');assert.equal(state.lastModelSource,'banana');assert.equal(context.storyboardPendingRestoreScroll,192);
  loading=true;context.storyboardChangeWorkbenchEngine(root,'model');assert.equal(state.source,'banana');assert.equal(context.storyboardPendingRestoreScroll,71);
  assert.deepEqual(saved,['banana']);assert.deepEqual(renders,['comfy','banana']);assert.deepEqual(queued,before);
  assert.equal(storyboard.normalizeStoryboardState({...state,source:'comfy',lastModelSource:'banana'}).lastModelSource,'banana');
  assert.equal(storyboard.normalizeStoryboardState({...state,source:'comfy',lastModelSource:'comfy'}).lastModelSource,'novel');
});

test('Comfy never invents provider prompt prefixes but remembers user supplied additions',()=>{
  const state=storyboard.createStoryboardDefaults();let context=vm.createContext({...storyboard,storyboardState:()=>state,STORYBOARD_GENERIC_PROMPT_DEFAULTS:{positive:'generic default',negative:'generic negative'},STORYBOARD_NAI_QUALITY_DEFAULTS:{},STORYBOARD_NAI_NEGATIVE_DEFAULTS:{}});
  vm.runInContext(['storyboardPromptDefaultsKey','storyboardProviderPromptDefaults'].map(section).join('\n'),context);
  assert.equal(context.storyboardProviderPromptDefaults('comfy','comfy-workflow').positive,'');
  state.promptDefaults[context.storyboardPromptDefaultsKey('comfy','comfy-workflow')]={positive:'my workflow words',negative:'my exclusion'};
  assert.equal(context.storyboardProviderPromptDefaults('comfy','comfy-workflow').positive,'my workflow words');
  assert.equal(context.storyboardProviderPromptDefaults('banana','gemini-2.5-flash-image').positive,'generic default');
});

test('lazy Comfy view never loads for another mode, repaints a departed page or retries itself forever',async()=>{
  for(const scenario of ['other','success','departed','error','retry']){
    const state={source:scenario==='other'?'novel':'comfy',view:'create'},page={isConnected:true},root={isConnected:true,querySelector:()=>page};let calls=0,renders=0;
    const context=vm.createContext({storyboardState:()=>state,storyboardComfyViewRuntime:null,storyboardComfyViewError:scenario==='retry'?'load_failed':'',renderModal:()=>renders++,
      featureRuntime:{load:async key=>{calls++;assert.equal(key,'comfyWorkbench');if(scenario==='departed')page.isConnected=false;if(scenario==='error')throw Error('network');return comfyView;}}});
    vm.runInContext(section('storyboardLoadComfyView'),context);
    await context.storyboardLoadComfyView(root,scenario==='retry');
    assert.equal(calls,scenario==='other'?0:1);assert.equal(renders,['success','error','retry'].includes(scenario)?1:0);
    await context.storyboardLoadComfyView(root);assert.equal(calls,scenario==='other'?0:1);
  }
});

test('import is data-only, bounded and cannot overwrite another editor after a delayed file read',async()=>{
  for(const scenario of ['valid','invalid','canvas','empty','large','departed','edited']){
    const state={source:'comfy',view:'create',collapsedCards:{}},field={value:'old',isConnected:true,dataset:{}},root={isConnected:true,querySelector:()=>field};let reads=0,saves=0,renders=0;const notices=[];
    const context=vm.createContext({...storyboard,storyboardState:()=>state,storyboardCaptureWorkbench:()=>saves++,saveSettings:()=>{},renderModal:()=>renders++,toast:text=>notices.push(text)});
    vm.runInContext(section('storyboardImportComfyWorkflow'),context);
    const file={size:scenario==='large'?2*1024*1024+1:50,text:async()=>{reads++;if(scenario==='departed')field.isConnected=false;if(scenario==='edited')field.value='new';return scenario==='invalid'?'{':scenario==='empty'?'{}':scenario==='canvas'?'{"nodes":[]}':JSON.stringify(graph);}};
    assert.equal(await context.storyboardImportComfyWorkflow(root,file),scenario==='valid');assert.equal(saves,scenario==='valid'?1:0);assert.equal(renders,scenario==='valid'?1:0);
    if(scenario==='large')assert.equal(reads,0);if(scenario==='invalid')assert.equal(field.value,'old');if(scenario==='edited')assert.equal(field.value,'new');
  }
});

test('Comfy title and source-scoped position are read-only and preserve existing page routes',()=>{
  const state={view:'create',source:'comfy'},context=vm.createContext({storyboardState:()=>state});
  vm.runInContext(['storyboardPageKey','storyboardPageTitle'].map(section).join('\n'),context);
  assert.equal(context.storyboardPageTitle(state),'COMFY WORKBENCH');assert.equal(context.storyboardPageKey(state),'create:comfy');
  state.source='novel';assert.equal(context.storyboardPageKey(state),'create');assert.equal(context.storyboardPageTitle(state),'STORYBOARD');
  state.view='logs';assert.equal(context.storyboardPageTitle(state),'LOGS');
});

test('independent view is an on-demand shipped module and existing form controls retain their scoped baseline',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),css=await readFile(new URL('../style.css',import.meta.url),'utf8'),release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  assert.match(source,/load: \(\) => import\('\.\/qianmu-comfy-workbench\.js\?v=/);assert.ok(release.files.includes('qianmu-comfy-workbench.js'));
  assert.match(css,/\.sd-storyboard-engine-modes[^{]*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(comfyView.renderComfyWorkbench({profile:{},capabilities:{}}),/<script|https?:\/\//);
});
