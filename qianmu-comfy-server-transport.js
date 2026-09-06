// One authenticated, pinned server egress boundary for the native Comfy API.
// This is per-operation authorization, not a persistent administrator allowlist.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ImageGatewayError, validateGatewayBaseUrl } from './qianmu-image-gateway.js';
import { imageServiceAccount } from './qianmu-image-service-access.js';

const fail = (code, message, status = 400) => Object.assign(new ImageGatewayError(status, `comfy_transport_${code}`, message), { submissionState: 'not_submitted' });
const oneSegment = value => {
  try { const decoded = decodeURIComponent(value); return decoded.length > 0 && decoded.length <= 240 && !/[\u0000-\u001f\u007f/\\?#%]/.test(decoded) && !['.', '..'].includes(decoded); }
  catch (_) { return false; }
};
const safeRoot = raw => {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(raw)) throw fail('address', 'Comfy API 根地址无效');
  let base; try { base = new URL(raw); } catch (_) { throw fail('address', 'Comfy API 根地址无效'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw fail('address', 'Comfy API 根地址不能包含账户、查询参数或锚点');
  // Reject ambiguous proxy paths before URL normalization can erase dot segments.
  const rawPath = raw.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '');
  if (rawPath && (!rawPath.startsWith('/') || rawPath.slice(1).split('/').some(segment => !oneSegment(segment)))) throw fail('address', '请填写无跳转、无路径歧义的 Comfy API 根地址');
  return base;
};

export function normalizeComfyTarget(raw) {
  const base = safeRoot(raw);
  base.pathname = base.pathname.replace(/\/+$/, '') || '/';
  return base.toString().replace(/\/$/, '');
}

function addressList(addresses) {
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32) throw fail('address', 'Comfy 地址解析结果无效');
  return addresses.map(item => {
    let address = String(item?.address || ''); const family = isIP(address);
    if (!family || (item.family != null && item.family !== family)) throw fail('address', 'Comfy 地址解析结果无效');
    if (family === 6) address = new URL(`http://[${address}]`).hostname.slice(1, -1);
    const ip = address.toLowerCase();
    // Also exclude transition/translated ranges, even under private opt-in.
    if ((family === 4 && (/^(?:0\.|169\.254\.)/.test(ip) || Number(ip.split('.')[0]) >= 224))
      || (family === 6 && ((ip !== '::1' && !/^(?:[23][0-9a-f]{3}:|f[cd][0-9a-f]{2}:)/.test(ip))
        || /^2002:|^2001:(?:0:|2:|db8:)/.test(ip)))) throw fail('unsafe_target', '此地址不属于允许访问的 Comfy 主机');
    return Object.freeze({ address, family });
  });
}

function allowedOperation(base, url, method, operation) {
  const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
  if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith(prefix)) return false;
  const route = url.pathname.slice(prefix.length);
  if (operation === 'check') return method === 'GET' && route === 'system_stats' && !url.search;
  if (operation === 'models') return method === 'GET' && route === 'object_info' && !url.search;
  if (operation === 'readiness') return method === 'GET' && route.startsWith('object_info/') && oneSegment(route.slice(12)) && !url.search;
  if (operation !== 'generate') return false;
  if (method === 'POST') return ['prompt', 'upload/image'].includes(route) && !url.search;
  if (method !== 'GET') return false;
  if (route.startsWith('history/')) return oneSegment(route.slice(8)) && !url.search;
  if (route !== 'view') return false;
  const params = url.searchParams;
  if ([...params.keys()].some(key => !['filename', 'subfolder', 'type'].includes(key) || params.getAll(key).length !== 1)) return false;
  if (!oneSegment(params.get('filename') || '') || params.get('type') !== 'output') return false;
  const folder = params.get('subfolder');
  return !folder || folder.split('/').every(oneSegment);
}

