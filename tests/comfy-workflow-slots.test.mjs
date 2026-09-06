import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { inspectComfyWorkflow, prepareComfyWorkflow } from '../qianmu-comfy-workflow.js';
import * as storyboard from '../qianmu-storyboard.js';
import { generateDirectImage, isDirectImageTransportError } from '../qianmu-image-direct.js';
import { generateImage } from '../qianmu-image-gateway.js';
import { createStoryboardFormFixture, storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const workflow = inputs => ({ '1': { class_type: 'TestNode', inputs, _meta: { title: '%qianmu_negative%' } } });
const basic = () => workflow({ text: '%qianmu_prompt%' });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const reference = () => ({ data: png, mime: 'image/png', name: 'reference.png' });
const request = (graph, extra = {}) => ({ provider: 'comfy', baseUrl: 'https://comfy.example', model: 'comfy-workflow', prompt: 'garden', parameters: { workflow: graph, pollIntervalMs: 250, timeoutMs: 15000 }, ...extra });

test('capabilities come from input slots, not metadata or names of nodes', () => {
  const graph = basic(), result = inspectComfyWorkflow(graph);
  assert.equal(result.ok, true); assert.deepEqual(result.slots, ['prompt']);
  for (const key of ['negative', 'size', 'count', 'cfg', 'reference', 'mask']) assert.equal(result.capabilities[key], false, key);
  graph['1'].inputs.more = [{ cfg: '%qianmu_scale%', width: '%qianmu_width%', refs: '%qianmu_reference_2%' }];
  const more = inspectComfyWorkflow(graph).capabilities;
  assert.equal(more.cfg, true); assert.equal(more.width, true); assert.equal(more.height, false); assert.equal(more.ratio, false);
  assert.equal(more.multipleReferences, true); assert.equal(more.referenceMode, 'workflow');
});

test('invalid, UI-format, oversized and deeply nested workflows fail without echoing their contents', () => {
  let nested = 'x'; for (let i = 0; i < 68; i++) nested = { child: nested };
  for (const value of ['{ secret', 'x'.repeat(2 * 1024 * 1024 + 1), [], {nodes: []}, {foo: 'not a graph'}, workflow({text: nested})]) {
    const result = inspectComfyWorkflow(value); assert.equal(result.ok, false); assert.doesNotMatch(result.message, /secret/);
  }
});

test('static input graphs stay available to edit but cannot silently ignore the requested picture', () => {
  const graph = workflow({ text: 'a fixed prompt' });
  assert.equal(inspectComfyWorkflow(graph).ok, true); assert.match(inspectComfyWorkflow(graph).message, /qianmu_prompt/);
  assert.throws(() => prepareComfyWorkflow(graph), {code: 'comfy_prompt_slot_missing'});
  assert.equal(graph['1'].inputs.text, 'a fixed prompt');
});

test('one-pass typed substitution does not reinterpret tokens inside the user prompt', () => {
  const graph = workflow({ text: 'scene: %qianmu_prompt%', negative: '%qianmu_negative%', cfg: '%qianmu_cfg%', scale: '%qianmu_scale%', seed: '%qianmu_seed%', width: '%qianmu_width%', count: '%qianmu_count%', link: ['2', 0] });
  const prepared = prepareComfyWorkflow(graph, {prompt: 'literal %qianmu_negative%', negativePrompt: 'noise', parameters: {cfg: '0', seed: '0', width: '832', count: 2}});
  const result = prepared.bind();
  assert.deepEqual(result['1'].inputs, {text: 'scene: literal %qianmu_negative%', negative: 'noise', cfg: 0, scale: 0, seed: 0, width: 832, count: 2, link: ['2', 0]});
  assert.equal(result['1']._meta.title, '%qianmu_negative%');
  assert.equal(graph['1'].inputs.cfg, '%qianmu_cfg%');
  result['1'].inputs.link[0] = 'mutated'; assert.equal(prepared.bind()['1'].inputs.link[0], '2');
});

test('missing numeric values use typed defaults and random seed is resolved once per preparation', () => {
  const prepared = prepareComfyWorkflow(workflow({text: '%qianmu_prompt%', cfg: '%qianmu_scale%', seed: '%qianmu_seed%', width: '%qianmu_width%'}), {parameters: {cfg: '', seed: -1, width: ''}});
  const a = prepared.bind()['1'].inputs, b = prepared.bind()['1'].inputs;
  assert.equal(a.cfg, 5); assert.equal(a.width, 1024); assert.ok(Number.isSafeInteger(a.seed) && a.seed >= 0); assert.equal(a.seed, b.seed);
});

test('only referenced parameters are validated and scale takes precedence over cfg', () => {
  assert.equal(prepareComfyWorkflow(workflow({text: '%qianmu_prompt%', cfg: '%qianmu_cfg%'}), {parameters: {scale: 7, cfg: 2}}).bind()['1'].inputs.cfg, 7);
  assert.throws(() => prepareComfyWorkflow(workflow({text: '%qianmu_prompt%', steps: '%qianmu_steps%'}), {parameters: {steps: 'bad'}}), {code: 'comfy_invalid_parameter'});
  assert.doesNotThrow(() => prepareComfyWorkflow(basic(), {parameters: {steps: 'bad'}}));
  assert.throws(() => prepareComfyWorkflow(workflow({text: '%qianmu_prompt%', s: '%qianmu_sampler%'})), {code: 'comfy_parameter_missing'});
  assert.throws(() => prepareComfyWorkflow(workflow({text: '%qianmu_prompt%', m: '%qianmu_model%'}), {model: 'comfy-workflow'}), {code: 'comfy_model_slot_unbound'});
});

const invalidBindings = [
  ['static prompt instead of binding', workflow({text: 'a fixed prompt'}), 0, 'comfy_prompt_slot_missing'],
  ['unknown slot', workflow({text: '%qianmu_prompt%', x: '%qianmu_secret%'}), 0, 'comfy_unknown_slot'],
  ['punctuation in unknown slot', workflow({text: '%qianmu_prompt%', x: '%qianmu_cfg.value%'}), 0, 'comfy_unknown_slot'],
  ['unfinished slot', workflow({text: '%qianmu_prompt%', x: '%qianmu_cfg'}), 0, 'comfy_unknown_slot'],
  ['out of range reference', workflow({text: '%qianmu_prompt%', x: '%qianmu_reference_17%'}), 1, 'comfy_unknown_slot'],
  ['embedded array slot', workflow({text: '%qianmu_prompt%', x: 'files: %qianmu_references%'}), 1, 'comfy_reference_slot_type'],
  ['missing first reference', workflow({text: '%qianmu_prompt%', x: '%qianmu_reference%'}), 0, 'comfy_reference_missing'],
  ['missing numbered reference', workflow({text: '%qianmu_prompt%', x: '%qianmu_reference_2%'}), 1, 'comfy_reference_missing'],
  ['missing reference list', workflow({text: '%qianmu_prompt%', x: '%qianmu_references%'}), 0, 'comfy_reference_missing'],
  ['unused selected reference', basic(), 1, 'comfy_reference_unused'],
  ['hole in numbered references', workflow({text: '%qianmu_prompt%', x: '%qianmu_reference_2%'}), 2, 'comfy_reference_unused'],
  ['reference count limit', workflow({text: '%qianmu_prompt%', x: '%qianmu_references%'}), 17, 'comfy_reference_count'],
];
for (const [name, graph, referenceCount, code] of invalidBindings) test(`${name} is rejected before DNS, upload and prompt submission on both paths`, async () => {
  for (const run of [generateDirectImage, generateImage]) {
    let calls = 0;
    await assert.rejects(() => run(request(graph, {referenceImages: Array.from({length: referenceCount}, reference)}), {
      resolveHost: async () => {calls++; throw new Error('must not resolve');}, fetchImpl: async () => {calls++; throw new Error('must not send');},
    }), error => { assert.equal(error.code, code); assert.equal(isDirectImageTransportError(error), false); return true; });
    assert.equal(calls, 0);
  }
});

test('array and numbered reference slots bind actual returned upload names, preserving array type', () => {
  const graph = workflow({text: '%qianmu_prompt%', list: '%qianmu_references%', first: '%qianmu_reference%', second: '%qianmu_reference_2%'});
  const prepared = prepareComfyWorkflow(graph, {referenceCount: 2});
  assert.throws(() => prepared.bind(['one.png']), {code: 'comfy_reference_missing'});
  const result = prepared.bind(['folder/one.png', 'two.png'])['1'].inputs;
  assert.deepEqual(result.list, ['folder/one.png', 'two.png']); assert.equal(result.first, 'folder/one.png'); assert.equal(result.second, 'two.png');
});

test('a corrupt later reference does not leave the first reference uploaded in direct mode', async () => {
  let calls = 0;
  await assert.rejects(() => generateDirectImage(request(workflow({text: '%qianmu_prompt%', refs: '%qianmu_references%'}), {
    referenceImages: [reference(), {...reference(), data: 'not@base64'}],
  }), {fetchImpl: async () => {calls++; throw new Error('must not upload');}}), {code: 'invalid_reference'});
  assert.equal(calls, 0);
});

test('direct and gateway submit the same graph and freeze inputs before the first upload', async () => {
  const results = [];
  for (const run of [generateDirectImage, generateImage]) {
    const graph = workflow({text: 'scene: %qianmu_prompt%', negative: '%qianmu_negative%', cfg: '%qianmu_cfg%', refs: '%qianmu_references%', seed: '%qianmu_seed%'});
    const input = request(graph, {negativePrompt: 'blur', referenceImages: [reference()], parameters: {workflow: graph, cfg: 0, seed: 42, pollIntervalMs: 250}});
    let uploads = 0;
    const output = await run(input, {resolveHost: async () => [{address: '8.8.8.8', family: 4}], waitImpl: async () => {}, fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/upload/image')) {
        uploads++; graph['1'].inputs.text = 'changed while waiting'; input.prompt = 'new prompt'; input.parameters.cfg = 10;
        return Response.json({name: 'actual.png', subfolder: 'uploads'});
      }
      if (path.endsWith('/prompt')) { results.push(JSON.parse(init.body).prompt); return Response.json({prompt_id: 'test'}); }
      if (path.endsWith('/history/test')) return Response.json({test: {status: {completed: true}, outputs: {out: {images: [{filename: 'done.png', type: 'output'}]}}}});
      if (path.endsWith('/view')) return new Response(Buffer.from(png, 'base64'), {headers: {'content-type': 'image/png'}});
      throw new Error('unexpected route');
    }});
    assert.equal(output.images.length, 1); assert.equal(uploads, 1);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0]['1'].inputs, {text: 'scene: garden', negative: 'blur', cfg: 0, refs: ['uploads/actual.png'], seed: 42});
});

