import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  QIANMU_PRODUCTION_PACKET_SCHEMA,
  adaptDirectorPlanToProductionPackets,
  canExposeProductionPacketToMainline,
  normalizeQianmuProductionPacket,
} from '../qianmu-production-packet.js';
import {
  STORYBOARD_SCHEMA_VERSION,
  adaptProductionPacketToStoryboardShotSpec,
  compileStoryboardPrompt,
} from '../qianmu-storyboard.js';

assert.equal(STORYBOARD_SCHEMA_VERSION, 24);

const plan = {
  story_status: { title: '厨房夜谈', cycle: '夜晚', mood: '克制' },
  quests: [{ id: 'q1', title: '寻找香料', objective: '确认缺失的香料' }],
  npc_updates: [{ id: 'n1', name: 'Alice', current_goal: '隐瞒来信', next_action: '把信塞进口袋' }],
  world_updates: [{ id: 'w1', title: '夜雨加重', content: '雨声盖过后巷脚步', scope: '餐厅街区' }],
  chain_reactions: [{ id: 'c1', spark: '停电', chain: '厨房安静 → Alice 注意到后门' }],
  relation_undercurrents: [{ id: 'r1', parties: ['Alice', 'Bob'], tension: '彼此试探', drift: '距离拉开' }],
};
const packets = adaptDirectorPlanToProductionPackets(plan, { chatKey: 'chat-a', floor: 12, sceneId: 'kitchen-night' });
assert.equal(packets.length, 5);
assert.ok(packets.every((packet) => packet.schema === QIANMU_PRODUCTION_PACKET_SCHEMA));
assert.equal(packets.find((packet) => packet.sourceRef.field === 'quests').track, 'main_camera');
assert.equal(packets.find((packet) => packet.sourceRef.field === 'quests').canonLevel, 'draft');
assert.ok(packets.filter((packet) => packet.sourceRef.field !== 'quests').every((packet) => packet.track === 'second_camera' && packet.canonLevel === 'director'));
assert.deepEqual(packets.find((packet) => packet.sourceRef.field === 'relation_undercurrents').characterState.map((item) => item.id), ['Alice', 'Bob']);
assert.ok(packets.every((packet) => packet.knowledgeScope.directorOnly), '推演适配结果默认只能停留在导演轨');
assert.ok(packets.every((packet) => !canExposeProductionPacketToMainline(packet, 'user')), '幕后事实不得自动泄露给正文角色');

const npcPacket = packets.find((packet) => packet.sourceRef.field === 'npc_updates');
const adaptedShot = adaptProductionPacketToStoryboardShotSpec(npcPacket);
assert.equal(adaptedShot.productionContext.packetId, npcPacket.packetId);
assert.equal(adaptedShot.productionContext.track, 'second_camera');
assert.equal(adaptedShot.productionContext.autoInsert, false, '导演轨镜头不得自动插入正文');
assert.equal(adaptedShot.shotRole, 'reaction');
assert.equal(adaptedShot.characters[0].id, 'Alice');
assert.match(adaptedShot.characters[0].temporaryState.join(' '), /把信塞进口袋/);

const compiled = compileStoryboardPrompt({ providerId: 'openai', modelId: 'custom-image-model', productionPacket: npcPacket });
assert.equal(compiled.productionContext.track, 'second_camera');
assert.equal(compiled.productionContext.autoInsert, false);
assert.match(compiled.prompt, /Alice/);

const perceived = normalizeQianmuProductionPacket({
  eventId: 'rain', track: 'second_camera', canonLevel: 'director', knowledgeScope: { directorOnly: true },
  perceivedConsequence: { summary: 'user 听见后巷异响', visibleTo: ['user'], evidenceRefs: ['p8'] },
});
assert.equal(canExposeProductionPacketToMainline(perceived, 'user'), true, '只有被当前视角真实感知的后果才能汇入正文');
assert.equal(canExposeProductionPacketToMainline(perceived, 'Alice'), false);

const mediaSafe = normalizeQianmuProductionPacket({
  eventId: 'safe', mediaRefs: ['asset-1'], imageData: 'data:image/png;base64,SHOULD_NOT_SURVIVE',
  sceneState: { location: 'kitchen', bytes: new Uint8Array([1, 2, 3]) },
});
assert.deepEqual(mediaSafe.mediaRefs, ['asset-1']);
assert.doesNotMatch(JSON.stringify(mediaSafe), /SHOULD_NOT_SURVIVE|imageData|bytes/, '制片包只能存媒体 ID，不得携带二进制');

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.match(indexSource, /productionPacket:[\s\S]*import\('\.\/qianmu-production-packet\.js\?v=1\.59\.52'\)/, '第二摄影机适配器必须保持按需加载');
assert.match(indexSource, /void refreshDirectorProductionPackets\(newPlan/, '制片包失败不得阻塞或回滚推演结果');
assert.match(indexSource, /productionPackets:\s*directorProductionPacketState\.packets\.length/, '开发诊断必须能核对会话内制片包缓存');

console.log('Second-camera production packet contract OK');
