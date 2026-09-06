// Readiness uses the same account, private-network and DNS policy as generation.
import { checkComfyReadiness, prepareComfyReadiness } from './qianmu-comfy-readiness.js';
import { createComfyServerTransport, pinnedComfyFetch } from './qianmu-comfy-server-transport.js';

export function pinnedComfyInspectionFetch(base, addresses, options = {}) {
  return pinnedComfyFetch(base, addresses, { ...options, operation: 'readiness' });
}

export async function checkServerComfyReadiness(req, input = {}, options = {}) {
  prepareComfyReadiness(input); // No DNS or host IO for an invalid local graph.
  const transport = await createComfyServerTransport(req, input, { ...options, operation: 'readiness' });
  const result = await checkComfyReadiness(input, { fetchImpl: transport.fetchImpl, signal: options.signal });
  transport.assertCurrent();
  return { ...result, transport: 'gateway', requester: 'ST 主机' };
}
