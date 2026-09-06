import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { generateDirectImage, isDirectImageTransportError } from '../qianmu-image-direct.js';
import { generateImage, imageGatewayErrorPayload } from '../qianmu-image-gateway.js';
import { createStoryboardDefaults, normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, name);
  const tail = source.slice(start.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
const image = () => new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { headers: { 'content-type': 'application/json' } });
const input = (extra = {}) => ({ provider: 'openai', baseUrl: 'https://images.example/v1', apiKey: 'mock-key', model: 'gpt-image-1', prompt: 'garden', parameters: { count: 1 }, ...extra });
const unknown = error => {
  assert.equal(error.code, 'image_submission_unknown'); assert.equal(error.submissionState, 'unknown');
  assert.equal(error.retryable, false); assert.equal(isDirectImageTransportError(error), false); return true;
};

test('a failed read-only preflight proves no image write occurred, allowing one alternate transport', async () => {
  const methods = []; let submissions = 0;
  await assert.rejects(() => generateDirectImage(input(), {
    probeTransport: true, beforeSubmit: () => { submissions++; },
    fetchImpl: async (_url, options) => { methods.push(options.method); throw new TypeError('simulated offline'); },
  }), error => { assert.equal(error.submissionState, 'not_submitted'); assert.equal(isDirectImageTransportError(error), true); assert.equal(error.retryable, false); return true; });
  assert.deepEqual(methods, ['GET']); assert.equal(submissions, 0);
});

test('readable catalog HTTP errors do not deny authorized generation or parse a large probe body', async () => {
  for (const status of [200, 401, 403, 404, 405, 429, 503]) {
    const methods = []; let cancelled = 0;
    const result = await generateDirectImage(input(), { probeTransport: true, fetchImpl: async (_url, options) => {
      methods.push(options.method);
      if (options.method === 'GET') return { status, ok: status === 200, body: { cancel: async () => { cancelled++; } }, json: () => { throw new Error('must not parse'); } };
      return image();
    } });
    assert.deepEqual(methods, ['GET', 'POST']); assert.equal(cancelled, 1); assert.equal(result.images.length, 1);
  }
});

test('a network failure after POST is uncertain, never a pre-submission transport failure', async () => {
  const methods = [];
  await assert.rejects(() => generateDirectImage(input(), { probeTransport: true, fetchImpl: async (_url, options) => {
    methods.push(options.method); if (options.method === 'GET') return new Response('{}'); throw new TypeError('simulated response lost');
  } }), unknown);
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('disabling catalog probing remains zero GET and never authorizes resend after an uncertain POST', async () => {
  const methods = [];
  await assert.rejects(() => generateDirectImage(input({ compatibility: { modelDiscovery: 'off' } }), { probeTransport: true, fetchImpl: async (_url, options) => {
    methods.push(options.method); throw new TypeError('simulated response lost');
  } }), unknown);
  assert.deepEqual(methods, ['POST']);
});

test('preflight timeout releases its signal and issues no paid write', async () => {
  let calls = 0;
  await assert.rejects(() => generateDirectImage(input(), { probeTransport: true, probeTimeoutMs: 100, fetchImpl: (_url, options) => {
    calls++; assert.equal(options.method, 'GET');
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } }), error => { assert.equal(error.submissionState, 'not_submitted'); assert.equal(isDirectImageTransportError(error), true); return true; });
  assert.equal(calls, 1);
});

test('explicit cancellation during preflight is not authorization to use an alternate transport', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => generateDirectImage(input({ signal: controller.signal }), { probeTransport: true, fetchImpl: async (_url, options) => {
    calls++; controller.abort(); throw options.signal.reason;
  } }), error => { assert.equal(error.name, 'AbortError'); assert.equal(error.submissionState, 'not_submitted'); assert.equal(isDirectImageTransportError(error), false); return true; });
  assert.equal(calls, 1);
});

