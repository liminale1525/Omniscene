import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  STORYBOARD_MODEL_PROFILE_LIMIT, STORYBOARD_PROVIDER_REGISTRY,
  createStoryboardDefaults, normalizeStoryboardState, normalizeStoryboardParameterProfile,
  getStoryboardRememberedProfile, rememberStoryboardModelProfile,
  resolveStoryboardModelBinding, resolveStoryboardJobModelIdentity, sanitizeStoryboardSnapshot,
  getStoryboardModel,
} from '../qianmu-storyboard.js';

const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full', V5 = 'nai-diffusion-5-full';
const alias = 'relay/shared-name';
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const count = (memory, family) => Object.keys(memory[family] || {}).length + (memory.bindings?.[family]?.length || 0);
const read = (memory, model = alias, capability = V3) => getStoryboardRememberedProfile(memory, 'novel', model, capability);
const write = (memory, capability = V3, values = {}) => rememberStoryboardModelProfile(memory, 'novel', {
  model: alias, capabilityModelId: capability, ...values,
});

test('the same remote name remembers each capability independently without duplicate legacy entries', () => {
  const memory = {};
  assert.equal(write(memory, V3, { cfg: '0', steps: '24', novelSm: true }), true);
  assert.equal(write(memory, V45, { cfg: '6', steps: '28', novelSm: false }), true);
  assert.equal(write(memory, V5, { cfg: '8', steps: '30' }), true);
  assert.equal(read(memory).cfg, '0');
  assert.equal(read(memory, alias, V45).cfg, '6');
  assert.equal(read(memory, alias, V5).cfg, '8');
  assert.equal(read(memory).novelSm, true);
  assert.equal(read(memory, alias, V45).novelSm, false);
  assert.equal(Object.keys(memory.novel).length, 0);
  assert.equal(count(memory, 'novel'), 3);
  assert.equal(getStoryboardRememberedProfile(memory, 'novel', alias), null, 'an unbound lookup must not guess a capability');
  assert.equal(write(memory, V3, { cfg: '3' }), true);
  assert.equal(read(memory).cfg, '3');
  assert.equal(read(memory, alias, V45).cfg, '6');
  assert.equal(count(memory, 'novel'), 3);
});

test('canonical and old OpenAI-compatible memory keeps the original readable shape', () => {
  const memory = {};
  rememberStoryboardModelProfile(memory, 'novel', { model: V3, steps: '31' });
  rememberStoryboardModelProfile(memory, 'novel', { model: V45, capabilityModelId: V45, cfg: '0' });
  rememberStoryboardModelProfile(memory, 'openai', { model: 'vendor/custom', openaiQuality: 'high' });
  assert.equal(memory.novel[V3].steps, '31');
  assert.equal(memory.novel[V45].cfg, '0');
  assert.equal(memory.openai['vendor/custom'].openaiQuality, 'high');
  assert.equal(Object.hasOwn(memory, 'bindings'), false);
  assert.equal(Object.hasOwn(memory.novel[V3], 'capabilityModelId'), false);
  assert.equal(read(memory, V3, V3).steps, '31');
});

test('model names cannot collide with the binding namespace, prototype keys or encoded tuple strings', () => {
  const memory = {};
  const names = ['bindings', '__proto__', 'constructor', 'toString', '["nai-diffusion-3","relay/shared-name"]'];
  for (const model of names) {
    assert.equal(write(memory, V3, { model, cfg: '3' }), true);
    assert.equal(write(memory, V45, { model, cfg: '4.5' }), true);
    assert.equal(rememberStoryboardModelProfile(memory, 'openai', { model, cfg: '2' }), true);
  }
  for (const model of names) {
    assert.equal(read(memory, model, V3).cfg, '3');
    assert.equal(read(memory, model, V45).cfg, '4.5');
    assert.equal(getStoryboardRememberedProfile(memory, 'openai', model).cfg, '2');
  }
  assert.equal(Object.getPrototypeOf(memory), Object.prototype);
  assert.equal(Object.getPrototypeOf(memory.openai), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, 'cfg'), false);
});

