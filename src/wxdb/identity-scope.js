export const ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS = 64;
export const ACCOUNT_IDENTITY_MESSAGE_SELECTION_STRATEGY = 'complete_up_to_hard_limit';

function messageShardTimeMs(file = {}) {
  const numeric = Number(file.mtimeMs || file.mtime_ms || 0) || 0;
  if (numeric > 0) return numeric;
  const parsed = Date.parse(String(file.last_write_time || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageShardIdentity(file = {}) {
  return String(file.path || file.relative || file.name || '').trim().toLowerCase();
}

export function accountIdentityMessageShardCandidates(files = [], limit = ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS) {
  const requested = Math.max(1, Math.floor(Number(limit || 0) || ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS));
  const max = Math.min(ACCOUNT_IDENTITY_MAX_MESSAGE_SHARDS, requested);
  const input = (Array.isArray(files) ? files : [])
    .filter(file => file && /^message_\d+\.db$/i.test(String(file.name || '')));
  const recent = [...input].sort((a, b) => messageShardTimeMs(b) - messageShardTimeMs(a)
    || String(a.name || '').localeCompare(String(b.name || ''))
    || messageShardIdentity(a).localeCompare(messageShardIdentity(b)));
  if (recent.length <= max) return recent;
  const smallest = [...input].sort((a, b) => Number(a.bytes || 0) - Number(b.bytes || 0)
    || String(a.name || '').localeCompare(String(b.name || ''))
    || messageShardIdentity(a).localeCompare(messageShardIdentity(b)));
  const selected = [];
  const seen = new Set();
  const add = file => {
    const key = messageShardIdentity(file);
    if (!key || seen.has(key) || selected.length >= max) return;
    seen.add(key);
    selected.push(file);
  };
  recent.slice(0, Math.ceil(max / 2)).forEach(add);
  smallest.forEach(add);
  return selected;
}
