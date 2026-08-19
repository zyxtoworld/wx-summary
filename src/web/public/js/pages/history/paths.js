// 历史页请求构造:所有 /api/* 路径与 body 的唯一出处,严格对照 src/main.js。
// GET 的 lookup 走 query(historyItemLookupFromQuery),POST 的 lookup 走 body(historyItemLookupFromBody)。
import {
  EXPECTED_MISSING_FILE_VERSION,
  itemExpectedDigestFileVersion,
  itemExpectedFileVersion,
  itemExportPolicyRevision,
  itemOutputDirIdentity,
} from './format.js';

// GET 系路径的历史项定位 query:
// 文件已缺失时带哨兵版本;摘要已缺失时不再带 digest 版本(history-digest 会因此 428,属预期)。
export function historyQuerySuffix(item = {}) {
  const params = new URLSearchParams();
  const key = String(item?.history_item_key || '').trim();
  if (key) params.set('history_item_key', key);
  const relativePath = String(item?.relative_path || '').trim();
  if (relativePath) params.set('relative_path', relativePath);
  const digestRelativePath = String(item?.digest_relative_path || '').trim();
  if (digestRelativePath) params.set('digest_relative_path', digestRelativePath);
  const historyOutputRelativePath = String(item?.history_output_relative_path || '').trim();
  if (historyOutputRelativePath) params.set('history_output_relative_path', historyOutputRelativePath);
  const createdAt = String(item?.created_at || '').trim();
  if (createdAt) params.set('created_at', createdAt);
  const artifactType = String(item?.artifact_type || '').trim();
  if (artifactType) params.set('artifact_type', artifactType);
  const fileType = String(item?.file_type || '').trim();
  if (fileType) params.set('file_type', fileType);
  const fileVersion = itemExpectedFileVersion(item);
  if (fileVersion) params.set('expected_file_version', fileVersion);
  if (item?.digest_exists !== false) {
    const digestFileVersion = String(item?.digest_file_version || '').trim();
    if (digestFileVersion) params.set('expected_digest_file_version', digestFileVersion);
  }
  const outputDirIdentity = itemOutputDirIdentity(item);
  if (outputDirIdentity) params.set('expected_output_dir_identity', outputDirIdentity);
  const settingsRevision = itemExportPolicyRevision(item);
  if (settingsRevision) params.set('expected_settings_revision', settingsRevision);
  return params.toString();
}

function withSuffix(base, item, extraParams = null) {
  const params = [];
  const suffix = historyQuerySuffix(item);
  if (suffix) params.push(suffix);
  if (extraParams) params.push(extraParams);
  return params.length ? `${base}?${params.join('&')}` : base;
}

export function historyItemStatusPath(item = {}) {
  return withSuffix(`/api/history-item-status/${encodeURIComponent(item?.digest_id || '')}`, item);
}

export function historyDigestPath(item = {}, { exportFull = false } = {}) {
  return withSuffix(
    `/api/history-digest/${encodeURIComponent(item?.digest_id || '')}`,
    item,
    exportFull ? 'export=markdown' : '',
  );
}

export function historyMarkdownSourcePath(item = {}) {
  return withSuffix(`/api/history-markdown-source/${encodeURIComponent(item?.digest_id || '')}`, item);
}

export function digestThumbPath(item = {}) {
  const params = [`t=${encodeURIComponent(String(item?.rerendered_at || item?.created_at || item?.relative_path || item?.digest_id || ''))}`];
  return withSuffix(`/api/digest-thumb/${encodeURIComponent(item?.digest_id || '')}`, item, params.join('&'));
}

export function digestFilePath(item = {}, { downloadCheck = false } = {}) {
  return withSuffix(
    `/api/digest-file/${encodeURIComponent(item?.digest_id || '')}`,
    item,
    downloadCheck ? 'download_check=true' : '',
  );
}

// /api/output-file 只接受 MD 历史项;digest_id 是必需 query(处理器从 query 读取)。
export function outputFilePath(item = {}, { downloadCheck = false } = {}) {
  const base = `/api/output-file?digest_id=${encodeURIComponent(String(item?.digest_id || '').trim())}`;
  const suffix = historyQuerySuffix(item);
  const parts = [suffix, downloadCheck ? 'download_check=true' : ''].filter(Boolean);
  return parts.length ? `${base}&${parts.join('&')}` : base;
}