export function pinnedComfyFetch(base, addresses, { operation, requestImpl, assertCurrent = () => {}, beforeRequest, signal } = {}) {
  base = new URL(base); // Do not retain a caller-mutable URL or DNS answer array.
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const list = addressList(addresses);
  if (isIP(host) && (list.length !== 1 || list[0].address !== host)) throw fail('address', 'Comfy 地址与解析结果不一致');
  return async (rawUrl, init = {}) => {
    assertCurrent(); signal?.throwIfAborted();
    const url = new URL(rawUrl), method = String(init.method || 'GET').toUpperCase();
    if (!allowedOperation(base, url, method, operation)) throw fail('target_changed', 'Comfy 请求目标或操作已变化');
    await beforeRequest?.(); assertCurrent(); signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    if ([...headers.keys()].some(key => !['authorization', 'content-type', 'accept'].includes(key))) throw fail('headers', 'Comfy 请求包含不允许的转发头');
    if (method === 'GET' && init.body != null) throw fail('body', 'Comfy 只读请求不能携带正文');
    // Web Request supplies the correct multipart boundary without buffering the image.
    const combined = signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal || init.signal;
    const packet = new Request(url, { method, headers, body: init.body, signal: combined });
    combined?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let outgoing;
      try {
        outgoing = (requestImpl || (base.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
          method, signal: combined, headers: Object.fromEntries(packet.headers), maxHeaderSize: 16384, agent: false,
          lookup(hostname, options, callback) {
            if (hostname.toLowerCase().replace(/^\[|\]$/g, '') !== host) { callback(fail('target_changed', 'Comfy 主机已变化')); return; }
            if (options?.all) callback(null, list.map(item => ({ ...item })));
            else { const item = list.find(value => !options?.family || value.family === options.family); if (item) callback(null, item.address, item.family); else callback(fail('address', 'Comfy 地址族不匹配')); }
          },
        }, incoming => {
          try {
            assertCurrent();
            if (incoming.statusCode >= 300 && incoming.statusCode < 400) throw fail('redirect', 'Comfy 接口发生跳转，未跟随', 502);
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
            const empty = [204, 205, 304].includes(incoming.statusCode); if (empty) incoming.resume();
            resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: responseHeaders }));
          } catch (error) { incoming.destroy(); reject(error); }
        });
        outgoing.once('error', reject);
        if (packet.body) pipeline(Readable.fromWeb(packet.body), outgoing).catch(reject);
        else outgoing.end();
      } catch (error) { outgoing?.destroy?.(); packet.body?.cancel().catch(() => {}); reject(error); }
    });
  };
}

export async function createComfyServerTransport(req, input, { operation, resolveHost = lookup, requestImpl, signal, dnsTimeoutMs = 5000, authorizeTarget } = {}) {
  let account;
  try { account = imageServiceAccount(req); } catch (_) { throw fail('authentication_required', '请先登录 ST 账户再连接 Comfy', 401); }
  const allowPrivateNetwork = input?.allowPrivateNetwork === true;
  if (allowPrivateNetwork && !account.admin) throw fail('private_admin', 'ST 私网连接需要管理员明确允许；也可使用浏览器直连', 403);
  const assertCurrent = () => {
    let current; try { current = imageServiceAccount(req); } catch (_) { /* Expired account is denied below. */ }
    if (!current || current.namespace !== account.namespace || (allowPrivateNetwork && !current.admin)) throw fail('account_changed', 'ST 账户或私网权限已变化，请重新连接', 401);
    signal?.throwIfAborted();
  };
  const rawBase = safeRoot(input?.baseUrl);
  if (!allowPrivateNetwork && rawBase.protocol !== 'https:') throw fail('address', '远程 Comfy 地址必须使用 HTTPS');
  assertCurrent();
  const verifyTarget = await authorizeTarget?.(req, { baseUrl: rawBase.toString(), allowPrivateNetwork });
  assertCurrent();
  const verify = async () => { assertCurrent(); await verifyTarget?.(); assertCurrent(); };
  let addresses, timer;
  const resolveOnce = async (host, settings) => {
    if (addresses) return addresses;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('dns_timeout', 'Comfy 地址解析超时')), Math.max(1, Math.min(5000, dnsTimeoutMs))); });
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true }); });
    try {
      const result = await Promise.race([resolveHost(host, settings), timeout, cancelled]);
      addresses = addressList(Array.isArray(result) ? result : [result]);
      assertCurrent(); return addresses;
    } catch (error) {
      if (signal?.aborted || error instanceof ImageGatewayError) throw error;
      throw fail('dns', '无法解析 Comfy 地址，请核对域名与 ST 主机网络');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  // Resolve once ourselves so validation cannot swallow an authentication/DNS error.
  await resolveOnce(rawBase.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
  const base = await validateGatewayBaseUrl(rawBase.toString(), { allowPrivateNetwork, resolveHost: async () => addresses });
  await verify();
  return { base, assertCurrent, verify, fetchImpl: pinnedComfyFetch(base, addresses, { operation, requestImpl, assertCurrent, beforeRequest: verify, signal }) };
}
