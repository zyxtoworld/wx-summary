import assert from 'node:assert/strict';
import { setAriaCurrentState } from '../src/web/public/js/ui/aria-state.js';

function item() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
  };
}

const current = item();
assert.equal(setAriaCurrentState(current, true, 'step'), current);
assert.equal(current.attrs.get('aria-current'), 'step');

assert.equal(setAriaCurrentState(current, false, 'step'), current);
assert.equal(current.attrs.has('aria-current'), false);

console.log('web setup current-state accessibility tests passed');
