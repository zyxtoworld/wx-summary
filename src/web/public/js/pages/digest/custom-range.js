import { parseLocalDateTime } from '../../shared/local-date-time.js';

export function createCustomRangeValidationFeedback({
  sinceInput,
  untilInput,
  errorText,
  setFieldInvalid,
  focusFirstInvalid,
} = {}) {
  const inputs = [sinceInput, untilInput];
  const clear = () => {
    errorText.textContent = '';
    for (const input of inputs) setFieldInvalid(input, false);
  };
  for (const input of inputs) {
    input.addEventListener('input', clear);
    input.addEventListener('change', clear);
  }
  return {
    clear,
    show(validation) {
      clear();
      if (validation?.ok) return true;
      errorText.textContent = String(validation?.message || '时间范围无效。');
      const invalidInput = validation?.field === 'until' ? untilInput : sinceInput;
      setFieldInvalid(invalidInput, true);
      focusFirstInvalid(inputs);
      return false;
    },
  };
}

export function validateCustomRange(sinceValue = '', untilValue = '') {
  const sinceText = String(sinceValue || '');
  const untilText = String(untilValue || '');
  const since = parseLocalDateTime(sinceText);
  if (!since) return { ok: false, field: 'since', message: '开始时间无效。' };

  if (!untilText) return { ok: true, sinceValue: sinceText, untilValue: 'now' };

  const until = parseLocalDateTime(untilText, { endOfMinuteWhenSecondsMissing: true });
  if (!until) return { ok: false, field: 'until', message: '结束时间无效。' };
  if (since.getTime() > until.getTime()) {
    return { ok: false, field: 'since', message: '开始时间不能晚于结束时间。' };
  }
  return { ok: true, sinceValue: sinceText, untilValue: untilText };
}
