import assert from 'node:assert/strict';
import {
  associateFormLabels,
  focusFirstInvalid,
  setFieldInvalid,
} from '../src/web/public/js/shared/form-accessibility.js';

function control(id = '') {
  return { id };
}

function field(labels, controls) {
  const parent = {
    querySelectorAll() { return controls; },
  };
  for (const label of labels) label.parentElement = parent;
  return parent;
}

function fakeField() {
  const attrs = new Map();
  return {
    focusedWith: null,
    classList: {
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
}

const loneControl = control();
const loneLabel = {
  htmlFor: '',
  querySelector() { return null; },
};
const wrappedControl = control('wrapped');
const wrappedLabel = {
  htmlFor: '',
  querySelector() { return wrappedControl; },
};
const otherControl = control('other');
const multiLabel = {
  htmlFor: '',
  querySelector() { return null; },
};
field([loneLabel], [loneControl]);
field([wrappedLabel], [wrappedControl]);
field([multiLabel], [loneControl, otherControl]);

const root = {
  querySelectorAll() { return [loneLabel, wrappedLabel, multiLabel]; },
};

assert.equal(associateFormLabels(root, { prefix: 'settings' }), 1);
assert.match(loneControl.id, /^wx-summary-settings-/);
assert.equal(loneLabel.htmlFor, loneControl.id);
assert.equal(wrappedLabel.htmlFor, '', '包装控件的标签不能重复生成 for');
assert.equal(multiLabel.htmlFor, '', '多个控件的布局不能猜测标签目标');

const invalidField = fakeField();
setFieldInvalid(invalidField, true);
assert.equal(invalidField.getAttribute('aria-invalid'), 'true');
assert.equal(focusFirstInvalid([invalidField]), invalidField);
assert.deepEqual(invalidField.focusedWith, { preventScroll: true });
setFieldInvalid(invalidField, false);
assert.equal(focusFirstInvalid([invalidField]), null);

console.log('web form label association tests passed');
