// 千幕 · SillyTavern Server Plugin
// 为豆包 TTS 与分镜生图提供同源请求边界，密钥只在单次上游请求中使用。
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createImageService, imageServiceTaskErrorPayload, IMAGE_SERVICE_TASK_VERSION } from './qianmu-image-service.js';
import { imageServiceAccount } from './qianmu-image-service-access.js';
import {
  checkImageConnection,
  generateImage,
  imageGatewayErrorPayload,
  imageGatewayCapabilities,
  listImageModels,
} from './qianmu-image-gateway.js';
import {
  cancelMiniMaxH3Video,
  createMiniMaxH3Video,
  openMiniMaxH3VideoResult,
  queryMiniMaxH3Video,
  videoGatewayErrorPayload,
} from './qianmu-video-gateway.js';
import { MINIMAX_H3_PROVIDER_CAPABILITY } from './qianmu-video-minimax.js';

const DOUBAO_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const MAX_TEXT_LENGTH = 10000;
const MAX_ADDITIONS_LENGTH = 20000;
const REQUEST_TIMEOUT_MS = 90000;
const ALLOWED_FORMATS = new Set(['mp3', 'ogg_opus', 'pcm']);
const ALLOWED_SAMPLE_RATES = new Set([16000, 24000, 32000, 48000]);
const ALLOWED_RESOURCE_IDS = new Set(['seed-tts-2.0', 'seed-icl-2.0', 'seed-icl-1.0']);
const ALLOWED_INFERENCE_MODELS = new Set(['seed-tts-2.0-expressive', 'seed-tts-1.1']);
const VIDEO_STREAM_TIMEOUT_MS = 15 * 60_000;
const imageTaskServices = new Set();

async function pluginVersion() {
  try {
    const module = await import('./package.json', { with: { type: 'json' } });
    return String(module.default?.version || 'unknown');
  } catch (_) { return 'unknown'; }
}

export const info = Object.freeze({
  id: 'qianmu-tts',
  name: '千幕同源服务',
  description: '为千幕提供豆包语音、分镜图像与 MiniMax H3 的同源网关。',
});

