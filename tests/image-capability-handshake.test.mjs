import test from 'node:test';
import assert from 'node:assert/strict';
import { imageGatewayCapabilities, sanitizeImageRequest, generateImage } from '../qianmu-image-gateway.js';
import { STORYBOARD_MODEL_REGISTRY } from '../qianmu-storyboard.js';
import { QIANMU_IMAGE_CAPABILITIES_ENDPOINT, probeQianmuImageCapabilities, checkQianmuImageModelBinding } from '../qianmu-service-capabilities.js';

const identity = { modelFamily: 'novel', protocol: 'novelai', remoteModelId: 'vendor/NAI', capabilityModelId: 'nai-diffusion-4-5-full' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request = { provider: 'novel', model: identity.remoteModelId, capabilityModelId: identity.capabilityModelId,
  apiKey: 'mock-key', baseUrl: 'https://relay.example', prompt: 'garden', modelBindingVersion: 1 };

test('server declaration advertises actual NAI capability support without exposing credentials or changing legacy providers', () => {
  const body = imageGatewayCapabilities('1.0.0');
  assert.equal(body.version, 3);
  assert.equal(body.modelBinding.version, 1);
  assert.deepEqual(body.providers.map((provider) => provider.id), ['novel', 'banana', 'openai', 'seedream', 'comfy']);
  for (const model of STORYBOARD_MODEL_REGISTRY.novel) assert.ok(body.modelBinding.providers.novel.capabilityModelIds.includes(model.id));
  body.modelBinding.providers.novel.capabilityModelIds.length = 0;
  assert.ok(imageGatewayCapabilities().modelBinding.providers.novel.capabilityModelIds.length, 'each response owns its lists');
});

test('read-only handshake is same-origin, bypasses caches, and sends no generation body or provider credentials', async () => {
  let calls = 0;
  const result = await probeQianmuImageCapabilities({ headers: { 'X-CSRF-Token': 'csrf-test' }, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, QIANMU_IMAGE_CAPABILITIES_ENDPOINT);
    assert.equal(init.method, 'GET');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-CSRF-Token'], 'csrf-test');
    assert.equal(init.body, undefined);
    assert.doesNotMatch(JSON.stringify(init), /mock-key|vendor\/NAI/);
    return reply({ ...imageGatewayCapabilities('1.0.0'), apiKey: 'must-not-retain', extra: 'untrusted-body' });
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'ready');
  assert.deepEqual(checkQianmuImageModelBinding(result, identity), { ok: true, bindingVersion: 1 });
  assert.doesNotMatch(JSON.stringify(result), /must-not-retain|untrusted-body/);
});

for (const [label, body] of [
  ['legacy v2', { ok: true, version: 2, modelListing: true }],
  ['future contract', { ...imageGatewayCapabilities(), version: 4 }],
  ['wrong plugin', { ...imageGatewayCapabilities(), plugin: 'different-plugin' }],
  ['binding mismatch', { ...imageGatewayCapabilities(), modelBinding: { version: 2 } }],
  ['string version', { ...imageGatewayCapabilities(), version: '3' }],
  ['false success', { ...imageGatewayCapabilities(), ok: false }],
]) {
  test(`incompatible declaration cannot authorize an alias: ${label}`, async () => {
    const result = await probeQianmuImageCapabilities({ fetchImpl: async () => reply(body) });
    assert.equal(result.status, 'incompatible');
    assert.equal(checkQianmuImageModelBinding(result, identity).ok, false);
  });
}

test('missing/auth/invalid JSON/timeouts/network failure remain distinguishable and do not leak response details', async () => {
  for (const [response, status] of [[reply({ message: 'sensitive-raw' }, 404), 'missing'], [reply({}, 401), 'unauthorized'],
    [reply({}, 403), 'unauthorized'], [reply({ message: 'sensitive-raw' }, 500), 'error'], [new Response('<html>login</html>'), 'incompatible']]) {
    const result = await probeQianmuImageCapabilities({ fetchImpl: async () => response });
    assert.equal(result.status, status);
    const check = checkQianmuImageModelBinding(result, identity);
    assert.equal(check.ok, false);
    assert.doesNotMatch(JSON.stringify(check), /sensitive-raw|<html>/);
  }
  for (const name of ['AbortError', 'TypeError']) {
    const result = await probeQianmuImageCapabilities({ fetchImpl: async () => { const error = new Error('sensitive-raw'); error.name = name; throw error; } });
    assert.equal(result.status, name === 'AbortError' ? 'timeout' : 'error');
    assert.equal(checkQianmuImageModelBinding(result, identity).ok, false);
  }
});

test('family, protocol, advertised capability list and zero/invalid IDs must match explicitly', async () => {
  for (const novel of [null, { protocol: 'openai-images', capabilityModelIds: [identity.capabilityModelId] },
    { protocol: 'novelai', capabilityModelIds: ['nai-diffusion-3', '', null, {}, 'bad\nname'] }]) {
    const body = imageGatewayCapabilities(); body.modelBinding.providers.novel = novel;
    const result = await probeQianmuImageCapabilities({ fetchImpl: async () => reply(body) });
    assert.equal(checkQianmuImageModelBinding(result, identity).ok, false);
    assert.equal(checkQianmuImageModelBinding(result, { ...identity, capabilityModelId: '' }).ok, false);
  }
  const result = await probeQianmuImageCapabilities({ fetchImpl: async () => reply(imageGatewayCapabilities()) });
  assert.equal(checkQianmuImageModelBinding(result, { ...identity, modelFamily: 'openai' }).ok, false);
  assert.equal(checkQianmuImageModelBinding(result, { ...identity, protocol: 'openai-images' }).ok, false);
});

test('a stalled capability request is aborted at its bounded timeout', async () => {
  let aborted = false;
  const result = await probeQianmuImageCapabilities({ timeoutMs: 1000, fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  }) });
  assert.equal(aborted, true);
  assert.equal(result.status, 'timeout');
});

test('gateway validates binding contract before DNS, provider requests or billable work', async () => {
  for (const change of [{ modelBindingVersion: 2 }, { modelBindingVersion: '1' }, { modelBindingVersion: null },
    { capabilityModelId: '' }, { provider: 'openai' }, { capabilityModelId: 'invalid' }, { model: 'nai-diffusion-3' }]) {
    await assert.rejects(generateImage({ ...request, ...change }, {
      resolveHost: async () => assert.fail('must not resolve host'), fetchImpl: async () => assert.fail('must not send a provider request'),
    }), (error) => ['model_binding_version_mismatch', 'invalid_model_binding_contract', 'invalid_capability_model', 'model_capability_conflict'].includes(error.code));
  }
  const accepted = sanitizeImageRequest(request);
  assert.equal(accepted.model, identity.remoteModelId);
  assert.equal(accepted.capabilityModelId, identity.capabilityModelId);
  assert.equal(Object.hasOwn(accepted, 'modelBindingVersion'), false, 'handshake metadata is not part of provider payloads');
  const { modelBindingVersion, ...legacy } = request;
  assert.equal(sanitizeImageRequest(legacy).model, identity.remoteModelId, 'existing clients retain compatible behavior');
});
