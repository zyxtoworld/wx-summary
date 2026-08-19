import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../src/web/public/css/app.css', import.meta.url),
  'utf8',
);
const mobileStart = css.indexOf('@media (max-width: 760px)');
const mobileEnd = css.indexOf('@media (max-width: 360px)', mobileStart);
const desktop = mobileStart >= 0 ? css.slice(0, mobileStart) : css;
const mobile = mobileStart >= 0 && mobileEnd > mobileStart
  ? css.slice(mobileStart, mobileEnd)
  : '';

assert.match(
  desktop,
  /\.account-menu\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\);[^}]*max-height:\s*min\(320px,\s*calc\(100vh - 123px\)\);/,
  '桌面账号菜单向上展开时，高度必须扣除底部账号与主题区，不能从低高度视口顶部溢出',
);
assert.ok(mobile, '应用壳必须存在移动端布局断点');
assert.match(
  mobile,
  /\.account-menu\s*\{[^}]*top:\s*calc\(100% \+ 6px\);[^}]*bottom:\s*auto;[^}]*max-height:\s*min\(320px,\s*calc\(100vh - 78px\)\);/,
  '移动端账号菜单向下展开时，高度必须扣除顶部锚点和底部安全间距，不能被低高度视口裁切',
);

console.log('web account menu low-height visibility tests passed');