function asString(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function sanitizeRequest(input) {
  const request = input && typeof input === 'object' ? input : {};
  const reqParams = request.req_params && typeof request.req_params === 'object' ? request.req_params : {};
  const text = asString(reqParams.text, MAX_TEXT_LENGTH);
  const speaker = asString(reqParams.speaker, 240);
  if (!text) throw new Error('文本为空');
  if (!speaker) throw new Error('未指定豆包音色 ID');

  const audio = reqParams.audio_params && typeof reqParams.audio_params === 'object' ? reqParams.audio_params : {};
  const format = ALLOWED_FORMATS.has(audio.format) ? audio.format : 'mp3';
  const sampleRate = ALLOWED_SAMPLE_RATES.has(Number(audio.sample_rate)) ? Number(audio.sample_rate) : 24000;
  const additions = asString(reqParams.additions, MAX_ADDITIONS_LENGTH);
  if (additions) {
    try { JSON.parse(additions); }
    catch (_) { throw new Error('豆包 additions 不是有效 JSON'); }
  }
  const inferenceModel = asString(reqParams.model, 80);
  if (inferenceModel && !ALLOWED_INFERENCE_MODELS.has(inferenceModel)) throw new Error('豆包推理模型不在允许列表');

  return {
    user: { uid: asString(request.user?.uid, 120) || 'qianmu-tts' },
    req_params: {
      text,
      speaker,
      audio_params: {
        format,
        sample_rate: sampleRate,
        speech_rate: Math.round(clampNumber(audio.speech_rate, -50, 100, 0)),
        loudness_rate: Math.round(clampNumber(audio.loudness_rate, -50, 100, 0)),
        bit_rate: Math.round(clampNumber(audio.bit_rate, 32000, 256000, 128000)),
      },
      ...(additions ? { additions } : {}),
      ...(inferenceModel ? { model: inferenceModel } : {}),
    },
  };
}

async function waitForDrain(res) {
  if (typeof res.once !== 'function') return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off?.('drain', onDrain);
      res.off?.('close', onClose);
      res.off?.('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('video result client disconnected')); };
    const onError = (error) => { cleanup(); reject(error); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

export async function streamMiniMaxH3VideoResult(opened, res) {
  const reader = opened?.response?.body?.getReader?.();
  if (!reader || typeof res?.write !== 'function') throw new Error('video result stream is unavailable');
  let bytes = 0;
  let timedOut = false;
  let closed = false;
  const onClose = () => {
    closed = true;
    void reader.cancel().catch(() => {});
  };
  res.once?.('close', onClose);
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, VIDEO_STREAM_TIMEOUT_MS);
  try {
    res.status(200);
    res.set('Content-Type', opened.contentType);
    res.set('Content-Disposition', `inline; filename="${opened.fileName}"`);
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (opened.contentLength > 0) res.set('Content-Length', String(opened.contentLength));
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > opened.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('video result stream exceeded its size limit');
      }
      if (!res.write(chunk)) await waitForDrain(res);
    }
    if (timedOut) throw new Error('video result stream timed out');
    if (!closed) res.end();
    return { bytes, completed: !closed };
  } finally {
    clearTimeout(timer);
    res.off?.('close', onClose);
    try { reader.releaseLock(); } catch (_) {}
  }
}

export async function init(router, options = {}) {
  router.get('/health', async (_req, res) => res.json({
    ok: true,
    plugin: info.id,
    version: await pluginVersion(),
    schemaVersion: 1,
    delivery: 'optional',
    services: ['doubao-tts', 'storyboard-image', 'minimax-h3'],
  }));

  router.get('/image/capabilities', async (_req, res) => prepareImageResponse(res).json(imageGatewayCapabilities(await pluginVersion())));

  const prepareImageResponse = (res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    return res;
  };

  let imageTasks;
  const hostDataRoot = () => options.dataRoot === undefined ? globalThis.DATA_ROOT : options.dataRoot;
  const tasksFor = (req) => {
    imageServiceAccount(req);
    if (!imageTasks) {
      imageTasks = createImageService({ dataRoot: hostDataRoot(), ...(options.imageTaskOptions || {}) });
      imageTaskServices.add(imageTasks);
    }
    return imageTasks;
  };
  router.get('/image/tasks/capabilities', (req, res) => {
    prepareImageResponse(res);
    try {
      imageServiceAccount(req);
      // Construction checks the trusted host path but performs no disk/network IO.
      tasksFor(req);
      return res.json({ ok: true, schemaVersion: IMAGE_SERVICE_TASK_VERSION, taskLocatorVersion: 1, accountBindingVersion: 1, catalogVersion: 1, providers: ['novel'], protocols: ['novelai'],
        scope: 'coordinated-endpoints-only', resultRetrieval: true, resultAcknowledgement: true, explicitCacheCleanup: true,
        maxPending: 32, maxActive: 2, automaticRestartReplay: false,
      });
    } catch (error) { const result = imageServiceTaskErrorPayload(error); return res.status(result.status).json(result.body); }
  });
  for (const action of ['submit', 'query', 'result', 'acknowledge', 'discard', 'catalog']) {
    router.post(`/image/tasks/${action}`, async (req, res) => {
      prepareImageResponse(res);
      const controller = new AbortController();
      // Request.close also fires after an ordinary request body is read in Node.
      // Only an unfinished RESPONSE closing means the waiting client went away.
      const onClose = () => { if (!res.writableEnded) controller.abort(); };
      if (action === 'submit') res.once?.('close', onClose);
      try {
        const service = tasksFor(req);
        const body = await service[action](req, req.body, { signal: controller.signal });
        if (!res.destroyed && !res.writableEnded) return res.json(body);
      } catch (error) {
        const result = imageServiceTaskErrorPayload(error);
        console.warn('[千幕生图任务]', result.body.code);
        if (!res.destroyed && !res.writableEnded) return res.status(result.status).json(result.body);
      } finally { res.off?.('close', onClose); }
      return undefined;
    });
  }

  router.post('/image/check', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await checkImageConnection(req.body));
    } catch (error) {
      const result = imageGatewayErrorPayload(error);
      console.warn('[千幕分镜网关] 连接检查失败', result.body.code);
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/image/models', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await listImageModels(req.body));
    } catch (error) {
      const result = imageGatewayErrorPayload(error);
      console.warn('[千幕分镜网关] 模型列表读取失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/image/generate', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await generateImage(req.body));
    } catch (error) {
      const result = imageGatewayErrorPayload(error);
      console.warn('[千幕分镜网关] 生成失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.get('/video/minimax/capabilities', (_req, res) => prepareImageResponse(res).json({
    ok: true,
    provider: MINIMAX_H3_PROVIDER_CAPABILITY.id,
    model: MINIMAX_H3_PROVIDER_CAPABILITY.model,
    modes: [...MINIMAX_H3_PROVIDER_CAPABILITY.modes],
    resolutions: [...MINIMAX_H3_PROVIDER_CAPABILITY.resolutions],
    duration: { ...MINIMAX_H3_PROVIDER_CAPABILITY.duration },
    transport: MINIMAX_H3_PROVIDER_CAPABILITY.transport,
    browserDirect: MINIMAX_H3_PROVIDER_CAPABILITY.browserDirect,
    keyType: MINIMAX_H3_PROVIDER_CAPABILITY.keyType,
  }));

  router.post('/video/minimax/create', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await createMiniMaxH3Video(req.body));
    } catch (error) {
      const result = videoGatewayErrorPayload(error);
      console.warn('[千幕 H3 网关] 创建失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/video/minimax/query', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await queryMiniMaxH3Video(req.body));
    } catch (error) {
      const result = videoGatewayErrorPayload(error);
      console.warn('[千幕 H3 网关] 查询失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/video/minimax/cancel', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await cancelMiniMaxH3Video(req.body));
    } catch (error) {
      const result = videoGatewayErrorPayload(error);
      console.warn('[千幕 H3 网关] 取消失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/video/minimax/result', async (req, res) => {
    prepareImageResponse(res);
    try {
      const opened = await openMiniMaxH3VideoResult(req.body);
      return await streamMiniMaxH3VideoResult(opened, res);
    } catch (error) {
      if (res.headersSent) {
        console.warn('[千幕 H3 网关] 成片流传输中断');
        res.destroy?.();
        return undefined;
      }
      const result = videoGatewayErrorPayload(error);
      console.warn('[千幕 H3 网关] 成片读取失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/doubao/synthesize', async (req, res) => {
    const apiKey = asString(req.body?.apiKey, 512);
    if (!apiKey) return res.status(400).send('缺少豆包 API Key');
    const resourceId = asString(req.body?.resourceId, 80) || 'seed-tts-2.0';
    if (!ALLOWED_RESOURCE_IDS.has(resourceId)) return res.status(400).send('豆包资源 ID 不在允许列表');

    let request;
    try { request = sanitizeRequest(req.body?.request); }
    catch (error) { return res.status(400).send(error?.message || '请求参数无效'); }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const upstream = await fetch(DOUBAO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': randomUUID(),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const data = Buffer.from(await upstream.arrayBuffer());
      const logId = upstream.headers.get('x-tt-logid') || '';
      if (logId) res.set('X-Tt-Logid', logId);
      res.set('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
      return res.status(upstream.status).send(data);
    } catch (error) {
      const message = error?.name === 'AbortError' ? '豆包请求超时' : `豆包网络请求失败：${error?.message || error}`;
      console.warn('[千幕豆包语音中转]', message);
      return res.status(502).send(message);
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function exit() {
  const active = [...imageTaskServices]; imageTaskServices.clear();
  await Promise.allSettled(active.map(service => service.close()));
}
