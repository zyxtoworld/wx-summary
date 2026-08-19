import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const setupSource = await readFile(new URL('../src/web/public/js/pages/setup/index.js', import.meta.url), 'utf8');
const keySource = await readFile(new URL('../src/web/public/js/pages/setup/step-key.js', import.meta.url), 'utf8');
const skipSource = await readFile(new URL('../src/web/public/js/pages/setup/skip-action.js', import.meta.url), 'utf8');

assert.match(setupSource, /if \(page\.stepIndex === 1\) \{[\s\S]*?skipVisible = true;/,
  'AI 步骤必须显示跳过按钮,不能把 beforeNext 当成可跳过门槛');
assert.match(setupSource, /createSetupSkipAction\([\s\S]*?button: skipBtn[\s\S]*?confirmDialog:/,
  'AI 步骤的跳过按钮必须接入统一的防重复动作边界');
assert.match(skipSource, /if \(stepIndex === 1\) \{[\s\S]*?confirmDialog\([\s\S]*?跳过 AI 接入[\s\S]*?gotoStep\(stepIndex \+ 1\)/,
  'AI 步骤的跳过动作必须经过确认并只推进捕获时的下一步');
assert.match(setupSource, /if \(page\.stepIndex === 2\) \{[\s\S]*?skipVisible = !\(step\?\.canContinue\?\.\(\) === true\)/,
  '数据库密钥步骤仍应只在未满足条件时显示跳过按钮');
assert.doesNotMatch(keySource, /const skipBtn = el\('button',[\s\S]*?跳过,稍后再说/,
  '密钥步骤不得再提供与向导底部重复的第二个跳过入口');
assert.doesNotMatch(keySource, /跳过,稍后再说/,
  '密钥步骤的阻塞提示不得继续指向已删除的第二个跳过入口');
assert.match(keySource, /blockedMessage[\s\S]*?跳过本步/,
  '密钥步骤的阻塞提示必须指向编排层唯一的跳过按钮');
assert.match(setupSource, /setup-page-notice[\s\S]*?role[\s\S]*?status[\s\S]*?aria-live[\s\S]*?polite/,
  '向导编排层必须提供固定的页面内联 live status');
const noticeStart = setupSource.indexOf('function showPageNotice(');
const noticeEnd = setupSource.indexOf('\n  function gotoStep(', noticeStart);
assert.ok(noticeStart >= 0 && noticeEnd > noticeStart, '必须能定位向导页面提示函数');
assert.match(setupSource.slice(noticeStart, noticeEnd), /if \(page\.destroyed\) return;/,
  '向导页面提示在 unmount 后必须停止写 DOM');
assert.match(skipSource, /if \(stepIndex === 2\) \{[\s\S]*?gotoStep\(stepIndex \+ 1\)[\s\S]*?showNotice\('warn', '已跳过数据库密钥验证/,
  '数据库密钥跳过结果必须在目标步骤内联显示');
assert.match(setupSource,
  /applyAccountIdentityUpgrade[\s\S]*?showPageNotice\('info', '微信账号身份已更新,已同步最新账号信息。', \{ carryToNextStep: true \}\)/,
  '账号身份升级反馈必须明确声明只跨下一次切步保留');
const gotoStart = setupSource.indexOf('function gotoStep(index,');
const gotoEnd = setupSource.indexOf('\n  async function goNext()', gotoStart);
assert.ok(gotoStart >= 0 && gotoEnd > gotoStart, '必须能定位向导切步函数');
const gotoSource = setupSource.slice(gotoStart, gotoEnd);
assert.match(gotoSource, /keepNotice \|\| page\.noticeCarryToNextStep/,
  '切步必须保留显式请求或待跨步反馈');
assert.match(gotoSource, /page\.noticeCarryToNextStep = false/,
  '跨步反馈必须在一次切步后消费，不能污染后续步骤');
assert.doesNotMatch(setupSource, /ctx\.ui\.toast(?:Warn|Error|Success)?\(/,
  '向导编排层反馈不得使用会覆盖窄屏卡片的全局 toast');

console.log('web setup skip flow tests passed');
