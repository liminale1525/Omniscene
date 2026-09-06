import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import {
  QIANMU_CURRENT_FA_ICON_COUNT,
  QIANMU_FA_ICON_MAP,
  QIANMU_ICON_SYSTEM_NAME,
  QIANMU_ICON_SYSTEM_VERSION,
  QIANMU_INLINE_GLYPH_COUNT,
  QIANMU_SEMANTIC_ICONS,
  applyQianmuIcons,
  qianmuIconMarkup,
  refreshQianmuIcon,
  resolveQianmuIcon,
} from '../qianmu-icon-renderer.js';

const rootUrl = new URL('../', import.meta.url);
const rendererSource = await readFile(new URL('qianmu-icon-renderer.js', rootUrl), 'utf8');
const indexSource = await readFile(new URL('index.js', rootUrl), 'utf8');
const styleSource = await readFile(new URL('style.css', rootUrl), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', rootUrl), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('package.json', rootUrl), 'utf8'));
const thirdPartyNotices = await readFile(new URL('THIRD_PARTY_NOTICES.md', rootUrl), 'utf8');

const faUtilityClasses = new Set(['fa-brands', 'fa-regular', 'fa-solid', 'fa-spin', 'fa-xs']);
const currentFaNames = [...new Set(
  [...indexSource.matchAll(/\bfa-[a-z0-9-]+\b/g)]
    .map((match) => match[0])
    .filter((name) => !faUtilityClasses.has(name)),
)].sort();

assert.equal(QIANMU_ICON_SYSTEM_NAME, 'Lucide · 千幕 2.25');
assert.equal(QIANMU_ICON_SYSTEM_VERSION, 'lucide-1.39.0');
assert.ok(QIANMU_INLINE_GLYPH_COUNT >= 120, 'Lucide 本地子集应覆盖语义入口与高频工具');
assert.equal(currentFaNames.length, 134);
assert.equal(QIANMU_CURRENT_FA_ICON_COUNT, currentFaNames.length);
assert.deepEqual(Object.keys(QIANMU_FA_ICON_MAP).sort(), currentFaNames, '所有实际使用的 FA 类名必须有确定语义');

const glyphBody = (markup) => String(markup).match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1] || '';
const fallbackGlyph = glyphBody(qianmuIconMarkup('qm-unknown-glyph'));
for (const name of currentFaNames) {
  assert.ok(resolveQianmuIcon(name), `${name} 缺少解析结果`);
  const markup = qianmuIconMarkup(name);
  assert.match(markup, /<svg class="qm-glyph-svg"/);
  assert.doesNotMatch(markup, /<use\b|https?:|\.svg#/i, `${name} 不得发起图标资源请求`);
  assert.notEqual(glyphBody(markup), fallbackGlyph, `${name} 不得退回无语义占位图形`);
}

const semanticSymbols = Object.values(QIANMU_SEMANTIC_ICONS);
assert.equal(Object.keys(QIANMU_SEMANTIC_ICONS).length, 16);
assert.equal(new Set(semanticSymbols).size, 16, '顶层语义图标不得复用同一签名');
for (const [semantic, symbol] of Object.entries(QIANMU_SEMANTIC_ICONS)) {
  assert.equal(resolveQianmuIcon(semantic), symbol);
  assert.match(symbol, /^qm-signature-/);
  assert.match(qianmuIconMarkup(semantic), /<path|<circle|<rect/);
}

assert.doesNotMatch(rendererSource, /new URL\(|fetch\(|XMLHttpRequest|<use\b|xlink:href/i, '图标渲染器不得依赖任何二次资源请求');
assert.match(rendererSource, /LUCIDE_STROKE_WIDTH = 2\.25/);
assert.doesNotMatch(rendererSource, /stroke-width=['"](?:1\.65|2)['"]/, '千幕图标不得退回旧描边粗细');
assert.doesNotMatch(rendererSource, /\bMutationObserver\b/);
assert.doesNotMatch(
  rendererSource,
  /(?:globalThis\.)?document\s*\.\s*(?:querySelector(?:All)?|getElementsBy(?:ClassName|TagName)|body\b)/,
  '图标渲染器不得扫描整页',
);
assert.match(styleSource, /\.qm-glyph-icon > svg\.qm-glyph-svg/);
assert.doesNotMatch(styleSource, /qm-phosphor-spin/);
await assert.rejects(access(new URL('assets/qianmu-phosphor-v1454.svg', rootUrl)));
await assert.rejects(access(new URL('assets/PHOSPHOR-LICENSE.txt', rootUrl)));
assert.match(thirdPartyNotices, /Lucide Static `1\.39\.0`/);
assert.match(thirdPartyNotices, /ISC License[\s\S]*Lucide Icons and Contributors/);

assert.equal(manifest.version, '1.59.70');
assert.equal(packageJson.version, manifest.version);
assert.equal(manifest.js, `index.js?v=${manifest.version}`);
assert.equal(manifest.css, `style.css?v=${manifest.version}`);
assert.match(indexSource, /from '\.\/qianmu-icon-renderer\.js\?v=1\.59\.70';/);

class FakeClassList {
  constructor(host, initial = '') { this.host = host; this.set(initial); }
  set(value) { this.names = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  add(...names) {
    let changed = false;
    for (const name of names) if (name && !this.names.has(name)) { this.names.add(name); changed = true; }
    if (changed && this.host.stats) this.host.stats.writes += 1;
  }
  remove(...names) {
    let changed = false;
    for (const name of names) changed = this.names.delete(name) || changed;
    if (changed && this.host.stats) this.host.stats.writes += 1;
  }
  contains(name) { return this.names.has(name); }
  toString() { return [...this.names].join(' '); }
}

function selectorParts(selector) { return String(selector || '').split(',').map((part) => part.trim()).filter(Boolean); }

class FakeElement {
  constructor(tagName = 'div', options = {}) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.id = options.id || '';
    this.attributes = new Map(Object.entries(options.attributes || {}));
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = options.ownerDocument || null;
    this.stats = options.stats || this.ownerDocument?.stats || null;
    this.classList = new FakeClassList(this, options.className || '');
    this._innerHTML = '';
  }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set(value); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    const next = String(value || '');
    if (this._innerHTML === next) return;
    this._innerHTML = next;
    if (this.stats) this.stats.writes += 1;
  }
  appendChild(child) {
    child.parentElement = this;
    child.ownerDocument ||= this.ownerDocument;
    child.stats ||= this.stats;
    this.children.push(child);
    if (this.stats) this.stats.writes += 1;
    return child;
  }
  setAttribute(name, value) {
    const key = String(name), next = String(value);
    if (this.attributes.get(key) === next) return;
    this.attributes.set(key, next);
    if (this.stats) this.stats.writes += 1;
  }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  removeAttribute(name) {
    if (this.attributes.delete(String(name)) && this.stats) this.stats.writes += 1;
  }
  matches(selector) { return selectorParts(selector).some((part) => this.matchesOne(part)); }
  matchesOne(selector) {
    if (selector === 'svg.qm-glyph-svg') return this.tagName === 'SVG' && this.classList.contains('qm-glyph-svg');
    if (selector === 'svg.qm-phosphor-svg') return this.tagName === 'SVG' && this.classList.contains('qm-phosphor-svg');
    if (selector === 'i[class*="fa-"]') return this.tagName === 'I' && [...this.classList.names].some((name) => name.startsWith('fa-'));
    if (/^#[a-z0-9_-]+$/i.test(selector)) return this.id === selector.slice(1);
    if (/^\.[a-z0-9_-]+$/i.test(selector)) return this.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[([a-z0-9_-]+)\]$/i);
    return attribute ? this.attributes.has(attribute[1]) : false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    if (this.stats) this.stats.queries += 1;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) { if (child.matches(selector)) matches.push(child); visit(child); }
    };
    visit(this);
    return matches;
  }
}

class FakeDocument {
  constructor(stats = { queries: 0, writes: 0 }) {
    this.nodeType = 9;
    this.stats = stats;
    this.body = new FakeElement('body', { ownerDocument: this, stats });
  }
  createElementNS(_namespace, tagName) { return new FakeElement(tagName, { ownerDocument: this, stats: this.stats }); }
}

function makeOwnedRoot(id = 'story-director-modal') {
  const stats = { queries: 0, writes: 0 };
  const document = new FakeDocument(stats);
  const root = new FakeElement('section', { id, ownerDocument: document, stats });
  return { document, root, stats };
}

assert.equal(applyQianmuIcons(), 0);
const local = makeOwnedRoot();
const camera = local.root.appendChild(new FakeElement('i', { className: 'fa-solid fa-camera', ownerDocument: local.document, stats: local.stats }));
assert.equal(applyQianmuIcons(local.root), 1);
assert.equal(camera.getAttribute('data-qm-glyph'), 'qm-duotone-camera');
assert.ok(camera.classList.contains('qm-glyph-icon'));
assert.equal(camera.children.length, 1);
assert.ok(camera.children[0].classList.contains('qm-glyph-svg'));
assert.match(camera.children[0].innerHTML, /<path|<circle/);
assert.doesNotMatch(camera.children[0].innerHTML, /<use\b/);

const firstSvg = camera.children[0];
const writesAfterFirstApply = local.stats.writes;
assert.equal(applyQianmuIcons(local.root), 1);
assert.equal(camera.children[0], firstSvg);
assert.equal(local.stats.writes, writesAfterFirstApply, '重复渲染应保持零 DOM 写入');

camera.className = 'fa-solid fa-play qm-glyph-icon';
assert.equal(refreshQianmuIcon(camera), true);
assert.equal(camera.children[0], firstSvg);
assert.equal(camera.getAttribute('data-qm-glyph'), 'qm-fill-play');
const playGlyph = firstSvg.innerHTML;
assert.match(playGlyph, /<path|<polygon/);
camera.className = 'fa-solid fa-pause qm-glyph-icon';
assert.equal(refreshQianmuIcon(camera), true);
assert.equal(camera.children[0], firstSvg);
assert.equal(camera.getAttribute('data-qm-glyph'), 'qm-fill-pause');
assert.match(firstSvg.innerHTML, /<path|<rect/);
assert.notEqual(firstSvg.innerHTML, playGlyph);

const external = makeOwnedRoot('story-director-quick-wheel');
const boundary = external.root.appendChild(new FakeElement('span', { className: 'sd-preserve-external-icon', ownerDocument: external.document, stats: external.stats }));
const externalIcon = boundary.appendChild(new FakeElement('i', { className: 'fa-solid fa-camera', ownerDocument: external.document, stats: external.stats }));
assert.equal(applyQianmuIcons(external.root), 0);
assert.equal(externalIcon.children.length, 0);

const outside = new FakeElement('section', { ownerDocument: local.document, stats: local.stats });
outside.appendChild(new FakeElement('i', { className: 'fa-solid fa-camera', ownerDocument: local.document, stats: local.stats }));
assert.equal(applyQianmuIcons(outside), 0);

const largeStats = { queries: 0, writes: 0 };
const largeDocument = new FakeDocument(largeStats);
for (let index = 0; index < 10_000; index += 1) {
  largeDocument.body.appendChild(new FakeElement('i', { className: index % 2 ? 'fa-solid fa-camera' : 'third-party-node', ownerDocument: largeDocument, stats: largeStats }));
}
assert.equal(applyQianmuIcons(largeDocument), 0);
assert.equal(applyQianmuIcons(largeDocument.body), 0);
assert.equal(largeStats.queries, 0, '拒绝 document/body 时不得执行全页查询');

console.log('Lucide local icon boundary and coverage contract OK');
