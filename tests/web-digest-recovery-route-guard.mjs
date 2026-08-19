import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');

assert.match(
  source,
  /isRunning: \(\) => page\.generationStarting \|\| page\.running \|\| page\.saving\s*\|\| resultOperation\.isBusy\(\) \|\| recoveryAction\.isBusy\(\) \|\| textPreviewAction\.isBusy\(\)/,
  '摘要页运行态必须包含 PNG 保存、结果本地动作和未完成批次的恢复或取消动作',
);

const leaveStart = source.indexOf('async confirmLeaveWhileRunning()');
const leaveEnd = source.indexOf('\n    async init()', leaveStart);
assert.ok(leaveStart >= 0 && leaveEnd > leaveStart, '必须能定位摘要页离开守卫');
assert.match(
  source.slice(leaveStart, leaveEnd),
  /if \(recoveryAction\.isBusy\(\)\) \{[\s\S]*ui\.toastWarn\('正在恢复或取消未完成的摘要批次，请等待操作结束后再离开。'\);[\s\S]*return false;[\s\S]*\}/,
  '恢复 lease 未结算时必须 fail-closed 阻止路由，不能让请求静默留在已卸载页面',
);

console.log('web digest recovery route guard tests passed');
