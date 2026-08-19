import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createCustomRangeValidationFeedback,
  validateCustomRange,
} from '../src/web/public/js/pages/digest/custom-range.js';

assert.deepEqual(
  validateCustomRange('2026-08-08 00:00', '2026-08-07 00:00'),
  { ok: false, field: 'since', message: '开始时间不能晚于结束时间。' },
);

assert.deepEqual(
  validateCustomRange('2026-08-08 00:00', ''),
  { ok: true, sinceValue: '2026-08-08 00:00', untilValue: 'now' },
);

function fakeInput() {
  const target = new EventTarget();
  const attributes = new Map();
  return Object.assign(target, {
    invalid: false,
    focusCalls: 0,
    classList: {
      toggle(_name, enabled) { target.invalid = enabled === true; },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    focus() { target.focusCalls += 1; },
  });
}

const sinceInput = fakeInput();
const untilInput = fakeInput();
const errorText = { textContent: '' };
const setInvalid = (input, invalid) => {
  input.classList.toggle('invalid', invalid === true);
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
};
const focusInvalid = inputs => {
  const input = inputs.find(item => item.getAttribute('aria-invalid') === 'true');
  input?.focus();
  return input || null;
};
const feedback = createCustomRangeValidationFeedback({
  sinceInput,
  untilInput,
  errorText,
  setFieldInvalid: setInvalid,
  focusFirstInvalid: focusInvalid,
});

assert.equal(feedback.show(validateCustomRange('2026-08-08 12:00', '2026-08-07 12:00')), false);
assert.equal(errorText.textContent, '开始时间不能晚于结束时间。');
assert.equal(sinceInput.getAttribute('aria-invalid'), 'true');
assert.equal(sinceInput.focusCalls, 1, '非法范围必须聚焦具体无效字段');

untilInput.dispatchEvent(new Event('input'));
assert.equal(errorText.textContent, '', '任一范围输入变化后必须立即清除过期错误');
assert.equal(sinceInput.getAttribute('aria-invalid'), null, '纠正输入后必须清除旧 aria-invalid');
assert.equal(untilInput.getAttribute('aria-invalid'), null);

assert.equal(feedback.show(validateCustomRange('', '2026-08-07 12:00')), false);
sinceInput.dispatchEvent(new Event('change'));
assert.equal(errorText.textContent, '', '日期选择器只触发 change 时也必须清除过期错误');

const digestSource = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
assert.match(
  digestSource,
  /createCustomRangeValidationFeedback\s*\(\s*\{[\s\S]*?sinceInput,[\s\S]*?untilInput,[\s\S]*?errorText,/,
  '摘要页生产弹窗必须实例化自定义范围反馈协调器',
);

console.log('web custom range validation tests passed');
