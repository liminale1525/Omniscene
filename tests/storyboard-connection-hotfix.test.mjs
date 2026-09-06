import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const direct = await readFile(new URL('../qianmu-image-direct.js', import.meta.url), 'utf8');

assert.match(source, /import\('\.\/qianmu-image-direct\.js\?v=1\.59\.37'\)/, '生图渠道必须按需接入浏览器直连适配层');
assert.match(source, /await storyboardSaveConnection\(root, \{ quiet: true \}\)/, '测试连接复用保留 Key 的保存流程');
assert.match(source, /STORYBOARD_BROWSER_CREDENTIALS_KEY = 'qianmu\.storyboard\.credentials\.v1'/, '预设凭据必须拥有不依赖服务端 secrets 暴露的当前浏览器存储');
assert.match(source, /async function storyboardLoadConnectionPreset[\s\S]*storyboardResolveApiKey\(sourceId, preset\.credentialId\)[\s\S]*storyboardDraftApiKeys.set\(sourceId, key\)/, '选择 API 预设必须同时载入连接和对应凭据至遮蔽输入框');
assert.match(source, /value="\$\{htmlEscape\(storyboardDraftApiKeys\.get\(state\.source\) \|\| ''\)\}"/, '表单重绘后必须恢复失败的 Key 输入');
assert.match(source, /try \{ data = await directImage\.generateDirectImage\(gatewayRequest\); \}/, '正式生图必须优先使用浏览器直连适配层');
assert.doesNotMatch(source, /if \(job\.source === 'novel'\)[\s\S]{0,160}generateDirectImage/, '直连不得仅限 NovelAI');
assert.match(direct, /response\.status === 404[\s\S]*verified: false/, 'NovelAI 订阅检查 404 必须按兼容站降级处理');
assert.match(direct, /\['novel', 'openai', 'banana', 'seedream', 'comfy'\]/, '全部生图渠道必须进入前端优先链');

console.log('Storyboard connection hotfix contract OK');
