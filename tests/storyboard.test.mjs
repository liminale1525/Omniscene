import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStoryboardFormFixture } from './helpers/storyboard-form-fixture.mjs';
import {
  STORYBOARD_CAPABILITIES,
  STORYBOARD_SOURCES,
  buildImagineCommand,
  createStoryboardDefaults,
  normalizeStoryboardState,
  storyboardRatioDimensions,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const gateway = await readFile(new URL('../qianmu-image-gateway.js', import.meta.url), 'utf8');

assert.deepEqual(Object.keys(STORYBOARD_SOURCES), ['novel', 'banana', 'openai', 'seedream', 'comfy'], '分镜 2.0 必须开放五种独立连接');
assert.equal(STORYBOARD_SOURCES.banana.stSource, 'google', 'Banana 必须复用 ST 官方 Google 图像后端');
assert.equal(STORYBOARD_CAPABILITIES.openai.seed, false, 'OpenAI 官方后端不读取 Seed，界面不得伪装支持');
assert.equal(STORYBOARD_CAPABILITIES.banana.negative, true);
assert.equal(STORYBOARD_CAPABILITIES.comfy.reference, true);
assert.equal(STORYBOARD_CAPABILITIES.seedream.reference, true);
assert.equal(STORYBOARD_SOURCES.novel.secretKey, 'api_key_novel');
assert.equal(STORYBOARD_SOURCES.openai.secretKey, 'api_key_openai');
assert.equal(STORYBOARD_SOURCES.banana.secretKey, 'api_key_makersuite');

const defaults = createStoryboardDefaults();
assert.equal(defaults.profiles.novel.model, '', '千幕不得硬塞默认模型或画质预设');
assert.equal(defaults.profiles.openai.openaiQuality, '', 'OpenAI 画质默认也必须留空/沿用 ST');
assert.equal(Object.hasOwn(defaults, 'characterView'), false);
assert.equal(Object.hasOwn(defaults, 'characters'), false);
assert.equal(Object.hasOwn(defaults, 'entities'), false);
assert.deepEqual(defaults.logs, []);
assert.deepEqual(defaults.parameterPresets, []);

const command = buildImagineCommand({ prompt: 'cinematic portrait', negative: 'watermark', width: 1024, height: 1536, steps: 28, cfg: 6.5, seed: -1 });
assert.match(command, /^\/imagine quiet=true gallery=false /);
assert.match(command, /negative="watermark"/);
assert.match(command, /width=1024 height=1536 steps=28 cfg=6\.5 seed=-1/);
assert.ok(command.endsWith('"cinematic portrait"'));
assert.deepEqual(storyboardRatioDimensions('1:1', 1024, 1024), { width: 1024, height: 1024 });

const normalized = normalizeStoryboardState({ logs: [{
  id: 'queued-1', status: 'queued', source: 'openai', prompt: 'shot', queuedAt: 7,
  snapshot: { source: 'openai', prompt: 'shot', chatKey: 'chat-a', profile: { model: 'gpt-image-1' } },
}] });
assert.equal(normalized.logs[0].status, 'queued');
assert.equal(normalized.logs[0].snapshot.profile.model, 'gpt-image-1');
assert.equal(normalized.logs[0].snapshot.chatKey, 'chat-a');

const normalizedPresets = normalizeStoryboardState({
  parameterPresets: [{ id: 'style-1', name: '柔光', source: 'openai', profile: { model: 'gpt-image-1', openaiQuality: 'high' } }],
  parameterPresetSelection: { openai: 'style-1', novel: 'missing' },
});
assert.equal(normalizedPresets.parameterPresets[0].profile.openaiQuality, 'high');
assert.equal(normalizedPresets.parameterPresetSelection.openai, 'style-1');
assert.equal(normalizedPresets.parameterPresetSelection.novel, '', '参数样式必须按供应商隔离并清理无效选择');

assert.match(source, /case 'imagegen': return renderStoryboardTab\(\)/, '分镜必须进入千幕顶层路由');
assert.doesNotMatch(source, /storyboardExecuteSlash\(`\/imagine-source/, '浏览模型标签不得触发 ST 全局连接切换');
assert.match(source, /storyboardPrepareGatewayAssets[\s\S]*storyboardGatewayRequest[\s\S]*\/api\/plugins\/qianmu-tts\/image\/generate/, '生成必须走千幕同源网关，不得改写 ST 全局生图状态');
assert.doesNotMatch(source, /STORYBOARD_TRANSIENT_SD_KEYS|storyboardWithTransientProfile/, '分镜 2.0 不得临时篡改 SillyTavern 生图设置');
assert.match(source, /import\('\.\.\/\.\.\/\.\.\/secrets\.js'\)[\s\S]*writeSecret/, '密钥必须进入 SillyTavern 密钥库');
assert.match(source, /readSecret[\s\S]*findSecret/, '密钥读取必须兼容 SillyTavern 新旧公开接口');
assert.match(source, /sourceCredentialId[\s\S]*storyboardResolveApiKey\(sourceId, sourceCredentialId\)[\s\S]*storyboardRememberApiKey\(sourceId, existingKey, credentialId\)/, '当前编辑连接另存为预设时必须无感迁移已保存 Key');
assert.match(source, /storyboardImages[\s\S]*messageHash[\s\S]*swipeId/, '正文挂载必须带楼层内容与 swipe 锚点');
assert.match(source, /createStoryboardMessageReference[\s\S]*resolveStoryboardMessageReference/, '正文挂载必须以稳定消息身份协调删楼、改楼与 swipe');
assert.match(source, /if \(!storyboardState\(\)\.enabled\)[\s\S]*sd-storyboard-inline, \.sd-storyboard-message-action/, '分镜总开关关闭后必须清理全部正文入口与成片');
assert.match(source, /paragraphAnchor: clone\(job\.paragraphAnchor \|\| null\)/, '第 0 楼与跨聊天待归档结果都必须保留段落锚点');
assert.match(source, /storyboardInlineAnchorNode\(text, anchorRecords\)[\s\S]*anchor\.node\.insertAdjacentElement\('afterend', wrapper\)[\s\S]*text\.insertAdjacentElement\('afterend', wrapper\)/, '命中段落锚点时必须原位插图，失配时才回退到整层末尾');
assert.match(source, /function storyboardInlineRecordValid[\s\S]*record\.messageHash[\s\S]*record\.swipeId/, '编辑或 reroll 后必须阻止旧图误挂');
assert.doesNotMatch(source, /storyboardProfileBindings|绑定到当前聊天|selectedCharacters/, '形象档案不得再自动绑定或注入镜头任务');
assert.match(source, /function storyboardGenerationPayload[\s\S]*compileStoryboardPrompt\([\s\S]*artistString/, '生图负载必须经角色隔离编译器合成，且画师串仍只来自用户选择');
assert.match(source, /function storyboardStartLog[\s\S]*function storyboardFinishLog[\s\S]*分镜日志/, '分镜必须记录成功、失败与诊断信息');
assert.match(source, /STORYBOARD_QUEUE_LIMIT[\s\S]*storyboardQueueJob[\s\S]*storyboardPumpQueue/, '分镜必须使用有上限的生成队列');
assert.match(source, /storyboardActiveJobs\.size < concurrency/, '镜组队列必须按配置执行真实并发');
assert.match(source, /routedConnection[\s\S]*const providerProfile = storyboardResolveRoutingProfile[\s\S]*capabilityModelId:[\s\S]*storyboardGenerationPayload\(state, providerProfile/, '镜组任务必须使用同一绑定解析链生成有效参数');
assert.match(source, /function storyboardRemoveQueuedLog/, '等待任务必须可单独移除');
assert.match(source, /移出等待/, '日志必须提供明确的移出等待操作');
assert.match(source, /storyboardDiscardActive[\s\S]*discardRequested[\s\S]*放弃进行中/, '斩断未暴露的 ST 请求时必须明确为放弃收片');
assert.match(source, /storyboardLoadLogToWorkbench[\s\S]*storyboardRetryLog[\s\S]*载入镜头台/, '日志必须可载入与再生成');
assert.match(source, /storyboardCheckConnection[\s\S]*\/api\/plugins\/qianmu-tts\/image\/check/, '所有供应商必须走千幕同源网关实测连接');
assert.match(source, /storyboardHandleChatChanged[\s\S]*storyboardDrainPendingDeliveries/, '跨聊天队列必须先进入原聊天收片箱，不能写入当前聊天');
assert.match(source, /原正文楼层已删除，未发起生图请求[\s\S]*正文已更改，未发起生图请求/, '请求送出前若正文删除或改写，必须停止而非继续消耗额度');
assert.match(createStoryboardFormFixture({family:'novel'}).content, /<b>API 设置<\/b>/, '模型接口卡保持 API 设置标题');
assert.match(createStoryboardFormFixture({family:'comfy'}).content, /<b>连接<\/b>/, 'Comfy 工作台独立连接卡');
assert.doesNotMatch(source, /将此瞬，妥为留存/, '镜头台不得继续显示已移除的装饰文案');
assert.doesNotMatch(source, /自定义兼容模型|输入兼容模型 ID|查看接口全部模型/, '模型工作台不得暴露低概率的任意模型入口');
assert.match(source, /function renderStoryboardModelCard[\s\S]*sd-storyboard-compiler-api[\s\S]*function renderStoryboardParameterVibes/, '画面整理模型必须与生图连接合并在同一工作台');
assert.doesNotMatch(source, /function renderStoryboardConnection\(/, '旧的重复连接页面必须移除');
assert.doesNotMatch(source, /千幕组织镜头，SillyTavern 负责连接与生成/, '镜头台不应展示尴尬的实现说明');
assert.match(css, /#chat \.mes \.sd-storyboard-inline/, '正文分镜样式必须严格限定在聊天消息内');
assert.match(source, /storyboardInjectMessageButtons[\s\S]*dataset\.storyboardChatAction = 'capture-floor'/, '正文每层必须提供半自动取景快捷入口');
assert.match(source, /function storyboardChooseCaptureMode[\s\S]*智能提取[\s\S]*手动选段补图/, '正文取景入口必须支持智能提取与多段手动补图');
assert.match(source, /storyboardParameterPresets[\s\S]*保存分镜样式[\s\S]*parameterPresetSelection/, '分镜参数样式必须可按模型保存和切换');
assert.match(source, /rememberStoryboardModelProfile\(state\.modelProfiles, providerId, \{ \.\.\.captured, model: previousModel \}\)[\s\S]*getStoryboardRememberedProfile\(state\.modelProfiles, providerId, binding\.remoteModelId, binding\.capabilityModelId\)/, '每个具体模型必须通过隔离读写入口记住最后一次参数修改');
assert.doesNotMatch(source, /sd-storyboard-reuse-record|sd-storyboard-lightbox-reuse/, '阅片室不得保留复用或重新生成入口');
assert.match(source, /getStoryboardCapabilities\(state\.source, profile\.capabilityModelId,[^\n]+[\s\S]*capabilities\.supportsNativeNegative[\s\S]*capabilities\.steps/, '绘制参数必须按供应商、具体模型及工作流能力裁剪');
assert.match(source, /openaiBackground[\s\S]*openaiOutputFormat[\s\S]*seedreamGuidanceScale[\s\S]*seedreamSequential[\s\S]*novelSm[\s\S]*novelVarietyBoost/, '各模型的官方参数必须在前端可调且进入真实请求');
assert.match(source, /storyboardParseWorkflow[\s\S]*storyboardGatewayRequest/, 'ComfyUI 必须把有效 API Workflow 交给千幕网关');
assert.match(source, /storyboardCaptureComfyWorkflow[\s\S]*sanitizeStoryboardWorkflow[\s\S]*comfyWorkflowNotice/, 'ComfyUI Workflow 必须在进入持久化设置前结构化清理凭据字段');
assert.match(source, /function storyboardParseWorkflow[\s\S]*removedFields[\s\S]*不能内嵌凭据/, '含凭据字段的 ComfyUI Workflow 必须在生成前明确阻断');
assert.match(source, /storyboardPipelineStage[\s\S]*sanitizeStoryboardDiagnosticData\(input\)[\s\S]*sanitizeStoryboardDiagnosticData\(output\)/, '分镜诊断日志写入前必须经过凭据净化');
assert.match(source, /storyboardExportPackage[\s\S]*sanitizeStoryboardSnapshot[\s\S]*credentialsIncluded: false/, '分镜数据包必须再次净化历史成片快照');
assert.match(source, /async function exportConfig[\s\S]*snapshot\.imagegen[\s\S]*normalizeStoryboardState/, '千幕全量配置导出也必须净化旧版分镜工作流');
assert.match(source, /async function importConfig[\s\S]*merged\.imagegen[\s\S]*normalizeStoryboardState/, '千幕全量配置导入不得把工作流凭据重新写回设置');
assert.match(gateway, /prepareComfyWorkflow[\s\S]*template\.bind\(referenceNames\)/, 'ComfyUI Workflow 必须复用共享槽位准备与替换器');
assert.doesNotMatch(source, /source !== 'comfy'[\s\S]{0,120}consistencyMode = 'reference'/, '非 ComfyUI 后端不得伪装参考图一致性');
assert.match(source, /storyboardFilteredGalleryRecords[\s\S]*storyboardGalleryVisibleCount[\s\S]*storyboardOpenLightbox/, '成片必须支持检索、渐进渲染与独立看图层');
assert.match(source, /storyboardGallerySelection[\s\S]*删除选中图片/, '阅片室必须具备批量管理');
assert.match(source, /storyboardExportPackage[\s\S]*type: 'qianmu-storyboard'[\s\S]*credentialsIncluded: false/, '分镜数据包不得包含 API 密钥');
assert.match(source, /storyboardImportPackage[\s\S]*saveBase64AsFile[\s\S]*messageHash/, '跨端导入须将内嵌图片交给 ST 落盘并重新校验正文锚点');
assert.match(source, /gallery\.length > 400 \? gallery\.splice\(0, gallery\.length - 400\)/, '聊天成片元数据必须有容量上限');
assert.match(source, /sd-reader-native-file sd-storyboard-pack-file/, 'iOS 导入必须保留真实文件控件，不得用 hidden 切断用户手势链');
assert.match(source, /const saveDraft[\s\S]*setTimeout[\s\S]*storyboardCaptureWorkbench\(root, sourceAtBind\)/, '镜头台长文与参数草稿必须延迟自动保存');
assert.match(source, /function closeModal\(\)[\s\S]*storyboardCaptureWorkbench\(storyboardRoot\)[\s\S]*storyboardCloseLightbox\(\)/, '关闭面板必须先保存草稿并收掉独立看图层');
assert.match(source, /role="dialog"[\s\S]*aria-modal[\s\S]*event\.key === 'Escape'/, '成片看图层必须支持屏幕阅读语义和 Escape 关闭');
assert.match(source, /storyboardHandleChatChanged\(\)[\s\S]*storyboardGallerySelection\.clear\(\)/, '切换聊天时必须清理成片选择态');
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*sd-storyboard-queue-pulse[\s\S]*animation: none/, '分镜必须尊重系统低动态偏好');
assert.match(css, /sd-storyboard-root button:focus-visible[\s\S]*outline:/, '分镜主要操作必须保留键盘焦点轮廓');

console.log('Storyboard module contract OK');
