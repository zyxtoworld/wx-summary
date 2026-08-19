import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [appCss, historySource, modalSource] = await Promise.all([
  readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/ui/modal.js', import.meta.url), 'utf8'),
]);

// 只计算本契约需要的简单类选择器。危险动作会同时带 btn-ghost 与
// btn-danger；这里锁定普通态最终背景，避免白字落到透明底上而看似空按钮。
function cascadedDeclaration(css, classNames, property) {
  const classes = new Set(classNames);
  let winner = null;
  let order = 0;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',');
    const declarations = Object.fromEntries(
      [...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)]
        .map(entry => [entry[1].trim(), entry[2].trim()]),
    );
    if (!(property in declarations)) {
      order += 1;
      continue;
    }
    for (const rawSelector of selectors) {
      const selector = rawSelector.trim();
      if (!selector || /\s/.test(selector)) continue;
      const excluded = [...selector.matchAll(/:not\(\.([\w-]+)\)/g)].map(entry => entry[1]);
      if (excluded.some(name => classes.has(name))) continue;
      const reduced = selector.replace(/:not\(\.[\w-]+\)/g, '');
      if (/:/.test(reduced) || /[#\[>+~]/.test(reduced)) continue;
      const required = [...reduced.matchAll(/\.([\w-]+)/g)].map(entry => entry[1]);
      if (!required.length || required.some(name => !classes.has(name))) continue;
      const specificity = required.length + excluded.length;
      if (!winner || specificity > winner.specificity
        || (specificity === winner.specificity && order >= winner.order)) {
        winner = { value: declarations[property], specificity, order };
      }
    }
    order += 1;
  }
  return winner?.value || '';
}

assert.match(
  historySource,
  /primary \? 'btn-primary' : 'btn-ghost'[\s\S]*?danger \? ' btn-danger'/,
  '历史详情危险动作仍会组合 ghost 与 danger 类，CSS 必须明确定义危险态优先级',
);
assert.match(
  modalSource,
  /action\.kind === 'primary' \? 'btn-primary' : 'btn-ghost'[\s\S]*?action\.danger \? ' btn-danger'/,
  '确认弹层危险动作仍会组合 ghost 与 danger 类，CSS 必须明确定义危险态优先级',
);

const classes = ['btn', 'btn-sm', 'btn-ghost', 'btn-danger'];
assert.notEqual(
  cascadedDeclaration(appCss, classes, 'background'),
  'transparent',
  '危险按钮普通态不得被 btn-ghost 覆盖成透明背景，否则白色文字在浅色弹层中不可见',
);

console.log('web danger button visibility tests passed');
