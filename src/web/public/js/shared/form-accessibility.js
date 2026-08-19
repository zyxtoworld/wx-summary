let generatedId = 0;

const FORM_CONTROL_SELECTOR = 'input,select,textarea';

function nextControlId(prefix) {
  generatedId += 1;
  return `wx-summary-${String(prefix || 'field').replace(/[^a-z0-9_-]+/gi, '-')}-${generatedId}`;
}

// 只关联“同一个字段内恰好一个控件”的视觉标签;包装控件和多控件布局由调用方自行命名。
export function associateFormLabels(root, { prefix = 'field' } = {}) {
  if (!root?.querySelectorAll) return 0;
  let associated = 0;
  for (const label of root.querySelectorAll('label:not([for])')) {
    if (label.querySelector?.(FORM_CONTROL_SELECTOR)) continue;
    const parent = label.parentElement;
    const controls = parent?.querySelectorAll?.(FORM_CONTROL_SELECTOR) || [];
    if (controls.length !== 1) continue;
    const control = controls[0];
    if (!control.id) control.id = nextControlId(prefix);
    label.htmlFor = control.id;
    associated += 1;
  }
  return associated;
}

export function setFieldInvalid(input, invalid) {
  if (!input) return;
  const value = invalid === true;
  input.classList.toggle('invalid', value);
  if (value) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

export function focusFirstInvalid(inputs) {
  const target = (Array.isArray(inputs) ? inputs : []).find(input => (
    input?.getAttribute?.('aria-invalid') === 'true'
  ));
  if (!target) return null;
  target.focus?.({ preventScroll: true });
  return target;
}
