import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exportMarkdownCheck, itemBadges, rerenderCheck } from '../src/web/public/js/pages/history/format.js';

const [historySource, schedulerSource, mainSource, backendMainSource, collectorSource, aboutSource, outputSource, historyIndexSource, historyActionsSource, settingsIndexSource, rendererSource, fatalNoticesSource, wxdbSource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/history/format.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/scheduler.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/collector/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/about.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/output.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/history/actions.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/settings/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/fatal-notices.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8'),
]);

function visibleUiSource(source) {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .map(line => line.replace(/^\s*\/\/.*$/, '').replace(/\s+\/\/.*$/, ''))
    .filter(line => /\b(?:text|title|label|message|reason|placeholder|headline|description|missingMessage|too_large_message|search_text|error)\s*:|\b(?:message|detail|label|reason|error|postCommitStatusError)\s*=|\b(?:kv|toast|toastError|toastWarn|toastSuccess|beginAction|setStatus)\s*\(|(?:openStatus|status|maintainStatus)\.set\s*\(|\.textContent\s*=|\.title\s*=|(?:badges|notes)\.push\s*\(|(?:new\s+)?(?:Error|requestValidationError|requestAbortError)\s*\(/.test(line))
    .join('\n');
}

const visibleCopySource = [
  aboutSource,
  outputSource,
  historySource,
  historyIndexSource,
  historyActionsSource,
  settingsIndexSource,
  rendererSource,
  mainSource,
  backendMainSource,
  collectorSource,
  fatalNoticesSource,
].map(visibleUiSource).join('\n');

const pngOnlyItem = {
  digest_id: 'copy-version-png-only',
  history_item_key: 'copy-version-history-key',
  digest_status: 'legacy_png_only',
  digest_exists: false,
  file_version: 'file-v1',
  rerender_file_version: 'rerender-v1',
};

assert.deepEqual(
  itemBadges({ digest_status: 'legacy_png_only' }),
  [{ label: '仅含 PNG 的记录', tone: 'info' }],
  'PNG-only 历史徽标应描述记录内容,不能暗示前端版本',
);
assert.doesNotMatch(historySource, /旧版仅 PNG/, '历史页不得显示带前端版本暗示的 PNG 文案');
assert.match(historySource, /legacy_png_only/, '历史协议状态必须仍保留 legacy_png_only 识别值');
assert.deepEqual(
  exportMarkdownCheck(pngOnlyItem),
  { ok: false, reason: '这条记录没有摘要 JSON,不能导出 MD。' },
  'PNG-only 记录的导出提示应描述缺少摘要 JSON,不能暴露旧前端身份',
);
assert.deepEqual(
  rerenderCheck(pngOnlyItem),
  { ok: false, reason: '这条记录没有摘要 JSON,不能重渲染。' },
  'PNG-only 记录的重渲染提示应描述缺少摘要 JSON,不能暴露旧前端身份',
);
assert.doesNotMatch(historySource, /reason: '这条旧历史/, '历史操作提示不得使用旧历史身份措辞');
assert.doesNotMatch(historySource, /reason: '这条历史来自旧输出目录/, '历史操作提示不得把输出目录迁移概念直接展示给用户');

assert.match(schedulerSource, /失效调度游标/, '调度确认文案应使用中性失效状态');
assert.doesNotMatch(schedulerSource, /旧版调度游标/, '调度页不得显示带前端版本暗示的确认文案');
assert.match(schedulerSource, /clear-unverified-legacy-cursors/, '调度清理 API 路径不得改变');
assert.match(schedulerSource, /legacy_cursor_cleanup_token/, '调度清理协议令牌不得改变');
assert.match(mainSource, /页面资源需要手动刷新/, '版本闸门失败提示应描述页面资源状态和恢复动作');
assert.doesNotMatch(mainSource, /前端版本未刷新成功/, '版本闸门提示不得把前端版本身份直接展示给用户');
assert.match(mainSource, /页面资源已更新,正在刷新/, '版本闸门刷新提示应描述页面资源状态');
assert.doesNotMatch(mainSource, /本地页面版本已更新/, '版本闸门刷新提示不得把前端版本身份直接展示给用户');
assert.doesNotMatch(visibleUiSource(backendMainSource), /旧游标/, '后端返回页面的调度清理错误不得暴露迁移代际措辞');
assert.match(fatalNoticesSource, /当前服务尚未重新载入这些更改/, '服务源码变化提示应描述尚未重新载入的状态');
assert.doesNotMatch(fatalNoticesSource, /旧代码/, '服务源码变化提示不得展示旧代码身份');
assert.match(mainSource, /ASSET_VERSION/, '版本闸门内部协议仍必须保留');

assert.match(aboutSource, /页面资源标识/, '关于分区应使用页面资源标识');
assert.match(aboutSource, /页面资源信息/, '关于分区说明应使用页面资源语义');
assert.match(outputSource, /输出目录状态未就绪/, '输出目录错误应描述状态未就绪');
assert.match(historySource, /文件格式未知/, '历史文件未知徽标应描述真实文件格式');
assert.match(historySource, /非当前输出目录/, '历史记录应使用非当前输出目录语义');
assert.match(historyIndexSource, /非当前输出目录/, '历史详情和动作标题应使用非当前输出目录语义');
assert.match(historyActionsSource, /原目录文件保持不变/, '历史动作结果应使用原目录语义');
assert.doesNotMatch(outputSource, /旧目录/, '设置输出状态不得把其他输出目录描述成旧目录');
assert.doesNotMatch(visibleUiSource(rendererSource), /旧目录/, '历史渲染错误不得把其他输出目录描述成旧目录');
assert.doesNotMatch(
  visibleUiSource(backendMainSource),
  /(?:旧目录 PNG|旧目录上下文|走旧目录|旧导出文件)/,
  '后端历史/输出投影不得把其他输出目录描述成旧目录',
);
assert.match(settingsIndexSource, /设置已同步为其他窗口保存的最新设置/, '跨窗口同步提示应描述最新设置');
assert.match(settingsIndexSource, /页面已同步为最新设置/, '保存后的同步提示应描述最新设置');
assert.doesNotMatch(settingsIndexSource, /最新版本/, '设置页不得把设置新鲜度写成版本身份');
assert.match(wxdbSource, /phase: 'fetch_shard_sqlcipher_compat'[\s\S]*?label: '拉取消息 · 兼容消息库格式'/,
  '消息库兼容检查的首个进度阶段必须使用中性能力文案');
assert.doesNotMatch(visibleUiSource(wxdbSource), /旧式数据库/, '消息库兼容进度不得把格式兼容写成代际身份');
assert.match(rendererSource, /legacy_png_/, '仅长图历史的内部识别字段必须保留');
assert.match(rendererSource, /search_text: .*仅长图历史/, '仅长图历史的搜索文本应使用中性语义');
for (const forbidden of [/v2/i, /新版/, /旧版/, /前端版本/, /旧输出目录/, /版本未知/]) {
  assert.doesNotMatch(visibleCopySource, forbidden, `用户可见字符串不得包含 ${forbidden}`);
}
assert.match(historySource, /legacy_png_only/, '历史协议字段必须仍保留');
assert.match(outputSource, /getOutputDirIdentity/, '输出目录身份协议必须仍保留');

console.log('web user copy version-neutral tests passed');
