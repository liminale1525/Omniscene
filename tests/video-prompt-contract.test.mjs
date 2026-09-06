import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_H3_PROMPT_MAX_CHARS,
  QIANMU_H3_BASE_PROMPT_SECTIONS,
  QIANMU_H3_REFERENCE_PROMPT_SECTIONS,
  QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID,
  QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA,
  buildVideoPromptPlanRequest,
  compileH3VideoPrompt,
  createVideoPromptPlanFromShotSpec,
  normalizeVideoPromptPlan,
  parseVideoPromptPlanResponse,
  validateH3CompiledPrompt,
  validateVideoPromptPlan,
} from '../qianmu-video-prompt.js';

const shot = {
  durationSeconds: 6,
  intent: { summary: 'A opens the kitchen door while B keeps stirring.' },
  characters: [
    {
      characterId: 'a', name: 'A', subjectLabel: '<Subject 1>',
      appearance: { identity: ['red hair'], wardrobe: ['white shirt, coat removed'], physicalState: ['dry hair'] },
      performance: { blocking: 'left of frame', action: 'opens the door', expression: 'alert' },
    },
    {
      characterId: 'b', name: 'B', subjectLabel: '<Subject 2>',
      appearance: { identity: ['black hair'], wardrobe: ['blue apron'], physicalState: ['flour on hands'] },
      performance: { blocking: 'at the stove', action: 'keeps stirring', expression: 'calm' },
    },
  ],
};

const plan = {
  schema: QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID,
  shot_summary: 'A enters; B continues cooking without turning around.',
  subjects: [
    { subject_id: 'a', name: 'A', reference_label: '<Subject 1>', identity: ['red hair'], wardrobe: ['white shirt'], physical_state: ['dry hair'], blocking: 'left doorway', action: 'opens door', expression: 'alert', eye_line: 'toward B' },
    { subject_id: 'b', name: 'B', reference_label: '<Subject 2>', identity: ['black hair'], wardrobe: ['blue apron'], physical_state: ['flour on hands'], blocking: 'at stove', action: 'stirs soup', expression: 'calm', eye_line: 'toward pot' },
  ],
  environment: { location: 'small kitchen', time_light: 'warm evening practicals', atmosphere: 'quiet', continuity: 'same cookware positions' },
  camera: { shot_size: 'MS', angle: 'eye level', lens: 'normal lens', movement: 'slow dolly in', composition: 'A left, B right', focus: 'rack from A to B', axis: 'stay on established axis' },
  temporal_beats: [
    { start_seconds: 0, end_seconds: 3, subject_ids: ['a'], visual: 'A opens the door', camera: 'hold', sound: 'door latch' },
    { start_seconds: 3, end_seconds: 6, subject_ids: ['b'], visual: 'B keeps stirring', camera: 'rack focus', sound: 'simmering pot' },
  ],
  dialogue: [{ subject_id: 'b', text: 'You are late.', delivery: 'quietly', start_seconds: 4, end_seconds: 5.5 }],
  ambient_audio: ['soft kitchen room tone'],
  negative_constraints: ['no wardrobe reset', 'no identity transfer'],
};

test('the response schema is strict, bounded and explicitly owns every subject field', () => {
  assert.equal(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.additionalProperties, false);
  assert.equal(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.subjects.maxItems, 6);
  assert.equal(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.subjects.items.additionalProperties, false);
  assert.ok(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.subjects.items.required.includes('wardrobe'));
  assert.ok(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.dialogue.items.required.includes('subject_id'));
});

test('normalization strips extra fields without allowing them into the provider prompt', () => {
  const normalized = normalizeVideoPromptPlan({ ...plan, api_key: 'secret', subjects: [{ ...plan.subjects[0], hidden: 'x' }] }, { ...shot, characters: [shot.characters[0]] });
  assert.equal(normalized.api_key, undefined);
  assert.equal(normalized.subjects[0].hidden, undefined);
  const validation = validateVideoPromptPlan({ ...plan, api_key: 'secret' }, shot);
  assert.equal(validation.ok, true);
  assert.ok(validation.warnings.includes('unexpected_key:$.api_key'));
});