test('bound reads are detached, whitelisted and never reorder or create state', () => {
  const memory = {}, original = { model: alias, capabilityModelId: V3, cfg: '0', apiKey: 'do-not-store', unrelated: { nested: true } };
  rememberStoryboardModelProfile(memory, 'novel', original);
  const before = JSON.stringify(memory);
  original.cfg = '99';
  const restored = read(memory);
  restored.cfg = '88';
  assert.equal(read(memory).cfg, '0');
  assert.equal(Object.hasOwn(restored, 'apiKey'), false);
  assert.equal(Object.hasOwn(restored, 'unrelated'), false);
  assert.equal(JSON.stringify(memory), before);
  assert.equal(read(memory, 'missing', V45), null);
  assert.equal(JSON.stringify(memory), before);
});

test('invalid explicit bindings never enter memory or silently become another model', () => {
  const memory = {};
  for (const profile of [
    { model: alias }, { model: alias, capabilityModelId: 'gpt-image-2' },
    { model: V3, capabilityModelId: V45 }, { model: alias, capabilityModelId: ' ' },
    { model: alias, capabilityModelId: 0 }, { model: alias, capabilityModelId: {} },
    { model: 'x'.repeat(241), capabilityModelId: V3 }, { model: `\n${alias}`, capabilityModelId: V3 },
    { model: alias, capabilityModelId: `${V3}\n` },
  ]) {
    assert.equal(rememberStoryboardModelProfile(memory, 'novel', profile), false);
    assert.equal(getStoryboardRememberedProfile(memory, 'novel', profile.model, profile.capabilityModelId), null);
  }
  assert.equal(rememberStoryboardModelProfile(memory, '__proto__', { model: alias, capabilityModelId: V3 }), false);
  assert.deepEqual(memory, {});
});

test('inherited bindings, family arrays and identity fields are not read or written through', () => {
  const entry = { model: alias, capabilityModelId: V3, steps: '77' };
  const raw = { bindings: { novel: [entry] } };
  const inherited = Object.create(raw);
  assert.equal(read(inherited), null);
  write(inherited, V3, { steps: '28' });
  assert.equal(read(inherited).steps, '28');
  assert.equal(entry.steps, '77');
  assert.equal(read({ bindings: Object.create({ novel: [entry] }) }), null);
  assert.equal(read({ bindings: { novel: [Object.create(entry)] } }), null);
  assert.equal(rememberStoryboardModelProfile({}, 'novel', Object.create(entry)), false);
});

test('legacy and bound entries share one immediate per-family limit and keep the edited entry', () => {
  const memory = {};
  for (const model of [V3, V45, V5]) rememberStoryboardModelProfile(memory, 'novel', { model, steps: '28' });
  for (let i = 0; i < 100; i++) {
    write(memory, V3, { model: `alias-${i}`, steps: String(i) });
    assert.ok(count(memory, 'novel') <= STORYBOARD_MODEL_PROFILE_LIMIT);
  }
  assert.equal(count(memory, 'novel'), 80);
  assert.equal(read(memory, 'alias-99').steps, '99');
  write(memory, V3, { model: 'alias-20', steps: 'updated' });
  write(memory, V45, { model: 'alias-100', steps: '30' });
  assert.equal(read(memory, 'alias-20').steps, 'updated');
  assert.equal(read(memory, 'alias-21'), null);
  rememberStoryboardModelProfile(memory, 'novel', { model: V3, steps: 'canonical-updated' });
  assert.equal(read(memory, V3).steps, 'canonical-updated');
  assert.equal(count(memory, 'novel'), 80);
});

