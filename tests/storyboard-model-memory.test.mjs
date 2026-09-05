import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  STORYBOARD_MODEL_PROFILE_LIMIT,
  STORYBOARD_PROVIDER_REGISTRY,
  createStoryboardDefaults,
  normalizeStoryboardState,
  normalizeStoryboardParameterProfile,
  getStoryboardRememberedProfile,
  rememberStoryboardModelProfile,
  resolveStoryboardModelBinding,
  getStoryboardModel,
} from '../qianmu-storyboard.js';

const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full';

test('parameter memory returns detached values without changing state or order', () => {
  const memory = {};
  const profile = { model: V3, loaded: true, steps: '28', cfg: '0', seed: '0', ratio: '3:2' };
  assert.equal(rememberStoryboardModelProfile(memory, 'novel', profile), true);
  profile.steps = '99';
  const before = JSON.stringify(memory);
  const restored = getStoryboardRememberedProfile(memory, 'novel', V3);
  assert.equal(restored.steps, '28');
  assert.equal(restored.cfg, '0');
  assert.equal(restored.seed, '0');
  restored.steps = '12';
  assert.equal(JSON.stringify(memory), before);
  assert.equal(getStoryboardRememberedProfile(memory, 'novel', V45), null);
  assert.equal(JSON.stringify(memory), before);
});

test('all special object names are ordinary custom model data, including JSON reloads', () => {
  const memory = {};
  for (const [i, model] of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype'].entries()) {
    assert.equal(getStoryboardRememberedProfile(memory, 'openai', model), null);
    assert.equal(rememberStoryboardModelProfile(memory, 'openai', { model, openaiQuality: `quality-${i}` }), true);
    assert.equal(Object.hasOwn(memory.openai, model), true);
    assert.equal(getStoryboardRememberedProfile(memory, 'openai', model).openaiQuality, `quality-${i}`);
  }
  assert.equal(Object.getPrototypeOf(memory.openai), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, 'openaiQuality'), false);
  const state = normalizeStoryboardState(JSON.parse(JSON.stringify({ schemaVersion: 24, modelProfiles: memory })));
  assert.equal(Object.getPrototypeOf(state.modelProfiles.openai), Object.prototype);
  for (const model of ['__proto__', 'constructor', 'toString']) {
    assert.equal(getStoryboardRememberedProfile(state.modelProfiles, 'openai', model).model, model);
  }
  const again = normalizeStoryboardState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(again.modelProfiles, state.modelProfiles);
});

test('inherited buckets, model entries and parameter fields are never used', () => {
  const inheritedMemory = Object.create({ openai: { fake: { model: 'fake', cfg: '99' } } });
  assert.equal(getStoryboardRememberedProfile(inheritedMemory, 'openai', 'fake'), null);
  rememberStoryboardModelProfile(inheritedMemory, 'openai', { model: 'real', cfg: '0' });
  assert.equal(Object.hasOwn(inheritedMemory, 'openai'), true);
  assert.equal(getStoryboardRememberedProfile(inheritedMemory, 'openai', 'fake'), null);
  const memory = { openai: Object.create({ inherited: { cfg: '77' } }) };
  assert.equal(getStoryboardRememberedProfile(memory, 'openai', 'inherited'), null);
  const profile = normalizeStoryboardParameterProfile(Object.create({ loaded: true, steps: '88', comfyWorkflow: 'malicious' }), 'openai');
  assert.equal(profile.loaded, false);
  assert.equal(profile.steps, '');
  assert.equal(profile.comfyWorkflow, '');
});

test('unavailable, invalid and overlong IDs never fall back to a different model cache', () => {
  const memory = {};
  for (const [provider, model] of [['novel', 'unknown-alias'], ['constructor', 'gpt-image-2'], ['openai', ''], ['openai', 'x'.repeat(241)], ['openai', 'model\n'], ['openai', 42]]) {
    assert.equal(rememberStoryboardModelProfile(memory, provider, { model, steps: '40' }), false);
    assert.equal(getStoryboardRememberedProfile(memory, provider, model), null);
  }
  assert.deepEqual(memory, {});
  const model = 'x'.repeat(240);
  assert.equal(rememberStoryboardModelProfile(memory, 'openai', { model, cfg: '3' }), true);
  assert.equal(getStoryboardRememberedProfile(memory, 'openai', model).model, model);
});