test('workflow capabilities are recomputed after edits, with no global changes to other families', () => {
  const graph = basic();
  assert.equal(storyboard.getStoryboardCapabilities('comfy', '', graph).cfg, false);
  graph['1'].inputs.cfg = '%qianmu_cfg%'; assert.equal(storyboard.getStoryboardCapabilities('comfy', '', graph).cfg, true);
  assert.equal(storyboard.getStoryboardCapabilities('comfy', '', '').referenceMode, 'none');
  assert.equal(storyboard.getStoryboardCapabilities('novel', 'nai-diffusion-4-5-full', graph).supportsVibe, true);
});

test('production renderer exposes only wired controls and does not erase remembered settings', () => {
  const a = createStoryboardFormFixture({family: 'comfy', workflow: basic()});
  for (const field of ['width', 'height', 'count', 'steps', 'cfg', 'seed', 'sampler', 'scheduler']) assert.ok(!a.content.includes(`data-storyboard-field="${field}"`), field);
  assert.doesNotMatch(a.content, /class="text_pole sd-storyboard-negative/); assert.doesNotMatch(a.content, /data-storyboard-card="composition"/);
  const graph = workflow({text: '%qianmu_prompt%', negative: '%qianmu_negative%', cfg: '%qianmu_cfg%', width: '%qianmu_width%'});
  const b = createStoryboardFormFixture({family: 'comfy', workflow: graph});
  assert.match(b.content, /data-storyboard-field="cfg"/); assert.match(b.content, /data-storyboard-field="width"/); assert.match(b.content, /class="text_pole sd-storyboard-negative/);
  assert.equal(a.state.profiles.comfy.width, b.state.profiles.comfy.width);
});

test('planner filters to actual workflow capabilities and leaves the saved workflow intact', () => {
  const graph = workflow({text: '%qianmu_prompt%', width: '%qianmu_width%'}), before = structuredClone(graph);
  const plan = storyboard.buildStoryboardProviderPlan({providerId: 'comfy', prompt: 'garden', negative: 'blur', params: {workflow: graph, width: 832, height: 1216, cfg: 4, count: 3}});
  assert.equal(plan.gatewayRequest.parameters.width, 832); assert.equal(plan.gatewayRequest.parameters.height, undefined);
  assert.equal(plan.gatewayRequest.parameters.cfg, undefined); assert.equal(plan.gatewayRequest.parameters.count, 1); assert.equal(plan.gatewayRequest.negativePrompt, '');
  for (const field of ['negative', 'height', 'cfg', 'count']) assert.ok(plan.droppedParameters.includes(field), field);
  assert.deepEqual(graph, before);
});

test('real job payload and deterministic prompt compilation use the selected workflow, not generic Comfy flags', () => {
  const state = storyboard.createStoryboardDefaults(); state.source = 'comfy';
  const profile = state.profiles.comfy; profile.comfyWorkflow = JSON.stringify(basic()); profile.count = '3'; profile.cfg = '7';
  const context = vm.createContext({...storyboard, clone: structuredClone, storyboardSelectedArtistPreset: () => null, storyboardProviderPromptDefaults: () => ({positive: 'quality', negative: 'blur'})});
  vm.runInContext(storyboardFunctionSource('storyboardGenerationPayload'), context);
  const result = context.storyboardGenerationPayload(state, profile, {prompt: 'garden', negative: 'noise'});
  assert.equal(result.negative, ''); assert.equal(result.parameters.scale, ''); assert.equal(result.parameters.width, ''); assert.equal(result.parameters.count, 1);
  assert.equal(result.parameters.size, ''); assert.equal(result.parameters.aspectRatio, '');
  assert.equal(result.selectedVibeIds.length, 0); assert.equal(profile.cfg, '7'); assert.equal(profile.count, '3');
});

test('a workflow with only one size slot does not inherit a hidden automatic ratio policy', () => {
  const graph = workflow({text: '%qianmu_prompt%', width: '%qianmu_width%'});
  const result = storyboard.resolveStoryboardComposition({providerId: 'comfy', workflow: graph, width: '832', height: '1216', policy: {mode: 'fixed', fixedRatioId: '16:9'}, shot: {composition: {ratioId: '16:9'}}});
  assert.equal(result.source, 'workflow'); assert.equal(result.ratioId, ''); assert.equal(result.dimensions.width, 832); assert.equal(result.dimensions.height, 0);
  const compiled = storyboard.compileStoryboardPrompt({providerId: 'comfy', workflow: graph, shot: {scene: 'garden', composition: {ratioId: '16:9'}}});
  assert.doesNotMatch(compiled.prompt, /16:9/);
});

test('both adapters import one binder and the shared runtime is included in release files', async () => {
  for (const name of ['qianmu-image-direct.js', 'qianmu-image-gateway.js']) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(source, /from '\.\/qianmu-comfy-workflow\.js'/); assert.doesNotMatch(source, /function replaceWorkflowValues/);
  }
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.ok(release.files.includes('qianmu-comfy-workflow.js'));
});
