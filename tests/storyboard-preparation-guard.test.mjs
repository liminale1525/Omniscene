import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { for (let n = 0; n < 10; n++) await Promise.resolve(); }
function environment() {
  const state = storyboard.createStoryboardDefaults();
  state.enabled = true;
  state.profiles.novel.model = 'nai-diffusion-5-full';
  state.prompt = 'original prompt'; state.negative = 'original negative';
  state.promptPresets = [{ id: 'preset-a', items: [{ name: 'one', instruction: 'original instruction' }] }];
  state.promptCompiler.instructionPresetId = 'preset-a';
  state.promptCompiler.apiProfileId = 'llm-a';
  const chat = [{ mes: 'original floor', swipe_id: 0 }], events = new Map(), calls = [], notices = [];
  const plan = { id: 'plan-a', chatKey: 'chat-a', floor: 0, status: 'screening', shots: [] };
  const context = vm.createContext({
    ...storyboard, clone: structuredClone, settings: { apiProfiles: [{ id: 'llm-a', model: 'fast', apiUrl: 'https://llm.example', apiKey: 'private-key' }] },
    storyboardState: () => state, getChatKey: () => 'chat-a', ctx: () => ({ chat, mainApi: 'openai' }),
    getCharacterDescription: () => 'character', getPersonaDescription: () => 'persona', storyboardCredentialRevision: 0,
    storyboardDraftApiKeys: new Map(), storyboardCompilerBusy: false, storyboardTargetFloor: () => 0,
    storyboardScheduleAutomaticCapture: () => {},
    storyboardCaptureWorkbench: () => ({ state, profile: state.profiles[state.source] }),
    storyboardSetPlanStatus: (target, status, info = {}) => { if (target) Object.assign(target, { status, ...info }); },
    renderModal: () => {}, saveSettings: () => calls.push('save'), storyboardSchedulePlanArchive: () => {}, storyboardScheduleInlineRender: () => {},
    storyboardAnchorForMessage: () => null, storyboardShotSpecForSelection: () => null,
    toast: (message) => notices.push(message), console: { error: () => {}, warn: () => {} }, MODULE_NAME: 'qianmu-test',
    sanitizeStoryboardDiagnosticData: (data) => data, uid: () => 'test-id',
    document: {
      addEventListener: (name, handler) => { const handlers = events.get(name) || new Set(); handlers.add(handler); events.set(name, handlers); },
      removeEventListener: (name, handler) => events.get(name)?.delete(handler),
    },
    storyboardCompilerContext: async () => ({ floor: 0, paragraphs: ['original floor'], messages: [], worldRows: [] }),
    featureRuntime: { load: async () => ({ buildStoryboardPlanContractRequest: () => ({ messages: [{ content: 'test contract' }], schema: {}, schemaId: 'test' }) }) },
    storyboardCompilerRequestConfig: () => ({}),
    storyboardCallCompiler: async () => { calls.push('llm'); return 'old response'; },
    storyboardCompilerResult: async () => ({ shouldGenerate: true, prompt: 'extracted prompt', negative: '', shots: [{ prompt: 'extracted prompt', sensitive: false }] }),
    storyboardProviderProfile: (_state, id = state.source) => state.profiles[id],
  });
  vm.runInContext(['storyboardUsesComfyCharacters','storyboardCreatePreparationGuard', 'storyboardCompilePrompt', 'storyboardAdaptShotForModel'].map(section).join('\n'), context);
  const dispatchInput = (className = 'sd-storyboard-field') => {
    for (const handler of events.get('input') || []) handler({ target: { className, type: 'text', matches: () => true, closest: () => ({}) } });
  };
  return { state, context, calls, notices, plan, chat, events, dispatchInput };
}

