import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function syncFloatingRevealCapabilityButton(');
const end = source.indexOf('\nfunction localRevealReadyTitle(', start);
assert.ok(start >= 0 && end > start, 'floating reveal capability synchronizer must exist');

const state = { hardUnavailable: false, supported: false };
const context = vm.createContext({
  localRevealHardUnavailable: () => state.hardUnavailable,
  localRevealSupported: () => state.supported,
  localRevealButtonLabel: ({ supported }) => supported ? 'reveal-ready' : 'reveal-probe',
  localRevealUnavailableMessage: () => 'desktop-unavailable',
  localRevealReadyTitle: title => `ready:${title}`,
});
vm.runInContext(`${source.slice(start, end)}\nglobalThis.syncReveal = syncFloatingRevealCapabilityButton;`, context);

function fakeButton() {
  const attributes = new Map();
  return {
    attributes,
    disabled: false,
    textContent: '',
    title: '',
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

const button = fakeButton();

state.hardUnavailable = true;
state.supported = false;
assert.equal(context.syncReveal(button, { readyTitle: 'saved file' }), false);
assert.equal(button.disabled, true);
assert.equal(button.attributes.get('aria-disabled'), 'true');
assert.equal(button.attributes.has('aria-busy'), false);
assert.equal(button.title, 'desktop-unavailable');

state.hardUnavailable = false;
assert.equal(context.syncReveal(button, { readyTitle: 'saved file' }), true);
assert.equal(button.disabled, false);
assert.equal(button.attributes.get('aria-disabled'), 'false');
assert.equal(button.textContent, 'reveal-probe');
assert.match(button.title, /desktop-unavailable/);

assert.equal(context.syncReveal(button, { busy: true, readyTitle: 'saved file' }), false);
assert.equal(button.disabled, true);
assert.equal(button.attributes.get('aria-busy'), 'true');
assert.equal(button.textContent, '显示中...');

state.supported = true;
assert.equal(context.syncReveal(button, { readyTitle: 'saved file' }), true);
assert.equal(button.disabled, false);
assert.equal(button.attributes.has('aria-busy'), false);
assert.equal(button.textContent, 'reveal-ready');
assert.equal(button.title, 'ready:saved file');

console.log('local reveal capability runtime tests passed');
