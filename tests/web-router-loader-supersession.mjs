import assert from 'node:assert/strict';

globalThis.window = { __WX_LAUNCH_FOCUS_TOKEN__: '', addEventListener() {} };
globalThis.location = new URL('http://wx-summary.test/#/a');
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    globalThis.location.href = new URL(String(value), globalThis.location.href).href;
  },
};
globalThis.document = {
  title: '',
  head: { appendChild() {} },
  querySelectorAll() { return []; },
  createElement() {
    return {
      dataset: {},
      classList: { toggle() {} },
      setAttribute() {},
      removeAttribute() {},
      append() {},
      appendChild() {},
      remove() {},
    };
  },
};

const { createRouter } = await import('../src/web/public/js/router.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const bLoad = deferred();
const bStarted = deferred();
const mounted = [];
const page = name => ({
  title: name,
  async mount() { mounted.push(name); },
});

const routes = {
  a: { async load() { return { default: page('a') }; } },
  b: {
    async load() {
      bStarted.resolve();
      return { default: await bLoad.promise };
    },
  },
  c: { async load() { return { default: page('c') }; } },
};

const router = createRouter({
  root: {
    scrollTop: 0,
    replaceChildren() {},
    appendChild() {},
    querySelector() { return null; },
  },
  routes,
});

await router.route();
assert.deepEqual(mounted, ['a']);

globalThis.location.hash = '#/b';
const bNavigation = router.route();
await bStarted.promise;

globalThis.location.hash = '#/c';
const cNavigation = router.route();
bLoad.resolve(page('b'));
await Promise.all([bNavigation, cNavigation]);

assert.deepEqual(mounted, ['a', 'c'],
  'B 模块加载期间被 C supersede 时不得先挂载过时 B');
assert.equal(router.currentName(), 'c');
assert.equal(globalThis.location.hash, '#/c');

console.log('web router loader supersession tests passed');
