import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const styles = await readFile(new URL('style.css', root), 'utf8');
const source = await readFile(new URL('index.js', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

assert.equal(manifest.version, '1.59.29');
assert.match(styles, /v1\.58\.6 · 千幕视觉基线/);
assert.match(styles, /--qm-type-page-title: 20px[\s\S]*--qm-type-card-title: 14px[\s\S]*--qm-type-body: 13px/);
assert.match(styles, /--qm-type-caption: 11px[\s\S]*--qm-control-height: 38px[\s\S]*--qm-control-radius: 10px/);
assert.match(styles, /input::placeholder,[\s\S]*textarea::placeholder[\s\S]*font-size: var\(--qm-type-label\)/);
assert.match(styles, /\.sd-icon-btn \.qm-glyph-icon[\s\S]*width: var\(--qm-icon-size\) !important/);
assert.match(styles, /#story-director-modal button,[\s\S]*border-radius: var\(--qm-button-radius\) !important/);
assert.match(styles, /\.sd-storyboard-root \{[\s\S]*grid-template-rows: 42px minmax\(0, 1fr\) 38px !important/);
assert.match(styles, /\.sd-storyboard-nav \{[\s\S]*margin: 0 !important[\s\S]*border-radius: 0 !important[\s\S]*box-shadow: none !important/);
assert.match(styles, /#sd-reader-portal,[\s\S]*\.sd-reader-portal \{[\s\S]*font-size: 14px/);
assert.doesNotMatch(styles, /min-font-size:/, 'the visual foundation must only use valid CSS properties');

assert.match(source, /new URL\('\.\/qianmulogo\.png', import\.meta\.url\)/, 'the main logo must remain bundled with the extension');
assert.doesNotMatch(source, /https?:[^'"`]*(?:fontawesome|cloudflare|jsdelivr|unpkg)/i, 'icons must never depend on an external CDN');
await assert.rejects(access(new URL('assets/fontawesome-pro', root)), 'commercial icon sources must not be published without a redistribution grant');

console.log('V1.58.6 visual system contract OK');
