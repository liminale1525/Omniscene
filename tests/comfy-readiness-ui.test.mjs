import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import { storyboardFunctionSource, createStoryboardFormFixture } from './helpers/storyboard-form-fixture.mjs';

const graph = { a: { class_type: 'TestImage', inputs: { text: '%qianmu_prompt%' } }, b: { class_type: 'SaveImage', inputs: { images: ['a', 0] } } };
const report = { schemaVersion: 1, ok: true, ready: true, actualGenerationVerified: false, nodeCount: 2, message: '节点与模型清单相符；请以生图验证', errors: 0, issues: [] };
const element = () => ({ children: [], textContent: '', hidden: false, disabled: false, classList: { add() {}, toggle() {} },
  append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; this.textContent = ''; } });

function fixture(options = {}) {
  const state = storyboard.createStoryboardDefaults(); state.source = 'comfy'; state.profiles.comfy.comfyWorkflow = JSON.stringify(graph);
  const button = element(), output = element(), key = { value: 'typed-key' }, field = { value: 'same', checked: false }, listeners = new Map();
  const root = { isConnected: true, currentButton: button, querySelector(selector) { return selector === '.sd-comfy-check-workflow' ? this.currentButton : selector === '.sd-comfy-readiness-result' ? output : key; },
    querySelectorAll: () => [key, field], addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const calls = [];
  const runtime = { prepareComfyReadiness() {}, async checkComfyReadiness(request) { calls.push(request); return structuredClone(report); }, ...options.runtime };
  const context = vm.createContext({ ...storyboard, AbortController, setTimeout, clearTimeout, document: { createElement: element },
    storyboardState: () => state, clone: structuredClone, storyboardCaptureWorkbench() {}, storyboardProviderProfile: () => state.profiles.comfy,
    storyboardConnectionState: () => ({ draft: { baseUrl: 'https://comfy.example', options: options.mode ? { comfyTransport: options.mode } : {} } }), getChatKey: () => 'chat-a',
    storyboardKeyInputRevision: 0, storyboardConnectionLoadRevision: 0, featureRuntime: { load: async () => runtime },
    storyboardResolveApiKey: async () => assert.fail('typed key should be retained'), storyboardRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    fetch: async () => assert.fail('unexpected request'), ...options.globals });
  vm.runInContext(storyboardFunctionSource('storyboardComfyReferenceMetadata') + storyboardFunctionSource('storyboardCheckComfyReadiness'), context);
  return { root, button, output, key, field, state, calls, listeners, context, run: () => context.storyboardCheckComfyReadiness(root) };
}

test('node inspection is only exposed inside the independent workflow card and stays disabled without a workflow', () => {
  const comfy = createStoryboardFormFixture({ family: 'comfy', workflow: graph }).content;
  assert.match(comfy, /sd-comfy-check-workflow/); assert.match(comfy, /sd-comfy-readiness-result[^>]*hidden/);
  assert.doesNotMatch(createStoryboardFormFixture({ family: 'novel' }).content, /sd-comfy-check-workflow/);
  assert.match(createStoryboardFormFixture({ family: 'comfy' }).content, /sd-comfy-check-workflow" disabled/);
});

test('actual handler uses captured recipe, keeps the typed Key and reports browser origin without saving definitions', async () => {
  const fx = fixture(), before = structuredClone(fx.state);
  await fx.run(); assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0].apiKey, 'typed-key');
  assert.equal(fx.calls[0].workflow, JSON.stringify(graph)); assert.equal(fx.key.value, 'typed-key');
  assert.match(fx.output.children[0].textContent, /当前浏览器/); assert.match(fx.output.children[1].textContent, /未运行工作流/);
  assert.deepEqual(fx.state, before); assert.equal(fx.button.disabled, false);
  fx.listeners.get('input')(); assert.equal(fx.output.hidden, true); assert.equal(fx.listeners.size, 0);
});

test('transport-only failure may inspect from ST, labels the requester and uses authenticated same-origin POST without generation', async () => {
  const requests = [];
  const fx = fixture({ runtime: { checkComfyReadiness: async () => { throw Object.assign(new Error('cors'), { code: 'comfy_readiness_transport' }); } },
    globals: { fetch: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify(report)); } } });
  await fx.run(); assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/plugins/qianmu-tts/image/comfy/readiness');
  assert.equal(requests[0].options.credentials, 'same-origin'); assert.match(fx.output.children[0].textContent, /ST 主机/);
  assert.match(fx.output.children[1].textContent, /不提供内网穿透/); assert.equal(fx.key.value, 'typed-key');
});

