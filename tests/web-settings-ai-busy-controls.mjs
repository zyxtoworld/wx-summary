import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/settings');

const aiSource = await readFile(new URL('../src/web/public/js/pages/settings/ai.js', import.meta.url), 'utf8');
assert.match(aiSource,
  /import \{ syncFormControlsDisabled \} from '\/js\/shared\/form-busy-controls\.js';/,
  'AI 分区必须使用 shared 表单忙态同步器');
assert.match(aiSource,
  /syncFormControlsDisabled\(\[\s*\.\.\.providerBtns\.values\(\),\s*baseUrlInput,\s*apiKeyInput,\s*apiKeyToggle,\s*apiKeyClear,\s*modelInput,\s*longModelInput,\s*\.\.\.Object\.values\(advancedInputs\),\s*temperatureInput,?\s*\],\s*busy\);/,
  '生产 setBusy 必须锁定所有会被保存响应重绘的 AI 编辑控件');

const loader = createBrowserModuleLoader();
const controlsModule = await loader.load('js/shared/form-busy-controls.js');
assert.equal(typeof controlsModule.syncFormControlsDisabled, 'function');

const controls = Array.from({ length: 14 }, () => ({ disabled: false }));
controlsModule.syncFormControlsDisabled(controls, true);
assert.equal(controls.every(control => control.disabled === true), true,
  'AI 保存期间全部编辑控件必须禁用');

controlsModule.syncFormControlsDisabled(controls, false);
assert.equal(controls.every(control => control.disabled === false), true,
  'AI 保存结束后全部编辑控件必须恢复');

const preDisabled = { disabled: true };
controlsModule.syncFormControlsDisabled([preDisabled], true);
controlsModule.syncFormControlsDisabled([preDisabled], false);
assert.equal(preDisabled.disabled, true,
  'busy 结束后不得误启用原本就不可用的控件');

console.log('web settings AI busy controls tests passed');
