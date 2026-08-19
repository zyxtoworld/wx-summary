// 写请求结果未知的统一判定,不依赖会话或 DOM,供网络层和消费端共同使用。
export function isMutationOutcomeUnknown(error) {
  if (!error || typeof error !== 'object') return false;
  const payload = error.payload && typeof error.payload === 'object' ? error.payload : null;
  const code = String(error.code || payload?.code || payload?.error?.code || '').trim();
  return error.outcomeUnknown === true
    || error.mutation_outcome_unknown === true
    || payload?.outcomeUnknown === true
    || payload?.mutation_outcome_unknown === true
    || code === 'mutation_outcome_unknown';
}
