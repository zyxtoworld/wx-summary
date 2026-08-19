import assert from 'node:assert/strict';
import {
  focusFirstInvalid,
  setFieldInvalid,
} from '../src/web/public/js/pages/setup/validation.js';

function fakeField() {
  const attrs = new Map();
  const field = {
    focusedWith: null,
    classList: {
      invalid: false,
      toggle(name, value) {
        assert.equal(name, 'invalid');
        this.invalid = value === true;
      },
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    focus(options) { this.focusedWith = options; },
  };
  return field;
}

const valid = fakeField();
setFieldInvalid(valid, false);
assert.equal(valid.classList.invalid, false);
assert.equal(valid.getAttribute('aria-invalid'), null);

const invalid = fakeField();
setFieldInvalid(invalid, true);
assert.equal(invalid.classList.invalid, true);
assert.equal(invalid.getAttribute('aria-invalid'), 'true');

assert.equal(focusFirstInvalid([valid, invalid]), invalid);
assert.deepEqual(invalid.focusedWith, { preventScroll: true });

setFieldInvalid(invalid, false);
assert.equal(focusFirstInvalid([valid, invalid]), null);
assert.equal(invalid.getAttribute('aria-invalid'), null);

console.log('web setup validation focus tests passed');