test('writes enforce the 80-entry limit immediately and retain the edited item', () => {
  const memory = {};
  for (let i = 0; i < 80; i++) rememberStoryboardModelProfile(memory, 'openai', { model: `relay-${i}`, cfg: String(i) });
  rememberStoryboardModelProfile(memory, 'openai', { model: 'relay-0', cfg: 'updated' });
  rememberStoryboardModelProfile(memory, 'openai', { model: 'relay-new', cfg: 'new' });
  assert.equal(Object.keys(memory.openai).length, STORYBOARD_MODEL_PROFILE_LIMIT);
  assert.equal(getStoryboardRememberedProfile(memory, 'openai', 'relay-0').cfg, 'updated');
  assert.equal(getStoryboardRememberedProfile(memory, 'openai', 'relay-1'), null);
  assert.equal(getStoryboardRememberedProfile(memory, 'openai', 'relay-new').cfg, 'new');
  // Numeric IDs are enumerated first by JavaScript, but the current one must survive.
  rememberStoryboardModelProfile(memory, 'openai', { model: '0', cfg: 'numeric' });
  assert.equal(getStoryboardRememberedProfile(memory, 'openai', '0').cfg, 'numeric');
  assert.equal(Object.keys(memory.openai).length, STORYBOARD_MODEL_PROFILE_LIMIT);
});

test('normalization preserves legacy cache shape, last known values and active uncached model', () => {
  const state = normalizeStoryboardState({ schemaVersion: 24,
    profiles: { novel: { model: V3, loaded: true, steps: '31' } },
    modelProfiles: { novel: { [V45]: { steps: '24', cfg: '5.5' } } },
  });
  assert.equal(state.schemaVersion, 24);
  assert.equal(state.modelProfiles.novel[V45].steps, '24');
  assert.equal(state.modelProfiles.novel[V3].steps, '31');
  assert.equal(state.profiles.novel.model, V3);
  assert.deepEqual(normalizeStoryboardState(JSON.parse(JSON.stringify(state))).modelProfiles, state.modelProfiles);
});

test('cache pruning does not touch presets, current settings, connections or historical snapshots', () => {
  const memory = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`relay-${i}`, { model: `relay-${i}`, steps: String(i) }]));
  const original = {
    schemaVersion: 24, profiles: { openai: { model: 'active', openaiQuality: 'high' } },
    modelProfiles: { openai: memory },
    parameterPresets: [{ id: 'style', name: 'style', source: 'openai', profile: { model: 'relay-0', steps: '30' } }],
    connections: { openai: { activePresetId: 'conn', presets: [{ id: 'conn', name: 'connection', credentialId: 'credential-ref', baseUrl: 'https://relay.example/v1' }] } },
    logs: [{ id: 'log-a', status: 'success', source: 'openai', snapshot: { source: 'openai', profile: { model: 'relay-0', steps: '22' } } }],
  };
  const state = normalizeStoryboardState(structuredClone(original));
  assert.equal(Object.keys(state.modelProfiles.openai).length, 80);
  assert.equal(getStoryboardRememberedProfile(state.modelProfiles, 'openai', 'active').openaiQuality, 'high');
  assert.equal(state.parameterPresets[0].profile.model, 'relay-0');
  assert.equal(state.parameterPresets[0].profile.steps, '30');
  assert.equal(state.connections.openai.presets[0].credentialId, 'credential-ref');
  assert.equal(state.logs[0].snapshot.profile.model, 'relay-0');
  assert.equal(state.logs[0].snapshot.profile.steps, '22');
  assert.equal(Object.keys(original.modelProfiles.openai).length, 100);
});

test('profile cleanup is single-family, whitelisted and preserves legal parameter values', () => {
  const input = { model: V3, cfg: 0, seed: -1, novelSm: false, novelVarietyBoost: true, ratio: 'invalid', apiKey: 'secret' };
  const snapshot = structuredClone(input);
  const profile = normalizeStoryboardParameterProfile(input, 'novel');
  assert.equal(profile.cfg, '0');
  assert.equal(profile.seed, '-1');
  assert.equal(profile.novelSm, false);
  assert.equal(profile.novelVarietyBoost, true);
  assert.equal(profile.ratio, '1:1');
  assert.equal(Object.hasOwn(profile, 'apiKey'), false);
  assert.deepEqual(input, snapshot);
  assert.throws(() => normalizeStoryboardParameterProfile({}, '__proto__'));
});