test('JSON reloads retain bound profile, named presets and historical task capability without remapping names', () => {
  const memory = {};
  write(memory, V3, { steps: '24' });
  write(memory, V45, { steps: '28' });
  const profile = { model: alias, capabilityModelId: V45, loaded: true, cfg: '0' };
  const snap = { source: 'novel', profile, connection: { id: 'original', credentialId: 'original-key', baseUrl: 'https://relay.example' }, payload: { prompt: 'original scene' } };
  snap.modelIdentity = resolveStoryboardJobModelIdentity(snap);
  const initial = { schemaVersion: 24, profiles: { novel: profile }, modelProfiles: memory,
    parameterPresets: [{ id: 'saved-style', name: 'saved style', source: 'novel', profile }],
    logs: [{ id: 'original-log', source: 'novel', status: 'success', snapshot: snap }],
  };
  const normalized = normalizeStoryboardState(JSON.parse(JSON.stringify(initial)));
  assert.equal(normalized.schemaVersion, 24);
  assert.equal(read(normalized.modelProfiles, alias, V3).steps, '24');
  assert.equal(read(normalized.modelProfiles, alias, V45).steps, '28');
  assert.equal(normalized.profiles.novel.capabilityModelId, V45);
  assert.equal(normalized.profiles.novel.model, alias);
  assert.equal(normalized.parameterPresets[0].profile.capabilityModelId, V45);
  assert.equal(normalized.logs[0].snapshot.profile.capabilityModelId, V45);
  assert.deepEqual(resolveStoryboardJobModelIdentity(normalized.logs[0].snapshot), snap.modelIdentity);
  assert.deepEqual(normalizeStoryboardState(JSON.parse(JSON.stringify(normalized))).modelProfiles, normalized.modelProfiles);
});

test('normalization of oversized caches retains the active identity, not just its remote name', () => {
  const bindings = Array.from({ length: 100 }, (_, i) => ({ model: `alias-${i}`, capabilityModelId: V3, steps: String(i) }));
  const state = normalizeStoryboardState({ schemaVersion: 24, modelProfiles: { bindings: { novel: bindings } },
    profiles: { novel: { model: 'alias-99', capabilityModelId: V45, steps: 'active' } },
    parameterPresets: [{ id: 'saved', name: 'saved', source: 'novel', profile: { model: 'alias-0', capabilityModelId: V3, steps: '12' } }],
  });
  assert.equal(count(state.modelProfiles, 'novel'), 80);
  assert.equal(read(state.modelProfiles, 'alias-99', V45).steps, 'active');
  assert.equal(read(state.modelProfiles, 'alias-99', V3).steps, '99');
  assert.equal(state.parameterPresets[0].profile.model, 'alias-0');
  assert.equal(bindings.length, 100);
});

test('malformed explicit profile metadata remains invalid after cleanup, not an implicit fallback', () => {
  for (const input of [
    { model: alias, capabilityModelId: ' ' }, { model: alias, capabilityModelId: 0 },
    { model: alias, capabilityModelId: `${V3}\n` }, { model: `\n${alias}`, capabilityModelId: V3 },
    { model: 'x'.repeat(241), capabilityModelId: V3 }, { model: V3, capabilityModelId: V45 },
    Object.assign(Object.create({ model: alias }), { capabilityModelId: V3 }),
  ]) {
    const profile = normalizeStoryboardParameterProfile(input, 'novel');
    assert.ok(profile.capabilityModelId);
    assert.throws(() => resolveStoryboardModelBinding('novel', profile));
    assert.equal(rememberStoryboardModelProfile({}, 'novel', profile), false);
  }
  const legacy = normalizeStoryboardParameterProfile({ model: V3 }, 'novel');
  assert.equal(Object.hasOwn(legacy, 'capabilityModelId'), false);
  assert.equal(normalizeStoryboardParameterProfile(Object.create({ model: alias, capabilityModelId: V3 }), 'novel').capabilityModelId, undefined);
});

