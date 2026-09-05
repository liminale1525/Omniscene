import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStoryboardDefaults, normalizeStoryboardState } from '../qianmu-storyboard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const contractSource = fs.readFileSync(path.join(root, 'qianmu-storyboard-contract.js'), 'utf8');

const defaults = createStoryboardDefaults();
assert.equal(defaults.contentRating, 'sfw');
assert.equal(defaults.paragraphMode, 'auto');
assert.equal(defaults.manualParagraphIndex, null);
assert.equal(defaults.promptDraft.artistString, '');
assert.equal(Object.hasOwn(defaults.promptDraft, 'manual'), false);
assert.equal(Object.hasOwn(defaults.promptDraft, 'autoInstruction'), false);
assert.equal(defaults.promptCompiler.worldMode, 'selected');
assert.ok(defaults.promptCompiler.tagRules.some((rule) => rule.name === 'think' && rule.action === 'remove'));

const normalized = normalizeStoryboardState({
  contentRating: 'nsfw',
  paragraphMode: 'manual',
  manualParagraphIndex: 4,
  promptDraft: { artistString: 'artist: user-owned' },
  artistPresets: [{ id: 'a1', name: '私有画师串', value: 'artist: user-owned' }],
  selectedArtistPresetId: 'a1',
  promptCompiler: {
    enabled: true,
    worldMode: 'selected',
    worldEntryIds: ['book::1'],
    tagRules: [{ name: 'thinking', action: 'remove' }, { name: 'scene', action: 'extract' }],
  },
});
assert.equal(normalized.contentRating, 'nsfw');
assert.equal(normalized.paragraphMode, 'manual');
assert.equal(normalized.manualParagraphIndex, 4);
assert.equal(normalized.promptDraft.artistString, 'artist: user-owned');
assert.equal(normalized.artistPresets[0].value, 'artist: user-owned');
assert.deepEqual(normalized.promptCompiler.worldEntryIds, ['book::1']);
assert.deepEqual(normalized.promptCompiler.tagRules, [
  { name: 'thinking', action: 'remove' },
  { name: 'scene', action: 'extract' },
  { name: 'think', action: 'remove' },
]);
assert.equal(normalized.promptCompiler.excludedTags, 'thinking, think');

