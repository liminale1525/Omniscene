// Explicitly opened, metadata-only Comfy inbox. No background polling or media fetch.
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const size = value => { const bytes = Math.max(0, Number(value) || 0); return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`; };
const stateName = value => ({ prepared:'待核查', available:'待归档', archived:'已归档', confirmed:'已领取', succeeded:'已完成', failed:'失败', released:'未提交', rejected:'已拒绝', reserved:'等待', submitting:'执行中', uncertain:'待核查', acknowledged:'待核查', unverified:'待核查' })[value] || '待核查';
export function mountComfyInbox(host, { service, receive, isCurrent = () => host.isConnected } = {}) {
  let disposed = false, revision = 0, mode = 'server', page = 0, busy = false, local, server, localError = '', serverError = '', notice = '';
  const selected = new Set();
  const current = () => !disposed && isCurrent();
  const rows = () => mode === 'server' ? (server?.originals || []) : (local?.rows || []);
  const enabled = row => mode === 'local' || row.canDiscard === true;
  const key = row => `${row.taskLocator?.channelKey || ''}/${row.attemptId}`;
  function paint() {
    if (!current()) return;
    const all = rows(), pages = Math.max(1, Math.ceil(all.length / 40)); page = Math.min(page, pages - 1);
    const shown = all.slice(page * 40, page * 40 + 40), total = server?.totals || {};
    const storedBytes = (Number(total.imageBytes) || 0) + (Number(total.metadataBytes) || 0) + (Number(total.temporaryBytes) || 0);
    const error = mode === 'server' ? serverError : localError;
    host.innerHTML = `<section class="sd-comfy-inbox" aria-label="Comfy 收片管理" aria-busy="${busy}">
      <header><b>Comfy 收片</b><button type="button" class="sd-btn" data-action="refresh" ${busy ? 'disabled' : ''}>刷新</button></header>
      <div class="sd-comfy-inbox-modes"><button type="button" class="sd-btn ${mode === 'server' ? 'active' : ''}" aria-pressed="${mode === 'server'}" data-action="server">服务器暂存</button><button type="button" class="sd-btn ${mode === 'local' ? 'active' : ''}" aria-pressed="${mode === 'local'}" data-action="local">本机记录</button></div>
      <p class="sd-comfy-inbox-meter">${mode === 'server' ? `当前账户 · 暂存 ${size(storedBytes)} · 预留 ${size(total.reservedBytes)}` : `当前账户 · ${local?.rows?.length || 0} / 2048 条 · ${size(local?.bytes)} / 16 MB`}</p>
      ${mode === 'server' ? '<small>仅千幕 Comfy 暂存，不是 VPS 总磁盘；清理不删除阅片室图片或任务防重复记录。</small>' : '<small>仅本浏览器的领取位置与进度；清理不删除图片，不取消正在执行的任务。</small>'}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}${notice ? `<p role="status">${escape(notice)}</p>` : ''}
      <div class="sd-comfy-inbox-tools"><label><input type="checkbox" data-action="select-page" ${busy ? 'disabled' : ''} ${shown.length && shown.filter(enabled).length && shown.filter(enabled).slice(0,20).every(row => selected.has(key(row))) ? 'checked' : ''}>本页前 20 项</label><button type="button" class="sd-btn" data-action="clear" ${!selected.size || busy ? 'disabled' : ''}>清理已选 ${selected.size || ''}</button></div>
      <div class="sd-comfy-inbox-rows">${shown.map((row, index) => `<article>
        <input type="checkbox" aria-label="选择任务 ${escape(row.attemptId)}" data-row="${index}" ${selected.has(key(row)) ? 'checked' : ''} ${busy || !enabled(row) ? 'disabled' : ''}>
        <div><b>${escape(row.model || (mode === 'local' ? '领取记录' : 'Comfy 原图'))}</b><small>${escape(stateName(row.status))} · ${escape(new Date(row.createdAt || 0).toLocaleString())}</small><small>${mode === 'server' ? `${Number(row.imageCount) || 0} 张 · ${size(row.cacheBytes)}${row.reservedBytes ? ` · 预留 ${size(row.reservedBytes)}` : ''}` : `已存 ${row.files?.length || 0} / ${row.imageCount || '—'} 张`}</small><small class="sd-comfy-inbox-id">${escape(row.attemptId)}</small>${mode === 'server' && !enabled(row) ? '<small>在途或状态待核查，暂不清理</small>' : ''}</div>
        <button type="button" class="sd-btn" data-receive="${index}" ${busy || (mode === 'server' && row.resultAvailable !== true) ? 'disabled' : ''}>领取</button>
      </article>`).join('')}</div>
      ${pages > 1 ? `<footer><button type="button" class="sd-btn" data-action="previous" ${!page || busy ? 'disabled' : ''}>上一页</button><span>${page + 1} / ${pages}</span><button type="button" class="sd-btn" data-action="next" ${page + 1 >= pages || busy ? 'disabled' : ''}>下一页</button></footer>` : ''}
    </section>`;
  }
  async function refresh() {
    const ticket = ++revision; busy = true; selected.clear(); paint();
    const results = await Promise.allSettled([service.list(), service.catalog()]);
    if (!current() || ticket !== revision) return;
    local = results[0].status === 'fulfilled' ? results[0].value : null;
    if (local) local.rows = local.rows.slice().sort((a,b) => b.createdAt - a.createdAt);
    server = results[1].status === 'fulfilled' ? results[1].value : null;
    localError = results[0].status === 'rejected' ? results[0].reason?.message || '本机记录读取失败' : '';
    serverError = results[1].status === 'rejected' ? results[1].reason?.message || 'Comfy 目录读取失败' : '';
    if (local && server && local.namespace !== server.namespace) { local = server = null; localError = serverError = 'ST 账户已变化，请重新读取'; }
    busy = false; paint();
  }
  async function click(event) {
    if (!current()) return;
    const button = event.target.closest?.('button'); if (!button || !host.contains(button) || button.disabled || busy) return;
    const action = button.dataset.action;
    if (action === 'server' || action === 'local') { mode = action; page = 0; selected.clear(); notice = ''; paint(); return; }
    if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; selected.clear(); paint(); return; }
    if (action === 'refresh') { notice = ''; return refresh(); }
    const chosen = rows().filter(row => selected.has(key(row))), row = rows()[page * 40 + Number(button.dataset.receive)];
    busy = true; paint();
    try {
      if (action === 'clear') {
        const result = await (mode === 'server' ? service.discard(chosen) : service.removeLocal(chosen));
        notice = result.cancelled ? '' : `已清理 ${result.removed} 项${result.errors?.length ? `；${result.errors.length} 项未清理：${result.errors[0]}` : ''}`;
      } else if (button.dataset.receive !== undefined && row) {
        const result = await receive(row, mode);
        notice = result?.cancelled ? '' : result?.warning || (result?.archived ? '原图已归档' : '请核查原任务');
      }
    } catch (error) { notice = error.message || '操作未完成，请保留原任务'; }
    finally { if (current()) await refresh(); }
  }
  function change(event) {
    if (busy || !current()) return;
    const input = event.target;
    const shown = rows().slice(page * 40, page * 40 + 40);
    if (input.dataset.action === 'select-page') {
      // Destructive batches are capped at 20, even when a page has 40 rows.
      selected.clear(); if (input.checked) shown.filter(enabled).slice(0,20).forEach(row => selected.add(key(row)));
    } else if (input.dataset.row !== undefined) {
      const row = shown[Number(input.dataset.row)]; if (!row || !enabled(row)) return;
      input.checked ? selected.size < 20 && selected.add(key(row)) : selected.delete(key(row));
    }
    paint();
  }
  host.addEventListener('click', click); host.addEventListener('change', change);
  void refresh();
  return () => { disposed = true; revision++; host.removeEventListener('click', click); host.removeEventListener('change', change); };
}
