import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
const historySource = await readFile(
  new URL('../src/web/public/js/pages/history/index.js', import.meta.url),
  'utf8',
);

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有可定位签名`);
  const open = signatureEnd + 2;
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
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

function makeModalHarness() {
  let options = null;
  return {
    ui: {
      openModal(nextOptions) {
        options = nextOptions;
        return { close() {} };
      },
    },
    get options() { return options; },
  };
}

const closeCallbackError = new Error('页面弹层关闭回调失败');
const closeDiagnostics = [];
const originalConsoleError = console.error;
console.error = (...args) => closeDiagnostics.push(args);
try {
  const digestHarness = makeModalHarness();
  const digestModals = new Set();
  const digestOpenPageModal = new Function(
    'ui', 'pageModals',
    `${extractFunction(source, 'function openPageModal(')}; return openPageModal;`,
  )(digestHarness.ui, digestModals);
  digestOpenPageModal({ onClose: () => { throw closeCallbackError; } });
  assert.equal(digestModals.size, 1, '总结页弹层关闭前必须登记 owner');
  digestHarness.options.onClose();
  assert.equal(digestModals.size, 0, '总结页关闭回调异常也必须先释放弹层 owner');

  const historyHarness = makeModalHarness();
  const historyPage = { modals: new Set() };
  const historyOpenPageModal = new Function(
    'ui', 'page',
    `${extractFunction(historySource, 'function openPageModal(')}; return openPageModal;`,
  )(historyHarness.ui, historyPage);
  historyOpenPageModal({ onClose: () => { throw closeCallbackError; } });
  assert.equal(historyPage.modals.size, 1, '历史页弹层关闭前必须登记 owner');
  historyHarness.options.onClose();
  assert.equal(historyPage.modals.size, 0, '历史页关闭回调异常也必须先释放弹层 owner');
} finally {
  console.error = originalConsoleError;
}
assert.equal(closeDiagnostics.length, 2,
  '两个生产页面 wrapper 的关闭回调异常都必须可观测');
assert.deepEqual(closeDiagnostics.map(args => args[0]), [
  'page modal close callback failed',
  'page modal close callback failed',
]);
assert.equal(closeDiagnostics[0][1], closeCallbackError);

assert.match(source, /function openPageModal\(/, '总结页必须登记自己创建的页面弹层');
assert.match(source, /function closePageModals\(/, '总结页必须提供统一弹层清理入口');
assert.match(
  source,
  /function closePageModals\(\{ restoreFocus = true \} = \{\}\)[\s\S]*?entry\.modal\.close\(\{ restoreFocus \}\)/,
  '总结页弹层清理必须把关闭时的焦点策略传给统一 modal',
);
assert.match(
  source,
  /function openZoomModal\([\s\S]*?openPageModal\(/,
  '长图放大弹层必须纳入总结页生命周期',
);
assert.match(
  source,
  /function openCustomRangeModal\([\s\S]*?openPageModal\(/,
  '自定义时间弹层必须纳入总结页生命周期',
);
assert.match(
  source,
  /async destroy\(\) \{[\s\S]*?closePageModals\(\{ restoreFocus: false \}\);/,
  '总结页销毁时关闭弹层不得把焦点恢复到旧页面触发按钮',
);

console.log('web digest modal lifecycle tests passed');
