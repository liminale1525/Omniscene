import { finalizeModelList } from './qianmu-image-models.js';

// Per-control, short-lived catalog. No persistent model cache, credential keys or startup work.
export function createModelPickerSession({ provider, models, current, isCurrent, fetchModels, apply }) {
  let rows = finalizeModelList(provider, models, { source: 'builtin' }).models;
  let request = 0, loading = false;
  const known = new Set(models.map((item) => item.id));
  if (current.model && !rows.some((item) => item.id === current.model)) rows.unshift({ id: current.model, label: current.model });
  return {
    get loading() { return loading; },
    list(query = '') {
      const term = query.trim().toLocaleLowerCase();
      return rows.filter((item) => !term || `${item.id} ${item.label}`.toLocaleLowerCase().includes(term));
    },
    capability(id) { return known.has(id) ? id : id === current.model ? current.capabilityModelId || '' : ''; },
    known(id) { return known.has(id); },
    async load() {
      const epoch = ++request;
      loading = true;
      try {
        const result = await fetchModels();
        if (epoch !== request || !isCurrent()) return null;
        rows = finalizeModelList(provider, [...models, ...(result.models || [])], { source: result.source }).models;
        if (current.model && !rows.some((item) => item.id === current.model)) rows.unshift({ id: current.model, label: current.model });
        return { ...result, total: rows.length };
      } finally { if (epoch === request) loading = false; }
    },
    commit(id, capabilityModelId = '') {
      if (!isCurrent()) throw new Error('模型或连接已变化，请重新打开模型选择');
      const model = String(id || '').trim();
      if (!model || model.length > 240 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('请填写有效的完整模型 ID');
      const capability = known.has(model) ? model : capabilityModelId || this.capability(model);
      if (!capability || !known.has(capability)) throw new Error('请先选择该模型对应的参数能力');
      return apply({ remoteModelId: model, capabilityModelId: capability });
    },
    dispose() { request++; loading = false; rows = []; },
  };
}

export function attachModelPicker(host, options) {
  const doc = host.ownerDocument;
  const input = host.querySelector('[role="combobox"]');
  const panel = host.querySelector('.sd-model-picker-panel');
  const pull = host.querySelector('.sd-model-picker-pull');
  const session = createModelPickerSession(options);
  const events = new AbortController();
  let query = '', limit = 60, selected = -1, visible = [], notice = '', disposed = false;
  const create = (tag, className, text = '') => {
    const el = doc.createElement(tag); el.className = className; el.textContent = text;
    if (tag === 'button') el.type = 'button';
    return el;
  };
  const close = () => {
    panel.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    input.value = options.current.model; selected = -1; query = '';
  };
  const commit = (id, capability) => {
    try { session.commit(id, capability); close(); }
    catch (error) { notice = error.message; render(); }
  };
  const render = () => {
    if (disposed || !host.isConnected) return;
    input.removeAttribute('aria-activedescendant');
    panel.replaceChildren(); panel.hidden = false; input.setAttribute('aria-expanded', 'true');
    const all = session.list(query); visible = all.slice(0, limit);
    const list = create('div', 'sd-model-picker-list'); list.id = `${input.id}-list`; list.setAttribute('role', 'listbox');
    input.setAttribute('aria-controls', list.id);
    visible.forEach((item, i) => {
      const option = create('button', 'sd-model-picker-option');
      option.id = `${input.id}-option-${i}`; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(i === selected));
      option.append(create('span', '', item.label), create('small', '', item.id));
      option.addEventListener('click', () => {
        if (session.known(item.id) || session.capability(item.id)) commit(item.id, session.capability(item.id));
        else { input.value = item.id; query = item.id; selected = -1; render(); }
      });
      list.append(option);
    });
    panel.append(list);
    if (all.length > limit) {
      const more = create('button', 'sd-btn sd-model-picker-more', `显示更多（${visible.length}/${all.length}）`);
      more.addEventListener('click', () => { limit += 60; render(); }); panel.append(more);
    }
    const typed = input.value.trim();
    const action = create('div', 'sd-model-picker-apply-row');
    const capability = create('select', 'text_pole sd-model-picker-capability');
    capability.setAttribute('aria-label', '参数能力');
    const empty = create('option', '', '选择参数能力'); empty.value = ''; capability.append(empty);
    for (const item of options.models) { const option = create('option', '', item.label); option.value = item.id; capability.append(option); }
    capability.value = session.capability(typed);
    if (!session.known(typed)) action.append(capability);
    const save = create('button', 'sd-btn sd-primary', '使用模型');
    save.addEventListener('click', () => commit(typed, capability.value)); action.append(save); panel.append(action);
    const status = create('small', 'sd-model-picker-status', notice || (session.known(typed) ? '' : '只选择参数能力，不改写渠道的模型 ID。'));
    status.setAttribute('role', 'status'); panel.append(status);
  };
  input.addEventListener('focus', () => { query = ''; limit = 60; if (options.isCurrent()) render(); }, { signal: events.signal });
  input.addEventListener('input', () => { query = input.value; selected = -1; limit = 60; notice = ''; render(); }, { signal: events.signal });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      selected = Math.max(0, Math.min(visible.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
      render(); const option = panel.querySelector(`#${input.id}-option-${selected}`);
      if (option) { input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      const item = visible[selected];
      if (item && !session.known(item.id) && !session.capability(item.id)) { input.value = item.id; query = item.id; selected = -1; render(); }
      else commit(item?.id || input.value, panel.querySelector('select')?.value || '');
    }
  }, { signal: events.signal });
  host.addEventListener('focusout', (event) => { if (!host.contains(event.relatedTarget)) close(); }, { signal: events.signal });
  return {
    isCurrent: options.isCurrent,
    dispose() { disposed = true; events.abort(); session.dispose(); close(); },
    open: render,
    async fetch() {
      if (session.loading) return;
      pull.disabled = true; notice = '正在读取模型'; render();
      try {
        const result = await session.load();
        if (!result) { notice = '连接已变化，请重新打开模型选择'; return; }
        notice = result.source === 'builtin' ? '当前渠道提供内置目录' : result.source === 'disabled' ? '该连接已关闭模型列表探测' : `已读取 ${result.total} 个模型`;
        query = ''; limit = 60;
      } catch (error) { notice = options.errorMessage?.(error) || '模型列表暂不可用；仍可手动填写模型 ID'; }
      finally { if (!disposed && host.isConnected) { pull.disabled = false; if (!panel.hidden) render(); } }
    },
  };
}
