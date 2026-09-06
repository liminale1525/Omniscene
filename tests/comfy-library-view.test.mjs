import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as storyboard from '../qianmu-storyboard.js';
import {renderComfyLibrary} from '../qianmu-comfy-library-view.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const document={workflow:JSON.stringify({save:{class_type:'SaveImage',inputs:{text:'%qianmu_prompt%'}}}),outputNodeId:'save',parameters:{width:'832',height:'1216'},positivePrompt:'prefix',negativePrompt:'exclusion'};
test('library list is metadata-only, escaped and blank without fabricated placeholder cards',()=>{
  const empty=renderComfyLibrary({rows:[]});assert.doesNotMatch(empty,/sd-comfy-library-row"|暂无|API Workflow JSON/);
  const html=renderComfyLibrary({rows:[{id:'a',name:'<script>bad</script>',version:1,nodes:4,totalBytes:100}]});
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/data-comfy-action="apply"/);assert.doesNotMatch(html,/data-comfy-action="purge"/);
});
test('full editor retains missing output, exposes history and separates saving from applying',()=>{
  const html=renderComfyLibrary({draft:{name:'x',revision:'r1',version:1,document:{...document,outputNodeId:'missing'},versions:[{revision:'r1',version:1,updatedAt:1}]}});
  assert.match(html,/value="missing" selected/);assert.match(html,/data-comfy-version/);assert.match(html,/data-comfy-action="save-copy"/);assert.doesNotMatch(html,/data-comfy-action="apply"/);
});
test('archived schemes expose explicit recovery/export/purge, not generation',()=>{
  const html=renderComfyLibrary({archived:true,rows:[{id:'a',name:'x',nodes:1,version:1,totalBytes:100}]});
  for(const action of ['restore','export','purge'])assert.ok(html.includes(`data-comfy-action="${action}"`));assert.doesNotMatch(html,/data-comfy-action="apply"/);
});
test('applying a recipe changes only the active Comfy snapshot/additions, never connections or other engine/queued data',()=>{
  const state=storyboard.createStoryboardDefaults();state.source='comfy';state.view='workflows';const connections=structuredClone(state.connections),other=structuredClone(state.profiles.novel),queued=structuredClone(state.profiles.comfy);
  const root={isConnected:true},notices=[],routes=[];const context=vm.createContext({...storyboard,storyboardState:()=>state,
    storyboardNavigate:(node,patch)=>{assert.equal(node,root);routes.push(patch);state.view=patch.view;},toast:message=>notices.push(message)});
  vm.runInContext(['storyboardPromptDefaultsKey','storyboardRememberPromptLayer','storyboardApplyComfyLibraryRecipe'].map(section).join('\n'),context);
  context.storyboardApplyComfyLibraryRecipe(root,state,{id:'a',revision:'b',name:'versioned',version:2,document});
  assert.equal(state.profiles.comfy.comfyWorkflow,document.workflow);assert.equal(state.profiles.comfy.width,'832');assert.equal(state.comfyLibrarySelection.version,2);
  assert.deepEqual(state.connections,connections);assert.deepEqual(state.profiles.novel,other);assert.equal(queued.comfyWorkflow,'');assert.equal(routes.length,1);assert.equal(notices.length,1);
  assert.equal(Object.values(state.promptDefaults)[0].positive,'prefix');assert.equal(Object.values(state.promptDefaults)[0].negative,'exclusion');
  assert.throws(()=>context.storyboardApplyComfyLibraryRecipe(root,state,{document}),/已切换/);
});
test('workflow route and selection survive reload without library documents in settings',()=>{
  const state=storyboard.createStoryboardDefaults();state.source='comfy';state.view='workflows';state.comfyLibrarySelection={id:'a',revision:'b',name:'x',version:2,workflow:'not-index-data'};
  const restored=storyboard.normalizeStoryboardState(state);assert.equal(restored.view,'workflows');assert.equal(restored.comfyLibrarySelection.version,2);assert.ok(!Object.hasOwn(restored.comfyLibrarySelection,'workflow'));
  restored.source='novel';assert.equal(storyboard.normalizeStoryboardState(restored).view,'create');
});
test('library and its document store are shipped lazily, and the existing legacy DB is unchanged',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  assert.ok(source.includes("load: () => import('./qianmu-comfy-library-view.js?v="));
  for(const file of ['qianmu-comfy-library.js','qianmu-comfy-library-view.js'])assert.ok(release.files.includes(file));
  const module=await readFile(new URL('../qianmu-comfy-library.js',import.meta.url),'utf8');assert.doesNotMatch(module,/qianmu-blobstore|fetch\(|\.generate\(/);
});
