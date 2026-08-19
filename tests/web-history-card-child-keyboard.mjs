import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/web/public/css/history.css', import.meta.url), 'utf8');

assert.doesNotMatch(source, /card\.setAttribute\('role',\s*'button'\)/,
  '包含子动作的历史卡片不得把整个 article 声明为 button');
assert.doesNotMatch(source, /card\.tabIndex\s*=\s*0/,
  '历史卡片的 Tab 停靠点必须由真实详情按钮承担');
assert.doesNotMatch(source, /card\.addEventListener\('keydown'/,
  '父卡不得截获子按钮 Enter/Space');
assert.match(source, /const openBtn = el\('button',\s*'history-card-open'\)/,
  '历史卡片必须提供独立的原生详情按钮');
assert.match(source, /openBtn\.dataset\.historyFocusAction = 'card'/,
  '详情按钮必须继续承载历史视图焦点身份');
assert.match(source, /openBtn\.addEventListener\('click',[\s\S]*?openDetail\(item\)/,
  '详情按钮必须打开当前卡片记录');
assert.match(source,
  /function scheduleCrossTabListReload\(\)[\s\S]*?await loadFirstPage\(\{ refresh: true \}\);[\s\S]*?if \(!page\.destroyed && !page\.detail\) await restorePersistedFocus\(\);/,
  '后到的列表重载完成后必须恢复已关闭详情的持久化焦点');
assert.match(css, /\.history-card-open\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?z-index:\s*1;/,
  '详情按钮必须覆盖卡片主区域');
assert.match(css, /\.history-related-chip\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*2;/,
  '关联/恢复子动作必须位于详情按钮上层并保持独立点击目标');

console.log('web history card child keyboard tests passed');
