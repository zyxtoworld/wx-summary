import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [collectorSource, wxdbSource, mainSource, settingsSource, discoverySource, schedulerSource] = await Promise.all([
  readFile(new URL('../src/collector/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/config/settings.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wxenv/discovery.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/daemon/scheduler.js', import.meta.url), 'utf8'),
]);

function sourceWithoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\/\/.*$/, '').replace(/\s+\/\/.*$/, ''));
}

// 只提取会形成进度/API/错误投影的 sink 及其短调用窗口;
// 不对内部 legacy/v2 字段做禁用扫描。
function visibleBackendProjection(source) {
  const lines = sourceWithoutComments(source);
  const starts = /\b(?:label|detail|error|message|too_large_message)\s*:|notifyProgress\s*\(|(?:new\s+)?Error\s*\(|requestValidationError\s*\(|outputDirCommitBarrier\s*\(|console\.(?:log|warn|error)\s*\(/;
  const picked = new Set();
  lines.forEach((line, index) => {
    if (!starts.test(line)) return;
    for (let next = index; next <= Math.min(lines.length - 1, index + 8); next += 1) picked.add(next);
  });
  return [...picked].sort((a, b) => a - b).map(index => lines[index]).join('\n');
}

const visibleProjection = [collectorSource, wxdbSource, mainSource, settingsSource, discoverySource, schedulerSource]
  .map(visibleBackendProjection)
  .join('\n');

for (const forbidden of [
  /旧版/, /新版/, /旧版本/, /新版本/, /旧服务/, /旧输出目录/,
  /旧代码/, /本地页面版本/, /旧配置/, /旧规则/, /旧白名单/, /旧后台检查/,
  /旧账号标识/, /旧格式/, /旧字段/, /旧引用/, /旧存储目录/, /旧别名/, /旧 ID/,
]) {
  assert.doesNotMatch(visibleProjection, forbidden, `后端用户可见投影不得包含 ${forbidden}`);
}

// 协议/兼容实现仍须存在;本门禁只约束投影文案。
assert.match(collectorSource, /fetch_key_legacy_migrate_skipped/);
assert.match(collectorSource, /legacy_manual_key_policy_forbidden/);
assert.match(wxdbSource, /codec_context_scan/);
assert.match(mainSource, /history_rerender_source_too_large/);
assert.match(mainSource, /outputDirCommitBarrier/);
assert.match(settingsSource, /legacy_manual_key/);
assert.match(discoverySource, /project mirror|项目副本/i);
assert.match(schedulerSource, /schedulerRefIsUnscoped/, '调度内部未绑定引用识别逻辑必须保留');

console.log('backend user copy version-neutral tests passed');
