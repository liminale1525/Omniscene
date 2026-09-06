import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStoryboardDefaults, normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const removedKeys = [
  'characterView',
  'selectedCharacterId',
  'characters',
  'entities',
  'castPickerOpen',
  'selectedCharacters',
  'consistencyModes',
];

const defaults = createStoryboardDefaults();
for (const key of removedKeys) {
  assert.equal(Object.hasOwn(defaults, key), false, `storyboard defaults must not declare removed character state: ${key}`);
}

const normalized = normalizeStoryboardState({
  schemaVersion: 8,
  view: 'characters',
  characterView: 'edit',
  selectedCharacterId: 'look-a',
  characters: [{ id: 'look-a', subjectName: 'Alice', appearance: 'red coat' }],
  entities: { char: [{ id: 'char:a', profiles: [{ id: 'look-a' }] }] },
  selectedCharacters: [{ entityId: 'char:a', profileId: 'look-a' }],
});
assert.equal(normalized.view, 'characters', 'the rebuilt archive route is distinct from retired character data');
for (const key of removedKeys) {
  assert.equal(Object.hasOwn(normalized, key), false, `normalization must delete removed character state: ${key}`);
}

assert.doesNotMatch(source, /\['characters',\s*'形象档案'/, 'storyboard navigation must not expose the character archive');
assert.match(source, /state\.view === 'characters' \? '<div class="sd-character-archive-host"/, 'rebuilt route mounts the lazy independent archive');
assert.doesNotMatch(source, /characters:\s*clone\(state\.characters\)/, 'storyboard packages must not export character records');
assert.doesNotMatch(source, /state\.characters\s*=\s*storyboardMergeById/, 'storyboard packages must not import character records');

console.log('Storyboard character archive removal contract OK');
