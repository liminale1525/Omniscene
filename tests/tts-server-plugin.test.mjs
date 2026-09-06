import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { info, init, streamMiniMaxH3VideoResult } from '../server-plugin.js';

const routes = new Map();
await init({
  get(path, handler) { routes.set(`GET ${path}`, handler); },
  post(path, handler) { routes.set(`POST ${path}`, handler); },
});

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

assert.equal(info.id, 'qianmu-tts');
assert.ok(routes.has('GET /health'));
assert.ok(routes.has('POST /doubao/synthesize'));
assert.ok(routes.has('GET /image/capabilities'));
assert.ok(routes.has('POST /image/check'));
assert.ok(routes.has('POST /image/models'));
assert.ok(routes.has('POST /image/generate'));
assert.ok(routes.has('GET /video/minimax/capabilities'));
assert.ok(routes.has('POST /video/minimax/create'));
assert.ok(routes.has('POST /video/minimax/query'));
assert.ok(routes.has('POST /video/minimax/cancel'));
assert.ok(routes.has('POST /video/minimax/result'));

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const installGuide = await readFile(new URL('../INSTALL-DOUBAO-APIKEY.md', import.meta.url), 'utf8');
const shellInstaller = await readFile(new URL('../install-server-plugin.sh', import.meta.url), 'utf8');
const powershellInstaller = await readFile(new URL('../install-server-plugin.ps1', import.meta.url), 'utf8');
assert.equal(packageJson.main, 'server-plugin.js');
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.version, packageJson.version);
assert.match(installGuide, /install-server-plugin\.sh \| sh/);
assert.match(installGuide, /install-server-plugin\.ps1 \| iex/);
assert.match(installGuide, /云端 \/ VPS 部署/);
assert.match(installGuide, /本地部署/);
assert.match(installGuide, /重启 SillyTavern 后端服务或 Docker 容器/);
assert.match(installGuide, /不是只刷新、关闭或重新打开 ST 网页/);
assert.match(installGuide, /st\.example\.com\/api\/plugins\/qianmu-tts\/health/);
assert.match(shellInstaller, /enableServerPlugins: true/);
assert.match(shellInstaller, /mkdir -p "\$PLUGIN_PARENT"/);
assert.match(shellInstaller, /config\/config\.yaml/);
assert.doesNotMatch(shellInstaller, /^\s*(?:if\s+)?docker compose (?:restart|stop|down)\b/m);
assert.match(shellInstaller, /docker compose start sillytavern/);
assert.match(shellInstaller, /QIANMU_SERVER_STOPPED/);
assert.match(powershellInstaller, /QIANMU_SERVER_STOPPED/);
assert.match(shellInstaller, /\/home\/node\/app\/plugins/);
assert.match(powershellInstaller, /enableServerPlugins: true/);
assert.match(powershellInstaller, /New-Item -ItemType Directory/);
assert.match(installGuide, /api\/plugins\/qianmu-tts\/health/);

const health = mockResponse();
await routes.get('GET /health')({}, health);
assert.equal(health.body.ok, true);
assert.equal(health.body.plugin, 'qianmu-tts');
assert.equal(health.body.version, packageJson.version);
assert.equal(health.body.schemaVersion, 1);
assert.equal(health.body.delivery, 'optional');
assert.deepEqual(health.body.services, ['doubao-tts', 'storyboard-image', 'minimax-h3']);

const videoCapabilities = mockResponse();
await routes.get('GET /video/minimax/capabilities')({}, videoCapabilities);
assert.equal(videoCapabilities.body.provider, 'minimax-h3');
assert.equal(videoCapabilities.body.transport, 'same_origin_gateway');
assert.equal(videoCapabilities.body.browserDirect, false);
assert.equal(videoCapabilities.headers['cache-control'], 'no-store');

const missingVideoKey = mockResponse();
await routes.get('POST /video/minimax/query')({ body: { taskId: 'remote-a' } }, missingVideoKey);
assert.equal(missingVideoKey.statusCode, 400);
assert.equal(missingVideoKey.body.code, 'missing_api_key');

const missingVideoResultKey = mockResponse();
await routes.get('POST /video/minimax/result')({ body: { taskId: 'remote-a' } }, missingVideoResultKey);
assert.equal(missingVideoResultKey.statusCode, 400);
assert.equal(missingVideoResultKey.body.code, 'missing_api_key');

