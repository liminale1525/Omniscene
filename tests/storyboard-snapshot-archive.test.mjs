import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

test('storyboard redraw snapshots use an additive private IndexedDB store', () => {
assert.match(store, /const DB_VERSION = 15/);
  assert.match(store, /STORE_STORYBOARD_SNAPSHOTS = 'storyboard_snapshots'/);
  assert.match(store, /if \(!db\.objectStoreNames\.contains\(STORE_STORYBOARD_SNAPSHOTS\)\) db\.createObjectStore\(STORE_STORYBOARD_SNAPSHOTS\)/);
  assert.match(store, /STORE_STORYBOARD_SNAPSHOTS\]: \{[^}]*recoverable: false/);
  assert.match(store, /name === STORE_STORYBOARD_SNAPSHOTS[\s\S]*CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_STORYBOARD_SNAPSHOTS/);
});

test('snapshot writes are transactional and reads stay bounded', () => {
  const write = store.slice(store.indexOf('export async function putStoryboardSnapshots'), store.indexOf('export async function getStoryboardSnapshots'));
  assert.match(write, /db\.transaction\(STORE_STORYBOARD_SNAPSHOTS, 'readwrite'\)/);
  assert.match(write, /transaction\.oncomplete/);
  assert.match(write, /transaction\.onabort/);
  assert.match(write, /transaction\.abort\(\)/);
  assert.match(store, /export async function getStoryboardSnapshots[\s\S]*?\.slice\(0, 500\)/);
});

test('inline snapshots win during migration and are stripped only after durable storage', () => {
  assert.match(source, /function storyboardSnapshotForRecord[\s\S]*?record\?\.snapshot[\s\S]*?storyboardSnapshotCache\.get/);
  const archive = source.slice(source.indexOf('async function storyboardArchiveGallerySnapshots'), source.indexOf('async function storyboardHydrateGallerySnapshots'));
  assert.ok(archive.indexOf('await blobStore.putStoryboardSnapshots') < archive.indexOf('delete item.record.snapshot'));
  assert.match(archive, /item\.record\.snapshot !== item\.source/);
  assert.match(archive, /await saveMetadata\(\)[\s\S]*?item\.record\.snapshot = item\.source/);
  assert.match(archive, /epoch !== storyboardSnapshotEpoch/);
});

test('redraw, edit, attach and export hydrate exact snapshots on demand', () => {
  assert.match(source, /async function storyboardAttachProductionRecord[\s\S]*?await storyboardReadSnapshotForRecord/);
  assert.match(source, /async function storyboardRedrawRecord[\s\S]*?await storyboardReadSnapshotForRecord/);
  assert.match(source, /async function storyboardEditPrompt[\s\S]*?await storyboardReadSnapshotForRecord/);
  assert.match(source, /async function storyboardExportPackage[\s\S]*?await storyboardHydrateGallerySnapshots/);
});

test('gallery lifecycle archives, prunes, clears and invalidates snapshots safely', () => {
  assert.match(source, /async function storyboardHandleChatChanged[\s\S]*?storyboardSnapshotEpoch\+\+[\s\S]*?storyboardArchiveGallerySnapshots/);
  assert.match(source, /receivedRecords\.push\(record\)[\s\S]*?storyboardArchiveGallerySnapshots\(receivedRecords\)/);
  assert.match(source, /gallery\.some\(item => item.id === record.id\)\) gallery.push\(record\)[\s\S]*?storyboardArchiveGallerySnapshots\(records\)/);
  assert.match(source, /storyboard_snapshots: \['不可恢复 · 阅片精确重绘设置', true\]/);
  assert.match(source, /STORAGE_CHAT_CLEARABLE[^\n]*storyboard_snapshots/);
  assert.match(source, /cleared\.has\('storyboard_snapshots'\)[\s\S]*?delete record\.snapshotRef/);
  assert.match(source, /storyboardDeleteRecordSnapshots\(removedRecords\)/);
});