// POST 系 body 的历史项定位字段。
export function historyRequestPayload(item = {}) {
  const payload = { digest_id: String(item?.digest_id || '').trim() };
  const key = String(item?.history_item_key || '').trim();
  if (key) payload.history_item_key = key;
  const relativePath = String(item?.relative_path || '').trim();
  if (relativePath) payload.relative_path = relativePath;
  const digestRelativePath = String(item?.digest_relative_path || '').trim();
  if (digestRelativePath) payload.digest_relative_path = digestRelativePath;
  const historyOutputRelativePath = String(item?.history_output_relative_path || '').trim();
  if (historyOutputRelativePath) payload.history_output_relative_path = historyOutputRelativePath;
  const createdAt = String(item?.created_at || '').trim();
  if (createdAt) payload.created_at = createdAt;
  const artifactType = String(item?.artifact_type || '').trim();
  if (artifactType) payload.artifact_type = artifactType;
  const fileType = String(item?.file_type || '').trim();
  if (fileType) payload.file_type = fileType;
  const fileVersion = itemExpectedFileVersion(item);
  if (fileVersion) payload.expected_file_version = fileVersion;
  const digestFileVersion = itemExpectedDigestFileVersion(item);
  if (digestFileVersion) payload.expected_digest_file_version = digestFileVersion;
  const outputDirIdentity = itemOutputDirIdentity(item);
  if (outputDirIdentity) payload.expected_output_dir_identity = outputDirIdentity;
  const settingsRevision = itemExportPolicyRevision(item);
  if (settingsRevision) payload.expected_settings_revision = settingsRevision;
  return payload;
}

// 重渲染专用:超大 PNG 用 rerender_file_version(服务端 stream 校验)替代常规 file_version。
export function rerenderRequestPayload(item = {}) {
  const payload = historyRequestPayload(item);
  const rerenderVersion = String(item?.rerender_file_version || '').trim();
  if (rerenderVersion) payload.expected_file_version = rerenderVersion;
  return payload;
}

// 删除前置条件:file_version + digest_file_version + output_dir_identity 缺一后端 428。
export function deleteRequestPayload(item = {}) {
  const payload = historyRequestPayload(item);
  payload.expected_file_version = itemExpectedFileVersion(item);
  payload.expected_digest_file_version = item?.digest_exists === false
    ? EXPECTED_MISSING_FILE_VERSION
    : String(item?.digest_file_version || '').trim();
  payload.expected_output_dir_identity = itemOutputDirIdentity(item);
  return payload;
}

// 设置上下文(/api/state 的当前值),导出 MD / 复制旧目录 PNG 必填。
export function settingsContextPayload(state = {}) {
  const payload = {};
  const settingsRevision = String(state?.settings_revision || '').trim();
  if (settingsRevision) payload.expected_settings_revision = settingsRevision;
  const exportPolicyRevision = String(state?.export_policy_revision || '').trim();
  if (exportPolicyRevision) payload.expected_export_policy_revision = exportPolicyRevision;
  const outputIdentity = String(state?.output_dir_identity || '').trim();
  if (outputIdentity) payload.expected_output_dir_identity = outputIdentity;
  return payload;
}

// 本地动作证据查询:kind 可空(服务端按 action_id 匹配),target 绑定防串号。
export function localActionEvidencePath({ kind = '', actionId = '', item = null } = {}) {
  const params = new URLSearchParams();
  params.set('kind', String(kind || '').trim());
  params.set('action_id', String(actionId || '').trim());
  if (item && typeof item === 'object') {
    const digestId = String(item.digest_id || '').trim();
    if (digestId) params.set('digest_id', digestId);
    const key = String(item.history_item_key || '').trim();
    if (key) params.set('history_item_key', key);
    const relativePath = String(item.relative_path || '').trim();
    if (relativePath) params.set('relative_path', relativePath);
    const fileVersion = String(item.file_version || '').trim();
    if (fileVersion && fileVersion !== EXPECTED_MISSING_FILE_VERSION) params.set('file_version', fileVersion);
    const digestFileVersion = String(item.digest_file_version || '').trim();
    if (digestFileVersion) params.set('digest_file_version', digestFileVersion);
    const outputDirIdentity = itemOutputDirIdentity(item);
    if (outputDirIdentity) params.set('output_dir_identity', outputDirIdentity);
    const settingsRevision = itemExportPolicyRevision(item);
    if (settingsRevision) params.set('settings_revision', settingsRevision);
  }
  return `/api/local-action-evidence?${params.toString()}`;
}
