import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatGroupProgressText } from '../src/web/public/js/pages/digest/group-load-scope.js';

const mirrorDetail = {
  phase: 'mirror_publish_finalize',
  label: '检查本地数据 · 确认最终发布清单',
  detail: '旧硬链接代次已清理；正在复核文件集合、大小、时间和文件身份，不重复读取数据库内容',
};
const mirrorDisplay = formatGroupProgressText({ status: 'running', ...mirrorDetail });
assert.match(
  mirrorDisplay,
  /读取群列表 · 完成本地数据更新/,
  '镜像发布阶段的进度标题必须使用面向用户的群列表语义',
);
assert.match(
  mirrorDisplay,
  /正在确认本地工作数据完整，完成后继续读取群列表/,
  '镜像发布阶段不得把硬链接、文件身份等内部实现投影到页面',
);
assert.equal(
  formatGroupProgressText({
    status: 'running',
    phase: 'account_identity_sample_cached',
    detail: 'message_0.db：数据库、WAL 和一对一会话集合均未变化，无需再次解密',
  }),
  '读取群列表 · 复用账号确认结果：最近消息数据未变化，正在复用上次验证结果',
);
assert.equal(
  formatGroupProgressText({
    status: 'running',
    phase: 'fetch_shard_decrypt_plain_progress',
    label: '拉取消息 · 兼容读取消息库',
  }),
  '读取群列表 · 准备最近消息数据：正在准备本次读取所需数据',
);
assert.equal(
  formatGroupProgressText({
    status: 'running',
    phase: 'fetch_shard_decrypt_plain_progress',
    detail: 'message_0.db：已处理 8.0MB/74MB（10%）',
  }),
  '读取群列表 · 准备最近消息数据：已处理 8.0MB/74MB（10%）',
);

const display = formatGroupProgressText({
  status: 'running',
  phase: 'mirror_scope_copy_hash_progress',
  label: '检查本地数据 · 校验所需本地工作数据',
  detail: '7/10 message/消息数据 · 1.4GB/1.5GB',
  index: 7,
  total: 10,
  bytes_read: 1_500,
  total_bytes: 2_000,
  percent: 75,
  elapsed_ms: 61_000,
});
assert.match(display, /读取群列表 · 校验数据完整性/);
assert.match(display, /第 7\/10 项数据/);
assert.match(display, /75%/);
assert.match(display, /已耗时 1 分 01 秒/);
assert.equal(display.includes('message/消息数据'), false, '文件进度不得原样显示内部文件集合');
assert.equal(
  formatGroupProgressText({
    status: 'running',
    phase: 'mirror_reuse',
    detail: '临时硬链接发生时间变化；已沿用此前验证的内容哈希；源库文件元数据未变化，没有新增分片，正在进行一致性捕获',
  }).includes('硬链接'),
  false,
  '镜像复用进度不得显示硬链接、内容哈希等内部术语',
);

const [scopeSource, indexSource] = await Promise.all([
  readFile(new URL('../src/web/public/js/pages/digest/group-load-scope.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8'),
]);
assert.match(scopeSource, /export \{\s*formatGroupProgressText\s*\} from '\.\/group-progress-text\.js';/,
  '群列表进度协调器必须暴露同一用户语义 formatter 给生产页面');
assert.match(indexSource, /formatGroupProgressText[\s\S]*from '\.\/group-load-scope\.js';/,
  '摘要页必须通过群列表进度模块投影进度，不得复制第二套 formatter');

console.log('web digest group progress user-facing tests passed');
