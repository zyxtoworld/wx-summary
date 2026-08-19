import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');

assert.match(
  source,
  /import\s*\{\s*captureActionFocus\s*,\s*restoreActionFocus\s*\}\s*from '\/js\/shared\/action-focus\.js'/,
  '摘要生成必须复用共享焦点恢复原语，不能复制第二套焦点判定',
);

const start = source.indexOf('async function startGeneration(previewText)');
const end = source.indexOf('async function cancelGeneration', start);
assert.ok(start >= 0 && end > start, '必须能定位摘要生成生命周期');
const generation = source.slice(start, end);

const captureIndex = generation.indexOf('const generationFocusTarget = captureActionFocus(');
const lockIndex = generation.indexOf('lockInputs(true);');
const unlockIndex = generation.indexOf('lockInputs(false);');
const restoreIndex = generation.lastIndexOf('restoreActionFocus(generationFocusTarget');

assert.ok(captureIndex >= 0 && captureIndex < lockIndex, '必须在禁用触发控件前捕获生成焦点');
assert.match(
  generation,
  /captureActionFocus\(\[generateBtn, previewBtn\], activeElement\)[\s\S]*?root\.contains\(activeElement\)[\s\S]*?previewText \? previewBtn : generateBtn/,
  '点击按钮应恢复原触发项，快捷键从页内控件启动时应回落到对应生成按钮',
);
assert.ok(unlockIndex >= 0 && unlockIndex < restoreIndex, '生成结束必须先启用控件，再安全恢复焦点');
assert.match(
  generation,
  /restoreActionFocus\(generationFocusTarget,\s*\{[\s\S]*?activeElement:\s*globalThis\.document\?\.activeElement,[\s\S]*?body:\s*globalThis\.document\?\.body/,
  '恢复时必须只在焦点仍丢失到 body 的情况下执行，不能抢走用户主动移动的焦点',
);
assert.match(
  generation,
  /if \(!generationAdmitted && !page\.destroyed\) \{[\s\S]*?restoreActionFocus\(generationFocusTarget/,
  '生成启动过期且页面已销毁时不得把焦点恢复到旧页面 DOM',
);

console.log('web digest generation focus restoration tests passed');
