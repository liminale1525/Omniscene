import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import { createModelPickerSession } from '../qianmu-model-picker.js';

const V3 = 'nai-diffusion-3', V5 = 'nai-diffusion-5-full';
const models = storyboard.STORYBOARD_MODEL_REGISTRY.novel;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function session(extra = {}) {
  const applied = [];
  const picker = createModelPickerSession({ provider: 'novel', models, current: { model: V5, capabilityModelId: V5 },
    isCurrent: () => true, fetchModels: async () => ({ models: [{ id: 'vendor/custom', label: 'Custom' }] }),
    apply: (value) => applied.push(value), ...extra });
  return { picker, applied };
}
test('offline search includes labels, IDs and the existing alias without any request', () => {
  const { picker } = session({ current: { model: 'Team/模型名', capabilityModelId: V3 }, fetchModels: () => assert.fail('no automatic listing') });
  assert.equal(picker.list('模型名')[0].id, 'Team/模型名');
  assert.ok(picker.list('Anime').length > 1);
  assert.equal(picker.capability('Team/模型名'), V3);
});
test('unknown names need an explicit capability and preserve their full ID', () => {
  const { picker, applied } = session();
  assert.throws(() => picker.commit('vendor/任意前缀:full@v1'), /参数能力/);
  assert.throws(() => picker.commit('vendor/任意前缀:full@v1', 'gpt-image-2'), /参数能力/);
  picker.commit('vendor/任意前缀:full@v1', V3);
  assert.deepEqual(applied[0], { remoteModelId: 'vendor/任意前缀:full@v1', capabilityModelId: V3 });
  picker.commit(V5, V3);
  assert.equal(applied[1].capabilityModelId, V5, 'known IDs own their canonical capability');
  for (const id of ['', 'x'.repeat(241), 'bad\nmodel']) assert.throws(() => picker.commit(id, V3), /完整模型/);
});
test('fetching does not apply a model; unknown names are never filtered by naming heuristics', async () => {
  const { picker, applied } = session();
  await picker.load();
  assert.equal(applied.length, 0);
  assert.equal(picker.list('vendor/custom')[0].id, 'vendor/custom');
  assert.ok(picker.list(V5).length);
});
test('late source responses and commits are rejected without replacing the prior catalog', async () => {
  const gate = deferred(); let current = true;
  const { picker } = session({ isCurrent: () => current, fetchModels: () => gate.promise });
  const request = picker.load(); current = false; gate.resolve({ models: [{ id: 'old-source' }] });
  assert.equal(await request, null);
  assert.equal(picker.list('old-source').length, 0);
  assert.throws(() => picker.commit(V3), /连接已变化/);
  assert.equal(picker.loading, false);
});
test('out-of-order refreshes cannot overwrite the newest list', async () => {
  const a = deferred(), b = deferred(); let count = 0;
  const { picker } = session({ fetchModels: () => (++count === 1 ? a : b).promise });
  const first = picker.load(), second = picker.load();
  b.resolve({ models: [{ id: 'new' }] }); await second;
  a.resolve({ models: [{ id: 'old' }] }); assert.equal(await first, null);
  assert.equal(picker.list('new').length, 1); assert.equal(picker.list('old').length, 0);
});
test('listing failure preserves choice and a later retry succeeds', async () => {
  let count = 0;
  const { picker } = session({ fetchModels: async () => { if (!count++) throw new Error('404'); return { models: ['retry'] }; } });
  await assert.rejects(picker.load(), /404/);
  assert.equal(picker.loading, false); assert.ok(picker.list(V5).length);
  await picker.load(); assert.equal(picker.list('retry').length, 1);
});
test('catalog data is bounded and does not copy response secrets or serialize private state', async () => {
  const { picker } = session({ fetchModels: async () => ({ apiKey: 'private-key', models: Array.from({ length: 5000 }, (_, i) => ({ id: `relay-${i}`, apiKey: 'private-key' })) }) });
  await picker.load(); assert.ok(picker.list().length <= 4000);
  assert.doesNotMatch(JSON.stringify(picker.list()), /private-key/);
  assert.doesNotMatch(JSON.stringify(picker), /relay-|private-key/);
});
test('disposing a session drops its rows and ignores pending data', async () => {
  const gate = deferred(), { picker } = session({ fetchModels: () => gate.promise });
  const work = picker.load(); picker.dispose(); gate.resolve({ models: ['late'] });
  assert.equal(await work, null); assert.equal(picker.list().length, 0);
});

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
async function bindingEnvironment({ route = false, direct = null } = {}) {
  const state = storyboard.createStoryboardDefaults(); state.enabled = true;
  state.profiles.novel.model = V5;
  state.connections.novel.draft.baseUrl = 'https://relay.example';
  const rule = { id: 'r', target: { providerId: 'novel', modelId: V5, capabilityModelId: V5, connectionPresetId: 'route-api' } };
  state.connections.novel.presets = [{ id: 'route-api', baseUrl: 'https://route.example', credentialId: 'route-key' }];
  state.routing.rules = [rule];
  let options, sent = [], reads = [], fetchCalls = [];
  const handlers = {}, pull = { addEventListener: (name, fn) => { handlers[`pull:${name}`] = fn; } };
  const host = { dataset: { storyboardModelPicker: 'novel' }, isConnected: true,
    closest: () => route ? { dataset: { storyboardRouteRule: 'r' } } : null,
    querySelector: () => pull, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const fields = [{ value: 'https://relay.example', checked: false }];
  const context = vm.createContext({ ...storyboard, JSON, AbortController, setTimeout, clearTimeout, clone: structuredClone,
    storyboardState: () => state, getChatKey: () => 'chat-a', storyboardCredentialRevision: 0, storyboardDraftApiKeys: new Map([['novel', 'typed-key']]),
    storyboardCaptureWorkbench: () => {}, storyboardProviderProfile: () => state.profiles.novel,
    storyboardResolveApiKey: async (provider, id) => { reads.push([provider, id]); return 'stored-key'; },
    storyboardRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    directImageRuntime: async () => ({ listDirectImageModels: direct || (async (request) => { sent.push(request); return { models: [] }; }), isDirectImageTransportError: (e) => e.code === 'direct_network_error' }),
    fetch: async (url, request) => { fetchCalls.push([url, request]); return { ok: true, json: async () => ({ ok: true, models: ['gateway-model'] }) }; },
    featureRuntime: { load: async (id) => { assert.equal(id, 'modelPicker'); return { attachModelPicker: (_host, value) => { options = value; return { open() {}, fetch() {}, isCurrent: value.isCurrent, dispose() {} }; } }; } },
    toast: () => {},
  });
  vm.runInContext([section('storyboardConnectionState'), section('storyboardConfirmGatewayProtocolBinding'), section('bindStoryboardModelPicker')].join('\n'), context);
  const root = { isConnected: true, querySelectorAll: () => fields };
  context.bindStoryboardModelPicker(root, host, state);
  handlers.focusin({ target: { matches: () => true } });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return { state, context, root, host, fields, handlers, options: () => options, sent, reads, fetchCalls };
}
test('actual workbench fetch uses the typed key without saving or clearing it', async () => {
  const e = await bindingEnvironment(); await e.options().fetchModels();
  assert.equal(e.sent[0].baseUrl, 'https://relay.example'); assert.equal(e.sent[0].apiKey, 'typed-key');
  assert.equal(e.context.storyboardDraftApiKeys.get('novel'), 'typed-key');
  assert.equal(e.fetchCalls.length, 0);
});
test('actual route fetch reads its own connection, not the workbench draft key', async () => {
  const e = await bindingEnvironment({ route: true }); await e.options().fetchModels();
  assert.equal(e.sent[0].baseUrl, 'https://route.example'); assert.equal(e.sent[0].apiKey, 'stored-key');
  assert.equal(e.reads[0][1], 'route-key');
});
test('actual binding guards unsaved URL edits, key revisions, changed models and detached controls', async () => {
  for (const mutate of [e => { e.fields[0].value = 'https://different.example'; }, e => { e.context.storyboardCredentialRevision++; },
    e => { e.state.profiles.novel.model = V3; }, e => { e.host.isConnected = false; }]) {
    const e = await bindingEnvironment(); mutate(e); assert.equal(e.options().isCurrent(), false);
    await assert.rejects(e.options().fetchModels(), /连接已变化/); assert.equal(e.sent.length, 0);
  }
});
test('only direct transport failures use the read-only gateway; HTTP failures do not', async () => {
  for (const [code, calls] of [['direct_network_error', 1], ['models_unavailable', 0], ['upstream_401', 0]]) {
    const e = await bindingEnvironment({ direct: async () => { const error = new Error('upstream'); error.code = code; throw error; } });
    if (calls) await e.options().fetchModels(); else await assert.rejects(e.options().fetchModels());
    assert.equal(e.fetchCalls.length, calls);
    if (calls) { assert.equal(e.fetchCalls[0][0], '/api/plugins/qianmu-tts/image/models'); assert.equal(e.fetchCalls[0][1].method, 'POST'); }
  }
});
test('a changed connection reopens a fresh session rather than leaving a permanently stale control', async () => {
  const e = await bindingEnvironment(), original = e.options();
  e.state.connections.novel.draft.baseUrl = 'https://changed.example';
  e.handlers.focusin({ target: { matches: () => true } });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.notEqual(e.options(), original); assert.equal(e.options().isCurrent(), true);
  await e.options().fetchModels(); assert.equal(e.sent[0].baseUrl, 'https://changed.example');
});
