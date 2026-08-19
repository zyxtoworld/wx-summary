import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/setup/step-llm.js', import.meta.url),
  'utf8',
);

assert.match(source,
  /function syncBusyControls\(\) \{[\s\S]*?control\.disabled = busy;[\s\S]*?w\.refreshButtons\(\);[\s\S]*?\}/,
  'AI 步骤必须通过统一入口同步表单、内部按钮和向导底部按钮');
assert.match(source,
  /function beginLlmAction\(kind, focusCandidates = \[\]\) \{[\s\S]*?if \(activeAction \|\| w\.destroyed\) return null;[\s\S]*?activeAction = action;[\s\S]*?syncBusyControls\(\)/,
  'AI 步骤已有动作时必须 fail-closed 拒绝并发动作');
assert.match(source,
  /function finishLlmAction\(action\) \{[\s\S]*?if \(activeAction !== action\) return false;[\s\S]*?activeAction = null;[\s\S]*?syncBusyControls\(\)/,
  '旧动作不得释放当前动作的忙态');

function operation(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `必须能定位 ${name}`);
  return source.slice(start, end);
}

for (const [name, nextName] of [
  ['fetchModels', 'testConnectivity'],
  ['testConnectivity', 'saveSettings'],
]) {
  const block = operation(name, nextName);
  assert.match(block, /const action = beginLlmAction\(/, `${name} 开始时必须取得独占动作并锁定全部控件`);
  assert.match(block, /if \(!action\) return false;/, `${name} 不得与已有动作并发`);
  assert.match(block, /finally \{[\s\S]*?finishLlmAction\(action\)/,
    `${name} 结束时只能释放自己持有的动作`);
}

const saveStart = source.indexOf('async function saveSettings');
const saveEnd = source.indexOf("fetchModelsBtn.addEventListener", saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart, '必须能定位 saveSettings');
const saveBlock = source.slice(saveStart, saveEnd);
assert.match(saveBlock, /const action = beginLlmAction\(/,
  'saveSettings 开始时必须取得独占动作并锁定全部控件');
assert.match(saveBlock, /if \(!action\) return false;/, 'saveSettings 不得与已有动作并发');
assert.match(saveBlock, /finally \{[\s\S]*?finishLlmAction\(action\)/,
  'saveSettings 结束时只能释放自己持有的动作');

assert.match(source, /onEnter\(\) \{[\s\S]*?beginLlmAction\('初始化 AI 设置'\)/,
  'AI 设置初始化期间必须锁定步骤，防止异步预填覆盖用户输入');
assert.match(source, /isBusy:\s*\(\) => !!activeAction/,
  '向导离开守卫与底部按钮必须读取同一个动作所有权');
assert.match(source,
  /function setProgress\(text, detail = ''\) \{\s*if \(w\.destroyed\) return;/,
  'LLM 步骤销毁后不得由异步收尾重绘进度 DOM');
assert.match(source,
  /function syncBusyControls\(\) \{\s*if \(w\.destroyed\) return;/,
  'LLM 步骤销毁后不得由异步收尾改写控件');
assert.match(source,
  /function finishLlmAction\(action\) \{[\s\S]*?activeAction = null;\s*if \(w\.destroyed\) return true;/,
  'LLM 步骤销毁后不得恢复旧步骤焦点');

console.log('web setup llm busy button tests passed');
