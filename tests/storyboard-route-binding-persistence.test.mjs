import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStoryboardState, routeStoryboardShot, resolveStoryboardProfileBinding } from '../qianmu-storyboard.js';

const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full';
const target = { providerId: 'novel', modelId: 'relay/shared', capabilityModelId: V45, connectionPresetId: 'connection-a', parameterPresetId: 'style-a' };
function stateFor(value = target) {
  return normalizeStoryboardState({ routing: { enabled: true, single: { ...value }, rules: [{ id: 'portrait', enabled: true, shotTypes: ['portrait'], target: { ...value } }] } });
}

test('route aliases and both explicit references survive repeated save/reload normalization', () => {
  const first = stateFor(), restored = normalizeStoryboardState(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(restored.routing, first.routing);
  assert.deepEqual(restored.routing.rules[0].target, target);
  assert.deepEqual(routeStoryboardShot({ shotType: 'portrait' }, restored.routing), { ...target, ruleId: 'portrait' });
  assert.deepEqual(routeStoryboardShot({ shotType: 'environment' }, restored.routing), { ...target, ruleId: '' });
});

test('disabled routing ignores a broken rule and retains the single target identity', () => {
  const state = stateFor();
  state.routing.enabled = false;
  state.routing.rules[0].target.capabilityModelId = 'invalid';
  assert.deepEqual(routeStoryboardShot({ shotType: 'portrait' }, state.routing), { ...target, ruleId: '' });
});

test('legacy canonical routes infer capability, not the legacy connection model', () => {
  const state = stateFor({ providerId: 'novel', modelId: V3 });
  assert.equal(state.routing.single.modelId, V3);
  assert.equal(state.routing.single.capabilityModelId, V3);
  const empty = stateFor({ providerId: 'openai' });
  assert.equal(empty.routing.single.modelId, 'gpt-image-2');
  assert.equal(empty.routing.single.capabilityModelId, 'gpt-image-2');
});

test('legacy custom OpenAI aliases remain custom without requiring a migration', () => {
  const state = stateFor({ providerId: 'openai', modelId: 'provider/custom' });
  assert.equal(state.routing.single.modelId, 'provider/custom');
  assert.equal(state.routing.single.capabilityModelId, 'gpt-image-2');
});

for (const [label, input] of [
  ['unbound alias', { modelId: 'relay/unknown', capabilityModelId: '' }],
  ['known model conflict', { modelId: V3, capabilityModelId: V45 }],
  ['cross-family capability', { capabilityModelId: 'gpt-image-2' }],
  ['malformed capability', { capabilityModelId: {} }],
  ['whitespace capability', { capabilityModelId: ' ' }],
  ['malformed model', { modelId: {} }],
  ['control character', { modelId: 'relay/\nshared' }],
  ['overlong model', { modelId: 'x'.repeat(241) }],
  ['blank explicit model', { modelId: ' ' }],
]) {
  test(`route normalization remains fail-closed after two reloads: ${label}`, () => {
    let state = stateFor({ ...target, ...input });
    state = normalizeStoryboardState(JSON.parse(JSON.stringify(state)));
    const route = routeStoryboardShot({ shotType: 'portrait' }, state.routing);
    assert.throws(() => resolveStoryboardProfileBinding(route.providerId, { model: route.modelId, capabilityModelId: route.capabilityModelId }));
    assert.equal(route.connectionPresetId, 'connection-a');
    assert.equal(route.parameterPresetId, 'style-a');
  });
}
