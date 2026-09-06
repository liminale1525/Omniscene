// Real form renderers with isolated state; no ST globals, credentials, generation or persistence.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storyboard from '../../qianmu-storyboard.js';
import { normalizeOpenAIImageCompatibility, serializeOpenAICompatibleHeaders } from '../../qianmu-openai-image-compat.js';

const source = await readFile(new URL('../../index.js', import.meta.url), 'utf8');
export function storyboardFunctionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  if (!match) throw new Error(`Missing renderer: ${name}`);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

export function createStoryboardFormFixture({ family = 'novel', enabled = true, workflow = '' } = {}) {
  const state = storyboard.createStoryboardDefaults();
  state.source = family; state.enabled = enabled;
  if (family === 'comfy') state.profiles.comfy.comfyWorkflow = typeof workflow === 'string' ? workflow : JSON.stringify(workflow);
  for (const key of ['model', 'context', 'params', 'prompt', 'composition']) state.collapsedCards[key] = false;
  const globals = {
    ...storyboard, normalizeOpenAIImageCompatibility, serializeOpenAICompatibleHeaders,
    settings: { apiProfiles: [] }, clone: structuredClone, uid: (() => { let id = 0; return () => `fixture-${++id}`; })(),
    htmlEscape: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    storyboardState: () => state, storyboardConnectionStatus: new Map(), storyboardDraftApiKeys: new Map(),
    storyboardSelectedArtistPreset: () => null, storyboardGalleryRecords: () => [], storyboardSafeUrl: () => '',
    STORYBOARD_NAI_QUALITY_DEFAULTS: {}, STORYBOARD_NAI_NEGATIVE_DEFAULTS: {}, STORYBOARD_GENERIC_PROMPT_DEFAULTS: { positive: '', negative: '' },
    storyboardCompilerTagRules: () => [{ name: 'think', action: 'remove' }, { name: 'thinking', action: 'remove' }],
    // Omit unrelated external data panels; form markup and all control styles remain production code.
    renderStoryboardProductionSources: () => '', renderStoryboardWorldbookCard: () => '', renderStoryboardQueue: () => '',
  };
  const context = vm.createContext(globals);
  const names = ['storyboardConnectionState', 'storyboardProviderProfile', 'renderStoryboardModelPicker', 'storyboardCompilerProfileOptions',
    'renderStoryboardModelCard', 'renderStoryboardAutomationCard', 'renderStoryboardContextCard', 'renderStoryboardCompilerContextPanel',
    'storyboardPromptDefaultsKey', 'storyboardProviderPromptDefaults', 'storyboardPromptLayerForArtist', 'storyboardParameterPresets',
    'renderStoryboardParameterPresets', 'renderStoryboardParameterVibes', 'renderStoryboardCompositionCard', 'renderStoryboardOpenAICompatibility',
    'renderStoryboardCreate', 'renderStoryboardNav'];
  vm.runInContext(names.map(storyboardFunctionSource).join('\n'), context);
  return { state, content: context.renderStoryboardCreate(state), nav: context.renderStoryboardNav(state) };
}
