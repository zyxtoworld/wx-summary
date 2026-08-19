import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');

function extractBeforeUnloadAssignment(sourceText) {
  const marker = 'page.onBeforeUnload = event => {';
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, '总结页必须注册 beforeunload 处理器');
  const open = sourceText.indexOf('{', start + marker.length - 1);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      const end = sourceText.indexOf(';', index);
      assert.ok(end > index, 'beforeunload 处理器必须完整结束');
      return sourceText.slice(start, end + 1);
    }
  }
  throw new Error('beforeunload 处理器函数体未闭合');
}

const assignment = extractBeforeUnloadAssignment(source);
const createBeforeUnload = new Function(
  'page',
  'resultOperation',
  'recoveryAction',
  'textPreviewAction',
  'digestDraftPersistenceRisk',
  `${assignment}; return page.onBeforeUnload;`,
);

function runCase({ label, page = {}, resultBusy = false, recoveryBusy = false, textPreviewBusy = false, draftRisk = false }) {
  const target = {
    generationStarting: false,
    running: false,
    saving: false,
    ...page,
  };
  const calls = { preventDefault: 0 };
  const handler = createBeforeUnload(
    target,
    { isBusy: () => resultBusy },
    { isBusy: () => recoveryBusy },
    { isBusy: () => textPreviewBusy },
    () => draftRisk,
  );
  const event = {
    returnValue: undefined,
    preventDefault() { calls.preventDefault += 1; },
  };
  handler(event);
  return { label, target, event, calls };
}

for (const result of [
  runCase({ label: '启动准备中', page: { generationStarting: true } }),
  runCase({ label: '摘要生成中', page: { running: true } }),
  runCase({ label: '恢复动作中', recoveryBusy: true }),
  runCase({ label: '草稿持久化失败', draftRisk: true }),
]) {
  assert.equal(result.calls.preventDefault, 1, `${result.label}必须阻止浏览器卸载`);
  assert.equal(result.event.returnValue, '', `${result.label}必须设置原生离页提示值`);
}

const idle = runCase({ label: '空闲' });
assert.equal(idle.calls.preventDefault, 0, '空闲总结页不得无条件触发离页提示');
assert.equal(idle.event.returnValue, undefined, '空闲总结页不得改写离页提示值');

const resultBusy = runCase({ label: '结果操作中', resultBusy: true });
assert.equal(resultBusy.calls.preventDefault, 1, '结果操作期间必须继续阻止浏览器卸载');
assert.equal(resultBusy.event.returnValue, '', '结果操作期间必须设置原生离页提示值');

console.log('digest beforeunload guard checks passed');
