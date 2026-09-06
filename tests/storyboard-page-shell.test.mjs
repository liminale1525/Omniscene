import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createStoryboardDefaults } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
let state = createStoryboardDefaults();
const sandbox = vm.createContext({
  storyboardState: () => state, htmlEscape: (v) => String(v), clone: structuredClone,
  storyboardPageScrolls: new Map(), storyboardPendingRestoreScroll: null,
  storyboardScroller: () => ({ scrollTop: 275 }), saveSettings() {}, renderModal() {},
  storyboardCloseLightbox() {}, storyboardReconcileGalleryLinks() {},
  renderStoryboardAssets: () => '<div>assets</div>', renderStoryboardArtistLibrary: () => '<div>artists</div>',
  renderStoryboardPresetLibrary: () => '<div>presets</div>', renderStoryboardGallery: () => '<div>gallery</div>',
  renderStoryboardLogs: () => '<div>logs</div>', renderStoryboardCreate: () => '<div>create</div>',
});
vm.runInContext(['storyboardPageTitle', 'renderStoryboardNav', 'renderStoryboardTab', 'storyboardPageKey',
  'storyboardApplyRoute', 'storyboardRememberPageScroll', 'storyboardNavigate', 'storyboardReturnTo'].map(fn).join('\n'), sandbox);

for (const [view, title] of Object.entries({ create: 'STORYBOARD', artists: 'ARTIST LIBRARY',
  presets: 'FRAMING PRESETS', gallery: 'SCREENING ROOM', logs: 'LOGS' })) {
  state.view = view;
  assert.match(sandbox.renderStoryboardTab(), new RegExp(`role="heading" aria-level="2">${title}</span>`));
}
for (const [assetView, title] of Object.entries({ tags: 'TAG LIBRARY', vibes: 'VIBE LIBRARY', routing: 'SHOT GROUPS' })) {
  state.view = 'assets'; state.assetView = assetView;
  assert.equal(sandbox.storyboardPageTitle(state), title);
}
assert.equal(sandbox.storyboardPageTitle({ view: 'characters' }), 'CHARACTERS');
assert.match(sandbox.renderStoryboardNav(state), /data-storyboard-view="characters"/, 'the independent archive is now a working navigation entry');
assert.equal((sandbox.renderStoryboardNav(state).match(/data-storyboard-view=/g) || []).length, 5);
state.view = 'characters';
assert.match(sandbox.renderStoryboardTab(), /sd-character-archive-host/);
assert.doesNotMatch(sandbox.renderStoryboardTab(), /<div>create<\/div>/);
assert.equal(sandbox.storyboardPageTitle({ view: 'artists', editingArtistPresetId: 'missing' }), 'ARTIST LIBRARY');
assert.equal(sandbox.storyboardPageTitle({ view: 'artists', editingArtistPresetId: 'new' }), 'ARTIST PROFILE');
assert.equal(sandbox.storyboardPageTitle({ view: 'artists', editingArtistPresetId: 'a', artistPresets: [{ id: 'a' }] }), 'ARTIST PROFILE');
assert.equal(sandbox.storyboardPageTitle({ view: 'presets', editingPromptItemId: 'missing' }), 'FRAMING PRESETS');
state = createStoryboardDefaults();
state.view = 'presets'; state.promptPresets = [{ id: 'p', items: [] }];
state.promptCompiler.instructionPresetId = 'p'; state.editingPromptItemId = 'new';
state.promptItemDraft = { name: '未保存', instruction: '保持草稿' };
const before = JSON.stringify(state);
assert.equal(sandbox.storyboardPageTitle(state), 'FRAMING ENTRY');
assert.equal(JSON.stringify(state), before, 'title computation is read-only');
sandbox.storyboardNavigate({}, { view: 'create', editingPromptItemId: '' });
assert.equal(sandbox.storyboardPageScrolls.get('presets:item:new'), 275);
sandbox.storyboardReturnTo({}, 'presets', { editingPromptItemId: 'new' });
assert.equal(sandbox.storyboardPendingRestoreScroll, 275, 'same editor restores its old position');
assert.equal(state.promptItemDraft.instruction, '保持草稿');
assert.doesNotMatch(fn('renderStoryboardArtistLibrary'), /<h3>ARTIST LIBRARY<\/h3>/);
assert.doesNotMatch(fn('renderStoryboardLogs'), /GENERATION LOG|<h3>分镜日志<\/h3>/);
assert.doesNotMatch(fn('renderStoryboardPresetLibrary'), /<header><b>\$\{editingItem/);
assert.match(css, /\.sd-storyboard-root \{ --qm-control-height: 40px;/);
assert.match(css, /\.sd-world-edge::before \{[^}]*width: 1\.5px;[^}]*linear-gradient\(to bottom, transparent/);
assert.match(css, /\.sd-header-actions[^}]*color: inherit !important;/);
console.log('Storyboard dynamic titles, draft/scroll preservation and scoped form baseline OK');