test('submission-time policy cancellation is preserved and stops the first POST', async () => {
  const methods = [];
  await assert.rejects(() => generateDirectImage(input(), { probeTransport: true,
    beforeSubmit: () => { throw Object.assign(new Error('disabled while preparing'), { code: 'storyboard_submission_cancelled' }); },
    fetchImpl: async (_url, options) => { methods.push(options.method); return new Response('{}'); },
  }), { code: 'storyboard_submission_cancelled', submissionState: 'not_submitted' });
  assert.deepEqual(methods, ['GET']);
});

test('invalid input and workflow are rejected before the transport probe', async () => {
  let calls = 0;
  for (const value of [input({ prompt: '' }), input({ provider: 'novel', model: '' }), input({ provider: 'comfy', parameters: { workflow: { bad: true } } })]) {
    await assert.rejects(() => generateDirectImage(value, { probeTransport: true, fetchImpl: async () => { calls++; throw new Error('unexpected'); } }), error => !isDirectImageTransportError(error));
  }
  assert.equal(calls, 0);
});

test('successful POST with unreadable or invalid JSON retains accepted status without fallback', async () => {
  let writes = 0;
  await assert.rejects(() => generateDirectImage(input(), { fetchImpl: async () => { writes++; return new Response('{'); } }), error => {
    assert.equal(error.code, 'invalid_json'); assert.equal(error.submissionState, 'accepted'); assert.equal(isDirectImageTransportError(error), false); return true;
  });
  assert.equal(writes, 1);
});

test('Comfy polling failure after prompt acceptance does not submit a second workflow', async () => {
  const calls = [];
  await assert.rejects(() => generateDirectImage(input({ provider: 'comfy', model: 'comfy-workflow', parameters: { workflow: { '1': { class_type: 'TestNode', inputs: { text: '%qianmu_prompt%' } } } } }), {
    probeTransport: true, waitImpl: async () => {}, fetchImpl: async (url, options) => {
      calls.push([new URL(url).pathname, options.method]);
      if (url.endsWith('/system_stats')) return new Response('{}');
      if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'accepted-job' }));
      throw new TypeError('history disconnected');
    },
  }), unknown);
  assert.deepEqual(calls, [['/v1/system_stats', 'GET'], ['/v1/prompt', 'POST'], ['/v1/history/accepted-job', 'GET']]);
});

test('NAI retries only explicit 429, probes once, and remains bounded at three writes', async () => {
  let probes = 0, writes = 0, guards = 0; const waits = [];
  await assert.rejects(() => generateDirectImage(input({ provider: 'novel', model: 'nai-diffusion-5-full' }), {
    probeTransport: true, beforeSubmit: () => { guards++; }, waitImpl: async ms => waits.push(ms),
    fetchImpl: async (_url, options) => { if (options.method === 'GET') { probes++; return new Response('{}'); } writes++; return new Response('busy', { status: 429 }); },
  }), error => { assert.equal(error.status, 429); assert.equal(error.submissionState, 'rejected'); return true; });
  assert.equal(probes, 1); assert.equal(writes, 3); assert.equal(guards, 3); assert.equal(waits.length, 2);
  assert.ok(waits.every(ms => ms >= 500 && ms <= 30000));
});

test('NAI cancellation during 429 backoff prevents another POST and preserves the known rejection', async () => {
  let stopped = false, writes = 0;
  await assert.rejects(() => generateDirectImage(input({ provider: 'novel', model: 'nai-diffusion-5-full' }), {
    beforeSubmit: () => { if (stopped) throw Object.assign(new Error('disabled'), { code: 'storyboard_submission_cancelled', submissionState: 'unknown' }); },
    waitImpl: async () => { stopped = true; }, fetchImpl: async () => { writes++; return new Response('busy', { status: 429 }); },
  }), { code: 'storyboard_submission_cancelled', submissionState: 'rejected' });
  assert.equal(writes, 1);
});

test('NAI partial variant success cannot be reclassified as wholly unaccepted by a later rejection', async () => {
  let writes = 0;
  await assert.rejects(() => generateDirectImage(input({ provider: 'novel', model: 'nai-diffusion-5-full', parameters: { count: 2 } }), {
    fetchImpl: async () => { writes++; return writes === 1 ? image() : new Response('no funds', { status: 402 }); },
  }), error => { assert.equal(error.status, 402); assert.equal(error.submissionState, 'accepted'); return true; });
  assert.equal(writes, 2);
});

