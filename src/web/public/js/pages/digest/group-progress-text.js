import { formatElapsedProgress } from './progress-state.js';

const GROUP_MIRROR_PROGRESS_LABELS = Object.freeze({
  mirror_refresh_needed: '读取群列表 · 发现本地数据需更新',
  mirror_source_snapshot_retry_wait: '读取群列表 · 等待微信写入稳定',
  mirror_copy_retry_wait: '读取群列表 · 等待微信写入稳定',
  mirror_scope_copy_retry_wait: '读取群列表 · 等待微信写入稳定',
  mirror_copy_db: '读取群列表 · 复制所需数据',
  mirror_scope_copy_db: '读取群列表 · 复制所需数据',
  mirror_copy_verify: '读取群列表 · 校验临时数据',
  mirror_scope_copy_verify: '读取群列表 · 校验临时数据',
  mirror_copy_hash: '读取群列表 · 校验数据完整性',
  mirror_copy_hash_progress: '读取群列表 · 校验数据完整性',
  mirror_scope_copy_hash: '读取群列表 · 校验数据完整性',
  mirror_scope_copy_hash_progress: '读取群列表 · 校验数据完整性',
  mirror_copy_source_verify_before_publish: '读取群列表 · 确认微信数据稳定',
  mirror_scope_source_verify_before_publish: '读取群列表 · 确认微信数据稳定',
  mirror_reuse_source_verify: '读取群列表 · 确认微信数据稳定',
  mirror_scope_copy_start: '读取群列表 · 更新账号确认数据',
  mirror_copy_publish_ready: '读取群列表 · 更新本地工作数据',
  mirror_scope_publish_ready: '读取群列表 · 更新本地工作数据',
  mirror_publish_manifest: '读取群列表 · 确认本地数据完整',
  mirror_publish_manifest_progress: '读取群列表 · 确认本地数据完整',
  mirror_publish_manifest_done: '读取群列表 · 本地数据完整性已确认',
  mirror_publish_finalize: '读取群列表 · 完成本地数据更新',
  mirror_retry_identity_rebind: '读取群列表 · 确认上次稳定数据',
  mirror_retry_identity_rebind_done: '读取群列表 · 上次稳定数据可继续使用',
  mirror_reuse_source_changed: '读取群列表 · 发现微信有新写入',
  mirror_source_busy_reuse: '读取群列表 · 使用上次稳定数据',
  mirror_reuse: '读取群列表 · 已是最新',
});

function groupProgressOperationPrefix(fallbackPrefix = '正在读取群列表') {
  return /完整本地数据/.test(String(fallbackPrefix || '')) ? '检查完整本地数据' : '读取群列表';
}

export function normalizeDbCopyTermsForUsers(value = '') {
  return String(value || '')
    .replace(/项目数据库副本/g, '本地工作数据')
    .replace(/数据库项目副本/g, '本地工作数据')
    .replace(/项目临时副本/g, '临时读取数据')
    .replace(/项目副本/g, '本地工作数据')
    .replace(/临时副本/g, '临时读取数据');
}

export function normalizeGroupMirrorProgressText(value = '') {
  return normalizeDbCopyTermsForUsers(value)
    .replace(/源\s*DB\/WAL/gi, '微信数据库和增量文件')
    .replace(/DB\/WAL/gi, '数据库和增量文件')
    .replace(/源数据库/g, '微信数据库')
    .replace(/源文件/g, '微信数据文件')
    .replace(/项目内本地工作数据/g, '本地工作数据')
    .replace(/项目工作数据/g, '本地工作数据')
    .replace(/发布清单/g, '完整性记录')
    .replace(/硬链接代次/g, '临时版本')
    .replace(/临时硬链接/g, '临时文件')
    .replace(/文件身份/g, '文件状态')
    .replace(/内容指纹/g, '数据校验结果')
    .replace(/内容哈希/g, '完整校验结果')
    .replace(/源库文件元数据/g, '微信数据状态')
    .replace(/源文件元数据/g, '微信数据状态')
    .replace(/新增分片/g, '新增数据文件')
    .replace(/一致性捕获/g, '稳定读取')
    .replace(/代次/g, '版本')
    .replace(/原子替换/g, '安全更新')
    .replace(/\bWAL\b/gi, '增量数据')
    .replace(/发布/g, '更新')
    .replace(/staging/gi, '临时数据')
    .replace(/\bcontact\.db\b/gi, '群列表数据')
    .replace(/\bsession\.db\b/gi, '最近消息数据')
    .replace(/\bmessage_\*\.db\b/gi, '消息数据')
    .replace(/\bmessage_[^\s，。；、]*\.db\b/gi, '消息数据');
}

