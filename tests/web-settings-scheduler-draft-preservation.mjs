import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

globalThis.location = new URL('http://wx-summary.test/#/settings');

const loader = createBrowserModuleLoader();
const scheduler = await loader.load('js/pages/settings/scheduler.js');
const source = await fs.readFile(
  new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url),
  'utf8',
);

assert.equal(typeof scheduler.applySchedulerMutationResult, 'function',
  '调度分区必须提供保留草稿的 mutation 回填路径');

const settings = { settings_revision: 'synthetic-revision' };
const calls = [];
const applied = scheduler.applySchedulerMutationResult((value, options) => {
  calls.push({ value, options });
}, settings);

assert.equal(applied, true, 'mutation 回填必须调用分区设置应用器');
assert.deepEqual(calls, [{ value: settings, options: { preserveDirty: true } }],
  '调度维护响应回填时必须保留其他尚未保存的草稿');

assert.equal(
  (source.match(/applySchedulerMutationResult\(applySettings, page\.getSettings\(\)\);/g) || []).length,
  3,
  '白名单保存、调度保存和清理未绑定引用都必须走保留草稿的回填路径',
);
assert.doesNotMatch(
  source,
  /applySettings\(page\.getSettings\(\), \{ preserveDirty: false \}\);/,
  '调度分区成功 mutation 不得用 preserveDirty:false 擦除另一份草稿',
);

console.log('web settings scheduler draft preservation tests passed');
