import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('index.js', root), 'utf8');
const iconRendererSource = await readFile(new URL('qianmu-icon-renderer.js', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const readme = await readFile(new URL('README.md', root), 'utf8');
const license = await readFile(new URL('LICENSE', root), 'utf8');

assert.equal(manifest.version, '1.59.47');
assert.equal(packageJson.version, manifest.version, 'manifest 与 package 版本必须一致');
assert.equal(packageJson.license, 'PolyForm-Noncommercial-1.0.0');
assert.equal(manifest.js, `index.js?v=${manifest.version}`, '入口脚本必须按版本破除浏览器模块缓存');
assert.equal(manifest.css, `style.css?v=${manifest.version}`, '样式必须按版本破除浏览器缓存');
assert.equal(manifest.display_name, '千幕万象V2-导演剪辑版');
assert.equal(manifest.homePage, 'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git');
assert.match(readme, /https:\/\/github\.com\/Liminale-art\/qianmuwanxiang-V2-Directors-Cut\.git/);
assert.doesNotMatch(readme, /liminale1525\/Omniscene/);
assert.match(readme, /PolyForm Noncommercial License 1\.0\.0/);
assert.match(license, /^# PolyForm Noncommercial License 1\.0\.0/m);
assert.match(license, /^Required Notice: Copyright © 2026 Liminale-art\./m);
assert.doesNotMatch(license, /AGPL-3\.0-or-later/);
assert.match(source, /const VERSION = '1\.59\.47';/);

assert.match(source, /Symbol\.for\('qianmu\.omniscene\.runtime'\)/, '不同 URL 和安装目录必须共用一把运行锁');
assert.match(source, /function init\(\) \{\s*if \(initialized \|\| !acquireRuntimeOwnership\(\)\) return;\s*try \{/, '初始化必须先取得所有权并启用事务保护');
assert.match(source, /initialization failed[\s\S]*cleanupRuntime\(false\)/, '同步初始化失败必须回滚已绑定资源');
assert.match(source, /function cleanupRuntime\([\s\S]*if \(!isRuntimeOwner\(\)\) return;/, '重复模块不得清理活动实例');
assert.match(source, /finally \{\s*releaseRuntimeOwnership\(\);\s*\}/, '清理异常时也必须释放运行锁');
assert.match(source, /function releaseRuntimeOwnership\([\s\S]*globalThis\.qianmuDirectorInterceptor === qianmuDirectorInterceptor[\s\S]*delete globalThis\[RUNTIME_LOCK_KEY\]/, '只有所有者可移除自己的拦截器和运行锁');
assert.match(source, /function registerRuntimeInterceptor\([\s\S]*globalThis\.qianmuDirectorInterceptor = qianmuDirectorInterceptor/, '拦截器必须在取得所有权后注册');
assert.doesNotMatch(source, /globalThis\.qianmuDirectorInterceptor\s*=\s*async function/, '模块求值阶段不得覆盖其他实例的拦截器');

const updateHook = source.slice(source.indexOf('export async function onUpdate'), source.indexOf('export async function onDelete'));
assert.doesNotMatch(updateHook, /cleanupRuntime\(false\)/, 'ST 更新完成后旧模块必须存活到刷新，不能让悬浮入口提前消失');
assert.match(updateHook, /renderFloatButton\(\)[\s\S]*startFloatHostGuard\(\)/, '更新钩子必须保持当前悬浮入口可操作');
assert.doesNotMatch(updateHook, /\binit\(/, '更新钩子不得重新启动浏览器仍缓存的旧模块');
assert.match(source, /function scheduleStartupFallback\([\s\S]*setTimeout\([\s\S]*if \(!lifecycleHandled\) init\(\);[\s\S]*1500\)/, '旧版 SillyTavern 兼容启动必须延迟且受生命周期门控');
assert.match(source, /function handleLifecycle\(\)[\s\S]*lifecycleHandled = true;[\s\S]*cancelStartupFallback\(\)/, '新版生命周期必须取消兼容启动');
for (const hook of ['Activate', 'Enable', 'Disable', 'Update', 'Delete']) {
  assert.match(source, new RegExp(`export async function on${hook}\\(\\) \\{\\s*handleLifecycle\\(\\)`), `${hook} 必须先阻止兜底复活`);
}
assert.doesNotMatch(source, /setTimeout\(init,\s*0\)/, '不得保留不可取消的即时双启动');

const bindEvents = source.slice(source.indexOf('function bindEvents()'), source.indexOf('function init()'));
assert.ok(bindEvents.indexOf('if (!source?.on) return;') < bindEvents.indexOf('eventBound = true;'), '事件源未就绪时不得提前锁死绑定状态');

const guardStart = source.indexOf('function isRuntimeOwner()');
const guardEnd = source.indexOf('function ctx()');
assert.ok(guardStart >= 0 && guardEnd > guardStart);
const guardSource = source.slice(guardStart, guardEnd);
const sandbox = vm.createContext({ console: { warn() {} }, Date, Symbol });
const createGuard = vm.runInContext(`
  (RUNTIME_OWNER, RUNTIME_URL) => {
    const RUNTIME_LOCK_KEY = Symbol.for('qianmu.omniscene.runtime');
    const EXTENSION_NAME = 'test';
const VERSION = '1.54.0';
    let duplicateRuntimeWarned = false;
    async function qianmuDirectorInterceptor() {}
    ${guardSource}
    return {
      acquire: acquireRuntimeOwnership,
      register: registerRuntimeInterceptor,
      release: releaseRuntimeOwnership,
      owns: isRuntimeOwner,
      interceptor: qianmuDirectorInterceptor,
    };
  }
`, sandbox);

const first = createGuard(Symbol('first'), 'index.js?v=1.54.0');
const duplicate = createGuard(Symbol('duplicate'), 'index.js?v=1.54.0&copy=2');
assert.equal(first.acquire(), true);
first.register();
assert.equal(first.owns(), true);
assert.equal(duplicate.acquire(), false, '第二个 URL 模块实例必须保持静默');
duplicate.release();
assert.equal(first.owns(), true, '重复实例的生命周期不得释放活动实例');
first.release();
assert.equal(first.owns(), false);
assert.equal(duplicate.acquire(), true, '原实例清理后，启用中的另一个实例可以接管');
duplicate.register();
assert.equal(duplicate.owns(), true);
duplicate.release();

for (const removedPath of ['qianmu-icons.js', 'assets/qianmu-phosphor-icons.svg', 'assets/qianmu-phosphor-v1454.svg']) {
  await assert.rejects(access(new URL(removedPath, root)), undefined, `${removedPath} 不得出现在稳定版`);
}
assert.match(source, /qianmu-icon-renderer\.js\?v=1\.59\.47/, '稳定版必须按版本加载局部图标渲染器');
assert.match(source, /qianmu-storyboard\.js\?v=1\.59\.47/, '分镜数据契约必须随发布版本破除子模块缓存');
assert.doesNotMatch(source, /qianmu-icons\.js|installQianmuIconSystem/, '稳定版不得恢复旧图标系统');
assert.doesNotMatch(iconRendererSource, /\bMutationObserver\b/, '局部图标渲染器不得观察全页 DOM');

console.log('Startup stability contract OK');
