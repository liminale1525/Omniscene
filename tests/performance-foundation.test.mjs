import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /const performanceRuntime = \{[\s\S]*modalRenderCount:[\s\S]*slowModalRenderCount:[\s\S]*rendersByTab:/, 'runtime measurements must stay in an in-memory envelope');
assert.match(source, /function renderModal\([\s\S]*renderStartedAt[\s\S]*modalRenderTotalMs \+= renderMs[\s\S]*lastNodeCount/, 'modal rendering must record time and node count');
assert.match(source, /function runtimeHealthSnapshot\([\s\S]*settingsBytes[\s\S]*chatBytes[\s\S]*observers[\s\S]*timers/, 'health snapshot must cover data size and active background work');
assert.match(source, /数据只保留在本次页面，不写入日志或用户设置/, 'diagnostics must explicitly remain session-only');
assert.match(source, /if \(f\.status !== 'running'\) return;[\s\S]*setInterval\(focusClockRuntimeTick, 500\)/, 'the focus clock must not poll while idle or paused');
assert.doesNotMatch(source, /^import[^\n]*qianmu-image-direct/m, 'image provider transports must stay outside the startup module graph');
assert.match(source, /createFeatureRuntime\(\{[\s\S]*imageDirect:[\s\S]*import\('\.\/qianmu-image-direct\.js\?v=1\.59\.70'\)[\s\S]*featureRuntime\.load\('imageDirect'\)/, 'the direct image runtime must enter the shared on-demand feature boundary');
assert.match(source, /optionalService:[\s\S]*import\('\.\/qianmu-service-capabilities\.js\?v=1\.59\.70'\)/, 'optional backend capability checks must stay outside the startup graph');
assert.doesNotMatch(source, /^import .*\.\/builtin-theaters\.js/m, 'large built-in theater catalogs must stay outside the startup graph');
assert.doesNotMatch(source, /^import .*\.\/qianmu-theaters\.js/m, 'large Qianmu theater catalogs must stay outside the startup graph');
assert.match(source, /theaterCatalog:[\s\S]*Promise\.all\([\s\S]*import\('\.\/builtin-theaters\.js\?v=1\.59\.70'\)[\s\S]*import\('\.\/qianmu-theaters\.js\?v=1\.59\.70'\)/, 'both managed theater catalogs must share one on-demand feature boundary');
assert.match(source, /function renderTheaterTab\(\)[\s\S]*ensureTheaterCatalog\(\)[\s\S]*sd-theater-catalog-retry/, 'the theater page must load its catalog on first entry and expose retry after a failed chunk');
const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
assert.doesNotMatch(initSource, /seedBuiltinTheaters\(\)/, 'startup must not parse or seed theater catalogs before the feature is opened');
assert.doesNotMatch(initSource, /hydrateNotesRuntime\(\)/, 'startup must not scan all pinned notes before the notes workspace is opened');
assert.match(source, /function openNotesPanel\(\)[\s\S]*renderNotesPanelPortal\(\)[\s\S]*hydrateNotesRuntime\(\)/, 'the independent notes entry must hydrate its IndexedDB records on first use');
assert.match(source, /function runtimeHealthSnapshot\(\)[\s\S]*featureRuntime\.snapshot\(\)[\s\S]*lazyFeatures/, 'session diagnostics must expose feature chunk state without persisting it');
assert.match(source, /function inputMenuObservationRoot\(\)[\s\S]*return sendForm \|\| menu\?\.parentElement \|\| document\.body/, 'the input entry observer must prefer the narrow input-shell boundary');
assert.match(source, /inputMenuObserverTarget = target;[\s\S]*inputMenuObserver\.observe\(target, \{ childList: true, subtree: true \}\)/, 'the input entry observer must not remain hard-wired to the entire document body');
assert.match(source, /storyboardCheckConnection[\s\S]*await directImageRuntime\(\)[\s\S]*directImage\.checkDirectImageConnection/, 'connection tests must enter the lazy image boundary');
assert.match(source, /storyboardRunJob[\s\S]*await directImageRuntime\(\)[\s\S]*directImage\.generateDirectImage/, 'generation jobs must enter the lazy image boundary');
assert.match(styles, /\.sd-runtime-health-grid[\s\S]*grid-template-columns: repeat\(2/, 'desktop diagnostics need a compact two-column layout');
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.sd-runtime-health-grid \{ grid-template-columns: minmax\(0, 1fr\)/, 'mobile diagnostics must collapse to one column');

console.log('Performance foundation contract OK');
