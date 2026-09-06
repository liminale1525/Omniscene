import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { checkComfyReadiness, prepareComfyReadiness, inspectComfyDefinitions } from '../qianmu-comfy-readiness.js';
import { checkServerComfyReadiness, pinnedComfyInspectionFetch } from '../qianmu-comfy-readiness-server.js';

const node = (class_type, inputs) => ({ class_type, inputs });
const spec = (required, output, output_node = false) => ({ input: { required, optional: {} }, output, output_node });
export const readinessGraph = {
  model: node('CheckpointLoaderSimple', { ckpt_name: 'test.safetensors' }),
  text: node('CLIPTextEncode', { clip: ['model', 1], text: '%qianmu_prompt%' }),
  latent: node('EmptyLatentImage', { width: '%qianmu_width%', height: 1024, batch_size: 1 }),
  sampler: node('KSampler', { model: ['model', 0], positive: ['text', 0], negative: ['text', 0], latent_image: ['latent', 0],
    seed: 0, steps: 28, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 }),
  decode: node('VAEDecode', { samples: ['sampler', 0], vae: ['model', 2] }),
  save: node('SaveImage', { images: ['decode', 0], filename_prefix: 'qianmu' }),
};
export const readinessDefinitions = {
  CheckpointLoaderSimple: spec({ ckpt_name: [['test.safetensors']] }, ['MODEL', 'CLIP', 'VAE']),
  CLIPTextEncode: spec({ clip: ['CLIP'], text: ['STRING', { multiline: true }] }, ['CONDITIONING']),
  EmptyLatentImage: spec({ width: ['INT', { min: 64, max: 8192 }], height: ['INT'], batch_size: ['INT'] }, ['LATENT']),
  KSampler: spec({ model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
    seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['euler']], scheduler: [['normal']], denoise: ['FLOAT'] }, ['LATENT']),
  VAEDecode: spec({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE']),
  SaveImage: spec({ images: ['IMAGE'], filename_prefix: ['STRING'] }, [], true),
};
const input = () => ({ baseUrl: 'https://comfy.example/api', workflow: structuredClone(readinessGraph), parameters: { width: 832 }, apiKey: 'private-key' });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fakeFetch(defs = readinessDefinitions, calls = []) {
  return async (url, options) => {
    calls.push({ url, options }); const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    return json(Object.hasOwn(defs, name) ? { [name]: defs[name] } : {});
  };
}
const prepared = () => prepareComfyReadiness(input()).graph;

test('readiness only GETs the unique classes with bounded, non-redirecting credential-isolated requests', async () => {
  const calls = [], before = input(); const result = await checkComfyReadiness(before, { fetchImpl: fakeFetch(undefined, calls) });
  assert.equal(result.ready, true); assert.equal(result.actualGenerationVerified, false); assert.equal(calls.length, 6);
  for (const { url, options } of calls) {
    assert.match(url, /^https:\/\/comfy.example\/api\/object_info\//); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer private-key');
  }
  assert.deepEqual(before, input()); assert.doesNotMatch(JSON.stringify(result), /private-key|safetensors|qianmu-readiness-check/);
});

test('same class reused by many nodes is fetched once; missing class is {} not a successful installation', async () => {
  const value = input(); value.workflow.more = structuredClone(value.workflow.text);
  const defs = structuredClone(readinessDefinitions); delete defs.CLIPTextEncode;
  const calls = [], result = await checkComfyReadiness(value, { fetchImpl: fakeFetch(defs, calls) });
  assert.equal(calls.length, 6); assert.equal(result.ready, false); assert.equal(result.issues.filter(row => row.code === 'missing_node').length, 2);
});

test('checks required inputs, enum model/LoRA/sampler options, numeric range and literal type', () => {
  const graph = prepared(); delete graph.sampler.inputs.steps; graph.model.inputs.ckpt_name = 'not-installed';
  graph.latent.inputs.width = 999999; graph.text.inputs.text = 9; graph.sampler.inputs.sampler_name = 'absent';
  const result = inspectComfyDefinitions(graph, readinessDefinitions);
  for (const code of ['missing_input', 'option_unavailable', 'number_range', 'value_type']) assert.ok(result.issues.some(row => row.code === code));
  assert.equal(result.errors, 5); assert.equal(result.ready, false);
});

test('checks connected output index and type, including valid union output types', () => {
  const graph = prepared(); graph.text.inputs.clip = ['model', 9]; graph.decode.inputs.samples = ['model', 0];
  let result = inspectComfyDefinitions(graph, readinessDefinitions);
  assert.ok(result.issues.some(row => row.code === 'output_index')); assert.ok(result.issues.some(row => row.code === 'type_mismatch'));
  const defs = structuredClone(readinessDefinitions); defs.CheckpointLoaderSimple.output[1] = 'OTHER, CLIP';
  result = inspectComfyDefinitions(prepared(), defs); assert.equal(result.ready, true);
});

test('unknown descriptors, custom inputs and dynamic choices remain uncertain and remote option URLs never execute', async () => {
  const defs = structuredClone(readinessDefinitions);
  defs.CheckpointLoaderSimple.input.required.ckpt_name = [[], { remote: { route: 'https://do-not-follow.example' } }];
  defs.CLIPTextEncode.input.required.clip = ['*'];
  defs.SaveImage = { inputs: {}, outputs: [] }; // v2 normalized frontend format is not the raw v1 server contract.
  const calls = [], result = await checkComfyReadiness(input(), { fetchImpl: fakeFetch(defs, calls) });
  assert.equal(result.ready, false); assert.ok(result.warnings >= 3); assert.equal(calls.length, 6);
  assert.ok(calls.every(call => !call.url.includes('do-not-follow')));
});

test('output contract and malformed input links are not silently treated as ready', () => {
  const graph = prepared(), defs = structuredClone(readinessDefinitions); defs.SaveImage.output_node = false;
  graph.text.inputs.clip = ['model', -1]; graph.sampler.inputs.latent_image = ['missing', 0];
  const result = inspectComfyDefinitions(graph, defs);
  assert.equal(result.issues.filter(row => row.code === 'invalid_link').length, 2);
  assert.ok(result.issues.some(row => row.code === 'output_contract'));
});

test('reject invalid local workflow, unresolved refs, unsafe class paths and too many classes before fetching', async () => {
  const variants = [ { workflow: '{}' }, { workflow: { ...readinessGraph, text: node('CLIPTextEncode', { text: '%qianmu_reference%' }) } },
    { workflow: { ...readinessGraph, extra: node('..', {}) } },
    { workflow: { ...readinessGraph, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`n${i}`, node(`Extra${i}`, {})])) } },
    ...['a/b', 'a\\b', 'a%2fb', 'a?b'].map(name => ({ workflow: { ...readinessGraph, extra: node(name, {}) } })) ];
  for (const variant of variants) {
    let called = false;
    await assert.rejects(checkComfyReadiness({ ...input(), ...variant }, { fetchImpl: () => { called = true; throw new Error(); } }));
    assert.equal(called, false);
  }
});

