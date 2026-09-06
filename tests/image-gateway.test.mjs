import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import {
  IMAGE_GATEWAY_PROVIDERS,
  checkImageConnection,
  extractZipImages,
  generateImage,
  imageGatewayErrorPayload,
  listImageModels,
  sanitizeImageRequest,
  validateGatewayBaseUrl,
} from '../qianmu-image-gateway.js';

const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), { status: init.status || 200, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
}

function storedZip(name, payload) {
  const filename = Buffer.from(name);
  const data = Buffer.from(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

assert.deepEqual(Object.keys(IMAGE_GATEWAY_PROVIDERS), ['novel', 'banana', 'openai', 'seedream', 'comfy']);

const browserSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.match(browserSource, /fetch\('\/api\/plugins\/qianmu-tts\/image\/models'/, '模型拉取复用只读网关端点');
assert.match(browserSource, /function bindStoryboardModelPicker[\s\S]*models: STORYBOARD_MODEL_REGISTRY\[providerId\]/, '保留内置目录作为离线选择');

const sanitized = sanitizeImageRequest({
  provider: 'openai', apiKey: 'secret', model: 'gpt-image-2', prompt: 'quiet street', negativePrompt: 'watermark',
  parameters: { count: 99, width: 1, providerOptions: { moderation: 'low', apiKey: 'must-not-pass' } },
});
assert.equal(sanitized.parameters.count, 4);
assert.equal(sanitized.parameters.width, 64);
assert.equal(sanitized.parameters.providerOptions.moderation, 'low');
assert.equal(sanitized.parameters.providerOptions.apiKey, undefined);

const sanitizedNovelBatch = sanitizeImageRequest({
  provider: 'novel', apiKey: 'secret', model: 'nai-diffusion-5-full', prompt: 'portrait',
  parameters: { count: 4 },
});
assert.equal(sanitizedNovelBatch.parameters.count, 1, 'the gateway must never merge NovelAI outputs into one unrecoverable request');

const nestedSecrets = sanitizeImageRequest({
  provider: 'openai', apiKey: 'secret', model: 'gpt-image-2', prompt: 'test',
  parameters: { providerOptions: { metadata: { token: 'hidden', style: 'soft' }, headers: { authorization: 'hidden' } } },
});
assert.deepEqual({ ...nestedSecrets.parameters.providerOptions.metadata }, { style: 'soft' });
assert.equal(nestedSecrets.parameters.providerOptions.headers, undefined);

await assert.rejects(() => validateGatewayBaseUrl('http://127.0.0.1:8188', { resolveHost: publicDns }), /HTTPS/);
await assert.rejects(() => validateGatewayBaseUrl('https://localhost/v1', { resolveHost: publicDns }), /私有网络/);
await assert.rejects(() => validateGatewayBaseUrl('https://relay.example/v1?key=secret', { resolveHost: publicDns }), /查询参数/);
await assert.rejects(() => validateGatewayBaseUrl('https://[::ffff:127.0.0.1]/v1'), /私有网络/);
await assert.rejects(() => validateGatewayBaseUrl('https://relay.example/v1', { resolveHost: async () => [{ address: '203.0.113.8', family: 4 }] }), /私有网络/);
assert.equal((await validateGatewayBaseUrl('http://127.0.0.1:8188', { allowPrivateNetwork: true })).origin, 'http://127.0.0.1:8188');

let captured;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
const openai = await generateImage({
  provider: 'openai', apiKey: 'openai-key', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', prompt: 'portrait',
  parameters: { size: '1024x1536', quality: 'high', outputFormat: 'webp' },
}, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ id: 'img_req', data: [{ b64_json: tinyPng.toString('base64') }] }, { headers: { 'x-request-id': 'req-1' } });
  },
});
assert.equal(captured.url, 'https://relay.example/v1/images/generations');
assert.equal(captured.init.headers.Authorization, 'Bearer openai-key');
assert.equal(JSON.parse(captured.init.body).quality, 'high');
assert.ok(Buffer.from(openai.images[0].data, 'base64').equals(tinyPng));

