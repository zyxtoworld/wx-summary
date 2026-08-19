// 危险历史操作的最后一道目标身份检查。
// 调用方负责在 revalidate 中读取服务端最新快照,这里只允许同一稳定键继续。
export async function revalidateHistoryActionTarget({
  captured,
  getCurrent,
  revalidate,
  identity = item => String(item?.history_item_key || '').trim(),
  validate = () => ({ ok: true }),
} = {}) {
  const capturedKey = String(identity(captured) || '').trim();
  if (!capturedKey || typeof getCurrent !== 'function' || typeof revalidate !== 'function') {
    return { ok: false, code: 'target_invalid', item: null };
  }
  if (String(identity(getCurrent()) || '').trim() !== capturedKey) {
    return { ok: false, code: 'target_changed', item: null };
  }
  const latest = await revalidate(captured);
  if (!latest || String(identity(latest) || '').trim() !== capturedKey) {
    return { ok: false, code: 'target_changed', item: null };
  }
  if (String(identity(getCurrent()) || '').trim() !== capturedKey) {
    return { ok: false, code: 'target_changed', item: null };
  }
  const verdict = validate(latest) || { ok: true };
  if (verdict.ok !== true) return { ...verdict, ok: false, item: latest };
  return { ok: true, code: '', item: latest };
}
