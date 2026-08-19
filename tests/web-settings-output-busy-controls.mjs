import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/settings');

const loader = createBrowserModuleLoader();
const controlsModule = await loader.load('js/shared/form-busy-controls.js');
assert.equal(typeof controlsModule.syncFormControlsDisabled, 'function',
  '输出分区必须复用 shared 编辑控件 busy 同步器');

const controls = Array.from({ length: 9 }, () => ({ disabled: false }));
controlsModule.syncFormControlsDisabled(controls, true);
assert.equal(controls.every(control => control.disabled === true), true,
  '保存期间主题、字号和输出字段必须全部禁用');

controlsModule.syncFormControlsDisabled(controls, false);
assert.equal(controls.every(control => control.disabled === false), true,
  '保存结束后必须恢复全部输出编辑控件');

const source = await readFile(new URL('../src/web/public/js/pages/settings/output.js', import.meta.url), 'utf8');
assert.match(source,
  /import \{ syncFormControlsDisabled \} from '\/js\/shared\/form-busy-controls\.js';/,
  '输出分区必须依赖 shared 表单忙态同步器');
assert.match(source,
  /syncFormControlsDisabled\(\[\s*\.\.\.themeBtns\.values\(\),\s*\.\.\.fontBtns\.values\(\),\s*dirInput,\s*retentionInput,\s*patternInput,?\s*\],\s*busy\);/,
  '生产 setBusy 必须锁定所有会被保存响应重绘的编辑控件');

console.log('web settings output busy controls tests passed');
