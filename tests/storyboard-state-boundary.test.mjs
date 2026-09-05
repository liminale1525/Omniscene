import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
let normalizations = 0, saves = 0;
const sandbox = vm.createContext({
  ...storyboard,
  settings: { imagegen: storyboard.createStoryboardDefaults() },
  isPlainObject: (value) => !!value && typeof value === 'object' && !Array.isArray(value),
  normalizeStoryboardState: (value) => { normalizations++; return storyboard.normalizeStoryboardState(value); },
  storyboardNormalizedStates: new WeakSet(),
  storyboardRuntimeReconciled: true,
  queueMicrotask: (fn) => fn(),
  saveSettings: () => { saves++; },
});
vm.runInContext([
  'storyboardState', 'storyboardProfile', 'storyboardConnectionState',
  'storyboardProviderProfile', 'storyboardVibeAmount', 'storyboardRememberCardState', 'snapshotAccState',
].map(fn).join('\n'), sandbox);
const state = vm.runInContext('storyboardState()', sandbox);
const rules = state.routing.rules;
sandbox.state = state;
// The original failing evaluation order must now work too, not just the rewritten handler.
vm.runInContext(`state.routing.rules.push({ id: 'r1', name: '分工', enabled: true, shotTypes: [],
  target: { providerId: state.source, modelId: storyboardProviderProfile(state).model }, priority: 0 });`, sandbox);
assert.equal(state.routing.rules, rules, 'profile reads must not detach the live rules array');
assert.equal(state.routing.rules.length, 1);
const rule = rules[0];
for (let i = 0; i < 100; i++) vm.runInContext('storyboardState(); storyboardProviderProfile(state)', sandbox);
assert.equal(normalizations, 1, 'normalization is an initialization boundary, not a per-read cost');
rule.name = '修改后的分工';
assert.equal(vm.runInContext('storyboardState().routing.rules[0].name', sandbox), rule.name);
assert.equal(storyboard.normalizeStoryboardState(structuredClone(state)).routing.rules[0].name, rule.name, 'reload retains edits');

assert.equal(sandbox.storyboardVibeAmount('0', .6), 0);
assert.equal(sandbox.storyboardVibeAmount('0', 1), 0);
assert.equal(sandbox.storyboardVibeAmount('', .6), .6);
assert.equal(sandbox.storyboardVibeAmount('broken', .6), .6);
assert.equal(sandbox.storyboardVibeAmount('Infinity', 1), 1);
assert.equal(sandbox.storyboardVibeAmount('1.3', .6), 1);
assert.equal(sandbox.storyboardVibeAmount('-.2', .6), 0);
assert.equal(storyboard.normalizeStoryboardState({}).collapsedCards.worldbook, true);
assert.equal(storyboard.normalizeStoryboardState({ collapsedCards: { worldbook: false } }).collapsedCards.worldbook, false);

const card = { dataset: { storyboardCard: 'worldbook' }, open: false, isConnected: true, addEventListener: (_type, cb) => { card.toggle = cb; } };
const root = { isConnected: true, _sdStoryboardState: state, querySelectorAll: (s) => s.includes('data-storyboard-card') ? [card] : [] };
sandbox.root = root;
sandbox.accState = {};
const toggleStart = source.indexOf("  root.querySelectorAll('details[data-storyboard-card]').forEach", source.indexOf('function bindStoryboardTabEvents('));
const toggleEnd = source.indexOf('\n  });', toggleStart) + '\n  });'.length;
vm.runInContext(source.slice(toggleStart, toggleEnd), sandbox);
state.collapsedCards.worldbook = false;
card.toggle();
assert.equal(state.collapsedCards.worldbook, true);
const saved = saves;
card.toggle();
assert.equal(saves, saved, 'initial or repeated native toggle must not repeatedly save');
card.isConnected = false;
card.open = true;
card.toggle();
assert.equal(state.collapsedCards.worldbook, true, 'detached card cannot overwrite current state even if modal root is reused');
card.isConnected = true;
sandbox.snapshotAccState(root);
assert.equal(state.collapsedCards.worldbook, false, 'capture a pending native toggle before replacing the card');

sandbox.settings = { imagegen: { collapsedCards: { worldbook: true } } };
const reloaded = vm.runInContext('storyboardState()', sandbox);
assert.notEqual(reloaded, state);
assert.equal(normalizations, 2, 'replacement settings are normalized once');
sandbox.snapshotAccState(root);
card.toggle();
assert.equal(reloaded.collapsedCards.worldbook, true, 'old UI must not migrate collapse state into new settings');
for (let i = 0; i < 200; i++) sandbox.storyboardRememberCardState(reloaded, { dataset: { storyboardCard: `worldbook-entry-${i}` }, _sdInitialOpen: false, open: true });
assert.equal(Object.keys(reloaded.collapsedCards).filter((key) => key.startsWith('worldbook-entry-')).length, 120);
assert.equal(reloaded.collapsedCards.worldbook, true, 'entry memory cannot evict the outer card');
const count = Object.keys(reloaded.collapsedCards).length;
sandbox.storyboardRememberCardState(reloaded, { dataset: { storyboardCard: 'worldbook-entry-untouched' }, _sdInitialOpen: false, open: false });
assert.equal(Object.keys(reloaded.collapsedCards).length, count, 'untouched closed rows do not inflate settings');
console.log('Storyboard live-state, fold ownership and Vibe zero regression OK');
