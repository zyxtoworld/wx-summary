// 时间范围快捷档与计算。rangeKey 取值与 digest-draft-store 白名单保持一致:
// today / yesterday / yesterdayToday / last4h / last12h / last1d / thisweek / custom
export const RANGE_KEYS = Object.freeze([
  'today',
  'yesterday',
  'yesterdayToday',
  'last4h',
  'last12h',
  'last1d',
  'thisweek',
  'custom',
]);

export const RANGE_LABELS = Object.freeze({
  today: '今天',
  yesterday: '昨天',
  yesterdayToday: '昨天+今天',
  last4h: '近 4 小时',
  last12h: '近 12 小时',
  last1d: '近 24 小时',
  thisweek: '本周',
  custom: '自定义',
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

// 本地时间格式化为服务端要求的 `YYYY-MM-DD HH:mm`。
export function formatLocalMinute(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function startOfWeek(date) {
  // 周一为一周的开始。
  const day = date.getDay() || 7;
  const start = startOfDay(date);
  start.setDate(start.getDate() - (day - 1));
  return start;
}

// 返回 { since, until } 字符串;custom 由调用方提供 customSince/customUntil。
export function resolveRange(rangeKey, { customSince = '', customUntil = '', now = new Date() } = {}) {
  switch (rangeKey) {
    case 'today':
      return { since: formatLocalMinute(startOfDay(now)), until: 'now' };
    case 'yesterday': {
      const start = startOfDay(now);
      start.setDate(start.getDate() - 1);
      const end = startOfDay(now);
      end.setMinutes(end.getMinutes() - 1);
      return { since: formatLocalMinute(start), until: formatLocalMinute(end) };
    }
    case 'yesterdayToday': {
      const start = startOfDay(now);
      start.setDate(start.getDate() - 1);
      return { since: formatLocalMinute(start), until: 'now' };
    }
    case 'last4h':
      return { since: formatLocalMinute(new Date(now.getTime() - 4 * 3600 * 1000)), until: 'now' };
    case 'last12h':
      return { since: formatLocalMinute(new Date(now.getTime() - 12 * 3600 * 1000)), until: 'now' };
    case 'last1d':
      return { since: formatLocalMinute(new Date(now.getTime() - 24 * 3600 * 1000)), until: 'now' };
    case 'thisweek':
      return { since: formatLocalMinute(startOfWeek(now)), until: 'now' };
    case 'custom':
      return { since: String(customSince || ''), until: String(customUntil || '') };
    default:
      return { since: formatLocalMinute(startOfDay(now)), until: 'now' };
  }
}

// 当前范围的人类可读摘要。
export function rangeSummaryText(rangeKey, options = {}) {
  const { since, until } = resolveRange(rangeKey, options);
  const label = RANGE_LABELS[rangeKey] || rangeKey;
  // 草稿规范化会把“结束时间留空”保存为空值;它与运行时的 now 语义相同。
  const untilText = !until || until === 'now' ? '现在' : until;
  if (!since) return label;
  return `${label}:${since} ~ ${untilText}`;
}