await generateImage({
  provider: 'openai', apiKey: 'openai-key', baseUrl: 'https://relay.example/v1', model: 'gpt-image-2', prompt: 'edit portrait',
  referenceImages: [{ mime: 'image/png', data: tinyPng.toString('base64'), name: 'portrait.png' }],
  parameters: { size: '1024x1024', providerOptions: { input_fidelity: 'high', api_key: 'must-not-pass' } },
}, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('input_fidelity'), 'high');
    assert.equal(init.body.get('api_key'), null);
    assert.equal(init.body.getAll('image[]').length, 1);
    return jsonResponse({ data: [{ b64_json: tinyPng.toString('base64') }] });
  },
});
assert.equal(captured.url, 'https://relay.example/v1/images/edits');

const gemini = await generateImage({
  provider: 'banana', apiKey: 'gemini-key', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-flash-image', prompt: 'forest', negativePrompt: 'text',
  referenceImages: [{ mime: 'image/png', data: tinyPng.toString('base64') }], parameters: { aspectRatio: '16:9', imageSize: '2K' },
}, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: tinyPng.toString('base64') } }] } }] });
  },
});
assert.match(captured.url, /v1beta\/models\/gemini-3\.1-flash-image:generateContent$/);
assert.equal(captured.init.headers['x-goog-api-key'], 'gemini-key');
assert.equal(JSON.parse(captured.init.body).generationConfig.imageConfig.aspectRatio, '16:9');
assert.equal(gemini.text, 'done');

const seedream = await generateImage({
  provider: 'seedream', apiKey: 'ark-key', model: 'doubao-seedream-5-0-260128', prompt: 'city',
  referenceImages: [{ mime: 'image/png', data: tinyPng.toString('base64') }],
  parameters: { size: '2048x2048', seed: 5, watermark: false, count: 3 },
}, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ data: [{ b64_json: tinyPng.toString('base64') }], request_id: 'ark-1' });
  },
});
assert.match(captured.url, /api\/v3\/images\/generations$/);
const seedreamBody = JSON.parse(captured.init.body);
assert.equal(seedreamBody.seed, 5);
assert.equal(typeof seedreamBody.image, 'string', '单张 Seedream 参考图应使用字符串而不是数组');
assert.equal(seedreamBody.sequential_image_generation, 'auto');
assert.equal(seedreamBody.sequential_image_generation_options.max_images, 3);
assert.equal(seedream.upstreamId, 'ark-1');

const archive = storedZip('image_1.png', tinyPng);
assert.equal(extractZipImages(archive).length, 1);
const novel = await generateImage({
  provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-4-5-full', prompt: '1girl', negativePrompt: 'bad anatomy',
  parameters: { width: 832, height: 1216, steps: 28, scale: 5, count: 4 },
}, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    captured = { url: String(url), init };
    return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } });
  },
});
assert.match(captured.url, /ai\/generate-image$/);
assert.equal(JSON.parse(captured.init.body).parameters.negative_prompt, 'bad anatomy');
assert.equal(JSON.parse(captured.init.body).parameters.n_samples, 1);
assert.equal(novel.images[0].mime, 'image/png');

await generateImage({
  provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-5-full', prompt: '2girls at a station', negativePrompt: 'bad anatomy',
  parameters: { providerOptions: {
    v4_prompt: { caption: { base_caption: '2girls at a station', char_captions: [
      { char_caption: 'Alice, red hair', centers: [{ x: 0.25, y: 0.5 }] },
      { char_caption: 'Bob, blue hair', centers: [{ x: 0.75, y: 0.5 }] },
    ] }, use_coords: true, use_order: true },
    v4_negative_prompt: { caption: { base_caption: 'bad anatomy', char_captions: [] }, legacy_uc: false },
  } },
}, {
  resolveHost: publicDns,
  fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.parameters.v4_prompt.caption.base_caption, '2girls at a station');
    assert.equal(body.parameters.v4_prompt.caption.char_captions.length, 2);
    assert.deepEqual(body.parameters.v4_prompt.caption.char_captions[1].centers[0], { x: 0.75, y: 0.5 });
    assert.equal(body.parameters.v4_negative_prompt.legacy_uc, false);
    return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } });
  },
});

