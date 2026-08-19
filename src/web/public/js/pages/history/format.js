// 历史页纯函数辅助:DOM 工厂、时间/数字格式化、状态徽章与操作资格判定。
// 只依赖 publicOutputItem 的公开字段(契约见 src/main.js 的 publicOutputItem)。

// 与后端 OUTPUT_FILE_EXPECTED_MISSING_VERSION 一致的哨兵值(src/renderer/output.js)。
export const EXPECTED_MISSING_FILE_VERSION = 'missing:v1';

// 与后端 HISTORY_RERENDER_PREVIEW_EXPECTED_WIDTH 一致(src/main.js:147)。
export const RERENDER_PREVIEW_EXPECTED_WIDTH = 2160;

export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// 本地动作 ID 必须符合服务端 /^[a-z0-9][a-z0-9_-]{5,80}$/i 约束。
export function createLocalActionId(kind = 'action') {
  const cleanKind = String(kind || 'action').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'action';
  const bytes = new Uint8Array(6);
  try { globalThis.crypto?.getRandomValues?.(bytes); } catch {}
  const random = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    || Math.random().toString(16).slice(2, 14);
  return `${cleanKind}_${Date.now().toString(36)}_${random}`;
}

export function accountIdOf(account) {
  return String(account?.id || account?.account_id || '').trim();
}

export function isMarkdownItem(item = {}) {
  if (String(item?.artifact_type || '').trim() === 'text_preview_md') return true;
  if (String(item?.file_type || '').trim() === 'markdown') return true;
  return String(item?.relative_path || '').trim().toLowerCase().endsWith('.md');
}

// 文件版本一律按字符串处理;file_exists === false 时后端用哨兵值参与版本校验。
export function itemExpectedFileVersion(item = {}) {
  if (item?.file_exists === false) return EXPECTED_MISSING_FILE_VERSION;
  return String(item?.file_version || '').trim();
}

export function itemExpectedDigestFileVersion(item = {}) {
  if (item?.digest_exists === false) return EXPECTED_MISSING_FILE_VERSION;
  return String(item?.digest_file_version || '').trim();
}

// 重渲染类操作的 PNG 版本:超大 PNG 走 rerender_file_version(索引 SHA256)通道。
export function itemRerenderFileVersion(item = {}) {
  return String(item?.rerender_file_version || '').trim() || itemExpectedFileVersion(item);
}

export function itemExportPolicyRevision(item = {}) {
  return String(item?.export_policy_revision || item?.export_settings_revision || '').trim();
}

export function itemOutputDirIdentity(item = {}) {
  return String(item?.output_dir_identity || '').trim();
}

export function historyItemStableKey(item = {}) {
  return String(item?.history_item_key || '').trim();
}

export function formatCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '';
  return String(Math.round(num));
}

