export function parseStrictIntegerInput(value, {
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
  clamp = false,
} = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return { ok: false, raw, reason: 'format' };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return { ok: false, raw, reason: 'range' };
  if (parsed < min || parsed > max) {
    if (!clamp) return { ok: false, raw, reason: 'range' };
    return {
      ok: true,
      raw,
      value: Math.max(min, Math.min(max, parsed)),
      clamped: true,
    };
  }
  return { ok: true, raw, value: parsed, clamped: false };
}
