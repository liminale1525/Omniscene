// Authenticated, GET-only inspection. Pin DNS and never turn a descriptor into a proxy target.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { checkComfyReadiness, prepareComfyReadiness } from './qianmu-comfy-readiness.js';
import { validateGatewayBaseUrl } from './qianmu-image-gateway.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `comfy_readiness_${code}`, status });

export function pinnedComfyInspectionFetch(base, addresses, { requestImpl } = {}) {
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const prefix = `${base.pathname.replace(/\/+$/, '')}/object_info/`;
  const list = addresses.map(item => ({ address: item.address, family: isIP(item.address) }));
  if (!list.length || list.length > 32 || list.some(item => !item.family)) throw fail('address', 'Comfy 地址解析结果无效');
  return async (rawUrl, init) => {
    const url = new URL(rawUrl), name = url.pathname.slice(prefix.length);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || !name || name.includes('/')
      || url.search || url.hash || url.username || url.password || init.method !== 'GET') throw fail('target_changed', '节点检查目标已变化');
    return new Promise((resolve, reject) => {
      const outgoing = (requestImpl || (base.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
        method: 'GET', signal: init.signal, headers: init.headers, maxHeaderSize: 16384,
        lookup(hostname, options, callback) {
          if (hostname.toLowerCase() !== host) { callback(new Error('inspection host changed')); return; }
          if (options?.all) callback(null, list.map(item => ({ ...item })));
          else callback(null, list[0].address, list[0].family);
        },
      }, incoming => {
        if (incoming.statusCode >= 300 && incoming.statusCode < 400) { incoming.destroy(); reject(fail('redirect', '节点接口发生跳转，未跟随')); return; }
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
          const empty = [204, 205, 304].includes(incoming.statusCode); if (empty) incoming.resume();
          resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers }));
        } catch (error) { incoming.destroy(); reject(error); }
      });
      outgoing.once('error', reject); outgoing.end();
    });
  };
}

export async function checkServerComfyReadiness(req, input = {}, options = {}) {
  const account = imageServiceAccount(req);
  const allowPrivateNetwork = input.allowPrivateNetwork === true;
  if (allowPrivateNetwork && !account.admin) throw fail('private_admin', 'ST 私网检查需要管理员明确授权；请使用可访问的 HTTPS 地址或浏览器直连', 403);
  prepareComfyReadiness(input); // Fail locally before DNS or other host IO.
  let addresses, timer;
  const resolveHost = async (host, settings) => {
    addresses = await Promise.race([(options.resolveHost || lookup)(host, settings), new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('dns_timeout', 'Comfy 地址解析超时')), 5000);
    })]).finally(() => clearTimeout(timer));
    if (!Array.isArray(addresses)) addresses = [addresses];
    return addresses;
  };
  const base = await validateGatewayBaseUrl(input.baseUrl, { allowPrivateNetwork, resolveHost });
  if (!addresses) await resolveHost(base.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
  // Never inspect link-local metadata, unspecified or multicast services, even with private-network permission.
  if (addresses.some(item => {
    const ip = String(item.address || '').toLowerCase();
    return /^(?:0\.|169\.254\.)/.test(ip) || Number(ip.split('.')[0]) >= 224
      || ip === '::' || /^fe[89ab]|^ff|^::ffff:/i.test(ip);
  })) throw fail('unsafe_target', '此地址不属于允许检查的 Comfy 主机');
  if (!imageServiceAccountStillMatches(req, account)) throw fail('account_changed', 'ST 账户已变化，请重新检查', 401);
  const pinned = pinnedComfyInspectionFetch(base, addresses, options);
  const result = await checkComfyReadiness(input, { fetchImpl: (url, init) => {
    if (!imageServiceAccountStillMatches(req, account)) throw fail('account_changed', 'ST 账户已变化，请重新检查', 401);
    return pinned(url, init);
  }, signal: options.signal });
  if (!imageServiceAccountStillMatches(req, account)) throw fail('account_changed', 'ST 账户已变化，请重新检查', 401);
  return { ...result, transport: 'gateway', requester: 'ST 主机' };
}
