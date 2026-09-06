import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('index.js', root), 'utf8');
const styles = await readFile(new URL('style.css', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

assert.equal(manifest.version, '1.59.50');
assert.match(styles, /v1\.58\.13 · 精调视觉标尺与独立便笺工作层/);
assert.match(styles, /--qm-type-card-title: 13px;[\s\S]*--qm-type-body: 12px;[\s\S]*--qm-type-label: 11px;[\s\S]*--qm-control-height: 30px;/, 'visual hierarchy must use the refined compact scale');
assert.match(styles, /\.sd-tabs button \{ font-size: 13\.5px !important; \}/, 'main tabs must gain one visual step');
assert.match(styles, /\.sd-card h3,[\s\S]*font-size: var\(--qm-type-card-title\) !important/, 'card titles must share one source of truth');
assert.match(styles, /input:not\([\s\S]*height: var\(--qm-control-height\);[\s\S]*font-size: 12px !important/, 'long input controls must use the compact height and body type');
assert.match(styles, /button:not\(\.sd-backdrop\):not\(\.sd-world-edge\) \{ border-radius: 9px !important; \}/, 'ordinary buttons must be rounded rectangles rather than circles');
assert.match(styles, /\.sd-storyboard-shortcut :is\(i, \.qm-glyph-icon\)[\s\S]*width: 20px !important;[\s\S]*scale\(1\.08\)/, 'the optically small storyboard camera must be enlarged');

const header = source.slice(source.indexOf('<header class="sd-header">'), source.indexOf('<nav class="sd-tabs">'));
assert.ok(header.indexOf('<h2>${EXTENSION_NAME}</h2>') < header.indexOf('一蝶振翅'), 'legacy title and version row must come before the slogan');
assert.match(header, /qianmuVersionBadgeMarkup\(\)/, 'the header must render the real update-state badge');
assert.doesNotMatch(header, /sd-version-new-dot|sd-version-line/, 'the crowded green-dot layout must be removed');
assert.match(source, /qianmuInstalledExtensionScope[\s\S]*fetch\('\/api\/extensions\/discover'/, 'NEW must resolve local and global extension installations through SillyTavern');
assert.match(source, /fetch\('\/api\/extensions\/version'[\s\S]*data\?\.isUpToDate === false/, 'NEW must be driven by SillyTavern remote repository status');
assert.match(source, /const scopes = resolvedScope == null \? \[false, true\] : \[resolvedScope, !resolvedScope\]/, 'version probing must retry the alternate install scope after a stale discovery result');
assert.match(source, /const label = hasUpdate \? 'NEW' : `v\$\{VERSION\}`/, 'the badge must return to the installed version whenever no remote update exists');
assert.match(styles, /\.sd-version-tag\.is-update-available[\s\S]*animation: sd-version-new-breathe/, 'NEW must use a restrained breathing state');
assert.match(styles, /\.sd-header-actions :is\(\.sd-coread-shortcut,[\s\S]*width: 20px !important;/, 'all top-row glyphs must match the storyboard icon optical size');
assert.match(styles, /#qianmu-storage-cleanup-layer \{[\s\S]*height: 100dvh !important;[\s\S]*transform: none !important;/, 'the cleanup chooser must remain centered in the mobile viewport');

assert.match(source, /<h3>小组件<\/h3>[\s\S]*>悬浮球<\/span>[\s\S]*>便笺<\/span>[\s\S]*>快捷盘<\/span>[\s\S]*>蜂巢收纳<\/span>/, 'widget controls must use one active-label row');
assert.match(source, /sd-focus-reset"><i class="fa-solid fa-arrow-rotate-left"><\/i>/, 'focus reset must carry the local reset icon');
assert.match(styles, /\.sd-focus-sound-preview \{[^}]*border-radius: 9px !important/, 'focus sound preview must use a square control');
assert.match(source, /dialogTipSeen: false[\s\S]*sd-reader-send-tip[\s\S]*长按邀请 AI 回应/, 'Coread must provide a one-time send gesture tip');
assert.match(styles, /#story-director-modal \.sd-storage-ios-bar \{ height: 36px; \}/, 'the storage visualization must use the taller readable bar');

const scopeStart = source.indexOf('async function qianmuInstalledExtensionScope');
const scopeEnd = source.indexOf('function qianmuVersionBadgeMarkup');
const scopeContext = vm.createContext({ fetch: null });
vm.runInContext(`${source.slice(scopeStart, scopeEnd)}\nglobalThis.resolveScope = qianmuInstalledExtensionScope;`, scopeContext);
scopeContext.fetch = async () => ({ ok: true, json: async () => [{ name: 'third-party/Omniscene', type: 'global' }] });
assert.equal(await scopeContext.resolveScope('Omniscene'), true, 'global installs must query the global extension directory');
scopeContext.fetch = async () => ({ ok: true, json: async () => [{ name: 'third-party/Omniscene', type: 'local' }] });
assert.equal(await scopeContext.resolveScope('Omniscene'), false, 'local installs must query the user extension directory');

console.log('V1.58.15 visual refinement contract OK');
