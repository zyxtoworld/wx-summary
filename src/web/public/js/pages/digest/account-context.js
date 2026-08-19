// 摘要页账号安全上下文身份；同一 ID 的数据库身份变化也必须建立新代次。
export function digestAccountContextIdentity(account) {
  const accountId = String(account?.id || account?.account_id || '').trim();
  const fingerprint = String(account?.manual_key_account_fingerprint || '').trim().toLowerCase();
  if (accountId) return `id:${accountId}|fingerprint:${fingerprint}`;
  return fingerprint ? `fingerprint:${fingerprint}` : '';
}

// 账号上下文变化时,同页仍在等待的生成/保存必须立即失效。
// 仅 abort 不足以阻止忽略 signal 的实现晚到写回,所以同时推进页面 generation。
export function invalidateDigestAccountAsyncWork(page, reason = '账号上下文已变化') {
  if (!page || typeof page !== 'object') return false;
  const previousGeneration = Number.isSafeInteger(page.generation)
    ? page.generation
    : 0;
  page.generation = previousGeneration + 1;
  const controller = page.abortController;
  page.abortController = null;
  if (controller && !controller.signal?.aborted) {
    controller.abort(new Error(reason));
  }
  return true;
}
