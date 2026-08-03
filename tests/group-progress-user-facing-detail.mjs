import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const mirrorLabelsStart = appSource.indexOf('const GROUP_MIRROR_PROGRESS_LABELS');
const mirrorLabelsEnd = appSource.indexOf('function groupProgressOperationPrefix', mirrorLabelsStart);
assert.ok(mirrorLabelsStart >= 0 && mirrorLabelsEnd > mirrorLabelsStart, 'group mirror progress labels should exist');
const mirrorLabelsSource = appSource.slice(mirrorLabelsStart, mirrorLabelsEnd);
const mirrorLabels = new Function(`${mirrorLabelsSource}; return GROUP_MIRROR_PROGRESS_LABELS;`)();

const normalizeStart = appSource.indexOf('function normalizeGroupMirrorProgressText');
const normalizeEnd = appSource.indexOf('function groupProgressMirrorFileDetail', normalizeStart);
assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, 'group mirror progress normalizer should exist');
const normalizeSource = appSource.slice(normalizeStart, normalizeEnd);
const normalizeMirrorText = new Function(
  'normalizeDbCopyTermsForUsers',
  `${normalizeSource}; return normalizeGroupMirrorProgressText;`,
)(value => String(value || ''));

const mirrorFileStart = appSource.indexOf('function groupProgressMirrorFileDetail');
const mirrorFileEnd = appSource.indexOf('function groupProgressUserFacingDetail', mirrorFileStart);
assert.ok(mirrorFileStart >= 0 && mirrorFileEnd > mirrorFileStart, 'group mirror file progress formatter should exist');
const mirrorFileSource = appSource.slice(mirrorFileStart, mirrorFileEnd);
const mirrorFileFormatter = new Function(
  'formatByteSize',
  `${mirrorFileSource}; return groupProgressMirrorFileDetail;`,
)(value => `${Math.round(Number(value || 0) / 1024)} KB`);

const labelStart = appSource.indexOf('function groupProgressUserFacingLabel');
const labelEnd = appSource.indexOf('function normalizeDbCopyTermsForUsers', labelStart);
assert.ok(labelStart >= 0 && labelEnd > labelStart, 'group progress label formatter should exist');

const labelSource = appSource.slice(labelStart, labelEnd);
const labelFormatter = new Function(
  'groupProgressOperationPrefix',
  'GROUP_MIRROR_PROGRESS_LABELS',
  'normalizeGroupMirrorProgressText',
  `${labelSource}; return groupProgressUserFacingLabel;`,
)(
  () => '读取群列表',
  mirrorLabels,
  normalizeMirrorText,
);

const detailStart = appSource.indexOf('function groupProgressUserFacingDetail');
const detailEnd = appSource.indexOf('function groupProgressDisplayText', detailStart);
assert.ok(detailStart >= 0 && detailEnd > detailStart, 'group progress detail formatter should exist');

const detailSource = appSource.slice(detailStart, detailEnd);
const formatter = new Function(
  'groupProgressOperationPrefix',
  'groupProgressMirrorFileDetail',
  'normalizeDbCopyTermsForUsers',
  'normalizeGroupMirrorProgressText',
  `${detailSource}; return groupProgressUserFacingDetail;`,
)(
  () => '读取群列表',
  mirrorFileFormatter,
  value => String(value || ''),
  normalizeMirrorText,
);