// created_at 等时间是服务端本地格式("YYYY-MM-DD HH:mm:ss")或 ISO;统一成本地可读文本。
export function formatDateTime(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return text;
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 状态徽章
// ---------------------------------------------------------------------------
const BLOCKING_REASON_LABELS = Object.freeze({
  history_identity_invalid: '记录身份无效',
  file_missing: '文件缺失',
  file_changed: '文件已变化',
  file_version_unknown: '文件格式未知',
  digest_missing: '摘要缺失',
  digest_invalid: '摘要失效',
  digest_changed: '摘要已变化',
  digest_unreadable: '摘要不可读',
  digest_empty: '摘要为空',
  digest_mismatch: '摘要不匹配',
  digest_md_meta_missing: 'MD 元数据缺失',
  digest_md_meta_unreadable: 'MD 元数据不可读',
  policy_revision_changed: '隐私策略已变化',
});

export function blockingIssueLabel(reason = '') {
  const clean = String(reason || '').trim();
  if (!clean) return '问题项';
  if (BLOCKING_REASON_LABELS[clean]) return BLOCKING_REASON_LABELS[clean];
  if (clean.startsWith('digest_')) return `摘要异常(${clean.slice(7)})`;
  if (clean.startsWith('file_')) return `文件异常(${clean.slice(5)})`;
  return `问题:${clean}`;
}

// 每张卡片的角标列表:[{ label, tone }] tone: danger | warn | info。
// 与后端 historyItemBlockingIssueReason 同序,保证最重的问题优先显示。
export function itemBadges(item = {}) {
  const badges = [];
  if (item?.cancelled_after_commit === true) badges.push({ label: '取消后已提交', tone: 'warn' });
  if (item?.history_commit_failed === true) badges.push({ label: '提交失败', tone: 'danger' });
  if (item?.has_blocking_issue === true) {
    badges.push({ label: blockingIssueLabel(item?.blocking_issue_reason), tone: 'danger' });
    return badges; // blocking 已收敛全部问题,不再重复罗列
  }
  if (item?.file_exists === false) badges.push({ label: '文件缺失', tone: 'danger' });
  if (item?.file_stale === true || item?.file_version_stale === true) badges.push({ label: '文件已变化', tone: 'danger' });
  if (item?.file_version_unknown === true) badges.push({ label: '文件格式未知', tone: 'warn' });
  if (item?.digest_invalid === true) {
    badges.push({ label: '摘要失效', tone: 'danger' });
  } else if (String(item?.digest_status || '').trim() === 'legacy_png_only'
    || String(item?.digest_missing_reason || '').trim() === 'legacy_png_only') {
    badges.push({ label: '仅含 PNG 的记录', tone: 'info' });
  }
  if (item?.history_current === false) badges.push({ label: '非当前输出目录', tone: 'info' });
  if (item?.complete === false) badges.push({ label: '不完整', tone: 'warn' });
  return badges;
}

// ---------------------------------------------------------------------------
// 操作资格(与后端 modeError / 版本前置条件一一对应;禁用原因用于按钮 title)
// ---------------------------------------------------------------------------
function baseLookupReady(item = {}) {
  return !!String(item?.digest_id || '').trim() && !!historyItemStableKey(item);
}

// 需要 PNG 文件本体可读的操作:打开原图 / 下载 PNG / 复制图片 / 复制路径 / 在文件夹显示。
export function pngFileActionCheck(item = {}) {
  if (isMarkdownItem(item)) return { ok: false, reason: '这条历史是导出的 MD,没有 PNG 文件。' };
  if (!baseLookupReady(item)) return { ok: false, reason: '缺少历史记录标识,请刷新列表后重试。' };
  if (item.file_exists === false) return { ok: false, reason: 'PNG 文件已缺失,无法执行该操作。' };
  if (item.file_readable === false) return { ok: false, reason: 'PNG 文件不可读,无法执行该操作。' };
  if (item.file_stale === true || item.file_version_stale === true) {
    return { ok: false, reason: '文件已变化,请先刷新状态再操作。' };
  }
  if (!String(item.file_version || '').trim()) return { ok: false, reason: '缺少可校验的文件版本,请刷新列表后重试。' };
  return { ok: true, reason: '' };
}

export function mdFileActionCheck(item = {}) {
  if (!isMarkdownItem(item)) return { ok: false, reason: '这条历史不是导出的 MD。' };
  if (!baseLookupReady(item)) return { ok: false, reason: '缺少历史记录标识,请刷新列表后重试。' };
  if (item?.history_commit_failed === true) {
    return { ok: false, reason: '历史索引提交失败,应用不能直接下载或显示这份未绑定文件;请先核对输出目录。' };
  }
  if (item.file_exists === false) return { ok: false, reason: 'MD 文件已缺失,请重新导出。' };
  if (item.file_stale === true || item.file_version_stale === true) {
    return { ok: false, reason: '文件已变化,请先刷新状态再操作。' };
  }
  if (!String(item.file_version || '').trim()) return { ok: false, reason: '缺少可校验的文件版本,请刷新列表后重试。' };
  if (!itemExportPolicyRevision(item)) return { ok: false, reason: '缺少可校验的设置版本,无法下载或显示该 MD。' };
  return { ok: true, reason: '' };
}

// 非当前输出目录 PNG 的"恢复到当前目录"资格(与 main.js oldHistoryRerenderRestoreEligible 对齐)。
export function restoreToCurrentOutputEligible(item = {}) {
  if (item?.history_current !== false || isMarkdownItem(item)) return false;
  if (item.file_exists === false) return true;
  const status = String(item?.file_status || '').trim();
  if (item.file_readable !== false && item.file_png_valid === false) {
    return ['png_payload_invalid', 'png_payload_dimensions_too_large', 'png_payload_canvas_too_large',
      'png_payload_decoded_too_large', 'png_payload_too_many_chunks'].includes(status);
  }
  return status === 'png_payload_too_large' && !!String(item?.rerender_file_version || '').trim();
}

// 非当前输出目录 PNG 的"复制到当前目录"资格(与 main.js oldHistoryPngCopyToCurrentOutputEligible 对齐)。
export function copyToCurrentOutputEligible(item = {}) {
  if (item?.history_current !== false || isMarkdownItem(item)) return false;
  if (restoreToCurrentOutputEligible(item)) return false;
  return item.file_exists !== false
    && item.file_readable !== false
    && item.file_png_valid !== false
    && !!String(item?.file_version || item?.saved_file_version || '').trim()
    && !!String(item?.digest_file_version || item?.saved_digest_file_version || '').trim();
}

// 导出 MD 的门槛:只需要原摘要 JSON 可读(非当前输出目录的历史也允许导出到当前目录)。
export function exportMarkdownCheck(item = {}) {
  if (isMarkdownItem(item)) return { ok: false, reason: '这条历史已是导出的 MD。' };
  if (!baseLookupReady(item)) return { ok: false, reason: '缺少历史记录标识,请刷新列表后重试。' };
  if (String(item.digest_status || '').trim() === 'legacy_png_only'
    || String(item.digest_missing_reason || '').trim() === 'legacy_png_only') {
    return { ok: false, reason: '这条记录没有摘要 JSON,不能导出 MD。' };
  }
  if (item.digest_exists === false) return { ok: false, reason: '原摘要 JSON 已缺失,不能导出 MD。' };
  if (!String(item.digest_file_version || '').trim()) {
    return { ok: false, reason: '缺少原摘要 JSON 版本,请刷新列表后重试。' };
  }
  return { ok: true, reason: '' };
}

export function rerenderCheck(item = {}) {
  if (isMarkdownItem(item)) return { ok: false, reason: '导出的 MD 不能重渲染。' };
  if (!baseLookupReady(item)) return { ok: false, reason: '缺少历史记录标识,请刷新列表后重试。' };
  const oldOutput = item.history_current === false;
  if (oldOutput && !restoreToCurrentOutputEligible(item)) {
    return { ok: false, reason: '这条记录来自其他输出目录,仅当 PNG 丢失、损坏或超限时才能恢复到当前目录。' };
  }
  if (!oldOutput && item.file_exists === false) return { ok: false, reason: 'PNG 文件已缺失,不能原地重渲染。' };
  if (!itemRerenderFileVersion(item)) return { ok: false, reason: '缺少可校验的文件版本,请刷新列表后重试。' };
  if (!String(item.digest_file_version || '').trim() && item.digest_exists !== false) {
    return { ok: false, reason: '缺少原摘要 JSON 版本,请刷新列表后重试。' };
  }
  if (String(item.digest_status || '').trim() === 'legacy_png_only'
    || String(item.digest_missing_reason || '').trim() === 'legacy_png_only') {
    return { ok: false, reason: '这条记录没有摘要 JSON,不能重渲染。' };
  }
  return { ok: true, reason: '' };
}

export function deleteCheck(item = {}) {
  if (!baseLookupReady(item)) return { ok: false, reason: '缺少历史记录标识,请刷新列表后重试。' };
  if (!itemExpectedFileVersion(item)) return { ok: false, reason: '缺少历史文件版本,请刷新列表后重试。' };
  if (!itemExpectedDigestFileVersion(item)) return { ok: false, reason: '缺少原摘要 JSON 版本,请刷新列表后重试。' };
  if (!itemOutputDirIdentity(item)) return { ok: false, reason: '缺少历史输出目录身份,请刷新列表后重试。' };
  return { ok: true, reason: '' };
}

// MD 项的"查看 MD 源"(history-markdown-source 依赖文件版本)。
export function markdownSourceCheck(item = {}) {
  if (!isMarkdownItem(item)) return { ok: false, reason: '这条历史不是导出的 MD。' };
  if (!baseLookupReady(item)) return { ok: false, reason: '缺少历史记录标识,请刷新列表后重试。' };
  if (!String(item.file_version || '').trim() || item.file_exists === false) {
    return { ok: false, reason: '缺少可校验的文件版本,请刷新列表后重试。' };
  }
  return { ok: true, reason: '' };
}

export function markdownSourceReferenceAvailable(item = {}) {
  return !!String(item?.source_digest_id || item?.source_history_item_key || '').trim();
}

export function markdownRecoveryInstruction(item = {}) {
  if (!isMarkdownItem(item) || (item?.file_exists !== false && item?.history_commit_failed !== true)) return '';
  if (item?.history_commit_failed === true) {
    return '历史索引提交失败,请先到设置页核对输出目录中的文件。';
  }
  return markdownSourceReferenceAvailable(item)
    ? '原摘要仍可定位,请刷新后从源摘要重新导出 MD。'
    : '这条 MD 没有可定位的源摘要,请回到总结页重新生成文本预览并导出 MD。';
}
