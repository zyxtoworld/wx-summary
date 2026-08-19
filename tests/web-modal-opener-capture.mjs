import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/ui/modal.js', import.meta.url),
  'utf8',
);

const openerCapture = source.indexOf('const opener = document.activeElement;');
const overlayMount = source.indexOf('modalRoot().appendChild(overlay);');

assert.ok(openerCapture >= 0, '弹层必须记录触发控件');
assert.ok(
  openerCapture < overlayMount,
  '必须在将 aria-modal 节点插入 DOM 前记录触发控件，否则浏览器可能先把焦点退回 body',
);
assert.match(
  source,
  /createDialogFocusManager\(\{ dialog, opener \}\)/,
  '对话框焦点管理器必须使用 DOM 插入前记录的 opener',
);

console.log('web modal opener capture tests passed');