for (const [name, mutate] of [
  ['model', (e) => { e.state.profiles.novel.model = 'nai-diffusion-3'; }],
  ['capability', (e) => { e.state.profiles.novel.capabilityModelId = 'nai-diffusion-3'; }],
  ['character reference toggle', (e) => { e.state.profiles.novel.characterReferenceEnabled = true; }],
  ['series', (e) => { e.state.source = 'openai'; }],
  ['connection URL', (e) => { e.state.connections.novel.draft.baseUrl = 'https://different.example'; }],
  ['image key revision', (e) => { e.context.storyboardCredentialRevision++; }],
  ['LLM credential', (e) => { e.context.settings.apiProfiles[0].apiKey = 'replacement-key'; }],
  ['LLM preset model', (e) => { e.context.settings.apiProfiles[0].model = 'different'; }],
  ['preset item', (e) => { e.state.promptPresets[0].items[0].instruction = 'new instruction'; }],
  ['worldbook selection', (e) => { e.state.promptCompiler.worldBookNames = ['new worldbook']; }],
  ['composition', (e) => { e.state.compositionPolicy.fixedRatioId = '16:9'; }],
  ['generation budget', (e) => { e.state.generationPolicy.maxImages = 1; }],
  ['manual prompt', (e) => { e.state.prompt = 'hand edited'; e.state.promptDraft.userEditedCompiled = true; }],
  ['source floor text', (e) => { e.chat[0].mes = 'edited floor'; }],
  ['source floor replacement', (e) => { e.chat[0] = { ...e.chat[0] }; }],
  ['chat switch', (e) => { e.context.getChatKey = () => 'chat-b'; }],
  ['state replacement', (e) => { e.context.storyboardState = () => ({ ...e.state }); }],
  ['cancelled plan', (e) => { e.plan.status = 'cancelled'; }],
]) {
  test(`late extraction cannot write or start repair after changing ${name}`, async () => {
    const e = environment(), gate = deferred();
    e.context.storyboardCallCompiler = async () => { e.calls.push('llm'); return gate.promise; };
    e.context.storyboardCompilerResult = async () => assert.fail('must not parse or repair a stale result');
    const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
    await tick(); assert.equal(e.calls.includes('llm'), true);
    mutate(e);
    const prompt = e.state.prompt, negative = e.state.negative;
    gate.resolve('stale response');
    assert.equal(await work, false);
    assert.equal(e.state.prompt, prompt);
    assert.equal(e.state.negative, negative);
    assert.equal(e.context.storyboardCompilerBusy, false);
    assert.equal([...e.events.values()].reduce((sum, set) => sum + set.size, 0), 0, 'operation listeners must be released');
    if (name === 'cancelled plan') assert.equal(e.plan.status, 'cancelled');
    else assert.equal(e.plan.status, 'stale', 'the original plan must not remain compiling');
    if (name === 'chat switch' || name === 'state replacement') assert.equal(e.notices.length, 0, 'do not notify the new context about an old result');
  });
}

test('edit-and-restore invalidates in-flight work; searches and view navigation do not', () => {
  const e = environment(), guard = e.context.storyboardCreatePreparationGuard(e.state);
  e.state.view = 'gallery'; e.dispatchInput('sd-storyboard-gallery-search');
  assert.equal(guard.isCurrent(), true);
  e.dispatchInput('sd-storyboard-model-select');
  assert.equal(guard.isCurrent(), false);
  assert.throws(() => guard.assertCurrent(), { code: 'storyboard_input_changed' });
  assert.doesNotMatch(JSON.stringify(guard), /private-key|original floor/);
  guard.dispose();
});

test('context or runtime loading cannot start an LLM request after the selection changed', async () => {
  for (const phase of ['context', 'runtime']) {
    const e = environment(), gate = deferred();
    if (phase === 'context') e.context.storyboardCompilerContext = () => gate.promise;
    else e.context.featureRuntime.load = () => gate.promise;
    const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
    await tick(); e.state.promptCompiler.instructionPresetId = 'different';
    gate.resolve({});
    assert.equal(await work, false);
    assert.equal(e.calls.includes('llm'), false);
  }
});

test('successful current extraction still writes its result and clears operation resources', async () => {
  const e = environment();
  assert.equal(await e.context.storyboardCompilePrompt(null, { plan: e.plan }), true);
  assert.equal(e.state.prompt, 'extracted prompt');
  assert.equal(e.plan.status, 'prompt_ready');
  assert.equal(e.context.storyboardCompilerBusy, false);
  assert.equal(e.events.get('input').size, 0);
});

test('a no-picture response cannot clear a manually edited draft while it was in flight', async () => {
  const e = environment(), gate = deferred();
  e.context.storyboardCompilerResult = async () => gate.promise;
  const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
  await tick(); e.state.prompt = 'manual new drawing';
  gate.resolve({ shouldGenerate: false, skipReason: 'old no picture' });
  assert.equal(await work, false);
  assert.equal(e.state.prompt, 'manual new drawing');
});