test('HTTP/definition errors never switch hosts and old backend missing endpoint is explicit', async () => {
  const fx = fixture({ runtime: { checkComfyReadiness: async () => { throw Object.assign(new Error('权限不足'), { code: 'comfy_readiness_http_401' }); } } });
  await fx.run(); assert.equal(fx.output.textContent, '权限不足');
  const old = fixture({ runtime: { checkComfyReadiness: async () => { throw Object.assign(new Error(), { code: 'comfy_readiness_transport' }); } },
    globals: { fetch: async () => new Response('', { status: 404 }) } });
  await old.run(); assert.match(old.output.textContent, /更新增强服务并重启 ST/);
});

test('a changed key, profile, source or replaced page cannot paint a late check result', async () => {
  for (const change of [fx => fx.key.value = 'new-key', fx => fx.state.profiles.comfy.width = 1234,
    fx => fx.state.source = 'novel', fx => fx.root.currentButton = element(), fx => fx.context.storyboardConnectionLoadRevision++]) {
    let resolve;
    const fx = fixture({ runtime: { checkComfyReadiness: () => new Promise(done => { resolve = done; }) } });
    const pending = fx.run(); await new Promise(done => setTimeout(done, 0)); change(fx); resolve(report); await pending;
    assert.equal(fx.output.children.length, 0); assert.equal(fx.listeners.size, 0);
  }
});

test('stale lazy loading stops before any network and unsafe embedded credentials stop before resolving a key', async () => {
  let resolve; const fx = fixture({ globals: { featureRuntime: { load: () => new Promise(done => { resolve = done; }) } } });
  const pending = fx.run(); fx.field.value = 'changed'; resolve({}); await pending; assert.equal(fx.calls.length, 0);
  const unsafe = fixture(); unsafe.state.profiles.comfy.comfyWorkflow = JSON.stringify({ ...graph, secret: { class_type: 'X', inputs: { api_key: 'not-exported' } } });
  await unsafe.run(); assert.equal(unsafe.calls.length, 0); assert.match(unsafe.output.textContent, /工作流需先/);
});

test('reported issue markup is rendered as text and duplicate clicks do not start parallel checks', async () => {
  let resolve; const fx = fixture({ runtime: { checkComfyReadiness: () => new Promise(done => { resolve = done; }) } });
  const pending = fx.run(); await new Promise(done => setTimeout(done, 0)); await fx.run();
  resolve({ ...report, errors: 1, issues: [{ message: '<img src=x onerror=bad()>' }] }); await pending;
  assert.equal(fx.output.children.at(-1).children[0].textContent, '<img src=x onerror=bad()>');
  assert.equal(fx.button.disabled, false);
});

test('explicit ST readiness skips browser and explicit browser readiness cannot silently change the requester', async () => {
  let posted = 0;
  const gateway = fixture({ mode: 'gateway', runtime: { checkComfyReadiness: () => assert.fail('browser must not run') },
    globals: { fetch: async () => { posted++; return new Response(JSON.stringify(report)); } } });
  await gateway.run(); assert.equal(posted, 1); assert.match(gateway.output.children[0].textContent, /ST 主机/);
  const browser = fixture({ mode: 'browser', runtime: { checkComfyReadiness: async () => { throw Object.assign(new Error('网络失败'), { code: 'comfy_readiness_transport' }); } } });
  await browser.run(); assert.equal(browser.output.textContent, '网络失败');
});

test('programmatic connection changes invalidate a pending check even without a DOM input event', async () => {
  let resolve; const draft = { baseUrl: 'https://original.example', options: { comfyTransport: 'browser' } };
  const fx = fixture({ globals: { storyboardConnectionState: () => ({ draft }) }, runtime: { checkComfyReadiness: () => new Promise(done => { resolve = done; }) } });
  const pending = fx.run(); await new Promise(done => setTimeout(done, 0)); draft.options.comfyTransport = 'gateway'; resolve(report); await pending;
  assert.equal(fx.output.children.length, 0); assert.equal(fx.listeners.size, 0);
});
