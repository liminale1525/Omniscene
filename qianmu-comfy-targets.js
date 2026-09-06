import { randomUUID } from 'node:crypto';
import { imageServiceAccount } from './qianmu-image-service-access.js';
import { ImageGatewayError } from './qianmu-image-gateway.js';
import { normalizeComfyTarget } from './qianmu-comfy-server-transport.js';
import { comfyTargetId } from './qianmu-comfy-target-store.js';

const fail = (code, message, status = 409) => Object.assign(new ImageGatewayError(status, `comfy_targets_${code}`, message), { submissionState: 'not_submitted' });
const allowed = (row, account) => row && (account.admin || row.shared && !row.allowPrivateNetwork);
function capture(req, admin = false) {
  let first; try { first = imageServiceAccount(req); } catch (_) { throw fail('authentication', '请先登录 ST 账户', 401); }
  const check = () => {
    let current; try { current = imageServiceAccount(req); } catch (_) { /* Fail below. */ }
    if (!current || current.namespace !== first.namespace) throw fail('account_changed', 'ST 账户已变化，请重新打开连接管理', 401);
    if (admin && !current.admin) throw fail('admin', '仅 ST 管理员可管理可信连接', 403);
    return current;
  };
  check(); return check;
}
export function createComfyTargets({ store }) {
  const view = (state, account) => ({ ok: true, schemaVersion: 1, revision: state.revision, admin: account.admin,
    targets: state.targets.filter(row => allowed(row, account)).map(({ grantId, ...row }) => row) });
  return {
    async list(req) { const current = capture(req); const state = await store.read(); return view(state, current()); },
    async change(req, input) {
      const current = capture(req, true);
      if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) throw fail('revision', '请先读取当前可信连接');
      if (!['trust', 'revoke'].includes(input.action)) throw fail('action', '可信连接操作无效');
      let row;
      if (input.action === 'trust') {
        const baseUrl = normalizeComfyTarget(input.baseUrl), allowPrivateNetwork = input.allowPrivateNetwork === true, shared = input.shared === true;
        if (shared && allowPrivateNetwork) throw fail('private_share', '私网连接仅供 ST 管理员使用');
        if (baseUrl.startsWith('http:') && !allowPrivateNetwork) throw fail('https', '远程 Comfy 地址必须使用 HTTPS');
        const name = String(input.name || '').trim(); if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw fail('name', '连接名称过长或包含无效字符');
        row = { baseUrl, name, allowPrivateNetwork, shared, id: comfyTargetId(baseUrl, allowPrivateNetwork), grantId: randomUUID(), updatedAt: Date.now() };
      } else if (!/^[a-f0-9]{64}$/.test(input.id || '')) throw fail('identity', '请选择需要撤销的连接');
      const id = row?.id || input.id;
      const state = await store.update(input.expectedRevision, rows => {
        current();
        const next = rows.filter(item => item.id !== id);
        if (row) next.push(row);
        if (next.length > 64) throw fail('full', '最多登记 64 个可信连接，请先整理');
        return next;
      });
      return view(state, current());
    },
    async acquire(req, input) {
      const current = capture(req), id = comfyTargetId(input.baseUrl, input.allowPrivateNetwork);
      const state = await store.read(), row = state.targets.find(item => item.id === id);
      if (!allowed(row, current())) throw fail('untrusted', '此地址尚未获准，请在 Comfy 连接设置的“ST 可信连接”中由管理员登记', 403);
      const grantId = row.grantId;
      return async () => {
        const latest = await store.read(), live = latest.targets.find(item => item.id === id);
        if (!allowed(live, current()) || live.grantId !== grantId) throw fail('revoked', '此连接的信任已撤销或更改，已停止后续请求；云端原任务可能仍在运行', 403);
      };
    },
  };
}