test('actual job runner falls back only after actual read-only preflight failure, never after POST', async () => {
  for (const failureAt of ['preflight', 'direct', 'cancel']) {
  const state = { enabled: true }, job = { target: 'gallery', source: 'openai' }, log = {}; const finished = [], posts = [];
  const directMethods = [];
  const run = vm.runInNewContext(`${section('storyboardRunJob')}\nstoryboardRunJob`, {
    storyboardAdmission: { beforeSubmit: async () => {} }, storyboardSettleImageAdmission: async () => {},
    MODULE_NAME: 'test', storyboardState: () => state, storyboardPlanForJob: () => null, storyboardValidatedAnchor: () => ({ valid: true }),
    resolveStoryboardJobModelIdentity: () => ({ capabilityModelId: 'gpt-image-1' }), storyboardMarkLogGenerating: () => {}, storyboardSetPlanStatus: () => {},
    storyboardPrepareGatewayAssets: async () => ({}), storyboardResolveApiKey: async () => 'mock', storyboardGatewayRequest: () => input(),
    storyboardPipelineStage: () => {}, storyboardConfirmGatewayProtocolBinding: async () => ({ ok: true }), storyboardConfirmGatewayModelBinding: async () => ({ ok: true }),
    directImageRuntime: async () => ({ generateDirectImage: (request, options) => generateDirectImage(request, { ...options, fetchImpl: async (_url, init) => {
      directMethods.push(init.method);
      if (failureAt === 'preflight' || init.method === 'POST') throw new TypeError('simulated disconnected');
      if (failureAt === 'cancel') state.enabled = false;
      return new Response('{}');
    } }), isDirectImageTransportError }),
    storyboardRequestHeaders: () => ({}), fetch: async (_url, options) => { posts.push(options.method); throw new TypeError('gateway disconnected'); },
    storyboardFinishLog: (_log, status, details) => finished.push({ status, ...details }), storyboardPipelineForLog: () => null, console: { error: () => {} }, saveSettings: () => {}, toast: () => {},
  });
  await run(job, log);
  assert.deepEqual(posts, failureAt === 'preflight' ? ['POST'] : []);
  assert.deepEqual(directMethods, failureAt === 'direct' ? ['GET', 'POST'] : ['GET']);
  assert.equal(finished[0].submissionState, failureAt === 'cancel' ? 'not_submitted' : 'unknown');
  assert.equal(finished[0].status, failureAt === 'cancel' ? 'cancelled' : 'failed');
  if (failureAt !== 'cancel') assert.match(finished[0].error, /结果未确认/);
  }
});

test('uncertain retry requires explicit consent and discards stale confirmation after a chat change', async () => {
  for (const choice of ['decline', 'approve', 'chat-change', 'snapshot-change', 'removed']) {
    const log = { id: 'log', status: 'failed', submissionState: 'unknown', snapshot: { prompt: 'old' } };
    const state = { logs: [log] }; let chat = 'chat-a', queued = 0, confirmed = 0;
    const retry = vm.runInNewContext(`${section('storyboardRetryLog')}\nstoryboardRetryLog`, {
      storyboardState: () => state, getChatKey: () => chat, storyboardJobFromLog: () => ({ chatKey: 'chat-a' }),
      storyboardGalleryRecords: () => [], storyboardQueueJob: async (_job, stillCurrent) => {
        // The shared admission layer now owns confirmation for every entry.
        confirmed++; if (choice === 'chat-change') chat = 'chat-b'; if (choice === 'snapshot-change') log.snapshot.prompt = 'new'; if (choice === 'removed') state.logs = [];
        if (choice === 'decline' || !stillCurrent()) return false;
        queued++; return true;
      }, toast: () => {},
    });
    await retry(log); assert.equal(confirmed, 1); assert.equal(queued, choice === 'approve' ? 1 : 0, choice);
  }
});

