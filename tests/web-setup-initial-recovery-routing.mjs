import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/setup/index.js', import.meta.url),
  'utf8',
);

const mountStart = source.indexOf('async mount(root, ctx)');
const mountEnd = source.indexOf('\n  async unmount()', mountStart);
assert.ok(mountStart >= 0 && mountEnd > mountStart, '必须能定位向导 mount 流程');
const mountSource = source.slice(mountStart, mountEnd);
assert.doesNotMatch(
  mountSource,
  /await page\.recoverPendingSettingsMutations\(\)/,
  '待确认设置恢复不得阻塞向导 mount 和后续路由导航',
);
assert.match(
  mountSource,
  /page\.startInitialRecovery\(\)/,
  '向导必须显式启动受页面生命周期管理的后台恢复',
);

assert.match(source, /initializing:\s*true/, '向导必须显式记录首屏恢复状态');
assert.match(
  source,
  /function stepBusy\(\)[\s\S]*?page\.initializing/,
  '首屏恢复期间向导步骤控件必须 fail-closed',
);
assert.match(
  source,
  /page\.startInitialRecovery\s*=\s*\(\)\s*=>\s*\{[\s\S]*?refreshButtons\(\)[\s\S]*?recoverPendingSettingsMutations\(\)\.then\([\s\S]*?!page\.destroyed[\s\S]*?page\.render\(\)/,
  '后台恢复只能在页面仍存活时落地步骤 UI',
);
assert.match(source, /noticeText:\s*''/,
  '向导必须在页面状态内持有页面提示');
assert.match(source, /noticeKind:\s*'info'/,
  '向导页面提示必须持有可测试的提示语义');
assert.match(
  source,
  /recovered\.cleared[\s\S]*?showPageNotice\('info', '已核对上次未确认的设置写入/,
  '恢复成功必须写入向导自己的页面提示',
);
assert.match(
  source,
  /setup-page-notice[\s\S]*?page\.noticeText/,
  '恢复成功提示必须渲染成向导内联状态，不能覆盖向导卡片',
);
const recoveryStart = source.indexOf('page.recoverPendingSettingsMutations = async () =>');
const recoveryEnd = source.indexOf('\n\n  page.destroy =', recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, '必须能定位向导恢复函数');
assert.doesNotMatch(
  source.slice(recoveryStart, recoveryEnd),
  /ctx\.ui\.toast(?:Warn|Error|Success)?\(/,
  '本页恢复结果的成功和失败分支都不得使用会覆盖窄屏向导内容的全局 toast',
);
assert.match(
  source.slice(recoveryStart, recoveryEnd),
  /catch \(error\)[\s\S]*?showPageNotice\('warn', `上次设置写入尚未核对:/,
  '恢复失败必须保留 marker，并把可操作错误写入向导内联警告',
);
assert.match(
  source,
  /page\.confirmLeave\s*=\s*createSetupLeaveGuard\(\(\)\s*=>\s*\(\{[\s\S]*?busy:\s*!page\.initializing\s*&&\s*stepBusy\(\)/,
  '只有用户操作忙态才需要离开确认，纯首屏恢复必须允许直接离开',
);
assert.match(source, /page\.destroy[\s\S]*?abortController\.abort\(\)/,
  '离开向导必须中止首屏恢复请求');

console.log('web setup initial recovery routing tests passed');
