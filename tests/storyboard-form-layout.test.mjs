import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStoryboardFormFixture } from './helpers/storyboard-form-fixture.mjs';

const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const rule = selector => {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `Missing scoped rule: ${selector}`);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
};

test('actual automation renderer keeps an accessible native switch for both saved states', () => {
  for (const enabled of [false, true]) {
    const {content} = createStoryboardFormFixture({enabled});
    const input = content.match(/<input[^>]+class="sd-storyboard-enabled"[^>]*>/)?.[0];
    assert.ok(input); assert.match(input, /type="checkbox"/); assert.match(input, /role="switch"/);
    assert.match(input, /aria-label="启用分镜"/);
    assert.equal(/\bchecked\b/.test(input), enabled); assert.doesNotMatch(input, /\bdisabled\b/);
    for (const name of ['auto-capture','auto-generate','world-side']) {
      const option = content.match(new RegExp(`<input[^>]+class="sd-storyboard-${name}"[^>]*>`))?.[0];
      assert.ok(option); assert.equal(/\bdisabled\b/.test(option), !enabled);
    }
  }
});

test('model-interface forms keep one family selector and a complete model/pull row', () => {
  for (const family of ['novel','openai','banana','seedream']) {
    const {content} = createStoryboardFormFixture({family});
    assert.equal((content.match(/class="text_pole sd-storyboard-provider"/g) || []).length, 1);
    assert.match(content, /sd-storyboard-model-field"><span>模型<\/span>/);
    assert.match(content, /sd-model-picker-input-row/); assert.match(content, /aria-label="拉取模型"/);
    assert.match(content, /sd-storyboard-key-field/);
  }
  const {content}=createStoryboardFormFixture({family:'comfy'});
  assert.doesNotMatch(content,/sd-storyboard-provider|sd-storyboard-model-field|sd-model-picker-input-row/);
  assert.match(content,/sd-storyboard-key-field/);assert.match(content,/sd-comfy-workbench/);
});

test('switch has one non-shrinking compact track and isolates the hidden input from modal checkbox rules', () => {
  const input = rule('#story-director-modal#story-director-modal .sd-storyboard-capsule-switch > input');
  assert.match(input, /position:\s*absolute !important/); assert.match(input, /clip-path:\s*inset\(50%\)/);
  const track = rule('#story-director-modal .sd-storyboard-capsule-switch > span');
  assert.match(track, /flex:\s*0 0 40px/); assert.match(track, /height:\s*22px/); assert.match(track, /position:\s*relative/);
  const thumb = rule('#story-director-modal .sd-storyboard-capsule-switch input:checked + span::before');
  assert.match(thumb, /translateX\(18px\)/);
  assert.match(css, /\.sd-storyboard-capsule-switch input:focus-visible \+ span/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*#story-director-modal \.sd-storyboard-capsule-switch/);
  assert.doesNotMatch(css, /\.sd-storyboard-capsule-switch span\s*\{/);
});

test('field caption baseline excludes decorative tracks and keeps paired model fields top-aligned', () => {
  assert.match(rule('#story-director-modal .sd-storyboard-model-picker'), /align-items:\s*start/);
  assert.match(css, /label:has\(> :is\(input.text_pole, select.text_pole, textarea.text_pole\)\)\s*\{\s*margin:\s*0 !important/);
  assert.match(css, /label:not\(\.sd-option-chip\):not\(\.sd-storyboard-capsule-switch\)/);
  assert.match(css, /\.sd-storyboard-model-picker > label > span, \.sd-storyboard-model-field > span/);
  assert.match(css, /\.sd-storyboard-root \{[^}]*text-align:\s*left/);
  assert.doesNotMatch(css, /:is\(label, label > span, label > b, \.sd-storyboard-field-label\)/);
});
