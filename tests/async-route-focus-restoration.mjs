import assert from 'node:assert/strict';
import { focusRouteHeading } from '../src/web/public/js/shared/route-focus.js';

function createHeading(name) {
  return {
    name,
    tabIndex: 0,
    focusCalls: 0,
    focus() {
      this.focusCalls += 1;
      documentTarget.activeElement = this;
    },
  };
}

const documentTarget = {
  body: { name: 'body' },
  documentElement: { name: 'html' },
  activeElement: null,
};
documentTarget.activeElement = documentTarget.body;

let heading = createHeading('loading');
const root = {
  contains(value) { return value === heading; },
  querySelector(selector) {
    assert.equal(selector, 'h1,[data-page-heading],h2');
    return heading;
  },
};

assert.equal(focusRouteHeading(root, { documentTarget }), true);
assert.equal(heading.focusCalls, 1);
assert.equal(heading.tabIndex, -1);

// 异步页面替换 loading DOM 后，焦点仍在 body 时，新标题必须重新声明入口。
documentTarget.activeElement = documentTarget.body;
heading = createHeading('settings');
assert.equal(focusRouteHeading(root, { documentTarget }), true);
assert.equal(documentTarget.activeElement, heading);
assert.equal(heading.focusCalls, 1);

// 用户已经在页面内操作时，异步重绘不得抢走焦点。
const field = { name: 'field' };
root.contains = value => value === heading || value === field;
documentTarget.activeElement = field;
assert.equal(focusRouteHeading(root, { documentTarget }), false);
assert.equal(documentTarget.activeElement, field);

console.log('async route focus restoration contract passed');
