import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildStoryboardProviderPlan,
  getStoryboardBuiltinParameterPresets,
  getStoryboardCapabilities,
  getStoryboardNovelParameterSpec,
  normalizeStoryboardState,
} from '../qianmu-storyboard.js';

const v5Model = 'nai-diffusion-5-full';
const v45Model = 'nai-diffusion-4-5-full';
const v5Capabilities = getStoryboardCapabilities('novel', v5Model);
assert.equal(v5Capabilities.scheduler, false, 'V5 must not expose the legacy noise scheduler');
assert.equal(v5Capabilities.sm, false, 'V5 must not send legacy SMEA flags');
assert.equal(v5Capabilities.varietyBoost, false, 'V5 must not send a legacy variety flag');
assert.equal(v5Capabilities.cfgRescale, true);

const v5Spec = getStoryboardNovelParameterSpec(v5Model);
assert.deepEqual(v5Spec.samplers.map((item) => item.value), [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
]);
assert.equal(v5Spec.schedulers.length, 0);
assert.deepEqual(
  [v5Spec.defaults.steps, v5Spec.defaults.cfg, v5Spec.defaults.sampler],
  ['28', '8', 'k_euler_ancestral'],
);

const builtins = getStoryboardBuiltinParameterPresets('novel', v5Model);
assert.deepEqual(builtins.map((preset) => preset.name), ['官方默认', '千幕·均衡', '千幕·草图', '千幕·稳定细节']);
assert.ok(builtins.every((preset) => preset.readonly));
const normalizedBuiltin = normalizeStoryboardState({
  source: 'novel',
  profiles: { novel: { model: v5Model } },
  parameterPresetSelection: { novel: 'builtin:nai-v5-official' },
});
assert.equal(normalizedBuiltin.parameterPresetSelection.novel, 'builtin:nai-v5-official');
const wrongGeneration = normalizeStoryboardState({
  source: 'novel',
  profiles: { novel: { model: v45Model } },
  parameterPresetSelection: { novel: 'builtin:nai-v5-official' },
});
assert.equal(wrongGeneration.parameterPresetSelection.novel, '', 'built-in styles must be isolated by model generation');

const v5Plan = buildStoryboardProviderPlan({
  providerId: 'novel',
  connection: { baseUrl: 'https://image.novelai.net', model: v5Model },
  prompt: 'portrait',
  params: {
    sampler: 'k_euler_ancestral', scheduler: 'karras', cfgRescale: 0.3,
    novelSm: true, novelSmDyn: true, novelDecrisper: true, novelVarietyBoost: true,
  },
});
assert.equal(v5Plan.request.sampler, 'k_euler_ancestral');
assert.equal(v5Plan.request.scheduler, undefined);
assert.deepEqual(v5Plan.request.providerOptions, { cfg_rescale: 0.3 });
for (const field of ['scheduler', 'sm', 'sm_dyn', 'dynamic_thresholding', 'variety_boost']) {
  assert.ok(v5Plan.droppedParameters.includes(field), `V5 must report dropped ${field}`);
}

const v45Plan = buildStoryboardProviderPlan({
  providerId: 'novel',
  connection: { baseUrl: 'https://image.novelai.net', model: v45Model },
  prompt: 'portrait',
  params: { sampler: 'k_dpmpp_2m', scheduler: 'karras', cfgRescale: 0.2, novelSm: true, novelVarietyBoost: true },
});
assert.equal(v45Plan.request.scheduler, 'karras');
assert.equal(v45Plan.request.providerOptions.sm, true);
assert.equal(v45Plan.request.providerOptions.variety_boost, true);
assert.equal(v45Plan.request.providerOptions.cfg_rescale, 0.2);

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /const storyboardPageScrolls = new Map\(\)/);
assert.match(source, /function storyboardPageKey[\s\S]*function storyboardRememberPageScroll/);
assert.match(source, /function storyboardNavigate[\s\S]*storyboardPageScrolls\.get/);
assert.match(source, /sd-storyboard-titlebar[\s\S]*sd-storyboard-close/);
assert.doesNotMatch(source, /sd-storyboard-back|function storyboardBack|storyboardRouteStack/);
const navSource = source.slice(source.indexOf('function renderStoryboardNav'), source.indexOf('function storyboardConnectionState'));
assert.doesNotMatch(navSource, /sd-storyboard-exit/);

assert.match(source, /estimateTokens\(item\.instruction[\s\S]{0,1800}sd-storyboard-preset-token/);
assert.match(source, /sd-storyboard-preset-entry-more[\s\S]*sd-storyboard-copy-preset-entry/);
assert.match(source, /storyboardPresetUndo[\s\S]*sd-storyboard-undo-preset-entry/);
assert.match(source, /drop-before[\s\S]*drop-after/);
const presetBinding = source.slice(source.indexOf("const presetList = root.querySelector"), source.indexOf("root.querySelector('.sd-storyboard-export-presets')"));
assert.doesNotMatch(presetBinding, /confirmDialog\('删除条目'/, 'entry deletion must be immediate and undoable');
assert.doesNotMatch(presetBinding, /insertBefore\(dragged/, 'dragging must not continuously move DOM rows');

assert.match(source, /getStoryboardNovelParameterSpec\(profile\.capabilityModelId\)/);
assert.match(source, /data-storyboard-field="sampler">\$\{novelSamplerOptions\}/);
assert.match(source, /capabilities\.cfgRescale/);
assert.match(styles, /v1\.57 cascade guard/);
assert.match(styles, /sd-storyboard-preset-entry\.drop-before::before/);

console.log('Storyboard phase A contract OK');
