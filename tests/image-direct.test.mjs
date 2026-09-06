import assert from 'node:assert/strict';

import {
  DirectImageError,
  checkDirectImageConnection,
  generateDirectImage,
  isDirectImageTransportError,
  novelDirectEndpoint,
} from '../qianmu-image-direct.js';

assert.equal(novelDirectEndpoint('https://image.novelai.net/', 'user/subscription'), 'https://image.novelai.net/ai/user/subscription');
assert.equal(novelDirectEndpoint('https://mirror.example/ai/generate-image', 'generate-image'), 'https://mirror.example/ai/generate-image');

let request = null;
const partial = await checkDirectImageConnection({ provider: 'novel', apiKey: 'nai-key', baseUrl: 'https://image.novelai.net' }, {
  fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response('Not Found', { status: 404 });
  },
});
assert.equal(request.url, 'https://image.novelai.net/ai/user/subscription');
assert.equal(request.init.headers.Authorization, 'Bearer nai-key');
assert.equal(partial.ok, true);
assert.equal(partial.verified, false, '404 订阅端点只能降级为待生图验证，不得报连接失败');

const verified = await checkDirectImageConnection({ provider: 'novel', apiKey: 'nai-key', baseUrl: 'https://image.novelai.net' }, {
  fetchImpl: async () => new Response(JSON.stringify({ tier: 3, active: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
});
assert.equal(verified.verified, true);
assert.match(verified.message, /Opus/);

await assert.rejects(
  () => checkDirectImageConnection({ provider: 'novel', apiKey: 'bad', baseUrl: 'https://image.novelai.net' }, {
    fetchImpl: async () => new Response('Unauthorized', { status: 401 }),
  }),
  /API Key 错误/,
);

const generated = await generateDirectImage({
  provider: 'novel', apiKey: 'nai-key', baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-5-full',
  prompt: 'artist:test, cinematic scene', negativePrompt: 'bad anatomy',
  parameters: {
    width: 1216, height: 832, count: 1, steps: 28, scale: 5.5, seed: 7,
    sampler: 'k_euler', scheduler: 'karras',
    providerOptions: {
      cfg_rescale: 0,
      v4_prompt: { caption: { base_caption: 'scene', char_captions: [{ char_caption: 'Alice', centers: [{ x: 0.25, y: 0.5 }] }] }, use_coords: true, use_order: true },
    },
  },
}, {
  fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200, headers: { 'content-type': 'application/zip', 'x-request-id': 'nai-direct' } });
  },
  unzipImpl: async () => [{ id: 'image.png', mime: 'image/png', data: 'aW1hZ2U=', url: '' }],
});
assert.equal(request.url, 'https://image.novelai.net/ai/generate-image');
const body = JSON.parse(request.init.body);
assert.equal(body.input, 'artist:test, cinematic scene');
assert.equal(body.parameters.negative_prompt, 'bad anatomy');
assert.equal(body.parameters.noise_schedule, 'karras');
assert.deepEqual(body.parameters.v4_prompt.caption.char_captions[0].centers, [{ x: 0.25, y: 0.5 }]);
assert.equal(generated.transport, 'direct');
assert.equal(generated.images[0].data, 'aW1hZ2U=');
assert.equal(generated.sequential, true);

const sequentialBodies = [];
const waitDurations = [];
let novelAttempt = 0;
const sequential = await generateDirectImage({
  provider: 'novel', apiKey: 'nai-key', baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-full',
  prompt: 'three sequential frames', parameters: { count: 3, seed: 20 },
}, {
  waitImpl: async (ms) => waitDurations.push(ms),
  fetchImpl: async (_url, init) => {
    novelAttempt++;
    sequentialBodies.push(JSON.parse(init.body));
    if (novelAttempt === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '2' } });
    return new Response(JSON.stringify({ images: [{ id: `seq-${novelAttempt}`, data: `aW1hZ2Ut${novelAttempt}` }] }), {
      status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `req-${novelAttempt}` },
    });
  },
});
assert.equal(sequential.images.length, 3);
assert.equal(sequential.requestCount, 3);
assert.equal(sequentialBodies.length, 4, '首张 429 后重试，其余图片各自单独请求');
assert.deepEqual(sequentialBodies.map((item) => item.parameters.n_samples), [1, 1, 1, 1]);
assert.deepEqual(sequentialBodies.map((item) => item.parameters.seed), [20, 20, 21, 22]);
assert.deepEqual(waitDurations, [2000]);

