import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('index.js', root), 'utf8');
const css = await readFile(new URL('style.css', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

assert.equal(manifest.version, '1.59.57');
assert.match(source, /function storyboardGalleryCollections\(\)[\s\S]*storyboardCollections/, 'collections must persist with chat metadata');
assert.match(source, /function storyboardGalleryGroupId[\s\S]*variantRootId[\s\S]*planShotId[\s\S]*groupId/, 'old and new image records need stable variant grouping');
assert.match(source, /function storyboardCreateRecord[\s\S]*variantRootId: job\.variantRootId \|\| job\.planShotId \|\| job\.id/, 'new images must record their variant root');
assert.match(source, /function storyboardRedrawRecord[\s\S]*job\.variantRootId = storyboardGalleryGroupId\(record\)/, 'redraws must append variants instead of replacing the original');
assert.match(source, /function renderStoryboardGallery[\s\S]*sd-media-library-shell[\s\S]*sd-storyboard-stack-count/, 'gallery must use the media-library shell and preserve variant counts');
assert.match(source, /sd-storyboard-gallery-new-folder[\s\S]*sd-media-collection-rename[\s\S]*sd-media-collection-delete/, 'collections need create, rename, and dissolve controls');
assert.match(source, /sd-storyboard-gallery-move-selected[\s\S]*storyboardAssignCollectionIds\(record, collectionId \? \[\.\.\.storyboardItemCollectionIds\(record\), collectionId\] : \[\]\)/, 'multi-select must add or clear collection membership');
assert.match(source, /chat: \{ images: records, collections: clone\(storyboardGalleryCollections\(\)\)/, 'storyboard exports must include media collections');
assert.match(source, /store\.storyboardCollections = storyboardMergeById/, 'cross-device imports must restore collections');
assert.match(source, /data-storyboard-chat-action="redraw"/, 'redraw remains an inline chat action');
assert.match(source, /data-storyboard-chat-action="artist"/, 'artist replacement remains an inline chat action');
assert.match(source, /sd-storyboard-lightbox-delete[\s\S]*store\.storyboardImages = storyboardGalleryRecords\(\)\.filter/, 'individual variants remain deletable');
assert.match(css, /\.sd-media-library-main \.sd-storyboard-gallery \{ columns: 2 180px/, 'gallery must keep a responsive waterfall inside the library');
assert.match(css, /\.sd-storyboard-gallery-card\.is-stack::before[\s\S]*\.sd-storyboard-gallery-card\.is-stack::after/, 'variant groups must retain their stack treatment');
assert.match(css, /\.sd-storyboard-lightbox-detail[\s\S]*overflow: auto/, 'mobile details must scroll independently');

console.log('Storyboard gallery and media-library contract OK');
