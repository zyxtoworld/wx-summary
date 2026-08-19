import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);

const mountStart = source.indexOf('async mount(root, ctx)');
const mountEnd = source.indexOf('\n  async unmount()', mountStart);
assert.ok(mountStart >= 0 && mountEnd > mountStart, '必须能定位设置页 mount 流程');
const mountSource = source.slice(mountStart, mountEnd);

assert.doesNotMatch(
  mountSource,
  /await page\.init\(\)/,
  '设置文档首屏请求不得阻塞 mount 返回和后续路由导航',
);
assert.match(
  mountSource,
  /void page\.init\(\)/,
  '设置页必须显式启动由页面 AbortController 管理的后台初始化任务',
);

const initStart = source.indexOf('const initializationLifecycle = createSettingsInitializationLifecycle({');
const initEnd = source.indexOf('\n\n  store.set(\'accountSwitchGuard\'', initStart);
assert.ok(initStart >= 0 && initEnd > initStart, '必须能定位设置页初始化任务');
const initSource = source.slice(initStart, initEnd);
assert.match(initSource, /signal: pageAbort\.signal/, '设置首屏请求必须受页面卸载信号控制');
assert.match(
  initSource,
  /state\.destroyed \|\| generation !== state\.generation/,
  '设置首屏响应必须在写 DOM 前核对页面生命周期',
);
assert.match(
  source,
  /settings-recovery-notice[\s\S]*?role:\s*'status'[\s\S]*?'aria-live':\s*'polite'/,
  '设置恢复成功提示必须使用页面内联 live status',
);
assert.match(
  initSource,
  /recovered\??\.cleared[\s\S]*?recoveryNotice\.hidden\s*=\s*false/,
  '恢复成功后必须显示设置页自己的内联提示',
);
assert.doesNotMatch(
  initSource,
  /ui\.toast\([^)]*页面已同步最终状态/,
  '设置页恢复结果不得使用会覆盖窄屏分区导航的全局 toast',
);

console.log('web settings initial load routing tests passed');
