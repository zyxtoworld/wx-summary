import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { revealHistoryDetailStatus } from '../src/web/public/js/pages/history/detail-status.js';

const scheduled = [];
const statusElement = {
  isConnected: true,
  calls: [],
  scrollIntoView(options) { this.calls.push(options); },
};

assert.equal(revealHistoryDetailStatus(statusElement, {
  schedule: callback => scheduled.push(callback),
  isActive: () => true,
}), true);
assert.equal(statusElement.calls.length, 0, '状态写入同步阶段不得打断当前按钮事件');
scheduled.shift()();
assert.deepEqual(statusElement.calls, [{ block: 'nearest', inline: 'nearest' }],
  '下一渲染帧必须用最小滚动让有限高度的状态区进入详情正文视口');

statusElement.calls.length = 0;
revealHistoryDetailStatus(statusElement, {
  schedule: callback => scheduled.push(callback),
  isActive: () => false,
});
scheduled.shift()();
assert.equal(statusElement.calls.length, 0, '详情已关闭或页面卸载后不得写滚动位置');

statusElement.isConnected = false;
revealHistoryDetailStatus(statusElement, {
  schedule: callback => scheduled.push(callback),
  isActive: () => true,
});
scheduled.shift()();
assert.equal(statusElement.calls.length, 0, '状态节点已被重绘移除后不得写滚动位置');

const source = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/web/public/css/history.css', import.meta.url), 'utf8');
assert.match(source,
  /import \{ revealHistoryDetailStatus \} from '\.\/detail-status\.js';/,
  '历史页必须依赖详情状态可见性 helper');
assert.match(source,
  /function setDetailStatus\(text, tone = ''\)[\s\S]*?if \(text\)[\s\S]*?revealHistoryDetailStatus\(detail\.statusEl,[\s\S]*?page\.detail === detail/,
  '详情状态写入后必须只为仍活动的详情安排可见性修正');
assert.match(source,
  /const setStatus = \(text, tone = ''\) => \{[\s\S]*?revealHistoryDetailStatus\(statusLine,[\s\S]*?modal\.el\?\.isConnected/,
  '重渲染状态写入后必须只为仍挂载的当前弹层安排可见性修正');
assert.match(source,
  /previewSlot\.replaceChildren\(el\('p', 'muted', '原摘要读取失败。请查看下方错误信息。'\)\);[\s\S]*?setStatus\(message, 'err'\)/,
  '重渲染读取失败时预览区应给短指引，完整错误只在状态区展示一次');
assert.match(css,
  /\.history-action-status\s*\{[\s\S]*?max-height:\s*min\(32vh,\s*160px\);[\s\S]*?overflow-y:\s*auto;/,
  '超长详情状态必须限制高度并在自身内部滚动，不能把已恢复焦点的操作按钮挤出正文视口');

console.log('web history detail status visibility tests passed');
