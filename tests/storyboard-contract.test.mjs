import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_CONTRACT_MAX_BYTES,
  STORYBOARD_PLAN_RESPONSE_SCHEMA,
  STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
  STORYBOARD_SAFETY_RESPONSE_SCHEMA,
  STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID,
  STORYBOARD_SHOT_SCALE_GUIDE,
  adaptStoryboardPlanContract,
  adaptStoryboardSafetyContract,
  buildStoryboardPlanContractRequest,
  buildStoryboardSafetyContractRequest,
  formatStoryboardContractErrors,
  parseStoryboardContractJson,
  parseStoryboardContractResponse,
  validateStoryboardPlanContract,
  validateStoryboardSafetyContract,
} from '../qianmu-storyboard-contract.js';
import { compileStoryboardPrompt } from '../qianmu-storyboard.js';

const character = (id, x, overrides = {}) => ({
  character_id: id,
  name: id === 'character-a' ? '角色A' : '角色B',
  fixed_identity: id === 'character-a' ? ['silver hair'] : ['black hair'],
  current_state: {
    outfit: ['current coat'],
    expression: ['hesitant'],
    pose: ['seated'],
    action: ['pressing an envelope'],
    gaze: ['looking at the envelope'],
    props: ['envelope'],
  },
  spatial: {
    order: id === 'character-a' ? 1 : 2,
    region: id === 'character-a' ? 'center-left' : 'center-right',
    center: { x, y: 0.52 },
    visible_crop: 'detail',
  },
  ...overrides,
});

const shot = (overrides = {}) => ({
  source_paragraph_ids: ['P2'],
  insert_after: 'P2',
  narrative_layer: 'present',
  narrative_purpose: '表现人物独处时的迟疑',
  shot_role: 'reaction',
  shot_scale: 'close_up',
  subject: '角色A的手指停在未寄出的信上',
  scene: {
    location: '书桌旁',
    time: '夜晚',
    lighting: ['台灯侧光'],
    environment: ['未寄出的信', '窗外雨痕'],
  },
  characters: [character('character-a', 0.38)],
  shared_relations: [],
  composition: {
    ratio_id: '3:2',
    orientation: 'landscape',
    camera_side: 'axis-side-a',
    angle: 'table-level',
    focus: '角色A的手与信封',
    negative_space: '信封前方',
    intent: '保留信封前方的负空间',
    continuity_key: 'scene-12',
  },
  prompt_atoms: {
    global: ['night interior', 'desk', 'side lighting'],
    character_ids: ['character-a'],
    scene_negative: ['extra people'],
  },
  sensitive: false,
  safety_notes: [],
  ...overrides,
});

const plan = (overrides = {}) => ({
  schema: STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
  should_generate: true,
  skip_reason: '',
  shots: [shot()],
  continuity_updates: [{
    category: 'prop',
    subject: 'character-a',
    key: 'held-object',
    value: '未寄出的信封',
    persistence: 'persistent',
    source_paragraph_ids: ['P2'],
    evidence: '角色A的手指压住信封',
  }],
  decisions: ['选择单人回忆落点'],
  ...overrides,
});

const validationOptions = {
  allowedParagraphIds: ['P1', 'P2', 'P3'],
  allowedCharacterIds: ['character-a', 'character-b'],
  allowedRatioIds: ['3:2', '2:3'],
  characterTermsById: {
    'character-a': ['silver hair', 'pressing an envelope'],
    'character-b': ['black hair', 'holding a cup'],
  },
};

assert.equal(STORYBOARD_PLAN_RESPONSE_SCHEMA.additionalProperties, false);
assert.equal(STORYBOARD_PLAN_RESPONSE_SCHEMA.properties.shots.maxItems, 4);
assert.equal(Object.isFrozen(STORYBOARD_PLAN_RESPONSE_SCHEMA.properties.shots.items), true);
assert.equal(STORYBOARD_SAFETY_RESPONSE_SCHEMA.additionalProperties, false);
assert.equal(STORYBOARD_CONTRACT_MAX_BYTES, 256 * 1024);
assert.match(STORYBOARD_SHOT_SCALE_GUIDE.extreme_close_up, /局部/);
assert.match(STORYBOARD_SHOT_SCALE_GUIDE.insert, /物件/);