const streamedChunks = [];
const streamResponse = {
  headers: {}, statusCode: 0, ended: false,
  status(code) { this.statusCode = code; return this; },
  set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
  write(chunk) { streamedChunks.push(Buffer.from(chunk)); return true; },
  end() { this.ended = true; },
};
const streamed = await streamMiniMaxH3VideoResult({
  response: new Response(Buffer.from('streamed-video')),
  contentType: 'video/mp4', contentLength: 14, fileName: 'qianmu-h3-test.mp4', maxBytes: 100,
}, streamResponse);
assert.equal(streamResponse.statusCode, 200);
assert.equal(streamResponse.headers['content-type'], 'video/mp4');
assert.equal(streamResponse.headers['content-length'], '14');
assert.equal(streamResponse.headers['cross-origin-resource-policy'], 'same-origin');
assert.equal(Buffer.concat(streamedChunks).toString(), 'streamed-video');
assert.equal(streamed.completed, true);

const capabilities = mockResponse();
await routes.get('GET /image/capabilities')({}, capabilities);
assert.equal(capabilities.body.version, 3);
assert.equal(capabilities.body.plugin, 'qianmu-tts');
assert.equal(capabilities.body.serviceVersion, packageJson.version);
assert.equal(capabilities.body.modelBinding.version, 1);
assert.ok(capabilities.body.modelBinding.providers.novel.capabilityModelIds.includes('nai-diffusion-4-5-full'));
assert.equal(capabilities.headers['cache-control'], 'no-store');
assert.equal(capabilities.body.modelListing, true);
assert.ok(capabilities.body.providers.some((provider) => provider.id === 'openai'));

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/object_info$/);
    return new Response(JSON.stringify({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors']] } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const modelResponse = mockResponse();
  await routes.get('POST /image/models')({
    body: { provider: 'comfy', baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true },
  }, modelResponse);
  assert.equal(modelResponse.statusCode, 200);
  assert.equal(modelResponse.body.models[0].id, 'model.safetensors');
  assert.equal(modelResponse.headers['cache-control'], 'no-store');
  assert.equal(modelResponse.headers['x-content-type-options'], 'nosniff');

  const missingImageKey = mockResponse();
  await routes.get('POST /image/generate')({ body: { provider: 'openai', model: 'gpt-image-2', prompt: 'test' } }, missingImageKey);
  assert.equal(missingImageKey.statusCode, 400);
  assert.equal(missingImageKey.body.code, 'missing_api_key');
  assert.equal(missingImageKey.headers['cache-control'], 'no-store');

  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url, init };
    const frame = JSON.stringify({ code: 0, data: Buffer.from('server-audio').toString('base64') });
    return new Response(frame, { status: 200, headers: { 'content-type': 'text/plain', 'x-tt-logid': 'server-log' } });
  };

  const response = mockResponse();
  await routes.get('POST /doubao/synthesize')({
    body: {
      apiKey: 'new-api-key',
      resourceId: 'seed-icl-2.0',
      request: {
        user: { uid: 'test' },
        req_params: {
          text: '你好', speaker: 'zh_female_vv_uranus_bigtts',
          audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 10, loudness_rate: 5 },
          additions: JSON.stringify({ context_texts: ['温柔地说'] }),
          model: 'seed-tts-2.0-expressive',
        },
      },
    },
  }, response);

  assert.equal(upstreamRequest.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(upstreamRequest.init.headers['X-Api-Key'], 'new-api-key');
  assert.equal(upstreamRequest.init.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
  assert.equal(JSON.parse(upstreamRequest.init.body).req_params.audio_params.sample_rate, 24000);
  assert.equal(JSON.parse(upstreamRequest.init.body).req_params.model, 'seed-tts-2.0-expressive');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-tt-logid'], 'server-log');
  assert.equal(Buffer.from(response.body).toString(), JSON.stringify({ code: 0, data: Buffer.from('server-audio').toString('base64') }));

  const missingKey = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: {} }, missingKey);
  assert.equal(missingKey.statusCode, 400);
  assert.match(String(missingKey.body), /缺少豆包 API Key/);

  const invalid = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: { apiKey: 'key', request: { req_params: { text: '你好' } } } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.match(String(invalid.body), /未指定豆包音色 ID/);

  const invalidResource = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: { apiKey: 'key', resourceId: 'https://example.com' } }, invalidResource);
  assert.equal(invalidResource.statusCode, 400);
  assert.match(String(invalidResource.body), /资源 ID 不在允许列表/);

  const invalidInference = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: {
    apiKey: 'key', resourceId: 'seed-icl-2.0',
    request: { req_params: { text: '你好', speaker: 'S_test', model: 'untrusted-model', audio_params: {} } },
  } }, invalidInference);
  assert.equal(invalidInference.statusCode, 400);
  assert.match(String(invalidInference.body), /推理模型不在允许列表/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('TTS server plugin OK');
