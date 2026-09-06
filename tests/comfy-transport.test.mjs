import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import { createStoryboardFormFixture, storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

test('fresh Comfy connections select ST; existing connections and historical snapshots without a route keep legacy behavior', () => {
  assert.equal(core.getStoryboardComfyTransport(core.createStoryboardDefaults().connections.comfy.draft), 'gateway');
  assert.equal(core.getStoryboardComfyTransport(core.normalizeStoryboardState({}).connections.comfy.draft), 'gateway');
  const state = core.createStoryboardDefaults(); state.connections.comfy.draft = { baseUrl: 'http://127.0.0.1:8188' };
  assert.equal(core.getStoryboardComfyTransport(core.normalizeStoryboardState(state).connections.comfy.draft), 'legacy-auto');
  assert.equal(core.getStoryboardComfyTransport({ baseUrl: 'old' }), 'legacy-auto');
});

test('connection presets preserve explicit routes; invalid future/conflicting values never become a different target', () => {
  for (const mode of ['browser', 'gateway', 'legacy-auto']) {
    const row = core.normalizeStoryboardConnectionProfile({ options: { comfyTransport: mode } }, 'comfy');
    assert.equal(core.requireStoryboardComfyTransport(row), mode); assert.equal(core.requireStoryboardComfyTransport({ comfyTransport: mode }), mode);
  }
  for (const connection of [{ comfyTransport: 'future' }, { options: { comfyTransport: null } }, { comfyTransport: 'browser', options: { comfyTransport: 'gateway' } }]) {
    assert.equal(core.getStoryboardComfyTransport(connection), 'invalid'); assert.throws(() => core.requireStoryboardComfyTransport(connection), { code: 'comfy_transport_invalid', submissionState: 'not_submitted' });
  }
});

test('daily Comfy connection selector covers deployment guidance but never offers invisible auto-switch on fresh connections', () => {
  const fresh = createStoryboardFormFixture({ family: 'comfy' }).content;
  assert.match(fresh, /sd-comfy-transport/); assert.match(fresh, /value="gateway" selected/); assert.doesNotMatch(fresh, /value="legacy-auto"/);
  for (const phrase of ['本地 ST＋本地 Comfy', '本地 ST＋云 Comfy', 'VPS ST＋云 Comfy', '不提供内网穿透']) assert.ok(fresh.includes(phrase));
  const old = createStoryboardFormFixture({ family: 'comfy', connection: { options: {} } }).content;
  assert.match(old, /value="legacy-auto" selected/);
  const browser = createStoryboardFormFixture({ family: 'comfy', connection: { options: { comfyTransport: 'browser' } } }).content;
  assert.match(browser, /sd-storyboard-private-network"[^>]*disabled/);
  assert.doesNotMatch(createStoryboardFormFixture({ family: 'novel' }).content, /sd-comfy-transport|sd-comfy-deployment-guide/);
});

// Run the production nested transport block, not a duplicate route-selection implementation.
const runJob = storyboardFunctionSource('storyboardRunJob');
const block = runJob.slice(runJob.indexOf('    const generateTransport = async () => {'), runJob.indexOf('    let response;', runJob.indexOf('    const generateTransport = async () => {')));
assert.ok(block.includes('generateDirectImage') && block.includes('/image/generate'));
function transport(mode, { error, provider = 'comfy', currentMode = 'gateway' } = {}) {
  const calls = [], job = { source: provider, profile: {}, connection: mode === undefined ? {} : { comfyTransport: mode } };
  const context = vm.createContext({ ...core, job, log: {}, beforeSubmit: async () => calls.push('beforeSubmit'),
    storyboardState: () => ({ enabled: true, connections: { comfy: { draft: { options: { comfyTransport: currentMode } } } } }),
    storyboardPrepareGatewayAssets: async () => { calls.push('assets'); return {}; }, storyboardGatewayRequest: () => ({}),
    storyboardPipelineStage() {}, storyboardRequestHeaders: () => ({}), apiKey: 'secret',
    storyboardComfyRecoveryRuntime: async () => ({ prepare: async value => { assert.equal(value, job); return { version: 1, attemptId: 'fixed' }; } }),
    directImageRuntime: async () => { calls.push('loadBrowser'); return { isDirectImageTransportError: value => value.code === 'direct_transport',
      generateDirectImage: async () => { calls.push('browser'); if (error) throw error; return { ok: true }; } }; },
    storyboardConfirmGatewayModelBinding: async () => { calls.push('gatewayBinding'); return 0; },
    fetch: async (url, options) => { calls.push(url); assert.equal(options.method, 'POST');
      if (provider === 'comfy') assert.equal(JSON.parse(options.body).comfyQueue.attemptId, 'fixed');
      return new Response(JSON.stringify({ ok: true })); },
  });
  vm.runInContext(`async function runTransport() {${block}\nreturn generateTransport();}`, context);
  return { calls, job, run: () => context.runTransport() };
}

test('actual explicit ST generation uses only the frozen gateway route, including when today workbench says browser', async () => {
  const h = transport('gateway', { currentMode: 'browser' }); const result = await h.run();
  assert.equal(result.transport, 'same_origin_gateway'); assert.deepEqual(h.calls, ['assets', 'gatewayBinding', 'beforeSubmit', '/api/plugins/qianmu-tts/image/generate']);
});

test('actual explicit browser generation never forwards after transport/unsupported/unknown-acceptance failures', async () => {
  for (const error of [Object.assign(new Error(), { code: 'direct_transport', submissionState: 'not_submitted' }),
    Object.assign(new Error(), { code: 'direct_transport', submissionState: 'unknown' }), Object.assign(new Error(), { code: 'direct_unsupported' })]) {
    const h = transport('browser', { error }); await assert.rejects(h.run(), error);
    assert.deepEqual(h.calls, ['assets', 'loadBrowser', 'browser']);
  }
});

test('legacy auto may fall back only when proven not submitted; uncertainty still prevents resubmission', async () => {
  const preflight = Object.assign(new Error(), { code: 'direct_transport', submissionState: 'not_submitted' });
  const h = transport(undefined, { error: preflight }); assert.equal((await h.run()).transport, 'same_origin_gateway');
  assert.equal(h.calls.filter(value => value === '/api/plugins/qianmu-tts/image/generate').length, 1);
  const ambiguous = transport('legacy-auto', { error: Object.assign(new Error(), { code: 'direct_transport', submissionState: 'unknown' }) });
  await assert.rejects(ambiguous.run()); assert.ok(!ambiguous.calls.includes('gatewayBinding'));
});

test('invalid snapshot route cannot reach either provider and NAI/Banana routing is unaffected by Comfy fields', async () => {
  const invalid = transport('future'); await assert.rejects(invalid.run(), { code: 'comfy_transport_invalid' });
  assert.ok(!invalid.calls.includes('browser') && !invalid.calls.includes('gatewayBinding'));
  for (const provider of ['novel', 'banana']) { const h = transport('gateway', { provider }); assert.equal((await h.run()).transport, 'browser_direct'); }
});