test('Comfy workflow cache still strips credentials and returns detached workflow text', () => {
  const memory = {}, workflow = { '1': { class_type: 'Example', inputs: { prompt: 'garden', api_key: 'secret' } } };
  rememberStoryboardModelProfile(memory, 'comfy', { model: 'comfy-workflow', comfyWorkflow: JSON.stringify(workflow) });
  const restored = getStoryboardRememberedProfile(memory, 'comfy', 'comfy-workflow');
  assert.equal(restored.comfyWorkflow.includes('secret'), false);
  assert.equal(JSON.parse(restored.comfyWorkflow)['1'].inputs.prompt, 'garden');
  assert.match(restored.comfyWorkflowNotice, /已移除凭据字段/);
  restored.comfyWorkflow = '{}';
  assert.equal(JSON.parse(getStoryboardRememberedProfile(memory, 'comfy', 'comfy-workflow').comfyWorkflow)['1'].inputs.prompt, 'garden');
});

test('cache families remain isolated when profiles are edited', () => {
  const memory = {};
  rememberStoryboardModelProfile(memory, 'novel', { model: V3, steps: '28' });
  rememberStoryboardModelProfile(memory, 'openai', { model: V3, steps: '12' });
  assert.equal(getStoryboardRememberedProfile(memory, 'novel', V3).steps, '28');
  assert.equal(getStoryboardRememberedProfile(memory, 'openai', V3).steps, '12');
});

test('real model-change handler saves previous controls then restores the selected model', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const begin = source.indexOf("  root.querySelector('.sd-storyboard-model-select')?.addEventListener('change', (event) => {");
  const end = source.indexOf("  root.querySelector('.sd-storyboard-compiler-api')", begin);
  assert.ok(begin >= 0 && end > begin);
  const state = createStoryboardDefaults();
  state.profiles.novel = { ...state.profiles.novel, model: V3, loaded: true, steps: '28', cfg: '5' };
  rememberStoryboardModelProfile(state.modelProfiles, 'novel', { model: V45, loaded: true, steps: '24', cfg: '6' });
  let handler, requested, saves = 0, renders = 0, controls = { steps: '32', cfg: '0' };
  vm.runInNewContext(source.slice(begin, end), {
    root: { querySelector: () => ({ addEventListener: (type, fn) => { assert.equal(type, 'change'); handler = fn; } }) }, state,
    clone: structuredClone, createStoryboardDefaults, rememberStoryboardModelProfile, getStoryboardRememberedProfile, STORYBOARD_PROVIDER_REGISTRY,
    resolveStoryboardModelBinding, getStoryboardModel, toast: (message) => assert.fail(message),
    storyboardCaptureWorkbench: (_root, family, options) => {
      assert.equal(options.rememberModel, false);
      Object.assign(state.profiles[family], controls, { model: requested });
    },
    saveSettings: () => saves++, renderModal: () => renders++,
  });
  requested = V45;
  handler({ target: { value: requested } });
  assert.equal(state.profiles.novel.model, V45);
  assert.equal(state.profiles.novel.steps, '24');
  assert.equal(state.profiles.novel.cfg, '6');
  assert.equal(getStoryboardRememberedProfile(state.modelProfiles, 'novel', V3).steps, '32');
  controls = { steps: '26', cfg: '6.5' };
  requested = V3;
  handler({ target: { value: requested } });
  assert.equal(state.profiles.novel.steps, '32');
  assert.equal(state.profiles.novel.cfg, '0');
  assert.equal(getStoryboardRememberedProfile(state.modelProfiles, 'novel', V45).steps, '26');
  assert.equal(saves, 2);
  assert.equal(renders, 2);
  assert.equal(state.parameterPresetSelection.novel, '');
  // Before the first capture, the UI already shows the family default while stored model is blank.
  state.profiles.novel = { ...createStoryboardDefaults().profiles.novel };
  controls = { steps: '35', cfg: '4.5' };
  requested = V45;
  handler({ target: { value: requested } });
  assert.equal(getStoryboardRememberedProfile(state.modelProfiles, 'novel', STORYBOARD_PROVIDER_REGISTRY.novel.defaultModel).steps, '35');
});

test('workbench cache writes no longer use raw indexed assignments', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /modelProfiles\[sourceId\]\[/);
  assert.match(source, /rememberModel && profile\.model[\s\S]*rememberStoryboardModelProfile\(state\.modelProfiles, sourceId, profile\)/);
});