test('unknown, duplicate and mismatched subject bindings fail closed', () => {
  const unknown = structuredClone(plan);
  unknown.subjects[1].subject_id = 'c';
  assert.ok(validateVideoPromptPlan(unknown, shot).issues.includes('subject_unknown:c'));
  assert.ok(validateVideoPromptPlan(unknown, shot).issues.includes('subject_missing:b'));

  const duplicate = structuredClone(plan);
  duplicate.subjects[1].subject_id = 'a';
  assert.ok(validateVideoPromptPlan(duplicate, shot).issues.includes('subject_duplicate:a'));

  const mismatch = structuredClone(plan);
  mismatch.subjects[0].reference_label = '<Subject 2>';
  assert.ok(validateVideoPromptPlan(mismatch, shot).issues.includes('subject_label_mismatch:a'));
});

test('stable subject ids support Chinese character names without collapsing ownership', () => {
  const chineseShot = {
    ...shot,
    characters: [{ ...shot.characters[0], characterId: '阿绫', name: '阿绫' }],
  };
  const chinesePlan = {
    ...structuredClone(plan),
    subjects: [{ ...plan.subjects[0], subject_id: '阿绫', name: '阿绫' }],
    temporal_beats: [{ ...plan.temporal_beats[0], subject_ids: ['阿绫'] }],
    dialogue: [{ ...plan.dialogue[0], subject_id: '阿绫' }],
  };
  const result = compileH3VideoPrompt(chinesePlan, chineseShot);
  assert.equal(result.ok, true);
  assert.match(result.prompt, /阿绫 \(S1\), identity: red hair/);
  assert.match(result.prompt, /阿绫 \(S1\) quietly: <d>\[English\] You are late\.<\/d>/);
});

test('beats and dialogue may only reference declared subject ids', () => {
  const invalid = structuredClone(plan);
  invalid.temporal_beats[0].subject_ids.push('ghost');
  invalid.dialogue[0].subject_id = 'ghost';
  const result = validateVideoPromptPlan(invalid, shot);
  assert.ok(result.issues.includes('beat_subject_unknown:0:ghost'));
  assert.ok(result.issues.includes('dialogue_subject_unknown:0:ghost'));
});

test('manual direction stays in the official body and character ownership remains separated', () => {
  const manualDirection = 'Keep B motionless until second 3.';
  const directedShot = { ...shot, intent: { ...shot.intent, summary: manualDirection } };
  const directedPlan = { ...structuredClone(plan), shot_summary: manualDirection };
  const result = compileH3VideoPrompt(directedPlan, directedShot, { manualDirection });
  assert.equal(result.ok, true);
  assert.equal(result.manualDirectionApplied, true);
  assert.ok(result.prompt.startsWith('integrated_multimodal_description: [Shot 1]'));
  assert.match(result.prompt, /Keep B motionless until second 3\./);
  assert.match(result.prompt, /A, identity: red hair[^\n]*wardrobe: white shirt[^\n]*action: opens door/);
  assert.match(result.prompt, /B \(S1\), identity: black hair[^\n]*wardrobe: blue apron[^\n]*action: stirs soup/);
  assert.match(result.prompt, /B \(S1\) quietly: <d>\[English\] You are late\.<\/d>/);
  assert.deepEqual(result.promptValidation.sections, QIANMU_H3_BASE_PROMPT_SECTIONS);
  assert.equal(result.submissionReady, true);
  assert.ok(result.length <= QIANMU_H3_PROMPT_MAX_CHARS);
});

