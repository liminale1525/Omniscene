import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createVideoTask, requestVideoTaskCancellation } from '../qianmu-video-task.js';
import {
  fetchMiniMaxH3Capabilities,
  pollMiniMaxH3VideoTask,
  reconcileMiniMaxH3Cancellation,
  submitMiniMaxH3VideoTask,
  videoRuntimeErrorPayload,
} from '../qianmu-video-runtime.js';

const makeTask = () => createVideoTask({
  shotId: 'shot-a',
  manifestId: 'manifest-a',
  owner: { chatKey: 'chat-a', floor: 8, messageId: 'message-a' },
  provider: { channel: 'minimax-h3', connectionId: 'connection-a' },
}, { now: 1000, clientNonce: 'runtime-test' });

const quote = {
  quoteId: 'quote-a',
  provider: 'minimax-h3',
  model: 'MiniMax-H3',
  unit: 'provider_units',
  estimatedUnits: 5,
  maximumUnits: 5,
  createdAt: 900,
  expiresAt: 60_000,
  input: { durationSeconds: 6, resolution: '768p', count: 1, includesAudio: true },
};

const policy = {
  unit: 'provider_units',
  totalDailyLimitUnits: 100,
  manual: { requireCostConfirmation: true },
};

const submission = (extra = {}) => ({
  task: makeTask(),
  reservations: [],
  quote,
  budgetPolicy: policy,
  costConfirmed: true,
  materialRightsConfirmed: true,
  h3LicenseConfirmed: true,
  apiKey: 'private-payg-key',
  spec: { shotId: 'shot-a', summary: 'A quiet room.', durationSeconds: 6, resolution: '768p' },
  manifest: { shotId: 'shot-a', assets: [] },
  prompt: 'A quiet room.',
  mediaInputs: [],
  connection: { region: 'global', connectionId: 'connection-a' },
  ...extra,
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('capabilities stay same-origin and expose only bounded provider fields', async () => {
  let request;
  const result = await fetchMiniMaxH3Capabilities({
    gatewayBase: 'https://evil.example/api',
    headers: { 'x-csrf-token': 'csrf-a' },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response({
        ok: true, provider: 'minimax-h3', model: 'MiniMax-H3', modes: ['t2va'], resolutions: ['768p'],
        duration: { min: 4, max: 15, integer: true }, transport: 'same_origin_gateway', browserDirect: false,
        keyType: 'pay_as_you_go', ignored: 'must not survive',
      });
    },
  });
  assert.equal(request.url, '/api/plugins/qianmu-tts/video/minimax/capabilities');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.credentials, 'same-origin');
  assert.equal(result.provider, 'minimax-h3');
  assert.equal(Object.hasOwn(result, 'ignored'), false);
});

test('paid submission uses two durable checkpoints and stays reserved until provider execution', async () => {
  const checkpoints = [];
  let body;
  const result = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000,
    workerId: 'tab-a',
    headers: { 'x-csrf-token': 'csrf-a' },
    persistCheckpoint: async (value) => checkpoints.push(structuredClone(value)),
    fetchImpl: async (url, init) => {
      assert.equal(url, '/api/plugins/qianmu-tts/video/minimax/create');
      assert.equal(init.headers['x-csrf-token'], 'csrf-a');
      body = JSON.parse(init.body);
      return response({ ok: true, remoteTaskId: 'remote-a', requestId: 'request-a', reused: false });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.task.state, 'submitted');
  assert.equal(result.task.provider.remoteTaskId, 'remote-a');
  assert.equal(result.task.submission.providerAccepted, true);
  assert.equal(result.task.budget.settlement, 'reserved');
  assert.equal(result.reservations[0].settlement, 'reserved');
  assert.equal(body.apiKey, 'private-payg-key');
  assert.equal(body.idempotencyKey, result.task.submission.idempotencyKey);
  assert.deepEqual(checkpoints.map((item) => item.reason), ['before_submission', 'submission_may_start', 'submission_accepted']);
  assert.equal(checkpoints[1].task.state, 'submitted');
  assert.equal(checkpoints[1].task.submission.providerAccepted, false);
  assert.doesNotMatch(JSON.stringify(result), /private-payg-key|A quiet room|mediaInputs/);
  assert.doesNotMatch(JSON.stringify(checkpoints), /private-payg-key|A quiet room/);
});

