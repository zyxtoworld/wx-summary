import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const llmSource = await readFile(
  new URL('../src/web/public/js/pages/setup/step-llm.js', import.meta.url),
  'utf8',
);
const keySource = await readFile(
  new URL('../src/web/public/js/pages/setup/step-key.js', import.meta.url),
  'utf8',
);

for (const [label, source] of [['AI 步骤', llmSource], ['密钥步骤', keySource]]) {
  assert.match(source,
    /import \{ captureActionFocus, restoreActionFocus \} from '\/js\/shared\/action-focus\.js';/,
    `${label}必须复用共享动作焦点原语`);
}

assert.match(llmSource,
  /function beginLlmAction\(kind, focusCandidates = \[\]\)[\s\S]*focusTarget: captureActionFocus\(focusCandidates, globalThis\.document\?\.activeElement\)/,
  'AI 独占动作开始时必须记录实际聚焦的触发按钮');
assert.match(llmSource,
  /function finishLlmAction\(action\)[\s\S]*if \(activeAction !== action\) return false;[\s\S]*syncBusyControls\(\);[\s\S]*restoreActionFocus\(action\.focusTarget,[\s\S]*activeElement: globalThis\.document\?\.activeElement,[\s\S]*body: globalThis\.document\?\.body/,
  '只有当前 AI 动作可以在重新启用控件后恢复焦点');
assert.match(llmSource, /beginLlmAction\('获取模型列表', \[fetchModelsBtn\]\)/,
  '获取模型列表必须把自己的按钮注册为焦点恢复目标');
assert.match(llmSource, /beginLlmAction\('测试 AI 连接', \[testBtn\]\)/,
  '连通测试必须把自己的按钮注册为焦点恢复目标');

assert.match(keySource,
  /function restoreKeyActionFocus\(focusTarget\)[\s\S]*restoreActionFocus\(focusTarget,[\s\S]*activeElement: globalThis\.document\?\.activeElement,[\s\S]*body: globalThis\.document\?\.body/,
  '密钥步骤必须通过统一收尾恢复焦点且保留用户主动焦点');
assert.match(keySource,
  /function setProgress\(text, detail = ''\) \{\s*if \(w\.destroyed\) return;/,
  '密钥步骤销毁后不得由异步收尾重绘进度 DOM');
assert.match(keySource,
  /function setBusy\(next\) \{[\s\S]*?busy = next;\s*if \(w\.destroyed\) return;/,
  '密钥步骤销毁后不得由异步收尾改写按钮和输入框');
assert.match(keySource,
  /function restoreKeyActionFocus\(focusTarget\) \{\s*if \(w\.destroyed\) return;/,
  '密钥步骤销毁后不得恢复旧步骤焦点');

for (const [name, button] of [
  ['validateAndSave', 'validateSaveBtn'],
  ['validateSaved', 'validateSavedBtn'],
  ['retryAutoScan', 'scanBtn'],
]) {
  const start = keySource.indexOf(`async function ${name}`);
  const next = keySource.indexOf('\n  async function ', start + 1);
  const end = next >= 0 ? next : keySource.indexOf('\n  keyInput.addEventListener', start);
  const block = keySource.slice(start, end);
  assert.match(block,
    new RegExp(`const focusTarget = captureActionFocus\\(\\[${button}\\], globalThis\\.document\\?\\.activeElement\\)`),
    `${name} 必须捕获自己的触发按钮`);
  assert.match(block, /finally \{[\s\S]*restoreKeyActionFocus\(focusTarget\)/,
    `${name} 必须在完整异步链结束后恢复焦点`);
}

console.log('web setup action focus tests passed');