function storedZip(name, payload) {
  const encoder = new TextEncoder(), file = encoder.encode(name), data = new Uint8Array(payload);
  const localSize = 30 + file.length + data.length, centralSize = 46 + file.length;
  const bytes = new Uint8Array(localSize + centralSize + 22), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint16(8, 0, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, file.length, true);
  bytes.set(file, 30); bytes.set(data, 30 + file.length);
  const central = localSize;
  view.setUint32(central, 0x02014b50, true); view.setUint16(central + 10, 0, true); view.setUint32(central + 20, data.length, true); view.setUint32(central + 24, data.length, true); view.setUint16(central + 28, file.length, true); view.setUint32(central + 42, 0, true);
  bytes.set(file, central + 46);
  const end = central + centralSize;
  view.setUint32(end, 0x06054b50, true); view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true); view.setUint32(end + 12, centralSize, true); view.setUint32(end + 16, central, true);
  return bytes;
}

const storedArchive = storedZip('direct.png', [137, 80, 78, 71]);
const unzippedWithoutLibrary = await generateDirectImage({
  provider: 'novel', apiKey: 'nai-key', baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-5-full', prompt: 'test', parameters: {},
}, {
  fetchImpl: async () => new Response(storedArchive, { status: 200, headers: { 'content-type': 'application/zip' } }),
});
assert.equal(unzippedWithoutLibrary.images[0].id, 'direct.png');
assert.equal(unzippedWithoutLibrary.images[0].data, 'iVBORw==');

const checkedOpenAI = await checkDirectImageConnection({ provider: 'openai', apiKey: 'openai-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' }, {
  fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(request.url, 'https://api.openai.com/v1/models');
assert.equal(request.init.headers.Authorization, 'Bearer openai-key');
assert.equal(checkedOpenAI.verified, true);

const openai = await generateDirectImage({
  provider: 'openai', apiKey: 'openai-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1',
  prompt: 'a quiet room', negativePrompt: 'text', parameters: { count: 1, size: '1536x1024', outputFormat: 'png' },
}, {
  fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: 'oa-1', data: [{ b64_json: 'b3BlbmFp' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
assert.match(JSON.parse(request.init.body).prompt, /Exclude from the image: text/);
assert.equal(openai.images[0].data, 'b3BlbmFp');

const banana = await generateDirectImage({
  provider: 'banana', apiKey: 'gemini-key', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-image',
  prompt: 'blue hour', parameters: { count: 1, aspectRatio: '3:2' },
}, {
  fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: 'YmFuYW5h' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.match(request.url, /\/v1beta\/models\/gemini-2\.5-flash-image:generateContent$/);
assert.equal(request.init.headers['x-goog-api-key'], 'gemini-key');
assert.equal(banana.images[0].data, 'YmFuYW5h');

const seedream = await generateDirectImage({
  provider: 'seedream', apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-5',
  prompt: 'rainy street', parameters: { count: 2, size: '2048x1365', sequential: true, watermark: false },
}, {
  fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ request_id: 'seed-1', data: [{ b64_json: 'c2VlZHJlYW0=' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
assert.equal(JSON.parse(request.init.body).sequential_image_generation_options.max_images, 2);
assert.equal(seedream.upstreamId, 'seed-1');

let comfyStep = 0;
const comfy = await generateDirectImage({
  provider: 'comfy', baseUrl: 'http://127.0.0.1:8188', prompt: 'forest', negativePrompt: 'fog',
  parameters: { workflow: { 1: { inputs: { text: '%qianmu_prompt%' } } }, pollIntervalMs: 250, timeoutMs: 15000 },
}, {
  waitImpl: async () => {},
  fetchImpl: async (url, init) => {
    comfyStep++;
    if (url.endsWith('/prompt')) {
      assert.equal(JSON.parse(init.body).prompt['1'].inputs.text, 'forest');
      return new Response(JSON.stringify({ prompt_id: 'comfy-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/history/comfy-1')) return new Response(JSON.stringify({ 'comfy-1': { status: { completed: true }, outputs: { 2: { images: [{ filename: 'out.png', type: 'output' }] } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/view?')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected Comfy request: ${url}`);
  },
});
assert.equal(comfyStep, 3);
assert.equal(comfy.upstreamId, 'comfy-1');
assert.ok(comfy.images[0].data);

let transportError = null;
try {
  await checkDirectImageConnection({ provider: 'novel', apiKey: 'key', baseUrl: 'https://image.novelai.net' }, {
    fetchImpl: async () => { throw new TypeError('CORS blocked'); },
  });
} catch (error) { transportError = error; }
assert.ok(transportError instanceof DirectImageError);
assert.equal(isDirectImageTransportError(transportError), true);

console.log('Browser-direct image adapter contract OK');