test('paid H3 submission requires rights and license confirmations before any network call', async () => {
  let calls = 0;
  const options = {
    now: 2000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async () => { calls += 1; return response({ ok: true, remoteTaskId: 'unexpected' }); },
  };
  const rights = await submitMiniMaxH3VideoTask(submission({ materialRightsConfirmed: false }), options);
  assert.equal(rights.issue, 'material_rights_confirmation_required');
  const license = await submitMiniMaxH3VideoTask(submission({ h3LicenseConfirmed: false }), options);
  assert.equal(license.issue, 'h3_license_confirmation_required');
  assert.equal(calls, 0);
});

test('missing or failed pre-network checkpoints prevent every paid request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response({ ok: true, remoteTaskId: 'unexpected' }); };
  const missing = await submitMiniMaxH3VideoTask(submission(), { fetchImpl, now: 2000 });
  assert.equal(missing.issue, 'checkpoint_writer_missing');
  assert.equal(calls, 0);

  const firstFailed = await submitMiniMaxH3VideoTask(submission(), {
    fetchImpl, now: 2000, workerId: 'tab-a', persistCheckpoint: async () => { throw new Error('disk full'); },
  });
  assert.equal(firstFailed.issue, 'checkpoint_failed_before_submission');
  assert.equal(firstFailed.task.state, 'queued');
  assert.equal(firstFailed.reservations[0].settlement, 'released');
  assert.equal(calls, 0);

  let writes = 0;
  const secondFailed = await submitMiniMaxH3VideoTask(submission(), {
    fetchImpl,
    now: 2000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {
      writes += 1;
      if (writes === 2) throw new Error('disk full');
    },
  });
  assert.equal(secondFailed.issue, 'checkpoint_failed_before_network');
  assert.equal(secondFailed.task.state, 'preparing');
  assert.equal(secondFailed.reservations[0].settlement, 'reserved');
  assert.equal(calls, 0);
});

test('provider, quote, connection, lease and serialization mismatches fail before the network', async () => {
  let calls = 0;
  const options = {
    now: 2000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async () => { calls += 1; return response({ ok: true, remoteTaskId: 'unexpected' }); },
  };
  const wrongProviderTask = makeTask();
  wrongProviderTask.provider.channel = 'another-provider';
  assert.equal((await submitMiniMaxH3VideoTask(submission({ task: wrongProviderTask }), options)).issue, 'task_provider_mismatch');
  assert.equal((await submitMiniMaxH3VideoTask(submission({ quote: { ...quote, provider: 'another-provider' } }), options)).issue, 'quote_provider_mismatch');
  assert.equal((await submitMiniMaxH3VideoTask(submission({ quote: { ...quote, model: 'MiniMax-H2' } }), options)).issue, 'quote_model_mismatch');
  assert.equal((await submitMiniMaxH3VideoTask(submission({ connection: { region: 'global', connectionId: 'connection-b' } }), options)).issue, 'task_connection_mismatch');

  const leasedTask = makeTask();
  leasedTask.lease = { holder: 'tab-b', expiresAt: 20_000 };
  assert.equal((await submitMiniMaxH3VideoTask(submission({ task: leasedTask }), options)).issue, 'lease_held');

  const circularSpec = { shotId: 'shot-a', summary: 'A quiet room.', durationSeconds: 6, resolution: '768p' };
  circularSpec.circular = circularSpec;
  const circular = await submitMiniMaxH3VideoTask(submission({ spec: circularSpec }), options);
  assert.equal(circular.issue, 'request_not_serializable');
  assert.equal(circular.task.failure.chargeState, 'not_charged');
  assert.equal(circular.reservations[0].settlement, 'released');
  assert.equal(calls, 0);
});