test('base modes use the official three-section structure and exact keyframe alignment line', () => {
  const firstManifest = {
    shotId: 'shot-1',
    assets: [{ assetId: 'first', kind: 'image', roles: ['first_frame'], locator: { kind: 'gallery', ref: 'chat␟first' } }],
  };
  const firstShot = { ...shot, keyframes: { firstAssetId: 'first' }, requestedMode: 'i2va' };
  const i2va = compileH3VideoPrompt(plan, firstShot, { manifest: firstManifest });
  assert.equal(i2va.ok, true);
  assert.match(i2va.prompt, /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\.\n\nintegrated_multimodal_description:/);
  assert.ok(i2va.prompt.indexOf('integrated_multimodal_description:') < i2va.prompt.indexOf('overall_soundscape:'));
  assert.ok(i2va.prompt.indexOf('overall_soundscape:') < i2va.prompt.indexOf('non_diegetic_music:'));
  assert.equal(i2va.format, 'official_base_three_section');

  const lastManifest = {
    shotId: 'shot-1',
    assets: [{ assetId: 'last', kind: 'image', roles: ['last_frame'], locator: { kind: 'gallery', ref: 'chat␟last' } }],
  };
  const l2va = compileH3VideoPrompt(plan, { ...shot, keyframes: { lastAssetId: 'last' }, requestedMode: 'l2va' }, { manifest: lastManifest });
  assert.match(l2va.prompt, /^How the reference pictures align with the target video — <Picture 1> \(from \[Shot 1\]\) aligns with the 6\.00-second mark/);

  const bothManifest = {
    shotId: 'shot-1',
    assets: [
      { assetId: 'first', kind: 'image', roles: ['first_frame'], locator: { kind: 'gallery', ref: 'chat␟first' } },
      { assetId: 'last', kind: 'image', roles: ['last_frame'], locator: { kind: 'gallery', ref: 'chat␟last' } },
    ],
  };
  const fl2va = compileH3VideoPrompt(plan, { ...shot, keyframes: { firstAssetId: 'first', lastAssetId: 'last' }, requestedMode: 'fl2va' }, { manifest: bothManifest });
  assert.match(fl2va.prompt, /^How the reference pictures align with the target video — Picture 1 \(from Shot 1\).*Picture 2 \(from Shot 1\).*6\.00-second mark/);
});

test('Ref2VA uses the official six-section order with stable reference labels', () => {
  const manifest = {
    shotId: 'shot-ref',
    assets: [
      { assetId: 'subject-a', kind: 'image', roles: ['subject_reference'], subjectLabel: '<Subject 1>', locator: { kind: 'gallery', ref: 'chat␟subject-a' } },
      { assetId: 'subject-b', kind: 'image', roles: ['subject_reference'], subjectLabel: '<Subject 2>', locator: { kind: 'gallery', ref: 'chat␟subject-b' } },
      { assetId: 'style', kind: 'image', roles: ['style_reference'], locator: { kind: 'gallery', ref: 'chat␟style' } },
    ],
  };
  const refShot = {
    ...shot,
    shotId: 'shot-ref',
    references: { assetIds: ['subject-a', 'subject-b', 'style'] },
    requestedMode: 'ref2va',
  };
  const result = compileH3VideoPrompt(plan, refShot, { manifest });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'official_ref_six_section');
  assert.deepEqual(result.promptValidation.sections, QIANMU_H3_REFERENCE_PROMPT_SECTIONS);
  assert.match(result.prompt, /^subject_definitions:\n<Subject 1> is A[^\n]*<Picture 1>/);
  assert.match(result.prompt, /<Subject 2> is B[^\n]*<Picture 2>/);
  assert.match(result.prompt, /<Picture 3> is the reference for visual style and treatment/);
  let previous = -1;
  for (const section of QIANMU_H3_REFERENCE_PROMPT_SECTIONS) {
    const index = result.prompt.indexOf(`${section}:`);
    assert.ok(index > previous, `${section} should follow the previous section`);
    previous = index;
  }
});

test('the compiled prompt validator rejects wrong order, unresolved labels and out-of-range timing', () => {
  const base = compileH3VideoPrompt(plan, shot);
  assert.equal(base.promptValidation.ok, true);
  assert.equal(validateH3CompiledPrompt(base.prompt.replace('overall_soundscape:', 'broken_soundscape:'), shot).ok, false);
  assert.ok(validateH3CompiledPrompt(`${base.prompt}\n<Picture 9>\nAt 00:09.000`, shot).issues.includes('h3_reference_unresolved:<Picture 9>'));
  assert.ok(validateH3CompiledPrompt(`${base.prompt}\nAt 00:09.000`, shot).issues.includes('h3_time_out_of_range:00:09.000'));
});

test('non-English generated prose is visible but cannot become submission-ready', () => {
  const localized = structuredClone(plan);
  localized.shot_summary = '镜头缓慢推进，两人保持各自的位置和动作，不得交换服装与外貌。';
  localized.environment.location = '安静的厨房，窗外正在下雨，室内只有暖色灯光。';
  localized.temporal_beats[0].visual = '人物A推开门并停在画面左侧，人物B继续在右侧搅拌汤锅。';
  const result = compileH3VideoPrompt(localized, shot);
  assert.equal(result.ok, true);
  assert.equal(result.submissionReady, false);
  assert.ok(result.promptValidation.warnings.includes('h3_english_rewrite_required'));
});

