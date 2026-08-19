import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  textPreviewAccountSwitchBlockedMessage,
  textPreviewBusyHint,
  textPreviewLeaveConfirmation,
} from '../src/web/public/js/pages/digest/text-preview-action-feedback.js';

assert.equal(textPreviewBusyHint('copy'), '正在复制全文…');
assert.equal(
  textPreviewAccountSwitchBlockedMessage('copy'),
  '正在复制摘要全文，请等待复制结束后再切换账号。',
);
assert.deepEqual(textPreviewLeaveConfirmation('copy'), {
  title: '正在复制摘要全文',
  message: '摘要全文正在写入系统剪贴板，离开页面会取消复制。确定离开?',
  confirmLabel: '离开并取消复制',
});

assert.equal(textPreviewBusyHint('export'), '正在导出 Markdown…');
assert.equal(
  textPreviewAccountSwitchBlockedMessage('export'),
  'Markdown 正在写入本机文件，请等待导出结束后再切换账号。',
);
assert.deepEqual(textPreviewLeaveConfirmation('export'), {
  title: 'Markdown 正在导出',
  message: 'Markdown 正在写入本机文件，离开页面会取消导出。确定离开?',
  confirmLabel: '离开并取消导出',
});

assert.equal(textPreviewBusyHint('download'), '正在准备下载…');
assert.match(textPreviewAccountSwitchBlockedMessage('download'), /下载/);
assert.match(textPreviewLeaveConfirmation('download').message, /离开页面会取消下载/);

assert.equal(textPreviewBusyHint('unexpected'), '正在处理文本预览…');
assert.match(textPreviewAccountSwitchBlockedMessage('unexpected'), /文本预览操作/);
assert.match(textPreviewLeaveConfirmation('unexpected').title, /文本预览操作/);

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
assert.match(
  source,
  /textPreviewAccountSwitchBlockedMessage\(textPreviewAction\.snapshot\(\)\?\.kind\)/,
  '账号切换守卫必须按当前动作种类生成提示',
);
assert.match(
  source,
  /textPreviewBusyHint\(textPreviewAction\.snapshot\(\)\?\.kind\)/,
  '全局动作提示必须按当前动作种类生成文案',
);
assert.match(
  source,
  /textPreviewLeaveConfirmation\(textPreviewAction\.snapshot\(\)\?\.kind\)[\s\S]*?invalidateTextPreviewAction\('页面已离开'\)/,
  '离开守卫必须按当前动作种类确认，并在确认后使动作失效',
);

console.log('web text preview action feedback tests passed');