test('an unknown create outcome remains reconcilable and never becomes an automatic retry', async () => {
  const checkpoints = [];
  const result = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000,
    workerId: 'tab-a',
    persistCheckpoint: async (value) => checkpoints.push(value),
    fetchImpl: async () => { throw new TypeError('connection closed'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'reconcile_submission');
  assert.equal(result.task.state, 'submitted');
  assert.equal(result.task.submission.providerAccepted, false);
  assert.equal(result.task.failure.chargeState, 'unknown');
  assert.equal(result.task.failure.retryable, false);
  assert.equal(result.task.budget.settlement, 'unknown');
  assert.equal(result.reservations[0].settlement, 'unknown');
  assert.equal(result.error.outcomeUnknown, true);
  assert.equal(checkpoints.at(-1).reason, 'submission_failed');
  assert.doesNotMatch(JSON.stringify(result), /private-payg-key/);
});

test('a stable pre-acceptance rejection releases budget and records no charge', async () => {
  const result = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async () => response({ ok: false, code: 'authentication_failed', message: 'bad key', retryable: false }, 401),
  });
  assert.equal(result.action, 'failed');
  assert.equal(result.task.state, 'failed');
  assert.equal(result.task.failure.code, 'authentication_failed');
  assert.equal(result.task.failure.chargeState, 'not_charged');
  assert.equal(result.task.budget.settlement, 'released');
  assert.equal(result.reservations[0].settlement, 'released');
});

test('polling commits the reservation only when execution starts', async () => {
  const submitted = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async () => response({ ok: true, remoteTaskId: 'remote-a' }),
  });
  const checkpoints = [];
  const running = await pollMiniMaxH3VideoTask({
    task: submitted.task, reservations: submitted.reservations, apiKey: 'private-payg-key', connection: { region: 'global' },
  }, {
    now: 12_000,
    workerId: 'tab-a',
    persistCheckpoint: async (value) => checkpoints.push(value),
    fetchImpl: async () => response({
      ok: true, remoteTaskId: 'remote-a', providerStatus: 'running', recognizedStatus: true,
      state: 'polling', result: {}, usage: {},
    }),
  });
  assert.equal(running.ok, true);
  assert.equal(running.task.state, 'polling');
  assert.equal(running.task.budget.settlement, 'committed');
  assert.equal(running.reservations[0].settlement, 'committed');
  assert.equal(running.task.timing.nextPollAt, 22_000);
  assert.equal(checkpoints.at(-1).reason, 'provider_polling');
});

test('an unrecognized provider status keeps the reservation conservative instead of inventing execution', async () => {
  const submitted = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000, workerId: 'tab-a', persistCheckpoint: async () => {},
    fetchImpl: async () => response({ ok: true, remoteTaskId: 'remote-a' }),
  });
  const result = await pollMiniMaxH3VideoTask({
    task: submitted.task, reservations: submitted.reservations, apiKey: 'private-payg-key', connection: { region: 'global' },
  }, {
    now: 12_000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async () => response({
      ok: true, remoteTaskId: 'remote-a', providerStatus: 'future_state', recognizedStatus: false,
      state: 'polling', retryable: true, result: {}, usage: {},
    }),
  });
  assert.equal(result.task.state, 'polling');
  assert.equal(result.task.budget.settlement, 'reserved');
  assert.equal(result.reservations[0].settlement, 'reserved');
  assert.equal(result.task.history.at(-1).code, 'provider_status_unknown');
});

test('completed media is archived idempotently while task storage keeps only stable references', async () => {
  const submitted = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000, workerId: 'tab-a', persistCheckpoint: async () => {}, fetchImpl: async () => response({ ok: true, remoteTaskId: 'remote-a' }),
  });
  let archiveInput;
  const complete = await pollMiniMaxH3VideoTask({
    task: submitted.task, reservations: submitted.reservations, apiKey: 'private-payg-key', connection: { region: 'global' },
  }, {
    now: 15_000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    storeResult: async (value) => {
      archiveInput = value;
      return { recordId: 'video-record-a', assetId: 'video-asset-a' };
    },
    fetchImpl: async () => response({
      ok: true, remoteTaskId: 'remote-a', providerStatus: 'succeeded', recognizedStatus: true, state: 'succeeded',
      result: { downloadUrl: 'https://media.example/result.mp4', resolution: '768P', durationSeconds: 6, ratio: '16:9' },
      usage: { totalSeconds: 6 },
    }),
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.action, 'succeeded');
  assert.equal(complete.task.state, 'succeeded');
  assert.equal(complete.task.result.recordId, 'video-record-a');
  assert.equal(complete.task.result.assetId, 'video-asset-a');
  assert.equal(complete.task.budget.settlement, 'committed');
  assert.match(archiveInput.idempotencyKey, /video-task-.*attempt-1/);
  assert.equal(archiveInput.attempt, 1);
  assert.equal(archiveInput.versionRootId, complete.task.taskId);
  assert.equal(archiveInput.budgetReservationId, complete.task.budget.reservationId);
  assert.equal(archiveInput.downloadUrl, 'https://media.example/result.mp4');
  assert.doesNotMatch(JSON.stringify(complete.task), /media\.example|downloadUrl|private-payg-key/);
});