// Preprocessing is an implementation detail owned by the top automation card.
assert.doesNotMatch(source, /class="sd-storyboard-compiler-toggle/);
assert.doesNotMatch(source, /data-storyboard-content-rating=/);
assert.doesNotMatch(source, />纯手写</);
assert.doesNotMatch(source, />手动触发</);
assert.match(source, /<b>API 设置<\/b>/);
assert.match(source, /<span>取景整理 API<\/span>/);
assert.doesNotMatch(source, /<span>提示词预处理<\/span>/);

// The default path is an unobtrusive two-stage automatic flow; manual capture remains an escape hatch.
assert.match(source, /sd-storyboard-capsule-switch[\s\S]*自动提取生成词[\s\S]*自动生图/);
assert.doesNotMatch(source, /sd-storyboard-auto-flow/);
assert.match(source, /dataset\.storyboardChatAction = 'capture-floor'/);
assert.match(source, /button\.dataset\.storyboardChatAction === 'capture-floor'[\s\S]*storyboardChooseCaptureMode[\s\S]*storyboardCompilePrompt\(null, \{ plan, quiet: false \}\)[\s\S]*manualSupplement[\s\S]*storyboardGenerate\(null, \{ plan, automatic: false \}\)/);
assert.match(source, /function storyboardHandleAutomaticCapture/);

// A take preset is a dedicated ordered-list workspace; there is no one-off instruction field on the workbench.
assert.match(source, /function renderStoryboardPresetLibrary/);
assert.doesNotMatch(source, /本次取景指令/);
assert.match(source, /storyboardNavigate\(root, \{ view: 'presets'/);
assert.doesNotMatch(source, /function storyboardSavePromptInstructionFromForm/);
assert.match(source, /presetItems\.map\(\(item, index\) => `\$\{index \+ 1\}\. \$\{item\.name\}\\n\$\{item\.instruction\}`\)/,
  'ordered preset entries must enter the compiler exactly once');
assert.match(source, /sd-storyboard-preset-entry[\s\S]*draggable="true"/);
assert.match(source, /sd-storyboard-add-preset-item[\s\S]*storyboardNavigate\(root, \{ view: 'presets',[\s\S]*editingPromptItemId: 'new'/);
assert.match(source, /sd-storyboard-preset-import-file[\s\S]*sd-storyboard-export-presets/);
assert.doesNotMatch(source, /sd-storyboard-manual-generate/,
  'manual prompt edits remain drafts and generation is initiated from the chat image flow');
assert.doesNotMatch(source, /class="[^\"]*sd-storyboard-generate/,
  'the removed floating storyboard generation button must not return');

// Character/persona context is unconditional; worldbook context is manual-only and always visible.
for (const selector of ['sd-storyboard-context-recent', 'sd-storyboard-context-rule-action', 'sd-storyboard-worldbook-picker']) assert.match(source, new RegExp(selector));
for (const removed of ['sd-storyboard-context-character', 'sd-storyboard-context-user', 'sd-storyboard-context-world', 'sd-storyboard-world-mode']) assert.doesNotMatch(source, new RegExp(removed));
assert.equal(normalized.promptCompiler.includeCharacterCards, true);
assert.equal(normalized.promptCompiler.includeUserPersona, true);
assert.equal(normalized.promptCompiler.worldMode, 'selected');
assert.doesNotMatch(source, /storyboardWorldEntryScore/);
assert.match(source, /function storyboardCleanWithTagRules[\s\S]*action === 'extract'[\s\S]*action === 'remove'/);
assert.match(source, /storyboardCleanWithTagRules\(item\.mes, state\)/);
assert.match(source, /storyboardCleanWithTagRules\(targetMessage\?\.mes \|\| '', state\)/);

// Artist strings remain entirely user-controlled and lead the provider prompt at request time.
assert.match(contractSource, /画师串由用户另行管理，任何字段都不得写画师名/);
assert.doesNotMatch(source, /"artist_string"|"artist_suggestion"/);
assert.match(source, /function storyboardPromptsForArtist/);
assert.match(source, /storyboardJoinPrompt\(\[artistString, layer\.positive, prompt\], sourceId\)/);
assert.match(source, /compileStoryboardPrompt\(\{[\s\S]*artistString/);
assert.match(source, /const compiled = manuallyLocked[\s\S]*compileStoryboardPrompt/);
assert.doesNotMatch(source, /function storyboardSaveArtistPreset/);
assert.match(source, /function renderStoryboardArtistLibrary[\s\S]*sd-storyboard-artist-waterfall/);
assert.match(source, /sd-storyboard-edit-selected-artist[\s\S]*storyboardNavigate\(root, \{ view: 'artists', editingArtistPresetId: state\.selectedArtistPresetId/);
assert.match(source, /storyboardMediaTagEditorMarkup\(editing\?\.tags \|\| \[\], knownTags, 'artist-draft'\)/);
assert.match(source, /sd-media-collection-choices/);
assert.match(source, /querySelectorAll\('\.sd-storyboard-prompt, \.sd-storyboard-negative/,
  'manual prompt edits must persist without triggering either automatic stage');

// Image data is server-backed for one ST instance; the explicit package remains a migration tool.
assert.match(source, /<b>分镜数据打包<\/b><small>跨 SillyTavern 迁移，不包含 API Key<\/small>/);
assert.match(source, /function renderStoryboardLogs[\s\S]*sd-storyboard-pack-card/);
assert.match(source, /ctx\(\)\.saveSettingsDebounced\?\.\(\)/);
assert.match(source, /storyboardImages[\s\S]*saveMetadata/);

assert.match(style, /分镜第一阶段：无感自动化/);
assert.match(style, /\.sd-storyboard-capsule-switch/);
assert.match(style, /\.sd-storyboard-prompt-stack/);
assert.match(style, /\.sd-storyboard-artist-waterfall/);

console.log('Storyboard prompt preprocessing workflow contract OK');
