function cleanId(value = '') {
  return String(value || '').trim();
}

export function selectFullyCoveredRecoverySupersessions({
  records = [],
  results = [],
  selectedGroupIds = [],
  accountId = '',
  accountFingerprint = '',
  previewText = false,
} = {}) {
  const expectedAccountId = cleanId(accountId);
  const expectedFingerprint = cleanId(accountFingerprint).toLowerCase();
  const selected = new Set((Array.isArray(selectedGroupIds) ? selectedGroupIds : []).map(cleanId).filter(Boolean));
  if (!expectedAccountId || !/^[a-f0-9]{64}$/.test(expectedFingerprint) || !selected.size) return [];

  const output = [];
  const seen = new Set();
  for (const record of (Array.isArray(records) ? records : [])) {
    const batchId = cleanId(record?.batch_id);
    const targets = Array.isArray(record?.targets) ? record.targets : [];
    if (!batchId || seen.has(batchId) || !targets.length
      || cleanId(record?.account_id) !== expectedAccountId
      || cleanId(record?.account_fingerprint).toLowerCase() !== expectedFingerprint
      || !!record?.preview_text !== (previewText === true)
      || cleanId(record?.phase) !== 'terminal_results_pending_recovery') continue;

    const batchResults = (Array.isArray(results) ? results : [])
      .filter(result => cleanId(result?.batch_id) === batchId);
    const retryGroupIds = [];
    const fullyCovered = targets.every((target, index) => {
      const groupId = cleanId(target?.group_id || target?.id);
      if (!groupId) return false;
      const result = batchResults.find(item => cleanId(item?.group_id || item?.groupId) === groupId)
        || batchResults.find(item => Math.max(0, Math.trunc(Number(item?.index || 0) || 0)) === index);
      if (!result) return false;
      if (result.durable === true) return true;
      if (result.retryable === true && selected.has(groupId)) {
        retryGroupIds.push(groupId);
        return true;
      }
      return false;
    });
    if (!fullyCovered || !retryGroupIds.length) continue;
    seen.add(batchId);
    output.push({ batch_id: batchId, retry_group_ids: retryGroupIds });
  }
  return output;
}