test('class names with spaces are encoded and prototype keys never resolve inherited definitions', async () => {
  const value = input(); value.workflow.extra = node('Custom node (test)', {});
  const defs = { ...readinessDefinitions, 'Custom node (test)': spec({}, []) }, calls = [];
  assert.equal((await checkComfyReadiness(value, { fetchImpl: fakeFetch(defs, calls) })).ready, true);
  assert.ok(calls.at(-1).url.includes('Custom%20node'));
  assert.equal(inspectComfyDefinitions({ x: node('toString', {}) }, {}).issues[0].code, 'missing_node');
});

test('reject URL credentials, queries, non-http and malformed authorization without network', async () => {
  for (const variant of [{ baseUrl: 'file:///tmp/a' }, { baseUrl: 'https://x/?key=secret' }, { baseUrl: 'https://user:password@x/' }, { apiKey: 'bad\r\nkey' }]) {
    await assert.rejects(checkComfyReadiness({ ...input(), ...variant }, { fetchImpl: () => assert.fail('must not fetch') }));
  }
});

test('HTTP failures never include reflected keys, follow redirects, retry or become readiness success', async () => {
  for (const status of [302, 401, 403, 404, 429, 500]) {
    let calls = 0;
    await assert.rejects(checkComfyReadiness(input(), { fetchImpl: async () => { calls++; return new Response('private-key', { status }); } }),
      error => error.code === `comfy_readiness_http_${status}` && !error.message.includes('private-key'));
    assert.equal(calls, 1);
  }
});

test('HTML login pages and oversized/chunked descriptors are rejected without fallback or generation', async () => {
  const values = [new Response('<html>login</html>'), new Response('x', { headers: { 'content-length': '2000000' } }),
    new Response('x'.repeat(1024 * 1024 + 1))];
  for (const response of values) await assert.rejects(checkComfyReadiness(input(), { fetchImpl: async () => response }), error => /definition_format|response_limit/.test(error.code));
});

test('one deadline covers body reads and all class requests; caller cancellation stops the remaining requests', async () => {
  await assert.rejects(checkComfyReadiness(input(), { timeoutMs: 100, fetchImpl: async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) }), { code: 'comfy_readiness_cancelled' });
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(checkComfyReadiness(input(), { signal: controller.signal, fetchImpl: async () => { calls++; controller.abort(); return json({}); } }), { code: 'comfy_readiness_cancelled' });
  assert.equal(calls, 1);
});

test('issues are bounded but total error count remains truthful', () => {
  const graph = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i, node('Missing', {})]));
  const result = inspectComfyDefinitions(graph, {}); assert.equal(result.issues.length, 64); assert.equal(result.issueCount, 100); assert.equal(result.errors, 100);
});

