import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');

assert.match(
  source,
  /function finishRecoveryAction\(action, focusTarget\) \{[\s\S]*if \(!recoveryAction\.isCurrent\(action\)\) return false;[\s\S]*recoveryAction\.end\(action\);[\s\S]*const target = focusTarget\?\.isConnected && !focusTarget\.disabled[\s\S]*\? focusTarget[\s\S]*: pageTitle;[\s\S]*restoreActionFocus\(target,[\s\S]*activeElement: globalThis\.document\?\.activeElement,[\s\S]*body: globalThis\.document\?\.body/,
  '恢复动作必须集中释放 lease，并在触发按钮消失时回退到页面标题',
);

const recoveryStart = source.indexOf('async function checkInterruptedRecovery()');
const recoveryEnd = source.indexOf('\n  async function recoverImageBatchResults', recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, '必须能定位中断批次恢复卡片生命周期');
const recovery = source.slice(recoveryStart, recoveryEnd);

for (const [label, startMarker, endMarker] of [
  ['放弃并取消', "discardBtn.addEventListener('click'", "recoverBtn.addEventListener('click'"],
  ['恢复结果', "recoverBtn.addEventListener('click'", null],
]) {
  const start = recovery.indexOf(startMarker);
  const end = endMarker ? recovery.indexOf(endMarker, start) : recovery.length;
  assert.ok(start >= 0 && end > start, `必须能定位${label}动作`);
  const action = recovery.slice(start, end);
  assert.match(
    action,
    /const actionFocusTarget = captureActionFocus\(\[recoverBtn, discardBtn\], globalThis\.document\?\.activeElement\);/,
    `${label}必须在禁用按钮前捕获触发焦点`,
  );
  assert.match(action, /finishRecoveryAction\(action, actionFocusTarget\);/, `${label}所有结算分支必须走统一焦点收尾`);
}

const rawEndCalls = recovery.match(/recoveryAction\.end\(action\);/g) || [];
assert.equal(rawEndCalls.length, 0, '恢复卡片分支不得绕过统一焦点收尾直接释放 lease');

console.log('web digest recovery focus tests passed');