assert.equal(formatter({
  phase: 'fetch_key_local',
  detail: '加密缓存候选 7 条 · 检查本地密钥缓存',
}), '优先复用上次验证结果，必要时自动重新检查');
assert.equal(formatter({
  phase: 'fetch_key_local_done',
  detail: '加密缓存候选 7 · 本地候选 12 · 文件 9',
}), '本地读取方式已准备，正在继续读取群列表');
assert.equal(formatter({
  phase: 'fetch_key_scan',
  detail: '扫描进程 2/4 · 候选 19 条',
}), '正在自动确认当前本地数据能否读取');
assert.equal(labelFormatter({
  phase: 'account_identity_sample_cached',
  label: '确认账号身份 · 复用未变化消息证据',
}), '读取群列表 · 复用账号确认结果');
assert.equal(formatter({
  phase: 'account_identity_sample_cached',
  detail: 'message_0.db：数据库、WAL 和一对一会话集合均未变化，无需再次解密',
}), '最近消息数据未变化，正在复用上次验证结果');
assert.equal(formatter({
  phase: 'account_identity_sample',
  detail: 'message_0.db：按文件从小到大验证本人发送者证据',
}), '正在核对当前账号与最近会话');
assert.equal(formatter({
  phase: 'account_identity_evidence_persist',
  detail: '正在加密保存已完成的消息分片复核证据；下次服务重启后会先验证内容指纹再复用',
}), '正在保存已完成的账号确认进度，便于下次继续');
assert.equal(labelFormatter({
  phase: 'mirror_publish_finalize',
  label: '检查本地数据 · 确认最终发布清单',
}), '读取群列表 · 完成本地数据更新');
assert.equal(formatter({
  phase: 'mirror_publish_finalize',
  detail: '旧硬链接代次已清理；正在复核文件集合、大小、时间和文件身份，不重复读取数据库内容',
}), '正在确认本地工作数据完整，完成后继续读取群列表');
assert.equal(labelFormatter({
  phase: 'fetch_shard_decrypt_plain_progress',
  label: '拉取消息 · 兼容读取消息库',
}), '读取群列表 · 准备最近消息数据');
assert.equal(formatter({
  phase: 'fetch_shard_decrypt_plain_progress',
  detail: 'message_0.db：已处理 8.0MB/74MB（10%）',
}), '已处理 8.0MB/74MB（10%）');
assert.equal(labelFormatter({
  phase: 'mirror_scope_copy_hash_progress',
  label: '检查本地数据 · 校验所需本地工作数据',
}), '读取群列表 · 校验数据完整性');
assert.equal(mirrorFileFormatter({
  phase: 'mirror_scope_copy_hash_progress',
  index: 7,
  total: 10,
  bytes_read: 1_500,
  total_bytes: 2_000,
  percent: 75,
  detail: '7/10 message/消息数据 · 1.4GB/1.5GB',
}), '第 7/10 项数据 · 本项 1 KB/2 KB · 75%');
assert.equal(labelFormatter({
  phase: 'mirror_retry_identity_rebind_done',
  label: '检查本地数据 · 可继续稳定捕获',
}), '读取群列表 · 上次稳定数据可继续使用');
assert.equal(labelFormatter({
  phase: 'mirror_scope_copy_start',
  label: '检查本地数据 · 更新账号身份范围',
}), '读取群列表 · 更新账号确认数据');
assert.equal(labelFormatter({
  phase: 'mirror_reuse_source_verify',
  label: '检查本地数据 · 复用前确认源库代次',
}), '读取群列表 · 确认微信数据稳定');
assert.equal(labelFormatter({
  phase: 'mirror_reuse',
  label: '检查本地数据 · 已是最新',
}), '读取群列表 · 已是最新');
assert.equal(formatter({
  phase: 'mirror_reuse',
  detail: '微信数据状态未变化，本地工作数据完整；本地工作数据一致，继续读取',
}), '微信数据状态未变化，本地工作数据完整');
const normalizedRuntimeDetail = normalizeMirrorText('本地工作数据仅因临时硬链接发生时间变化；已沿用此前验证的内容哈希；源库文件元数据未变化，没有新增分片，正在进行第 8/8 次一致性捕获');
for (const internalTerm of ['硬链接', '内容哈希', '源库文件元数据', '新增分片', '一致性捕获']) {
  assert.equal(normalizedRuntimeDetail.includes(internalTerm), false, `runtime progress must not expose ${internalTerm}`);
}

console.log('group progress user-facing detail tests passed');
