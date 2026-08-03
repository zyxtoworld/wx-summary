import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function restoreDialogFocus(');
const end = source.indexOf('\nfunction showAppConfirmDialog(', start);
assert.ok(start >= 0 && end > start, 'dialog focus restore source must be inspectable');

const animationFrames = [];
const document = {
  activeElement: null,
  body: { id: 'body' },
  documentElement: { id: 'html' },
};
let openerFocusCalls = 0;
const opener = {
  isConnected: true,
  disabled: false,
  tagName: 'BUTTON',
  getAttribute: () => null,
  hasAttribute: () => false,
  focus() {
    openerFocusCalls += 1;
    document.activeElement = opener;
  },
};
const replacementInput = { isConnected: true, tagName: 'INPUT' };
const sandbox = {
  document,
  $app: {},
  requestAnimationFrame: callback => animationFrames.push(callback),
  window: { setTimeout: () => 1 },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  dialogFocusRestoreTarget: context => context.opener,
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.__restoreDialogFocus = restoreDialogFocus;`, sandbox, { timeout: 1000 });

document.activeElement = replacementInput;
sandbox.__restoreDialogFocus({ opener });
animationFrames.shift()();
assert.equal(document.activeElement, replacementInput, 'delayed dialog cleanup must preserve focus explicitly chosen by the caller');
assert.equal(openerFocusCalls, 0);

document.activeElement = document.body;
sandbox.__restoreDialogFocus({ opener });
animationFrames.shift()();
assert.equal(document.activeElement, opener, 'dialog cleanup must still restore its opener when focus was genuinely lost');
assert.equal(openerFocusCalls, 1);

console.log('dialog delayed focus restoration tests passed');
