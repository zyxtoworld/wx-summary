import assert from 'node:assert/strict';
import { setSegmentedButtonState } from '../src/web/public/js/ui/segmented.js';

function button() {
  const attrs = new Map();
  return {
    attrs,
    classList: {
      active: false,
      toggle(name, value) {
        assert.equal(name, 'active');
        this.active = value === true;
      },
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
  };
}

const active = button();
assert.equal(setSegmentedButtonState(active, true), active);
assert.equal(active.classList.active, true);
assert.equal(active.attrs.get('aria-pressed'), 'true');

const inactive = button();
assert.equal(setSegmentedButtonState(inactive, false), inactive);
assert.equal(inactive.classList.active, false);
assert.equal(inactive.attrs.get('aria-pressed'), 'false');

console.log('web segmented control accessibility tests passed');
