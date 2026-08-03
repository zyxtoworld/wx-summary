export const MAX_MESSAGE_SHARD_CURSOR_POSITIONS = 256;

export function isMessageShardCursorKey(value = '') {
  return /^message_\d+\.db$/i.test(String(value || '').trim());
}

export function normalizeMessageShardCursorPosition(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(text)) return null;
    const rowId = Number(text);
    return Number.isSafeInteger(rowId) ? rowId : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rowId = value.row_id;
  const generation = String(value.generation || '').trim().toLowerCase();
  const anchorHash = String(value.anchor_hash || '').trim().toLowerCase();
  if (!Number.isSafeInteger(rowId) || rowId < 0 || !/^[a-f0-9]{64}$/.test(generation)) return null;
  if ((rowId === 0 && anchorHash) || (rowId > 0 && !/^[a-f0-9]{64}$/.test(anchorHash))) return null;
  return {
    row_id: rowId,
    generation,
    anchor_hash: anchorHash,
  };
}
