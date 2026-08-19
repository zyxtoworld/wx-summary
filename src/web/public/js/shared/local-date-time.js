export function parseLocalDateTime(
  value,
  { endOfMinuteWhenSecondsMissing = false, endOfSecond = false } = {},
) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, rawSeconds] = match;
  const s = rawSeconds ?? (endOfMinuteWhenSecondsMissing ? '59' : '0');
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), endOfSecond ? 999 : 0);
  const valid = !Number.isNaN(date.getTime())
    && date.getFullYear() === Number(y)
    && date.getMonth() === Number(mo) - 1
    && date.getDate() === Number(d)
    && date.getHours() === Number(h)
    && date.getMinutes() === Number(mi)
    && date.getSeconds() === Number(s);
  return valid ? date : null;
}