test('Comfy bound memory still sanitizes credentials and keeps zero/false values', () => {
  const memory = {};
  const profile = { model: 'cloud/workflow', capabilityModelId: 'comfy-workflow', cfg: '0', seed: '0', loaded: false,
    comfyWorkflow: JSON.stringify({ '1': { class_type: 'Demo', inputs: { text: 'garden', api_key: 'secret' } } }) };
  assert.equal(rememberStoryboardModelProfile(memory, 'comfy', profile), true);
  const cached = getStoryboardRememberedProfile(memory, 'comfy', profile.model, profile.capabilityModelId);
  assert.equal(cached.cfg, '0');
  assert.equal(cached.seed, '0');
  assert.equal(cached.loaded, false);
  assert.equal(cached.comfyWorkflow.includes('secret'), false);
  assert.match(cached.comfyWorkflowNotice, /已移除凭据字段/);
});

test('the real profile snapshot preserves only explicit identity, without copying keys or connection settings', () => {
  const begin = source.indexOf('function storyboardProfileSnapshot(');
  const end = source.indexOf('\nfunction storyboardParameterPresets(', begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({ createStoryboardDefaults, clone: structuredClone });
  vm.runInContext(source.slice(begin, end), context);
  const profile = { model: alias, capabilityModelId: V45, cfg: '0', baseUrl: 'https://relay.example', apiKey: 'secret' };
  const captured = context.storyboardProfileSnapshot(profile, 'novel');
  assert.equal(captured.capabilityModelId, V45);
  assert.equal(captured.model, alias);
  assert.equal(captured.cfg, '0');
  assert.equal(Object.hasOwn(captured, 'baseUrl'), false);
  assert.equal(Object.hasOwn(captured, 'apiKey'), false);
  assert.equal(sanitizeStoryboardSnapshot({ source: 'novel', profile: captured }).profile.capabilityModelId, V45);
  assert.equal(Object.hasOwn(context.storyboardProfileSnapshot({ model: V3 }, 'novel'), 'capabilityModelId'), false);
  assert.equal(Object.hasOwn(context.storyboardProfileSnapshot({ model: V3, capabilityModelId: null }, 'novel'), 'capabilityModelId'), false);
});

test('real canonical model switches keep capability and parameter fields together', () => {
  const begin = source.indexOf('function storyboardApplyModelBinding(');
  const end = source.indexOf('function bindStoryboardModelPicker(', begin);
  assert.ok(begin >= 0 && end > begin);
  const state = createStoryboardDefaults();
  state.profiles.novel = { ...state.profiles.novel, model: V3, capabilityModelId: V3, steps: '31' };
  rememberStoryboardModelProfile(state.modelProfiles, 'novel', { model: V45, capabilityModelId: V45, steps: '28' });
  let handler, requested;
  handler = vm.runInNewContext(`${source.slice(begin, end)}; storyboardApplyModelBinding;`, {
    state, createStoryboardDefaults, STORYBOARD_PROVIDER_REGISTRY, clone: structuredClone,
    rememberStoryboardModelProfile, getStoryboardRememberedProfile,
    resolveStoryboardModelBinding, getStoryboardModel, toast: (message) => assert.fail(message),
    storyboardState: () => state,
    storyboardCaptureWorkbench: () => { Object.assign(state.profiles.novel, { model: requested, cfg: '0' }); },
    saveSettings: () => {}, renderModal: () => {},
  });
  for (const [model, expectedSteps] of [[V45, '28'], [V3, '31']]) {
    requested = model;
    handler({ isConnected: true }, state, 'novel', resolveStoryboardModelBinding('novel', { remoteModelId: requested }));
    assert.equal(state.profiles.novel.model, model);
    assert.equal(state.profiles.novel.capabilityModelId, model);
    assert.equal(state.profiles.novel.steps, expectedSteps);
    assert.equal(resolveStoryboardModelBinding('novel', state.profiles.novel).remoteModelId, model);
  }
  assert.equal(read(state.modelProfiles, V3).cfg, '0');
});
