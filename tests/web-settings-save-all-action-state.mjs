import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettingsExternalActionControls } from '../src/web/public/js/pages/settings/external-action-controls.js';

const controls = createSettingsExternalActionControls();
const reload = { disabled: false };
const saveAll = { disabled: false };

controls.setBusy(true);
controls.register(reload, saveAll);
assert.equal(reload.disabled, true, '保存动作已经开始后才注册的重载按钮也必须立即禁用');
assert.equal(saveAll.disabled, true, '保存全部按钮必须与当前页面忙态同步');

controls.setBusy(false);
assert.equal(reload.disabled, false);
assert.equal(saveAll.disabled, false);

controls.setBusy(true);
assert.equal(reload.disabled, true);
assert.equal(saveAll.disabled, true);
controls.clear();
controls.setBusy(false);
assert.equal(reload.disabled, true, '销毁页面后不得继续改写已释放的控件');
assert.equal(saveAll.disabled, true);

const settingsSource = await readFile(
  new URL('../src/web/public/js/pages/settings/index.js', import.meta.url),
  'utf8',
);
assert.match(settingsSource, /externalActions:\s*createSettingsExternalActionControls\(\)/,
  '设置页必须持有页外动作控件协调器');
assert.match(settingsSource, /function syncBusy\(\)[\s\S]*?state\.externalActions\.setBusy\(busy\)/,
  '任意分区保存或检查的忙态必须同步到通知条动作');
assert.match(settingsSource, /state\.externalActions\.register\(reloadBtn, saveAllBtn\)/,
  '重新载入与保存全部按钮必须注册为页外动作控件');
assert.match(settingsSource, /page\.destroy = async[\s\S]*?state\.externalActions\.clear\(\)/,
  '页面销毁必须释放通知条控件引用');

console.log('web settings save-all action state tests passed');