test('known rejected retries remain direct, while accepted-but-unreadable retries require consent', async () => {
  for (const submissionState of ['rejected', 'not_submitted', 'accepted']) {
    const log = { id: 'log', status: 'failed', submissionState, snapshot: {} }; let confirmations = 0, queued = 0;
    const state = { logs: [log] };
    const retry = vm.runInNewContext(`${section('storyboardRetryLog')}\nstoryboardRetryLog`, {
      storyboardState: () => state, getChatKey: () => 'chat', storyboardJobFromLog: () => ({}),
      storyboardGalleryRecords: () => [], storyboardQueueJob: async (_job, stillCurrent) => { if (submissionState === 'accepted') confirmations++; assert.ok(stillCurrent()); queued++; return true; }, toast: () => {},
    });
    await retry(log); assert.equal(queued, 1); assert.equal(confirmations, submissionState === 'accepted' ? 1 : 0);
  }
});

test('failed, cancelled, successful and manually owned plans do not auto-retry on repeated host events', async () => {
  for (const plan of [
    { status: 'failed', origin: 'automatic' }, { status: 'cancelled', origin: 'automatic' }, { status: 'success', origin: 'automatic' },
    { status: 'idle', origin: 'manual' }, { status: 'idle', origin: 'automatic', promptLocked: true }, { status: 'idle', origin: 'automatic', manualReviewRequired: true },
  ]) {
    const capture = vm.runInNewContext(`${section('storyboardHandleAutomaticCapture')}\nstoryboardHandleAutomaticCapture`, {
      storyboardState: () => ({ enabled: true, automation: { autoCapture: true }, promptCompiler: { enabled: true } }),
      storyboardCurrentAssistantFloor: () => 0, ctx: () => ({ chat: [{ mes: 'garden' }] }), storyboardPlanForMessage: () => plan,
    });
    assert.equal(await capture(), false, JSON.stringify(plan));
  }
});

test('log reload preserves allowed submission states without trusting arbitrary state names', () => {
  const state = createStoryboardDefaults();
  state.logs = ['unknown', 'accepted', 'rejected', 'not_submitted', 'bad'].map((submissionState, i) => ({ id: `log-${i}`, status: 'failed', submissionState }));
  const restored = normalizeStoryboardState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.logs.map(log => log.submissionState), ['unknown', 'accepted', 'rejected', 'not_submitted', '']);
});

test('gateway distinguishes local validation, upstream rejection, network ambiguity and accepted invalid output', async () => {
  const cases = [
    { request: input({ prompt: '' }), state: 'not_submitted', writes: 0 },
    { response: () => new Response('denied', { status: 401 }), state: 'rejected', writes: 1 },
    { response: () => { throw new TypeError('simulated lost response'); }, state: 'unknown', writes: 1 },
    { response: () => new Response('{'), state: 'accepted', writes: 1 },
  ];
  for (const scenario of cases) {
    let writes = 0;
    await assert.rejects(() => generateImage(scenario.request || input(), {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => { writes++; return scenario.response(); },
    }), error => {
      assert.equal(error.submissionState, scenario.state);
      assert.equal(imageGatewayErrorPayload(error).body.submissionState, scenario.state); return true;
    });
    assert.equal(writes, scenario.writes);
  }
  assert.equal(Object.hasOwn(imageGatewayErrorPayload(Object.assign(new Error('bad'), { submissionState: 'invented' })).body, 'submissionState'), false);
});

test('gateway Comfy upload success remains recorded after prompt submission is rejected', async () => {
  let writes = 0;
  await assert.rejects(() => generateImage(input({ provider: 'comfy', model: 'comfy-workflow',
    referenceImages: [{ mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==' }],
    parameters: { workflow: { '1': { class_type: 'TestNode', inputs: { text: '%qianmu_prompt%', ref: '%qianmu_reference%' } } } },
  }), {
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => { writes++; return writes === 1 ? new Response(JSON.stringify({ name: 'reference.png' })) : new Response('no funds', { status: 402 }); },
  }), error => { assert.equal(error.submissionState, 'accepted'); assert.equal(imageGatewayErrorPayload(error).body.submissionState, 'accepted'); return true; });
  assert.equal(writes, 2);
});