await generateImage({
  provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-4-5-full', prompt: 'portrait',
  referenceImages: [{ data: tinyPng.toString('base64'), mime: 'image/png', strength: 0.7, information: 0.8, fidelity: 0.75, referenceType: 'character&style' }],
  parameters: { providerOptions: { precise_reference: true } },
}, {
  resolveHost: publicDns,
  fetchImpl: async (_url, init) => {
    const parameters = JSON.parse(init.body).parameters;
    assert.equal(parameters.precise_reference, undefined);
    assert.equal(parameters.director_reference_images.length, 1);
    assert.deepEqual(parameters.director_reference_strength_values, [0.7]);
    assert.deepEqual(parameters.director_reference_secondary_strength_values, [0.25]);
    assert.deepEqual(parameters.director_reference_information_extracted, [0.8]);
    assert.equal(parameters.director_reference_descriptions[0].caption.base_caption, 'character&style');
    return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } });
  },
});

await assert.rejects(() => generateImage({
  provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-5-full', prompt: 'portrait',
  vibes: [{ data: tinyPng.toString('base64'), mime: 'image/png' }],
}, { resolveHost: publicDns, fetchImpl: async () => { throw new Error('must not call'); } }), /V5.*Vibe/i);

await assert.rejects(() => generateImage({
  provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-2', prompt: 'portrait',
  vibes: [{ data: tinyPng.toString('base64'), mime: 'image/png' }],
}, { resolveHost: publicDns, fetchImpl: async () => { throw new Error('must not call'); } }), /选择 V3、V4/);

await assert.rejects(() => generateImage({
  provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-3', prompt: 'portrait',
  referenceImages: [{ data: tinyPng.toString('base64'), mime: 'image/png' }],
}, { resolveHost: publicDns, fetchImpl: async () => { throw new Error('must not call'); } }), { code: 'novel_precise_reference_unsupported' });

assert.throws(() => sanitizeImageRequest({
  provider: 'openai', apiKey: 'key', model: 'gpt-image-2', prompt: 'test',
  referenceImages: [{ data: Buffer.from('not-an-image').toString('base64'), mime: 'image/png' }],
}), /不是有效/);

