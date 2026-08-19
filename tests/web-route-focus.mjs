import assert from 'node:assert/strict';
import { focusRouteHeading } from '../src/web/public/js/shared/route-focus.js';

function node(name) {
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

const heading = node('heading');
const card = node('card');
const modalDialog = node('modal-dialog');
const modalAction = node('modal-action');
modalAction.closest = selector => (
  selector === '[role="dialog"][aria-modal="true"]' ? modalDialog : null
);
const root = {
  contains(value) { return value === heading || value === card; },
  querySelector(selector) {
    assert.equal(selector, 'h1,[data-page-heading],h2');
    return heading;
  },
};
const body = node('body');
const html = node('html');
const documentTarget = { activeElement: body, body, documentElement: html };

assert.equal(focusRouteHeading(root, { documentTarget }), true);
assert.equal(documentTarget.activeElement, heading, '切页时焦点在 body 必须进入页面标题');
assert.equal(heading.tabIndex, -1, '页面标题必须可作为程序化焦点目标');

documentTarget.activeElement = card;
assert.equal(focusRouteHeading(root, { documentTarget }), false);
assert.equal(documentTarget.activeElement, card, '页面内已有焦点时不得抢焦点');
assert.equal(heading.focusCalls, 1);

documentTarget.activeElement = modalAction;
assert.equal(focusRouteHeading(root, { documentTarget }), false);
assert.equal(documentTarget.activeElement, modalAction, '页面挂载期间打开模态框时不得把焦点从弹窗操作抢回页面标题');
assert.equal(heading.focusCalls, 1);

documentTarget.activeElement = html;
assert.equal(focusRouteHeading(root, { documentTarget }), true);
assert.equal(documentTarget.activeElement, heading, '焦点落到 documentElement 时必须恢复页面标题');

console.log('web route focus tests passed');
