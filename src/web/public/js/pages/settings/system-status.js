export function shouldAutoRefreshSystemStatus(lastDiagnostics) {
  return !lastDiagnostics;
}

export function localStatusPngRevealSummary(item = {}, { completed = false, failed = false } = {}) {
  const evidence = item?.latest_evidence;
  if (!evidence) return '尚未记录到定位已保存 PNG 的操作;定位 MD 不计入这项图片验收。';
  if (item?.target_binding?.current !== true) {
    return '已记录到定位 PNG,但它不是当前最近保存的长图。';
  }
  if (failed) return '已记录到定位当前 PNG,但上一次目测确认需要重试。';
  if (completed) return '已记录到定位当前 PNG,请继续确认文件管理器确实选中目标。';
  return '已记录到定位 PNG,当前服务已找到最近保存的长图作为验收目标。';
}

export function localStatusDisplayItem(item = {}) {
  if (String(item?.id || '').trim() !== 'B8') return item;
  const completed = item?.ready_for_user_confirmation === true;
  const failed = String(item?.software_evidence_status || '').includes('failed');
  const hasRecordedReveal = !!item?.latest_evidence;
  return {
    ...item,
    display_status: completed ? '已记录' : (failed ? '需要重试' : (hasRecordedReveal ? '需定位当前图' : '等待操作')),
    software_evidence_summary: localStatusPngRevealSummary(item, { completed, failed }),
  };
}
