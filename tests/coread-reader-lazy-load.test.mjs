import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

assert.doesNotMatch(source, /^import[^\n]*qianmu-reader\.js/m, 'the companion parser must stay outside the startup module graph');
assert.match(source, /readerCore:\s*\{[\s\S]*import\('\.\/qianmu-reader\.js\?v=1\.59\.65'\)[\s\S]*reader = module/, 'the companion parser must load through the shared feature runtime');
assert.match(source, /function renderCoreadRuntimeGate\(\)[\s\S]*runtime\.status === 'idle'[\s\S]*ensureCoreadReaderRuntime\(\{ rerender: true \}\)[\s\S]*sd-coread-runtime-retry/, 'the companion page must load on first entry and expose an explicit retry state');
assert.match(source, /case 'coread': return COREAD_ENABLED \? \(reader \? renderCoreadTab\(\) : renderCoreadRuntimeGate\(\)\)/, 'the companion page must not render reader-dependent content before its parser is ready');
assert.match(source, /function bindCoreadTabEvents\(root\) \{[\s\S]*if \(!reader\) return;[\s\S]*bindLibraryViewEvents\(root\)/, 'the companion page must not bind reader-dependent actions before its parser is ready');

const mainlineStart = source.indexOf('async function coreadBuildMainlineInjection()');
const mainlineEnd = source.indexOf('\n}', mainlineStart);
const mainlineSource = source.slice(mainlineStart, mainlineEnd);
assert.ok(mainlineStart >= 0, 'mainline companion injection must exist');
assert.ok(mainlineSource.indexOf('if (!m.mainlineFeedback) return') < mainlineSource.indexOf('await ensureCoreadReaderRuntime()'), 'disabled mainline feedback must not load the parser');
assert.ok(mainlineSource.indexOf('await ensureCoreadReaderRuntime()') < mainlineSource.indexOf('await coreadMainlinePool()'), 'enabled mainline feedback must load the parser before reading slices');

const initStart = source.indexOf('function init()');
const initEnd = source.indexOf('function destroy()');
const initSource = source.slice(initStart, initEnd);
assert.doesNotMatch(initSource, /ensureCoreadReaderRuntime\(/, 'normal startup must not eagerly parse the companion module');

console.log('Companion reader lazy-load contract OK');
