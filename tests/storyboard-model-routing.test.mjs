import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STORYBOARD_MODEL_REGISTRY,
  createStoryboardDefaults,
  normalizeStoryboardState,
  routeStoryboardShot,
} from '../qianmu-storyboard.js';

const browserSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

assert.deepEqual(
  STORYBOARD_MODEL_REGISTRY.novel.map((item) => item.id),
  [
    'nai-diffusion-3',
    'nai-diffusion-4-curated-preview',
    'nai-diffusion-4-full',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-4-5-full',
    'nai-diffusion-5-curated',
    'nai-diffusion-5-full',
  ],
  'NovelAI must expose only Anime V3 and later families',
);
assert.ok(STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-full').label.includes('💕'));
assert.ok(!STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-curated').label.includes('💕'));

const defaults = createStoryboardDefaults();
assert.equal(defaults.routing.enabled, false, 'the shot router must be opt-in');
assert.equal(STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-full').capabilities.contentPolicy, 'full');
assert.equal(STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-curated').capabilities.contentPolicy, 'filtered');

const routed = routeStoryboardShot({ shotType: 'portrait', sensitive: true }, {
  enabled: true,
  single: { providerId: 'novel', modelId: 'nai-diffusion-5-full' },
  rules: [
    { id: 'portrait', shotTypes: ['portrait'], sensitive: false, target: { providerId: 'openai', modelId: 'gpt-image-2' } },
  ],
});
assert.equal(routed.ruleId, 'portrait');
assert.equal(routed.modelId, 'gpt-image-2');

const disabled = routeStoryboardShot({ shotType: 'portrait', sensitive: true }, {
  enabled: false,
  single: { providerId: 'openai', modelId: 'gpt-image-2' },
  rules: [{ id: 'paid', target: { providerId: 'seedream', modelId: 'doubao-seedream-5-0-260128' } }],
});
assert.equal(disabled.providerId, 'openai');
assert.equal(disabled.ruleId, '');

const normalized = normalizeStoryboardState({
  schemaVersion: 4,
  source: 'novel',
  connections: {
    novel: {
      presets: [
        { id: 'v45-api', model: 'nai-diffusion-4-5-full', name: 'V4.5' },
        { id: 'v5-api', model: 'nai-diffusion-5-full', name: 'V5' },
      ],
    },
  },
  parameterPresets: [
    { id: 'v45-style', source: 'novel', profile: { model: 'nai-diffusion-4-5-full' } },
    { id: 'v5-style', source: 'novel', profile: { model: 'nai-diffusion-5-full' } },
  ],
  routing: {
    enabled: true,
    rules: [{
      id: 'route',
      target: { providerId: 'novel', modelId: 'nai-diffusion-4-5-full', connectionPresetId: 'v5-api', parameterPresetId: 'v5-style' },
    }],
  },
});
assert.equal(normalized.routing.rules[0].target.connectionPresetId, 'v5-api', 'a channel preset must remain selectable across models in the same provider');
assert.equal(normalized.routing.rules[0].target.parameterPresetId, '', 'a route cannot apply a style saved for another model');
assert.equal(Object.hasOwn(normalized.routing.rules[0], 'sensitive'), false, 'content sensitivity is internal metadata, not a routing switch');

assert.doesNotMatch(browserSource, /modelPresets[\s\S]*item\.model === profile\.model/, 'API presets must not be filtered by concrete model');
assert.match(browserSource, /const channelPresets = connection\.group\?\.presets \|\| \[\]/, 'API presets must be listed by image channel');
assert.match(browserSource, /const legacy = profileOverride \|\| state\.profiles\[providerId\][\s\S]*resolveStoryboardProfileBinding\(providerId, legacy\)/, 'the selected image model must come from drawing settings, not the connection preset');
assert.doesNotMatch(browserSource, /data-storyboard-routing-mode=/, 'the old single-model versus ensemble selector must be removed');
assert.match(browserSource, /class="sd-storyboard-routing-enabled"/, 'the router needs one master switch');
assert.match(browserSource, /class="text_pole sd-storyboard-route-model"/, 'each shot assignment must choose a concrete model');
assert.doesNotMatch(browserSource, /sd-storyboard-route-rating|仅 SFW|仅 NSFW/, 'the configuration UI must not expose redundant SFW/NSFW routing states');
assert.match(browserSource, /sd-storyboard-safety-notice[\s\S]*受限制模型[\s\S]*安全但叙事一致/, 'the safety policy must be explained once in configuration');
assert.match(browserSource, /function storyboardAdaptShotForModel[\s\S]*contentPolicy[\s\S]*safePrompt/, 'filtered models must receive the compiler-provided safe narrative equivalent');
assert.match(browserSource, /function renderStoryboardParameterVibes[\s\S]*!capabilities\.vibe[\s\S]*disabled/, 'Vibe selection must remain visible but disabled on unsupported NovelAI models');
assert.match(browserSource, /modelId: route\.modelId[\s\S]*connectionPresetId: route\.connectionPresetId/, 'the routed concrete model must reach the generation job');

console.log('Storyboard model and routing contract OK');
