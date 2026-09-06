import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { STORYBOARD_SCHEMA_VERSION, normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 24);

const migrated = normalizeStoryboardState({
  schemaVersion: 10,
  artistCollections: [
    { id: 'soft', name: 'Soft' },
    { id: 'cinema', name: 'Cinema' },
  ],
  artistPresets: [
    { id: 'artist-a', name: 'Artist A', value: 'artist:a', collectionId: 'soft' },
    { id: 'artist-b', name: 'Artist B', value: 'artist:b', collectionIds: ['soft', 'cinema'] },
  ],
});
assert.deepEqual(migrated.artistPresets[0].collectionIds, ['soft']);
assert.equal(migrated.artistPresets[0].collectionId, 'soft');
assert.deepEqual(migrated.artistPresets[1].collectionIds, ['soft', 'cinema']);

// Main header shortcuts use the same selected-state contract.
assert.match(source, /sd-storyboard-shortcut \$\{activeTab === 'imagegen' \? 'active' : ''\}/);
assert.match(source, /sd-plug-shortcut \$\{activeTab === 'plug' \? 'active' : ''\}/);
assert.match(style, /\.sd-coread-shortcut\.active,[\s\S]*\.sd-storyboard-shortcut\.active,[\s\S]*\.sd-plug-shortcut\.active/);
assert.match(style, /\.sd-theme-pick\.open \.sd-theme-btn/);

// Worldbook and prompt cards share the compact form baseline.
assert.match(source, /<details class="sd-card sd-storyboard-worldbook-card" data-storyboard-card="worldbook"/);
assert.match(source, /sd-storyboard-worldbook-card[\s\S]*sd-storyboard-refresh-worldbooks[\s\S]*sd-storyboard-card-body/);
assert.match(source, /sd-storyboard-prompt sd-storyboard-prompt-textarea/);
assert.match(source, /sd-storyboard-negative sd-storyboard-prompt-textarea/);
assert.match(style, /\.sd-storyboard-root \{ --qm-control-height: 40px; --qm-control-radius: 9px; text-align: left; \}/);
assert.match(style, /\.sd-storyboard-root input\.text_pole:not\(\[type="file"\]\),[\s\S]*min-height: var\(--qm-control-height\) !important; height: var\(--qm-control-height\)/);
assert.match(style, /\.sd-storyboard-prompt-textarea \{ min-height: 96px !important/);
assert.match(style, /\.sd-storyboard-root \{ --sd-storyboard-gap: 6px; gap: 6px; \}/);

// Artist and gallery libraries share Eagle-like collections, tags, and responsive panes.
assert.match(source, /function storyboardMediaSidebarMarkup/);
assert.match(source, /function storyboardMediaTagEditorMarkup/);
assert.match(source, /split\(\/\[,，\\n\]\+\//, 'desktop Enter and mobile comma input must tokenize tags');
assert.match(source, /function storyboardAssignCollectionIds/);
assert.match(source, /sd-media-gallery-library/);
assert.match(source, /sd-media-artist-library/);
assert.match(style, /\.sd-media-library-shell[\s\S]*grid-template-columns:/);
assert.match(style, /@media \(max-width: 720px\)[\s\S]*\.sd-media-library-shell \{ grid-template-columns: minmax\(0, 1fr\)/);

// Inline palette redraw swaps only the artist layer and retains the original frame settings.
assert.match(source, /data-storyboard-chat-action="artist"/);
assert.match(source, /function storyboardChooseArtistForRecord/);
assert.match(source, /function storyboardBasePromptsForArtistRedraw/);
assert.match(source, /function storyboardRedrawRecord\(record, \{ artistPreset = undefined, artistPool = null, rerollArtist = false, verify = async\(\)=>\{\} \} = \{\}\)/);
assert.match(source, /value="__reroll_pool__"[\s\S]*excludedArtistIds: \[record\.artistPresetId[\s\S]*reroll: true/, '正文换画师必须支持从原方案显式重抽并排除当前画师');
assert.match(source, /artistRerollCount = Math\.max[\s\S]*snapshot\.artistRerollCount = artistRerollCount/, '显式换画师必须留下稳定递增的重抽次数');
assert.match(source, /fallbackToStateArtist = true[\s\S]*fallbackToStateArtist: false/, '单镜明确清除画师层时不得重新吸入镜头台的全局画师');
assert.match(source, /storyboardAssignCollectionIds\(job, storyboardItemCollectionIds\(record\)\)/);

console.log('Storyboard v1.56.3 library and inline-redraw contract OK');