export function groupProgressUserFacingLabel(progress = {}, fallbackPrefix = '正在读取群列表') {
  const phase = String(progress?.phase || '').trim();
  const raw = String(progress?.label || fallbackPrefix || '正在读取群列表').trim();
  const operationPrefix = groupProgressOperationPrefix(fallbackPrefix);
  if (operationPrefix === '读取群列表' && GROUP_MIRROR_PROGRESS_LABELS[phase]) {
    return GROUP_MIRROR_PROGRESS_LABELS[phase];
  }
  if (phase === 'account_identity_sample_cached') return `${operationPrefix} · 复用账号确认结果`;
  if (phase === 'account_identity_sample') return `${operationPrefix} · 核对当前微信账号`;
  if (phase === 'account_identity_evidence_persist') return `${operationPrefix} · 保存账号确认进度`;
  if (phase === 'account_identity_worker_done' || phase === 'account_identity_switched') {
    return `${operationPrefix} · 当前微信账号已确认`;
  }
  if (phase === 'account_identity_worker_started' || phase === 'account_identity_open') {
    return `${operationPrefix} · 确认当前微信账号`;
  }
  if (/^fetch_shard_decrypt_plain_/.test(phase)) return `${operationPrefix} · 准备最近消息数据`;
  if (phase === 'mirror_reuse_verify_cached') return `${operationPrefix} · 快速校验本地数据`;
  if (phase === 'mirror_reuse_verify_hash' || phase === 'mirror_reuse_verify_hash_progress') {
    return `${operationPrefix} · 完整校验本地数据`;
  }
  if (/key|contact|session|sqlcipher|hmac|cipher|打开|验证数据库密钥/i.test(`${phase} ${raw}`)) {
    if (/session/i.test(`${phase} ${raw}`)) return `${operationPrefix} · 整理会话数据`;
    return `${operationPrefix} · 验证本地数据访问`;
  }
  if (/mirror|副本|复制|覆盖|staging/i.test(`${phase} ${raw}`)) {
    const normalized = normalizeGroupMirrorProgressText(raw)
      .replace(/^检查本地数据\s*·\s*/, `${operationPrefix} · `)
      .replace(/摘要范围/g, '本次所需数据')
      .replace(/所需数据库文件/g, '所需数据');
    return normalized || `${operationPrefix} · 准备本地数据`;
  }
  return raw
    .replace(/\bcontact\.db\b/gi, '群列表数据')
    .replace(/\bsession\.db\b/gi, '最近消息数据')
    .replace(/\bSQLCipher\b/gi, '本地数据访问')
    .replace(/\bHMAC\b/gi, '完整性校验');
}

function formatByteSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 100 * 1024 ? 0 : 1)} KB`;
  return `${Math.round(value)} B`;
}

export function groupProgressMirrorFileDetail(progress = {}) {
  const phase = String(progress?.phase || '').trim();
  if (!/(?:mirror|fetch_mirror)/.test(phase)
    || !/(?:_file_|copy_hash_progress|verify_hash_progress|publish_manifest_progress)/.test(phase)) return '';
  const index = Math.max(0, Number(progress?.index || 0) || 0);
  const total = Math.max(0, Number(progress?.total || 0) || 0);
  const bytesRead = Math.max(0, Number(progress?.bytes_read || 0) || 0);
  const totalBytes = Math.max(0, Number(progress?.total_bytes || 0) || 0);
  const fileBytes = Math.max(0, Number(progress?.bytes || 0) || 0);
  const rawPercent = Number(progress?.percent);
  const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.round(rawPercent))) : null;
  const parts = [];
  if (index > 0 && total > 0) parts.push(`第 ${index}/${total} 项数据`);
  if (bytesRead > 0 && totalBytes > 0) {
    parts.push(`本项 ${formatByteSize(bytesRead)}/${formatByteSize(totalBytes)}`);
  } else if (fileBytes > 0) {
    parts.push(`本项 ${formatByteSize(fileBytes)}`);
  }
  if (percent !== null) parts.push(`${percent}%`);
  if (progress?.reused === true) parts.push('复用已验证工作数据');
  return parts.join(' · ');
}

export function groupProgressUserFacingDetail(progress = {}, fallbackPrefix = '正在读取群列表') {
  const phase = String(progress?.phase || '').trim();
  const raw = String(progress?.detail || '').trim();
  const label = String(progress?.label || '').trim();
  const fullInventory = groupProgressOperationPrefix(fallbackPrefix) === '检查完整本地数据';
  const mirrorFileDetail = groupProgressMirrorFileDetail(progress);
  if (mirrorFileDetail) return mirrorFileDetail;
  if (phase === 'account_identity_sample_cached') return '最近消息数据未变化，正在复用上次验证结果';
  if (phase === 'account_identity_sample') return '正在核对当前账号与最近会话';
  if (phase === 'account_identity_evidence_persist') return '正在保存已完成的账号确认进度，便于下次继续';
  if (phase === 'account_identity_worker_done') return '当前微信账号已确认，正在继续读取群列表';
  if (phase === 'account_identity_switched') return '已确认当前微信账号；旧账号的缓存和自动规则不会沿用';
  if (phase === 'account_identity_worker_started' || phase === 'account_identity_open') {
    return '正在准备确认当前微信账号所需的本地数据';
  }
  if (/^fetch_shard_decrypt_plain_/.test(phase)) {
    return normalizeDbCopyTermsForUsers(raw)
      .replace(/^[^：:\r\n]{1,120}[：:]\s*/, '')
      .replace(/正在逐页准备临时读取数据/g, '正在准备本次读取所需数据')
      || '正在准备本次读取所需数据';
  }
  if (phase === 'mirror_publish_finalize') return '正在确认本地工作数据完整，完成后继续读取群列表';
  if (phase === 'mirror_retry_identity_rebind') return '本次更新已取消，正在确认上次稳定数据仍可使用';
  if (phase === 'mirror_publish_manifest_done') return '本地工作数据完整性已确认';
  if (phase === 'mirror_publish_manifest') return '正在确认本地工作数据完整，完成前继续使用当前版本';
  if (phase === 'mirror_reuse') {
    return normalizeGroupMirrorProgressText(raw).replace(/；本地工作数据一致，继续读取\s*$/, '');
  }
  if (phase === 'mirror_reuse_verify_cached' || phase === 'mirror_reuse_verify_hash'
    || phase === 'mirror_reuse_verify_hash_progress') return normalizeDbCopyTermsForUsers(raw);
  if (/mirror_scope_copy_done/.test(phase)) {
    if (fullInventory) return '已更新完整本地工作数据';
    if (/摘要|消息|Markdown|长图/.test(`${label} ${raw}`)) return '已更新摘要读取所需本地工作数据';
    return '已更新群列表所需本地工作数据';
  }
  if (/mirror_copy_done/.test(phase)) return '本地数据已更新';
  if (/mirror|fetch_mirror/.test(phase)) return normalizeGroupMirrorProgressText(raw);
  if (/^(?:groups_key_|fetch_key_)/.test(phase)) {
    if (/(?:done|cache_hit|cached)$/.test(phase)) return '本地读取方式已准备，正在继续读取群列表';
    if (/(?:memory|scan|probe)/.test(phase)) return '正在自动确认当前本地数据能否读取';
    return '优先复用上次验证结果，必要时自动重新检查';
  }
  if (/groups_open_contact|groups_query_contact/.test(phase)) return '读取群名、成员数和拼音搜索信息';
  if (/groups_open_session|groups_query_session/.test(phase)) return '读取最近消息时间用于排序';
  if (phase === 'groups_session_skipped') return '最近消息数据仅用于排序，本次只降级群列表排序';
  if (phase === 'groups_session_schema_skipped') return '最近消息数据格式暂不兼容，排序可能不完整';
  return normalizeDbCopyTermsForUsers(raw)
    .replace(/\bcontact\.db\b/gi, '群列表数据')
    .replace(/\bsession\.db\b/gi, '最近消息数据')
    .replace(/\bcontact\b/gi, '群列表')
    .replace(/\bsession\b/gi, '会话')
    .replace(/\bmessage_\*\.db\b/gi, '消息库')
    .replace(/\bmessage_[^\s，。；、]*\.db\b/gi, '消息库')
    .replace(/\bSQLCipher\b/gi, '本地数据访问')
    .replace(/\bHMAC\b/gi, '完整性校验')
    .replace(/候选密钥/g, '本地访问信息')
    .replace(/已有密钥未打开该分片，正在只读寻找可用于当前消息库的密钥/g, '正在确认本机群列表数据可读取')
    .replace(/打开该分片/g, '读取本地数据')
    .replace(/数据库密钥/g, '本地数据访问');
}

export function formatGroupProgressText(progress = {}, fallbackPrefix = '正在读取群列表') {
  if (String(progress?.status || '').trim().toLowerCase() !== 'running') return '';
  const label = groupProgressUserFacingLabel(progress, fallbackPrefix);
  const detail = groupProgressUserFacingDetail(progress, fallbackPrefix);
  const elapsedMs = Number(progress?.elapsed_ms || 0) || 0;
  const elapsed = elapsedMs > 0 ? formatElapsedProgress(elapsedMs) : '';
  const body = detail && !label.includes(detail) ? `${label}：${detail}` : label;
  return `${body}${elapsed ? `（已耗时 ${elapsed}）` : ''}`;
}
