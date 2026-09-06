// Lazy current-connection management. Never sends model keys or contacts Comfy.
const endpoint = '/api/plugins/qianmu-tts/image/comfy/targets';
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const normalize = value => new URL(String(value || '').trim()).toString().replace(/\/+$/, '');
async function readText(response) {
  const limit = 128 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('可信连接返回过大'); }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('可信连接返回过大'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
export async function requestComfyTargets({ action, headers = () => ({}), fetchImpl = fetch, signal } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(endpoint, { method: action ? 'POST' : 'GET', headers: { ...headers(), 'Content-Type': 'application/json' },
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: combined, ...(action ? { body: JSON.stringify(action) } : {}) });
    if (response.status === 404) throw new Error('请同步更新增强服务并重启 ST 后管理可信连接');
    const text = await readText(response);
    let data; try { data = JSON.parse(text); } catch (_) { throw new Error('可信连接服务返回无效，请核对增强服务'); }
    if (!response.ok || data.ok !== true) throw new Error(String(data.message || '可信连接操作失败').slice(0, 300));
    if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || typeof data.admin !== 'boolean' || !Array.isArray(data.targets) || data.targets.length > 64) throw new Error('可信连接服务版本不兼容');
    if (data.targets.some(row => !row || !/^[a-f0-9]{64}$/.test(row.id || '') || typeof row.name !== 'string' || row.name.length > 80
      || typeof row.baseUrl !== 'string' || row.baseUrl.length > 2048 || typeof row.shared !== 'boolean' || typeof row.allowPrivateNetwork !== 'boolean')) throw new Error('可信连接记录格式无效');
    return data;
  } finally { clearTimeout(timer); }
}

export async function requireTrustedComfyConnection(connection, options = {}) {
  const baseUrl = normalize(connection.baseUrl), privateNetwork = connection.options?.allowPrivateNetwork === true;
  const data = await requestComfyTargets(options);
  options.assertCurrent?.();
  if (!data.targets.some(row => row.baseUrl === baseUrl && row.allowPrivateNetwork === privateNetwork)) throw new Error('请先在 Comfy 连接设置的“ST 可信连接”中由管理员登记此地址');
  return data;
}

export function mountComfyTargets(container, { connection, headers, resolveNamespace, isCurrent = () => true, confirm = async () => false, notify = () => {}, fetchImpl } = {}) {
  const controller = new AbortController(); let current, busy = false, disposed = false, draft;
  let namespace;
  const active = () => !disposed && container.isConnected && isCurrent();
  const baseUrl = normalize(connection.baseUrl), allowPrivateNetwork = connection.options?.allowPrivateNetwork === true;
  const options = { headers, fetchImpl, signal: controller.signal };
  const rowFor = () => current?.targets.find(row => row.baseUrl === baseUrl && row.allowPrivateNetwork === allowPrivateNetwork);
  const authorize = async () => {
    if (typeof resolveNamespace !== 'function') throw new Error('暂未确认 ST 账户，请重新打开连接管理');
    const value = await resolveNamespace();
    if (!active()) throw new Error('页面已切换');
    if (typeof value !== 'string' || !value) throw new Error('暂未确认 ST 账户');
    if (namespace && value !== namespace) { namespace = value; current = null; draft = null; throw new Error('ST 账户已切换，请刷新可信连接'); }
    namespace = value;
  };
  const render = (error = '') => {
    if (!active()) return;
    const selected = rowFor(), disabled = busy ? 'disabled' : '';
    container.innerHTML = `<div class="sd-comfy-target-tools"><span>${selected ? '此连接已登记' : '此连接尚未登记'}</span><button type="button" class="sd-btn" data-comfy-target-action="refresh" ${disabled}>刷新</button></div>
      ${error ? `<p role="status">${escape(error)}</p>` : ''}
      <p class="sd-comfy-target-address">${escape(baseUrl)}</p>
      ${current?.admin ? `<label><span>连接名</span><input class="text_pole" data-comfy-target-name maxlength="80" value="${escape(draft?.name ?? selected?.name ?? '')}" ${disabled}></label>
      <label class="sd-comfy-target-share"><input type="checkbox" data-comfy-target-shared ${(draft?.shared ?? selected?.shared) ? 'checked' : ''} ${allowPrivateNetwork || busy ? 'disabled' : ''}><span>允许其他 ST 账户使用此地址</span></label>
      <button type="button" class="sd-btn" data-comfy-target-action="trust" ${disabled}>${selected ? '更新信任设置' : '信任此连接'}</button>
      <div class="sd-comfy-target-list">${current.targets.map(row => `<div><span><b>${escape(row.name || row.baseUrl)}</b><small>${escape(row.baseUrl)} · ${row.shared ? '已共享' : '仅管理员'}</small></span><button type="button" class="sd-btn" data-comfy-target-action="revoke" data-comfy-target-id="${escape(row.id)}" ${disabled}>撤销</button></div>`).join('')}</div>`
      : current ? '<p>请由 ST 管理员登记；这里不保存或共享 API Key。</p>' : ''}`;
  };
  const run = async action => {
    if (busy || !active()) return; if (action?.action === 'trust') draft = { name: action.name, shared: action.shared }; busy = true; render();
    try {
      await authorize();
      const data = await requestComfyTargets({ ...options, action });
      await authorize();
      if (!active()) return; current = data; draft = null;
      if (action) notify(action.action === 'trust' ? '可信连接已保存，不包含 API Key' : '信任已撤销；云端原任务可能仍在运行');
    } catch (error) { if (active()) { busy = false; render(error.message); return; } }
    finally { busy = false; }
    render();
  };
  const click = async event => {
    const button = event.target.closest('[data-comfy-target-action]'); if (!button || !container.contains(button) || busy || !active()) return;
    const action = button.dataset.comfyTargetAction;
    if (action === 'refresh') return run();
    if (!current?.admin) return;
    const expectedRevision = current.revision;
    if (action === 'trust') return run({ action, expectedRevision, baseUrl, allowPrivateNetwork,
      name: container.querySelector('[data-comfy-target-name]').value, shared: container.querySelector('[data-comfy-target-shared]').checked });
    if (action === 'revoke') {
      const id = button.dataset.comfyTargetId; let confirmed = false;
      busy = true; render();
      try { confirmed = await confirm('撤销可信连接', '将停止此地址的后续 ST 请求；已受理的云端任务不会因此取消。'); } catch (_) { /* Closing a host popup is cancellation. */ }
      finally { busy = false; render(); }
      if (confirmed && active() && current?.revision === expectedRevision) return run({ action, expectedRevision, id });
    }
  };
  container.addEventListener('click', click); void run();
  return () => { disposed = true; controller.abort(); container.removeEventListener('click', click); };
}