const valid = validateStoryboardPlanContract(plan(), validationOptions);
assert.equal(valid.ok, true, formatStoryboardContractErrors(valid.errors));

const fenced = parseStoryboardContractResponse(`\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``, validationOptions);
assert.equal(fenced.ok, true, formatStoryboardContractErrors(fenced.errors));
assert.equal(fenced.kind, 'plan');
assert.deepEqual(fenced.normalization, ['code_fence']);

const proseWrapped = parseStoryboardContractResponse(`以下是结果：\n${JSON.stringify(plan())}\n请查收。`, validationOptions);
assert.equal(proseWrapped.ok, true, formatStoryboardContractErrors(proseWrapped.errors));
assert.deepEqual(proseWrapped.normalization, ['extracted_object']);

const ambiguous = parseStoryboardContractJson(`${JSON.stringify(plan())}\n${JSON.stringify(plan())}`);
assert.equal(ambiguous.ok, false);
assert.equal(ambiguous.errors[0].code, 'ambiguous_json');

const adapted = adaptStoryboardPlanContract(fenced.data, {
  paragraphIndexById: { P1: 0, P2: 1, P3: 2 },
});
assert.equal(adapted.shots[0].paragraph_index, 1);
assert.equal(adapted.shots[0].shotSpec.narrativeLayer, 'present');
assert.equal(adapted.shots[0].shotSpec.shotScale, 'close_up');
assert.equal(adapted.shots[0].shotSpec.composition.ratioId, '3:2');
assert.equal(adapted.shots[0].shotSpec.composition.cameraSide, 'axis-side-a');
assert.equal(adapted.shots[0].shotSpec.composition.angle, 'table-level');
assert.equal(adapted.shots[0].shotSpec.composition.focus, '角色A的手与信封');
assert.equal(adapted.shots[0].shotSpec.composition.negativeSpace, '信封前方');
assert.deepEqual(adapted.shots[0].shotSpec.characters[0].identity, ['silver hair']);
assert.deepEqual(adapted.shots[0].shotSpec.characters[0].spatial.center, [0.38, 0.52]);
assert.equal(adapted.shots[0].shotSpec.characters[0].spatial.crop, 'detail');
assert.deepEqual(adapted.shots[0].shotSpec.promptAtoms.negative, ['extra people']);
assert.equal(adapted.shots[0].shotSpec.continuityUpdates.facts[0].value, '未寄出的信封');
assert.ok(adapted.shots[0].shotSpec.id === '', 'the adapter must not mint a reusable cross-plan shot id');
const compiled = compileStoryboardPrompt({
  providerId: 'novel',
  modelId: 'nai-diffusion-5-full',
  shot: adapted.shots[0].shotSpec,
});
assert.doesNotMatch(compiled.prompt, /silver hair/, 'character-exclusive identity must stay outside the public NAI V5 caption');
assert.match(compiled.characterBlocks[0], /silver hair/, 'character identity must enter its own NAI V5 character caption');

const validSkip = validateStoryboardPlanContract(plan({
  should_generate: false,
  skip_reason: '没有新增的视觉信息',
  shots: [],
}), validationOptions);
assert.equal(validSkip.ok, true, formatStoryboardContractErrors(validSkip.errors));

const safety = {
  schema: STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID,
  preserved_narrative_purpose: '保留关系变化',
  replacement_visual: '两人隔着雨幕对望',
  character_updates: [{
    character_id: 'character-a',
    outfit: ['buttoned coat'],
    expression: ['restrained'],
    pose: ['standing'],
    action: ['turning away'],
    gaze: ['toward the window'],
    props: [],
  }],
  prompt_atoms: { global: ['rainy window'], scene_negative: ['explicit content'] },
  adaptation_note: '以安全意象替代表现',
};
assert.equal(validateStoryboardSafetyContract(safety, validationOptions).ok, true);
assert.equal(parseStoryboardContractResponse(JSON.stringify(safety), validationOptions).kind, 'safety');
const safetyRequest = buildStoryboardSafetyContractRequest(adapted.shots[0].shotSpec, {
  providerId: 'banana',
  providerLabel: 'Banana',
  modelId: 'gemini-3.1-flash-image',
  sourcePrompt: 'original sensitive visual description',
});
assert.equal(safetyRequest.schemaId, STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID);
assert.deepEqual(safetyRequest.allowedCharacterIds, ['character-a']);
assert.deepEqual(safetyRequest.requiredCharacterIds, ['character-a']);
assert.match(safetyRequest.messages[0].content, /【任务】[\s\S]*【可信输入】[\s\S]*【执行规则】[\s\S]*【输出合同】/);
const safetyPayload = JSON.parse(safetyRequest.messages[1].content);
assert.equal(safetyPayload.visual_description, 'original sensitive visual description');
assert.equal(safetyPayload.characters[0].character_id, 'character-a');
const safeAdapted = adaptStoryboardSafetyContract(safety, adapted.shots[0].shotSpec);
assert.equal(safeAdapted.subject, '两人隔着雨幕对望');
assert.equal(safeAdapted.characters[0].id, 'character-a');
assert.deepEqual(safeAdapted.characters[0].identity, ['silver hair']);
assert.deepEqual(safeAdapted.characters[0].outfit, ['buttoned coat']);
assert.deepEqual(safeAdapted.promptAtoms.global, ['rainy window']);
assert.equal(safeAdapted.sensitive, false);
const safeCompiled = compileStoryboardPrompt({
  providerId: 'banana',
  modelId: 'gemini-3.1-flash-image',
  shot: safeAdapted,
});
assert.match(safeCompiled.prompt, /rainy window/);
assert.doesNotMatch(safeCompiled.prompt, /未寄出的信|书桌旁|pressing an envelope/, 'unsafe source atoms must not leak back into the adapted provider prompt');

const missingSafetyCharacter = validateStoryboardSafetyContract({
  ...safety,
  character_updates: [],
}, {
  ...validationOptions,
  requiredCharacterIds: ['character-a'],
});
assert.ok(missingSafetyCharacter.errors.some((entry) => entry.code === 'missing_character_update'));

const emptySafetyVisual = validateStoryboardSafetyContract({
  ...safety,
  prompt_atoms: { global: [], scene_negative: [] },
}, validationOptions);
assert.ok(emptySafetyVisual.errors.some((entry) => entry.code === 'min_items' && entry.path === '$.prompt_atoms.global'));

const crossedSafetyCharacter = validateStoryboardSafetyContract({
  ...safety,
  character_updates: [{ ...safety.character_updates[0], outfit: ['black hair'] }],
}, {
  ...validationOptions,
  requiredCharacterIds: ['character-a'],
});
assert.ok(crossedSafetyCharacter.errors.some((entry) => entry.code === 'character_cross_assignment'));

const narration = parseStoryboardContractJson(`以下是结果：\n${JSON.stringify(plan())}`);
assert.equal(narration.ok, true, 'a single balanced contract object may be extracted locally before validation');
assert.deepEqual(narration.normalization, ['extracted_object']);
const missingComma = parseStoryboardContractJson('{"schema":"qianmu.storyboard.plan.v1" "shots":[]}');
assert.equal(missingComma.ok, true, 'an unambiguous missing property comma should be repaired locally');
assert.ok(missingComma.normalization.includes('missing_comma'));
assert.equal(parseStoryboardContractJson('x'.repeat(STORYBOARD_CONTRACT_MAX_BYTES + 1)).errors[0].code, 'max_bytes');

const unknownRoot = validateStoryboardPlanContract({ ...plan(), explanation: 'hidden reasoning' }, validationOptions);
assert.equal(unknownRoot.ok, false);
assert.ok(unknownRoot.errors.some((entry) => entry.code === 'additional_property' && entry.path === '$.explanation'));

const wrongParagraph = validateStoryboardPlanContract(plan({
  shots: [shot({ source_paragraph_ids: ['P99'], insert_after: 'P99' })],
}), validationOptions);
assert.ok(wrongParagraph.errors.some((entry) => entry.code === 'unknown_paragraph'));
assert.ok(wrongParagraph.errors.some((entry) => entry.code === 'unknown_insert_anchor'));

const wrongContinuityParagraph = validateStoryboardPlanContract(plan({
  continuity_updates: [{ ...plan().continuity_updates[0], source_paragraph_ids: ['P404'] }],
}), validationOptions);
assert.ok(wrongContinuityParagraph.errors.some((entry) => entry.code === 'unknown_paragraph' && entry.path.startsWith('$.continuity_updates')));

const mismatchedAnchor = validateStoryboardPlanContract(plan({
  shots: [shot({ source_paragraph_ids: ['P1'], insert_after: 'P2' })],
}), validationOptions);
assert.ok(mismatchedAnchor.errors.some((entry) => entry.code === 'insert_anchor_not_sourced'));

const badRatio = validateStoryboardPlanContract(plan({
  shots: [shot({ composition: { ...shot().composition, ratio_id: '2:3', orientation: 'landscape' } })],
}), validationOptions);
assert.ok(badRatio.errors.some((entry) => entry.code === 'ratio_orientation'));

const invalidCrop = validateStoryboardPlanContract(plan({
  shots: [shot({ characters: [character('character-a', 0.38, { spatial: { ...character('character-a', 0.38).spatial, visible_crop: 'half-body' } })] })],
}), validationOptions);
assert.ok(invalidCrop.errors.some((entry) => entry.path.endsWith('.visible_crop')));

const overlapping = validateStoryboardPlanContract(plan({
  shots: [shot({
    characters: [character('character-a', 0.5), character('character-b', 0.51)],
    prompt_atoms: { ...shot().prompt_atoms, character_ids: ['character-a', 'character-b'] },
  })],
}), validationOptions);
assert.ok(overlapping.errors.some((entry) => entry.code === 'overlapping_characters'));

const pollutedGlobal = validateStoryboardPlanContract(plan({
  shots: [shot({ prompt_atoms: { ...shot().prompt_atoms, global: ['night room', 'silver hair'] } })],
}), validationOptions);
assert.ok(pollutedGlobal.errors.some((entry) => entry.code === 'global_character_pollution'));

const crossedIdentity = validateStoryboardPlanContract(plan({
  shots: [shot({ characters: [character('character-a', 0.38, { fixed_identity: ['black hair'] })] })],
}), validationOptions);
assert.ok(crossedIdentity.errors.some((entry) => entry.code === 'character_cross_assignment'));

const manualRejected = validateStoryboardPlanContract(plan({
  should_generate: false,
  skip_reason: '不想生成',
  shots: [],
}), { ...validationOptions, manualSupplement: true, requiredInsertAfter: 'P2', maxShots: 1 });
assert.ok(manualRejected.errors.some((entry) => entry.code === 'manual_must_generate'));
assert.ok(manualRejected.errors.some((entry) => entry.code === 'manual_single_shot'));

const manualAnchor = validateStoryboardPlanContract(plan({
  shots: [shot({ source_paragraph_ids: ['P1'], insert_after: 'P1' })],
}), { ...validationOptions, manualSupplement: true, requiredInsertAfter: 'P2', maxShots: 1 });
assert.ok(manualAnchor.errors.some((entry) => entry.code === 'manual_insert_anchor'));

const manualMissingSelectedParagraph = validateStoryboardPlanContract(plan({
  shots: [shot({ source_paragraph_ids: ['P2'], insert_after: 'P2' })],
}), {
  ...validationOptions,
  manualSupplement: true,
  requiredInsertAfter: 'P2',
  requiredSourceParagraphIds: ['P1', 'P2'],
  maxShots: 1,
});
assert.ok(manualMissingSelectedParagraph.errors.some((entry) => entry.code === 'manual_source_paragraph'));

const contractRequest = buildStoryboardPlanContractRequest({
  floor: 12,
  paragraphs: ['角色A脱下外套。', '角色B把杯子递给她。', '两人望向窗外。'],
  forcedParagraphIndexes: [0, 2],
  forcedParagraphIndex: 2,
  messages: [{ floor: 11, role: 'character', text: '前一层正文' }],
  currentCharacter: '角色A：银发。',
  persona: '用户人设',
  world: '世界书内容',
}, {
  providerId: 'novel',
  providerLabel: 'NovelAI',
  modelId: 'nai-diffusion-5-full',
  maxShots: 4,
  manualSupplement: true,
  allowedRatioIds: ['3:2'],
  compositionMode: 'fixed',
  preferredRatioId: '3:2',
  compositionRuleOverride: '人物视线前方保留呼吸空间。',
  groupLabel: '智能镜组',
  groupInstruction: '镜头职责不得重复。',
  extraInstructions: '优先表现动作变化。',
});
assert.equal(contractRequest.schemaId, STORYBOARD_PLAN_RESPONSE_SCHEMA_ID);
assert.equal(contractRequest.schema, STORYBOARD_PLAN_RESPONSE_SCHEMA);
assert.equal(contractRequest.maxShots, 1);
assert.deepEqual(contractRequest.paragraphIds, ['P1', 'P2', 'P3']);
assert.deepEqual(contractRequest.requiredSourceParagraphIds, ['P1', 'P3']);
assert.equal(contractRequest.requiredInsertAfter, 'P3');
assert.match(contractRequest.messages[0].content, /【任务】[\s\S]*【可信输入】[\s\S]*【执行规则】[\s\S]*【输出合同】/);
assert.match(contractRequest.messages[0].content, /qianmu\.storyboard\.plan\.v1/);
assert.match(contractRequest.messages[0].content, /人物专属外貌、服装、动作和道具不得放入 prompt_atoms\.global/);
assert.match(contractRequest.messages[0].content, /特写不是半身人像/);
assert.match(contractRequest.messages[0].content, /同场景相邻镜头至少改变主体、景别、机位侧、角度、焦点、构图中的两项/);
assert.match(contractRequest.messages[0].content, /构景个人修订[\s\S]*人物视线前方保留呼吸空间/);
assert.doesNotMatch(contractRequest.messages[0].content, /paragraph_index|safe_prompt|"negative":/);
const requestPayload = JSON.parse(contractRequest.messages[1].content);
assert.equal(requestPayload.task, 'manual_supplement');
assert.equal(requestPayload.constraints.required_insert_after, 'P3');
assert.deepEqual(requestPayload.constraints.required_source_paragraph_ids, ['P1', 'P3']);
assert.deepEqual(requestPayload.target_paragraphs.map((item) => item.id), ['P1', 'P2', 'P3']);
assert.equal(requestPayload.constraints.image_model, 'nai-diffusion-5-full');
assert.equal(requestPayload.constraints.composition_mode, 'fixed');
assert.equal(requestPayload.constraints.preferred_ratio_id, '3:2');
assert.deepEqual(requestPayload.constraints.allowed_ratio_ids, ['3:2']);

const smartRequest = buildStoryboardPlanContractRequest({ paragraphs: ['单人站在横向延伸的长廊中。'] }, {
  allowedRatioIds: ['16:9', '2:3'],
  preferredRatioId: '16:9',
  compositionMode: 'smart',
});
assert.match(smartRequest.messages[0].content, /不得按单人竖幅\/多人横幅机械映射/);
assert.match(smartRequest.messages[0].content, /16:9 只是主画幅偏好，不是强制值/);

assert.match(formatStoryboardContractErrors(wrongParagraph.errors, 1), /^\$\.shots\[0\]/);

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.match(indexSource, /storyboardContract:[\s\S]*import\('\.\/qianmu-storyboard-contract\.js\?v=1\.59\.43'\)/, 'the contract validator must stay outside the startup graph');
assert.match(indexSource, /buildStoryboardPlanContractRequest\(context, storyboardCompilerRequestConfig\(state, profile\)\)/, 'the first planning call must use the strict request contract');
assert.match(indexSource, /storyboardCallCompiler\(contractRequest\.messages[\s\S]*jsonSchema: contractRequest\.schema[\s\S]*jsonSchemaStrict: true/, 'capable external channels must receive the structured response schema');
assert.match(indexSource, /if \(contractRequest \|\| declaresPlanContract\)/, 'new requests must validate strictly while versioned legacy responses remain supported');
assert.match(indexSource, /async function storyboardAdaptShotForModel[\s\S]*policy !== 'filtered'[\s\S]*buildStoryboardSafetyContractRequest[\s\S]*repairStoryboardContractOnce[\s\S]*local_fallback/, 'filtered sensitive shots must use one bounded safety-contract pass before the deterministic fallback');
assert.match(indexSource, /const effectiveShot = await storyboardAdaptShotForModel/, 'generation must finish safety adaptation before compiling the provider request');
assert.match(indexSource, /const stillCurrent = \(\)[\s\S]*guard\.chatKey[\s\S]*guard\.cancelled[\s\S]*storyboardState\(\)\.enabled[\s\S]*safetyAborted/, 'late safety responses must fail closed across cancellation, chat changes and storyboard opt-out');
assert.match(indexSource, /const result = await storyboardCompilerResult\(/, 'the lazy validator must finish before compiler output is accepted');

console.log('Storyboard strict response contract OK');