test('the official prompt is rejected instead of silently truncated beyond the provider limit', () => {
  const oversized = structuredClone(plan);
  const longLine = 'A complete spoken sentence must stay attached to the same speaker and exact timeline. '.repeat(12);
  oversized.dialogue = Array.from({ length: 8 }, (_, index) => ({
    subject_id: index % 2 ? 'a' : 'b',
    text: `${index} ${longLine}`,
    delivery: longLine,
    start_seconds: index * 0.5,
    end_seconds: Math.min(6, index * 0.5 + 1),
  }));
  const result = compileH3VideoPrompt(oversized, shot);
  assert.equal(result.ok, false);
  assert.ok(result.length > QIANMU_H3_PROMPT_MAX_CHARS);
  assert.ok(result.promptValidation.issues.includes('h3_prompt_too_long'));
});

test('an existing structured shot creates a deterministic zero-network prompt plan', () => {
  const planFromShot = createVideoPromptPlanFromShotSpec({
    ...shot,
    camera: { shotSize: 'MCU', angle: 'eye level', movement: 'slow dolly', framing: 'A left, B right', axis: 'hall side' },
    beats: [{ startSeconds: 0, endSeconds: 3, visual: 'A opens the door', camera: 'hold', sound: 'latch' }],
    audio: { dialogue: [{ characterId: 'b', text: 'You are late.', startSeconds: 4, endSeconds: 5, delivery: 'quietly' }], ambience: ['simmering'] },
    continuityLedger: { requiredFacts: ['A:coat:removed'], forbiddenRegressions: ['no coat reset'] },
  });
  const result = validateVideoPromptPlan(planFromShot, {
    ...shot,
    camera: { shotSize: 'MCU' },
    beats: [{ startSeconds: 0, endSeconds: 3, visual: 'A opens the door' }],
    audio: { dialogue: [{ characterId: 'b', text: 'You are late.' }] },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(planFromShot.temporal_beats[0].subject_ids, ['a']);
  assert.ok(planFromShot.temporal_beats.some((beat) => beat.subject_ids.includes('b') && /stirring/.test(beat.visual)));
  assert.equal(planFromShot.dialogue[0].subject_id, 'b');
  assert.equal(planFromShot.subjects[0].wardrobe[0], 'white shirt, coat removed');
});

test('the LLM request is compact, JSON-only and does not perform network work', () => {
  const request = buildVideoPromptPlanRequest(shot, {
    selectedText: 'A enters the kitchen. B keeps stirring.',
    manualDirection: 'Keep B still at first.',
  });
  assert.equal(request.schema, QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID);
  assert.equal(request.responseFormat.type, 'json_schema');
  assert.equal(request.responseFormat.json_schema.strict, true);
  assert.match(request.messages[0].content, /Return only JSON/);
  assert.match(request.messages[0].content, /sole owner/);
  assert.equal(JSON.parse(request.messages[1].content).subjects[1].subject_id, 'b');
  assert.doesNotMatch(request.messages.map((message) => message.content).join('\n'), /fetch\(|api[_ -]?key/i);
});

test('the parser accepts exact JSON or a single JSON fence, and rejects prose wrappers', () => {
  assert.equal(parseVideoPromptPlanResponse(JSON.stringify(plan), shot).ok, true);
  assert.equal(parseVideoPromptPlanResponse(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, shot).ok, true);
  assert.equal(parseVideoPromptPlanResponse(`Here is the result: ${JSON.stringify(plan)}`, shot).ok, false);
});

test('the prompt contract stays lazy and is included in the release whitelist', async () => {
  const [indexSource, releaseSource] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../release-files.json', import.meta.url), 'utf8'),
  ]);
assert.match(indexSource, /videoPrompt:\s*\{[\s\S]*import\('\.\/qianmu-video-prompt\.js\?v=1\.59\.62'\)/);
  assert.equal(JSON.parse(releaseSource).files.includes('qianmu-video-prompt.js'), true);
  assert.doesNotMatch(indexSource.slice(0, indexSource.indexOf('const featureRuntime')), /qianmu-video-prompt/);
});