test('guard does not traverse media previews, gallery, logs or parameter memory', () => {
  const e = environment();
  for (const name of ['logs', 'pipelineLogs', 'modelProfiles']) Object.defineProperty(e.state, name, { get: () => assert.fail(`must not read ${name}`) });
  const artist = { id: 'a', value: 'style' };
  Object.defineProperty(artist, 'previewUrl', { get: () => assert.fail('must not read a preview') });
  e.state.artistPresets = [artist];
  const guard = e.context.storyboardCreatePreparationGuard(e.state);
  assert.equal(guard.isCurrent(), true); guard.dispose();
});

test('a late failed safety request aborts instead of turning into a local fallback picture', async () => {
  const e = environment(), gate = deferred();
  e.context.featureRuntime.load = async () => ({ buildStoryboardSafetyContractRequest: () => ({ messages: [], schema: {} }) });
  e.context.storyboardCallCompiler = () => gate.promise;
  const guard = e.context.storyboardCreatePreparationGuard(e.state);
  const work = e.context.storyboardAdaptShotForModel({ prompt: 'story', sensitive: true }, 'openai', 'gpt-image-2', e.state, { chatKey: 'chat-a', isCurrent: guard.isCurrent });
  await tick(); e.state.connections.novel.draft.baseUrl = 'https://new.example';
  gate.reject(new Error('late failure'));
  assert.equal((await work).safetyAborted, true);
  guard.dispose();
});

for (const phase of ['before repair request', 'during repair request']) {
  test(`actual compiler repair is isolated ${phase}`, {timeout:2000}, async () => {
    const e = environment(), gate = deferred(), reached = deferred();
    let llmCalls = 0;
    const contract = {
      buildStoryboardPlanContractRequest: () => ({ messages: [], schema: {}, schemaId: 'test' }),
      parseStoryboardContractResponse: () => ({ ok: false, errors: ['invalid'] }),
      repairStoryboardContractOnce: async ({ request }) => {
        if (phase === 'before repair request') { reached.resolve(); await gate.promise; }
        await request([]);
        return { ok: false };
      },
      createStoryboardContractManualFallback: () => assert.fail('stale result must not produce a fallback'),
    };
    e.context.featureRuntime.load = async () => contract;
    e.context.storyboardCallCompiler = async () => {
      llmCalls++;
      if (llmCalls === 2 && phase === 'during repair request') { reached.resolve(); await gate.promise; }
      return 'invalid output';
    };
    vm.runInContext(section('storyboardCompilerResult'), e.context);
    const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
    await reached.promise; e.state.prompt = 'new manual prompt'; gate.resolve();
    assert.equal(await work, false);
    assert.equal(llmCalls, phase === 'before repair request' ? 1 : 2);
    assert.equal(e.state.prompt, 'new manual prompt');
  });
}

test('safety repair cannot call a second LLM after a configuration change', async () => {
  const e = environment(), gate = deferred();
  let llmCalls = 0;
  e.context.featureRuntime.load = async () => ({
    buildStoryboardSafetyContractRequest: () => ({ messages: [], schema: {} }),
    parseStoryboardContractResponse: () => ({ ok: false }),
    repairStoryboardContractOnce: async ({ request }) => { await gate.promise; await request([]); return { ok: false }; },
  });
  e.context.storyboardCallCompiler = async () => { llmCalls++; return 'invalid'; };
  const guard = e.context.storyboardCreatePreparationGuard(e.state);
  const work = e.context.storyboardAdaptShotForModel({ prompt: 'story', sensitive: true }, 'openai', 'gpt-image-2', e.state, { isCurrent: guard.isCurrent });
  await tick(); e.state.promptCompiler.instructionPresetId = 'different'; gate.resolve();
  assert.equal((await work).safetyAborted, true);
  assert.equal(llmCalls, 1); guard.dispose();
});

test('an actual post-acceptance implementation failure is not disguised as stale input', async () => {
  const e = environment();
  e.context.storyboardAnchorForMessage = () => { throw new Error('implementation failure'); };
  assert.equal(await e.context.storyboardCompilePrompt(null, { plan: e.plan }), false);
  assert.equal(e.plan.status, 'failed');
  assert.match(e.notices.at(-1), /implementation failure/);
});