let comfyStep = 0;
let comfyUploads = 0;
const comfy = await generateImage({
  provider: 'comfy', baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true, model: 'workflow', prompt: 'rain', negativePrompt: 'blur',
  referenceImages: [
    { data: tinyPng.toString('base64'), mime: 'image/png', name: 'first.png' },
    { data: tinyPng.toString('base64'), mime: 'image/png', name: 'second.png' },
  ],
  parameters: {
    pollIntervalMs: 250, timeoutMs: 15_000, width: 832, seed: 42,
    workflow: { '1': { inputs: { text: '%qianmu_prompt%', negative: '%qianmu_negative%', width: '%qianmu_width%', seed: '%qianmu_seed%', refs: '%qianmu_references%' } } },
  },
}, {
  fetchImpl: async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/upload/image')) {
      comfyUploads++;
      assert.equal(init.body.get('overwrite'), 'false');
      assert.match(init.body.get('image').name, /^qianmu-[0-9a-f-]+-/);
      return jsonResponse({ name: `uploaded-${comfyUploads}.png` });
    }
    if (path.endsWith('/prompt')) {
      const inputs = JSON.parse(init.body).prompt['1'].inputs;
      assert.equal(inputs.text, 'rain');
      assert.equal(inputs.width, 832);
      assert.equal(inputs.seed, 42);
      assert.deepEqual(inputs.refs, ['uploaded-1.png', 'uploaded-2.png']);
      return jsonResponse({ prompt_id: 'prompt-1' });
    }
    if (path.endsWith('/history/prompt-1')) {
      comfyStep++;
      return jsonResponse(comfyStep > 1 ? { 'prompt-1': { status: { completed: true }, outputs: { '9': { images: [{ filename: 'done.png', subfolder: '', type: 'output' }] } } } } : {});
    }
    if (path.endsWith('/view')) return new Response(tinyPng, { status: 200, headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected Comfy URL ${url}`);
  },
});
assert.equal(comfy.upstreamId, 'prompt-1');
assert.equal(comfy.images.length, 1);
assert.equal(comfyUploads, 2);

let failedCalls = 0;
await assert.rejects(() => generateImage({
  provider: 'openai', apiKey: 'super-secret-key', model: 'gpt-image-2', prompt: 'test',
}, {
  resolveHost: publicDns,
  fetchImpl: async () => {
    failedCalls++;
    return jsonResponse({ error: { message: 'api_key=super-secret-key invalid' } }, { status: 503 });
  },
}), (error) => {
  const payload = imageGatewayErrorPayload(error);
  assert.equal(payload.body.retryable, true);
  assert.doesNotMatch(payload.body.message, /super-secret-key/);
  return true;
});
assert.equal(failedCalls, 1, '付费生图请求失败后不得自动重发');

let timeoutCalls = 0;
await assert.rejects(() => generateImage({
  provider: 'openai', apiKey: 'key', model: 'gpt-image-2', prompt: 'test',
}, {
  resolveHost: publicDns,
  fetchImpl: async () => {
    timeoutCalls++;
    const error = new Error('aborted request with key=key');
    error.name = 'AbortError';
    throw error;
  },
}), (error) => error?.code === 'upstream_timeout' && /没有自动重发/.test(error.message));
assert.equal(timeoutCalls, 1);

await assert.rejects(() => checkImageConnection({ provider: 'openai', apiKey: 'bad-key' }, {
  resolveHost: publicDns,
  fetchImpl: async () => jsonResponse({ error: { message: 'invalid API key' } }, { status: 401 }),
}), (error) => {
  assert.equal(error.status, 401);
  assert.equal(error.upstreamStatus, 401);
  assert.equal(error.retryable, false);
  return true;
});

await assert.rejects(() => generateImage({
  provider: 'openai', apiKey: 'key', model: 'gpt-image-2', prompt: 'test',
}, {
  resolveHost: publicDns,
  fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(49 * 1024 * 1024) } }),
}), (error) => error?.code === 'upstream_too_large');

const encodedSecret = tinyPng.toString('base64').repeat(40);
const redactedPayload = imageGatewayErrorPayload(new Error(`api_key=hidden-key {"b64_json":"${encodedSecret}"}`));
assert.doesNotMatch(redactedPayload.body.message, /hidden-key/);
assert.doesNotMatch(redactedPayload.body.message, new RegExp(encodedSecret.slice(0, 80)));

const checked = await checkImageConnection({ provider: 'openai', apiKey: 'key', model: 'gpt-image-2' }, {
  resolveHost: publicDns,
  fetchImpl: async (url) => {
    assert.match(String(url), /\/models$/);
    return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
  },
});
assert.equal(checked.ok, true);

const officialBananaChecked = await checkImageConnection({ provider: 'banana', apiKey: 'gemini-key', model: 'gemini-3.1-flash-image' }, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image');
    assert.equal(init.headers['x-goog-api-key'], 'gemini-key');
    return jsonResponse({ name: 'models/gemini-3.1-flash-image' });
  },
});
assert.equal(officialBananaChecked.ok, true);

const relayBananaChecked = await checkImageConnection({
  provider: 'banana', apiKey: 'relay-key', baseUrl: 'https://relay.example/v1beta', model: 'gemini-3.1-flash-image',
}, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://relay.example/v1beta/models');
    assert.equal(init.headers['x-goog-api-key'], 'relay-key');
    return jsonResponse({ models: [{ name: 'models/gemini-3.1-flash-image' }] });
  },
});
assert.equal(relayBananaChecked.ok, true);

await checkImageConnection({ provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-5-full' }, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://api.novelai.net/user/subscription');
    assert.equal(init.headers.Authorization, 'Bearer nai-key');
    return jsonResponse({ tier: 3 });
  },
});

const novelWithoutProbe = await checkImageConnection({ provider: 'novel', apiKey: 'nai-key', model: 'nai-diffusion-5-full' }, {
  resolveHost: publicDns,
  fetchImpl: async () => jsonResponse({ error: 'not found' }, { status: 404 }),
});
assert.equal(novelWithoutProbe.ok, true);
assert.equal(novelWithoutProbe.verified, false);
assert.equal(novelWithoutProbe.message, '地址可达，请以生图验证');

await checkImageConnection({ provider: 'seedream', apiKey: 'ark-key', model: 'doubao-seedream-5-0-260128' }, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://ark.cn-beijing.volces.com/api/v3/models');
    assert.equal(init.headers.Authorization, 'Bearer ark-key');
    return jsonResponse({ data: [{ id: 'doubao-seedream-5-0-260128' }] });
  },
});

await checkImageConnection({ provider: 'comfy', apiKey: 'comfy-token', baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }, {
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8188/system_stats');
    assert.equal(init.headers.Authorization, 'Bearer comfy-token');
    return jsonResponse({ system: { os: 'test' } });
  },
});

const openaiModels = await listImageModels({ provider: 'openai', apiKey: 'key', baseUrl: 'https://relay.example/v1' }, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://relay.example/v1/models');
    assert.equal(init.headers.Authorization, 'Bearer key');
    return jsonResponse({ data: [{ id: 'text-only-model', owned_by: 'relay' }, { id: 'gpt-image-2', owned_by: 'relay' }] });
  },
});
assert.deepEqual(openaiModels.models.map((item) => item.id), ['gpt-image-2', 'text-only-model']);
assert.equal(openaiModels.models[0].imageCapable, true);
assert.equal(openaiModels.models[1].imageCapable, false);
assert.equal(openaiModels.total, 2);

const nestedRelayModels = await listImageModels({ provider: 'seedream', apiKey: 'key', baseUrl: 'https://relay.example/ark/v1' }, {
  resolveHost: publicDns,
  fetchImpl: async () => jsonResponse({ result: { list: [{ modelId: 'doubao-seedream-custom', display_name: 'Seedream Custom' }] } }),
});
assert.equal(nestedRelayModels.models[0].id, 'doubao-seedream-custom');
assert.equal(nestedRelayModels.models[0].imageCapable, true);

let geminiModelPage = 0;
const geminiModels = await listImageModels({ provider: 'banana', apiKey: 'gemini-key', baseUrl: 'https://generativelanguage.googleapis.com' }, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    geminiModelPage++;
    assert.match(String(url), /\/v1beta\/models\?/);
    assert.equal(init.headers['x-goog-api-key'], 'gemini-key');
    if (geminiModelPage === 1) return jsonResponse({ models: [{ name: 'models/gemini-text' }], nextPageToken: 'next-page' });
    assert.equal(new URL(url).searchParams.get('pageToken'), 'next-page');
    return jsonResponse({ models: [{ name: 'models/gemini-3.1-flash-image', displayName: 'Nano Banana 2' }] });
  },
});
assert.equal(geminiModelPage, 2);
assert.deepEqual(geminiModels.models.map((item) => item.id), ['gemini-3.1-flash-image', 'gemini-text']);

const relayGeminiModels = await listImageModels({ provider: 'banana', apiKey: 'relay-key', baseUrl: 'https://relay.example/v1beta' }, {
  resolveHost: publicDns,
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://relay.example/v1beta/models?pageSize=1000');
    assert.equal(init.headers['x-goog-api-key'], 'relay-key');
    return jsonResponse({ models: [{ name: 'models/gemini-text' }, { name: 'models/gemini-custom-image' }] });
  },
});
assert.deepEqual(relayGeminiModels.models.map((item) => item.id), ['gemini-custom-image', 'gemini-text']);
assert.equal(relayGeminiModels.models[0].imageCapable, true);
assert.equal(relayGeminiModels.models[1].imageCapable, false);

const novelModels = await listImageModels({ provider: 'novel', apiKey: 'nai-key' }, { resolveHost: publicDns });
assert.equal(novelModels.source, 'builtin');
assert.ok(novelModels.models.some((item) => item.id === 'nai-diffusion-5-full'));
assert.ok(novelModels.models.some((item) => item.id === 'safe-diffusion'));

const comfyModels = await listImageModels({ provider: 'comfy', baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }, {
  fetchImpl: async (url) => {
    assert.match(String(url), /\/object_info$/);
    return jsonResponse({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['flux.safetensors', 'sdxl.safetensors']] } } },
      UNETLoaderGGUF: { input: { required: { unet_name: [['flux.gguf']] } } },
      TextEncoder: { input: { required: { model_name: [['must-not-be-included']] } } },
    });
  },
});
assert.deepEqual(comfyModels.models.map((item) => item.id), ['flux.gguf', 'flux.safetensors', 'sdxl.safetensors']);
assert.equal(comfyModels.models.find((item) => item.id === 'flux.gguf').kind, 'diffusion-model');

await assert.rejects(() => generateImage({
  provider: 'openai', apiKey: 'key', model: 'gpt-image-2', prompt: 'test',
}, {
  resolveHost: publicDns,
  fetchImpl: async () => jsonResponse({ data: [{ url: 'https://127.0.0.1/private.png' }] }),
}), /不安全/);

console.log('Image gateway contract OK');