test('total inventory memory is bounded across many distinct small descriptors', async () => {
  const value = input(); for (let i = 0; i < 6; i++) value.workflow[`extra${i}`] = node(`Extra${i}`, {});
  let calls = 0;
  await assert.rejects(checkComfyReadiness(value, { fetchImpl: async url => {
    calls++; const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    return json({ [name]: { ...(readinessDefinitions[name] || spec({}, [])), description: 'a'.repeat(800000) } });
  } }), { code: 'comfy_readiness_response_limit' });
  assert.ok(calls < 12);
});

test('oversized descriptor field sets and option arrays stay uncertain instead of monopolizing validation', () => {
  const defs = structuredClone(readinessDefinitions);
  defs.CheckpointLoaderSimple.input.required.ckpt_name = [Array(20001).fill('test.safetensors')];
  defs.CLIPTextEncode.input.optional = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [i, ['STRING']]));
  const result = inspectComfyDefinitions(prepared(), defs); assert.equal(result.ready, false); assert.ok(result.warnings >= 2);
});

const user = admin => ({ user: { profile: { handle: 'alice', enabled: true, admin } } });
function transport(calls = [], hook = () => {}) {
  return (url, options, callback) => {
    calls.push({ url, options });
    const outgoing = new EventEmitter(); outgoing.end = () => {
      hook();
      const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' };
      const name = decodeURIComponent(url.pathname.split('/').at(-1));
      callback(incoming); incoming.end(JSON.stringify({ [name]: readinessDefinitions[name] }));
    };
    return outgoing;
  };
}

test('server requires real ST authentication and private inspection requires explicit admin permission', async () => {
  const options = { resolveHost: () => assert.fail('must not resolve'), requestImpl: () => assert.fail('must not connect') };
  await assert.rejects(checkServerComfyReadiness({}, input(), options), { status: 401 });
  await assert.rejects(checkServerComfyReadiness(user(false), { ...input(), allowPrivateNetwork: true }, options), { status: 403 });
});

test('server public target pins once-resolved IPs, exact origin and GET-only node paths', async () => {
  const calls = []; let resolutions = 0;
  const result = await checkServerComfyReadiness(user(false), input(), { resolveHost: async () => { resolutions++; return [{ address: '8.8.8.8', family: 4 }]; }, requestImpl: transport(calls) });
  assert.equal(result.ready, true); assert.equal(result.requester, 'ST 主机'); assert.equal(resolutions, 1); assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer private-key');
    call.options.lookup('comfy.example', { all: true }, (error, list) => { assert.equal(error, null); assert.deepEqual(list, [{ address: '8.8.8.8', family: 4 }]); });
    call.options.lookup('changed.example', {}, error => assert.ok(error));
  }
  const pinned = pinnedComfyInspectionFetch(new URL(input().baseUrl), [{ address: '8.8.8.8' }], { requestImpl: () => assert.fail('must not connect') });
  for (const [url, method] of [['https://evil.example/api/object_info/A', 'GET'], ['https://comfy.example/api/prompt', 'POST'], ['https://comfy.example/api/object_info/A/extra', 'GET']]) await assert.rejects(pinned(url, { method }));
});

test('private target is opt-in, metadata targets remain blocked, DNS rebinding cannot change resolved request addresses', async () => {
  await assert.rejects(checkServerComfyReadiness(user(false), input(), { resolveHost: async () => [{ address: '127.0.0.1' }] }), { code: 'private_network_blocked' });
  for (const address of ['169.254.169.254', '0.0.0.0', '224.0.0.1', 'fe80::1', '::ffff:127.0.0.1']) {
    await assert.rejects(checkServerComfyReadiness(user(true), { ...input(), allowPrivateNetwork: true }, { resolveHost: async () => [{ address }] }), { code: 'comfy_readiness_unsafe_target' });
  }
  const calls = [];
  assert.equal((await checkServerComfyReadiness(user(true), { ...input(), baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }, { resolveHost: async () => [{ address: '127.0.0.1' }], requestImpl: transport(calls) })).ready, true);
  assert.equal(calls[0].url.hostname, '127.0.0.1');
});

test('account changes during an inspection cannot deliver a successful result to a new account', async () => {
  const req = user(false), calls = [];
  await assert.rejects(checkServerComfyReadiness(req, input(), { resolveHost: async () => [{ address: '8.8.8.8' }],
    requestImpl: transport(calls, () => { req.user.profile.handle = 'bob'; }) }), { code: 'comfy_readiness_account_changed' });
  assert.equal(calls.length, 1);
});

test('server redirect response never forwards authorization to another host', async () => {
  let calls = 0;
  await assert.rejects(checkServerComfyReadiness(user(false), input(), { resolveHost: async () => [{ address: '8.8.8.8' }], requestImpl: (_, options, callback) => {
    calls++; const out = new EventEmitter(); out.end = () => {
      const incoming = new PassThrough(); incoming.statusCode = 302; incoming.headers = { location: 'http://127.0.0.1' }; callback(incoming);
    }; return out;
  } }), { code: 'comfy_readiness_redirect' });
  assert.equal(calls, 1);
});
