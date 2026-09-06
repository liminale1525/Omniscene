import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { STORYBOARD_SCHEMA_VERSION, normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const utilities = await readFile(new URL('../qianmu-storyboard-utils.js', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 24);

// Storyboard owns the whole Qianmu panel and replaces the former world-map shortcut.
assert.doesNotMatch(source, /\['imagegen', '分镜'\]/);
assert.doesNotMatch(source, /sd-geo-shortcut/);
assert.match(source, /sd-storyboard-shortcut[\s\S]*activeTab = 'imagegen'/);
assert.match(source, /sd-storyboard-mode[\s\S]*sd-storyboard-body/);
assert.match(source, /sd-storyboard-titlebar[\s\S]*sd-storyboard-close/);
assert.doesNotMatch(source, /sd-storyboard-back|function storyboardBack|storyboardRouteStack/);
assert.match(source, /sd-storyboard-close[\s\S]*storyboardReturnTab/);
assert.match(style, /\.sd-storyboard-mode \.sd-storyboard-body/);

// World map is the swipeable reverse side of the World tab.
assert.match(source, /function renderCastWorldTab[\s\S]*sd-world-flip-shell/);
assert.match(source, /function bindWorldFlipEvents[\s\S]*Math\.abs\(dx\) >= 38/);
assert.match(source, /worldPage = worldPage === 'geopolitics' \? 'front' : 'geopolitics'/);
assert.match(source, /activeTab === 'castworld' && worldPage === 'geopolitics'/);
assert.match(style, /sd-world-edge-breathe/);

// API logs retain the full sent and returned payload. A scroll box controls layout, never data loss.
assert.doesNotMatch(source, /\bclipLog\b|内容过长已截断|LOG_CLIP/);
assert.doesNotMatch(utilities, /\bclipLog\b|内容过长已截断/);
assert.match(source, /log\.request = JSON\.stringify\(messages, null, 2\)/);
assert.match(source, /log\.response = String\(raw \|\| ''\)/);
assert.match(source, /log\.response = content/);
assert.match(style, /\.sd-term \{ max-height: min\(52vh, 720px\); \}/);

// Context is predictable: character/persona are always included and worldbook entries are manual-only.
const normalized = normalizeStoryboardState({
  schemaVersion: 8,
  promptCompiler: {
    includeCharacterCards: false,
    includeUserPersona: false,
    includeActivatedWorldInfo: false,
    worldMode: 'auto',
    worldEntryIds: ['book::entry'],
  },
  editingArtistPresetId: 'new',
  artistCollections: [{ id: 'folder-1', name: '水彩' }],
  artistPresets: [{ id: 'artist-1', name: '柔光', value: 'soft light', tags: ['柔光', '人像'], collectionId: 'folder-1' }],
});
assert.equal(normalized.promptCompiler.includeCharacterCards, true);
assert.equal(normalized.promptCompiler.includeUserPersona, true);
assert.equal(normalized.promptCompiler.includeActivatedWorldInfo, true);
assert.equal(normalized.promptCompiler.worldMode, 'selected');
assert.deepEqual(normalized.promptCompiler.worldEntryIds, ['book::entry']);
assert.deepEqual(normalized.promptCompiler.worldBookNames, ['book']);
assert.deepEqual(normalized.promptCompiler.tagRules.map((item) => item.name), ['think', 'thinking']);
assert.equal(normalized.editingArtistPresetId, 'new', 'new artist editor survives normalization');
assert.deepEqual(normalized.artistPresets[0].tags, ['柔光', '人像']);
assert.equal(normalized.artistPresets[0].collectionId, 'folder-1');

assert.match(source, /<b>上下文处理<\/b>/);
assert.match(source, /<span>参考层数<\/span>/);
assert.match(source, /<b>提取规则<\/b>/);
assert.match(source, /sd-storyboard-worldbook-card/);
assert.match(source, /sd-storyboard-worldbook-picker/);
assert.doesNotMatch(source, /自动筛选/);

// The fixed title system reserves a real top region; closing is not overloaded as navigation.
assert.match(source, /sd-storyboard-titlebar[\s\S]*STORYBOARD/);
assert.match(source, /function renderStoryboardNav[\s\S]*data-storyboard-view/);
assert.doesNotMatch(source.match(/function renderStoryboardNav[\s\S]*?\n}/)?.[0] || '', /sd-storyboard-exit/);
assert.match(style, /\.sd-storyboard-root[\s\S]*grid-template-rows: 46px minmax\(0, 1fr\) auto/);
assert.match(style, /\.sd-storyboard-scroll[\s\S]*overflow: auto/);
assert.doesNotMatch(source, /为 \$\{getStoryboardModel[\s\S]*连接起一个便于识别的名称/);

// Storyboard worldbooks use the same all-books → multi-book → per-entry hierarchy as Context.
assert.match(source, /listWorldBooks\(\)[\s\S]*sd-storyboard-toggle-worldbook/);
assert.match(source, /sd-storyboard-world-name[\s\S]*data-storyboard-world-entry/);
assert.match(source, /sd-storyboard-refresh-worldbooks/);

// Presets and artist strings use dedicated, full-panel editors.
assert.match(source, /function renderStoryboardPresetLibrary/);
assert.match(source, /sd-storyboard-new-preset[\s\S]*sd-storyboard-overwrite-preset[\s\S]*sd-storyboard-rename-preset/);
assert.match(source, /sd-storyboard-cancel-preset-item[\s\S]*sd-storyboard-save-preset-item/);
assert.match(source, /sd-storyboard-edit-selected-artist/);
assert.match(source, /sd-storyboard-new-artist-collection/);
assert.match(source, /data-media-tag-editor="artist-draft"/);
assert.match(source, /const verified = sourceId !== 'comfy' && data\.verified !== false;[\s\S]*toast\(message, verified \? 'success' : 'warning'\)/, 'NAI 缺失探测接口与 Comfy 地址可达均不得误报为生图已验证；实际入口另有协议回归');
assert.match(source, /sd-storyboard-artist-edit-positive/);
assert.match(source, /sd-storyboard-artist-edit-negative/);
assert.match(source, /sd-storyboard-artist-preview-file/);
assert.match(source, /sd-storyboard-artist-preview-gallery/);
assert.match(source, /fa-floppy-disk/);
assert.doesNotMatch(source, /class="[^"]*sd-storyboard-artist-string/);

// Prompt-card edits are remembered per concrete channel/model. Artist fields override one side at a time.
assert.match(source, /function storyboardProviderPromptDefaults[\s\S]*Object\.hasOwn\(remembered, 'positive'\)[\s\S]*Object\.hasOwn\(remembered, 'negative'\)/);
assert.match(source, /function storyboardPromptLayerForArtist[\s\S]*artist\?\.positivePrompt \|\| defaults\.positive[\s\S]*artist\?\.negativePrompt \|\| defaults\.negative/);
assert.match(source, /function storyboardRememberPromptLayer[\s\S]*artist\[field === 'positive'[\s\S]*state\.promptDefaults\[key\] = current/);
assert.match(source, /storyboardJoinPrompt\(\[artistString, layer\.positive, prompt\][\s\S]*storyboardJoinPrompt\(\[layer\.negative, negative\]/, 'artist string and positive defaults must precede the scene, with negative kept separate');

console.log('Storyboard v1.56.3 refinement contract OK');
