import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_COMPOSITION_RULE_ID,
  STORYBOARD_PLAN_SCHEMA,
  STORYBOARD_SCHEMA_VERSION,
  buildStoryboardProviderPlan,
  compileStoryboardPrompt,
  createStoryboardDefaults,
  normalizeStoryboardCompositionPolicy,
  normalizeStoryboardParagraphSelection,
  normalizeStoryboardShotSpec,
  normalizeStoryboardState,
  prepareStoryboardShotGroup,
  resolveStoryboardComposition,
  restoreStoryboardCompositionPolicy,
  validateStoryboardShotSpec,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const gateway = await readFile(new URL('../qianmu-image-gateway.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 24);
const defaults = createStoryboardDefaults();
assert.equal(defaults.compositionPolicy.systemRuleId, STORYBOARD_COMPOSITION_RULE_ID);
assert.equal(defaults.compositionPolicy.groupStrategy, 'main_secondary');
assert.equal(defaults.pendingParagraphSelection, null);

const policy = normalizeStoryboardCompositionPolicy({
  systemRuleId: 'spoofed', systemRuleVersion: 999, mode: 'smart', allowedRatioIds: ['16:9', '3:2', 'invalid'],
  preferredRatioId: '16:9', groupStrategy: 'montage', ruleOverride: '保留更多负空间', userEdited: true,
});
assert.equal(policy.systemRuleId, STORYBOARD_COMPOSITION_RULE_ID, 'system rule identity is immutable');
assert.equal(policy.systemRuleVersion, 2, 'system rule version comes from the runtime, not imported data');
assert.deepEqual(policy.allowedRatioIds, ['16:9', '3:2']);
assert.equal(restoreStoryboardCompositionPolicy(policy).ruleOverride, '');

const selection = normalizeStoryboardParagraphSelection({ mode: 'manual_supplement', indexes: [4, 1, 4, 2] });
assert.deepEqual(selection.indexes, [1, 2, 4]);
assert.deepEqual(selection.paragraphIds, ['p2', 'p3', 'p5']);
assert.equal(selection.insertAfterIndex, 4);

const shot = normalizeStoryboardShotSpec({
  id: 'duet', source_paragraph_ids: ['p2', 'p3'], insert_after: 'p3', narrative_layer: 'memory',
  narrative_purpose: '回忆中两人错身', shot_role: 'relationship', shot_scale: 'medium_shot',
  scene: 'rainy station platform', shared_relations: ['Alice faces Bob'],
  composition: { ratio_id: '16:9', rationale: '横向保留两人距离' },
  prompt_atoms: { global: ['2girls', 'rainy night'], camera: ['cinematic framing'], environment: ['railway platform'], negative: ['text'] },
  characters: [
    { id: 'alice', name: 'Alice', identity: ['red hair', 'green eyes'], outfit: ['white coat'], action: ['holding a red umbrella'], spatial: { region: 'left', center: [0.24, 0.52], crop: 'waist' } },
    { id: 'bob', name: 'Bob', identity: ['blue hair', 'amber eyes'], outfit: ['black jacket'], action: ['looking over his shoulder'], spatial: { region: 'right', center: [0.77, 0.51], crop: 'waist' } },
  ],
});
assert.equal(shot.schema, STORYBOARD_PLAN_SCHEMA);
assert.equal(shot.characters[0].identity[0], 'red hair');
assert.equal(validateStoryboardShotSpec(shot, { providerId: 'novel', modelId: 'nai-diffusion-5-full' }).valid, true);

const nai = compileStoryboardPrompt({
  providerId: 'novel', modelId: 'nai-diffusion-5-full', shot,
  artistString: 'artist: qianmu-user', artistPositive: 'very aesthetic', artistNegative: 'bad quality',
});
assert.match(nai.prompt, /^artist: qianmu-user, very aesthetic/);
assert.doesNotMatch(nai.providerOptions.v4_prompt.caption.base_caption, /red hair|blue hair|white coat|black jacket/,
  'exclusive character traits must not leak into the shared caption');
assert.equal(nai.providerOptions.v4_prompt.caption.char_captions.length, 2);
assert.match(nai.providerOptions.v4_prompt.caption.char_captions[0].char_caption, /Alice, red hair[\s\S]*white coat[\s\S]*red umbrella/);
assert.doesNotMatch(nai.providerOptions.v4_prompt.caption.char_captions[0].char_caption, /blue hair|black jacket/);
assert.match(nai.providerOptions.v4_prompt.caption.char_captions[1].char_caption, /Bob, blue hair[\s\S]*black jacket/);
assert.deepEqual(nai.providerOptions.v4_prompt.caption.char_captions.map((item) => item.centers[0]), [{ x: 0.24, y: 0.52 }, { x: 0.77, y: 0.51 }]);
assert.match(nai.negative, /^bad quality,[\s\S]*text,[\s\S]*mixed identities/);

const degraded = compileStoryboardPrompt({ providerId: 'openai', modelId: 'gpt-image-2', shot });
assert.equal(degraded.degradation.mode, 'named_character_blocks');
assert.deepEqual(degraded.providerOptions, {});
assert.match(degraded.prompt, /Alice[\s\S]*red hair[\s\S]*Bob[\s\S]*blue hair/);

const duplicateCenters = validateStoryboardShotSpec({ ...shot, characters: shot.characters.map((item) => ({ ...item, spatial: { ...item.spatial, center: [0.5, 0.5] } })) });
assert.equal(duplicateCenters.valid, false);
assert.match(duplicateCenters.errors.join('\n'), /同一空间中心/);

const fixed = resolveStoryboardComposition({ policy: { mode: 'fixed', fixedRatioId: '4:5' }, shot, providerId: 'openai', width: 832, height: 1216 });
assert.equal(fixed.ratioId, '4:5');
assert.equal(fixed.dimensions.size, '1024x1536');
const locked = resolveStoryboardComposition({ policy: { mode: 'fixed', fixedRatioId: '4:5' }, shot: { ...shot, composition: { ratioId: '16:9', ratioLocked: true } }, providerId: 'novel', width: 832, height: 1216 });
assert.equal(locked.ratioId, '16:9', 'a manually locked shot ratio must survive re-extraction and fixed defaults');

const duplicateShots = [shot, { ...shot, id: 'duet-copy' }];
const automaticGroup = prepareStoryboardShotGroup({ shots: duplicateShots, policy: { groupStrategy: 'main_secondary' }, maxShots: 4 });
assert.equal(automaticGroup.shots.length, 1);
assert.equal(automaticGroup.skipped[0].reason, 'duplicate_coverage');
const manualGroup = prepareStoryboardShotGroup({ shots: duplicateShots, policy: { groupStrategy: 'single' }, maxShots: 1, manual: true });
assert.equal(manualGroup.shots.length, 2, 'manual supplements are never denied by an automatic coverage budget');

const sequence = prepareStoryboardShotGroup({
  shots: [
    { ...shot, id: 'establish', shotRole: 'establishing', subject: 'station', narrativePurpose: 'establish space', composition: {}, continuityUpdates: { axis: 'platform axis', mainRatioId: '16:9', props: { umbrella: 'Alice' } } },
    { ...shot, id: 'reaction', shotRole: 'reaction', shotScale: 'close_up', subject: 'Alice', narrativePurpose: 'hold on her reaction', composition: { focus: 'Alice reaction' }, continuityUpdates: { actionState: { Alice: 'stops walking' } } },
  ],
  policy: { groupStrategy: 'main_secondary', allowedRatioIds: ['16:9', '4:5'], preferredRatioId: '16:9' }, maxShots: 4,
});
assert.equal(sequence.shots[0].composition.ratioId, '16:9');
assert.equal(sequence.shots[1].composition.ratioId, '4:5');
assert.equal(sequence.continuityLedger.axis, 'platform axis');
assert.equal(sequence.continuityLedger.props.umbrella, 'Alice');
assert.equal(sequence.continuityLedger.actionState.Alice, 'stops walking');

const providerPlan = buildStoryboardProviderPlan({
  providerId: 'novel', model: 'nai-diffusion-5-full', prompt: nai.prompt, negative: nai.negative,
  connection: { baseUrl: 'https://image.novelai.net' }, params: { providerOptions: nai.providerOptions },
});
assert.deepEqual(providerPlan.request.providerOptions.v4_prompt.caption.char_captions[0].centers[0], { x: 0.24, y: 0.52 });

const state = normalizeStoryboardState({
  schemaVersion: 11,
  shotPlans: [{ id: 'manual-plan', origin: 'manual_supplement', paragraphSelection: selection, shots: [{ id: 'shot-a', shotSpec: shot, paragraphSelection: selection }] }],
});
assert.equal(state.shotPlans[0].origin, 'manual_supplement');
assert.deepEqual(state.shotPlans[0].paragraphSelection.indexes, [1, 2, 4]);
assert.equal(state.shotPlans[0].shots[0].shotSpec.characters.length, 2);

assert.match(source, /手动选段补图[\s\S]*sd-storyboard-capture-paragraph-list/);
assert.match(source, /manualSupplement[\s\S]*shotProfile\.count = '1'/);
assert.match(source, /anchor\.node\.insertAdjacentElement\('afterend', wrapper\)/);
assert.match(source, /plan\.origin !== 'manual_supplement'/);
assert.match(source, /compositionLaw: \{ id: STORYBOARD_COMPOSITION_RULE_ID[\s\S]*ruleOverride/);
assert.match(gateway, /const parameters = \{[\s\S]*\.\.\.providerOptions/, 'the gateway must forward sanitized NAI character-caption structures');
assert.match(css, /构景之律、多人编译与正文选段补图/);

console.log('Storyboard phase B contract OK');
