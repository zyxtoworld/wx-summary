import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || '';
}

const digestMainRule = cssRule('.digest-main');
assert.match(
  digestMainRule,
  /grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)/,
  '摘要主列必须把隐式 auto 轨道改为可收缩的一列，不能让长运行时文本撑宽所有结果卡',
);

const progressCurrentRule = cssRule('.progress-current');
assert.match(progressCurrentRule, /min-width\s*:\s*0/, '当前群容器必须允许在摘要主列内收缩');
assert.match(progressCurrentRule, /overflow-wrap\s*:\s*anywhere/, '超长群名必须在当前群提示内断行');

const batchResultCardRule = cssRule('.batch-result-card');
assert.match(
  batchResultCardRule,
  /grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)/,
  '批次结果卡必须限制自己的网格列，不能按超长群名的 min-content 扩张',
);

const batchResultListRule = cssRule('.batch-result-list');
assert.match(
  batchResultListRule,
  /grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)/,
  '批次结果列表必须限制内部网格列，不能把超长群名的 min-content 重新传给外层',
);

const batchResultNameRule = cssRule('.batch-result-name');
assert.match(batchResultNameRule, /min-width\s*:\s*0/, '批次群名必须允许在状态标签之前收缩并省略');

const batchResultStatusRule = cssRule('.batch-result-status');
assert.match(batchResultStatusRule, /min-width\s*:\s*0/, '长失败状态必须允许在结果行内收缩');
assert.match(batchResultStatusRule, /max-width\s*:\s*62%/, '长失败状态必须给群名保留可见空间');
assert.match(batchResultStatusRule, /overflow-wrap\s*:\s*anywhere/, '长失败状态必须在自身宽度内断行');
assert.match(batchResultStatusRule, /word-break\s*:\s*break-all/, '无分隔错误码必须均匀填满行宽，不能把失败前缀拆成孤字');

const batchResultOkRule = cssRule('.batch-result-status.ok');
assert.match(batchResultOkRule, /white-space\s*:\s*nowrap/, '成功状态必须保持横向显示，不能被 flex 压成逐字竖排');
assert.match(batchResultOkRule, /flex\s*:\s*0\s+0\s+auto/, '成功状态必须保留完整的短标签宽度');

console.log('web digest long progress layout tests passed');