test('queued cancellation reaches the provider through the gateway and releases budget, while running cancellation only waits', async () => {
  const submitted = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000, workerId: 'tab-a', persistCheckpoint: async () => {}, fetchImpl: async () => response({ ok: true, remoteTaskId: 'remote-a' }),
  });
  const cancelRequested = requestVideoTaskCancellation(submitted.task, { now: 3000 }).task;
  const methods = [];
  const cancelled = await reconcileMiniMaxH3Cancellation({
    task: cancelRequested, reservations: submitted.reservations, apiKey: 'private-payg-key', connection: { region: 'global' },
  }, {
    now: 4000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      return methods.length === 1
        ? response({ ok: true, remoteTaskId: 'remote-a', providerStatus: 'queued', recognizedStatus: true, state: 'submitted', result: {}, usage: {} })
        : response({ ok: true, remoteTaskId: 'remote-a', action: 'cancelled', providerStatus: 'cancelled' });
    },
  });
  assert.deepEqual(methods, ['POST', 'POST']);
  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(cancelled.task.budget.settlement, 'released');
  assert.equal(cancelled.reservations[0].settlement, 'released');

  const runningRequested = requestVideoTaskCancellation(submitted.task, { now: 3000 }).task;
  let calls = 0;
  const waiting = await reconcileMiniMaxH3Cancellation({
    task: runningRequested, reservations: submitted.reservations, apiKey: 'private-payg-key', connection: { region: 'global' },
  }, {
    now: 4000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return response({ ok: true, remoteTaskId: 'remote-a', providerStatus: 'running', recognizedStatus: true, state: 'polling', result: {}, usage: {} });
    },
  });
  assert.equal(calls, 1);
  assert.equal(waiting.action, 'wait_terminal');
  assert.equal(waiting.task.state, 'cancel_requested');
  assert.equal(waiting.task.budget.settlement, 'committed');
});

test('external provider cancellation can terminate a submitted task without a local delete', async () => {
  const submitted = await submitMiniMaxH3VideoTask(submission(), {
    now: 2000, workerId: 'tab-a', persistCheckpoint: async () => {}, fetchImpl: async () => response({ ok: true, remoteTaskId: 'remote-a' }),
  });
  const result = await pollMiniMaxH3VideoTask({
    task: submitted.task, reservations: submitted.reservations, apiKey: 'private-payg-key', connection: { region: 'global' },
  }, {
    now: 4000,
    workerId: 'tab-a',
    persistCheckpoint: async () => {},
    fetchImpl: async () => response({
      ok: true, remoteTaskId: 'remote-a', providerStatus: 'cancelled', recognizedStatus: true, state: 'cancelled', result: {}, usage: {},
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.task.state, 'cancelled');
  assert.equal(result.task.budget.settlement, 'unknown');
  assert.equal(result.reservations[0].settlement, 'unknown');
});

test('runtime diagnostics redact credentials and never echo arbitrary gateway payloads', () => {
  const result = videoRuntimeErrorPayload(new Error('Authorization: Bearer private-secret api_key=sk-secretsecret'));
  assert.equal(result.message, '视频服务暂不可达');
  assert.doesNotMatch(JSON.stringify(result), /private-secret|sk-secretsecret/);
});

test('the client runtime ships as an idle feature chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import[^\n]*qianmu-video-runtime\.js/m);
assert.match(source, /minimaxH3Runtime:\s*\{[\s\S]*import\('\.\/qianmu-video-runtime\.js\?v=1\.59\.60'\)/);
  assert.ok(release.files.includes('qianmu-video-runtime.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('minimaxH3Runtime'\)/);
});
