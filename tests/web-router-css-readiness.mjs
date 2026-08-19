import assert from 'node:assert/strict';

globalThis.window = {
  __WX_LAUNCH_FOCUS_TOKEN__: '',
  addEventListener() {},
};
globalThis.location = new URL('http://wx-summary.test/#/settings');
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    globalThis.location.href = new URL(String(value), globalThis.location.href).href;
  },
};

const appendedLinks = [];
globalThis.document = {
  title: '',
  head: {
    appendChild(node) {
      appendedLinks.push(node);
    },
  },
  querySelectorAll() { return []; },
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      classList: { toggle() {}, add() {} },
      setAttribute() {},
      removeAttribute() {},
      append() {},
      appendChild() {},
      remove() {},
    };
  },
};

const { createRouter } = await import('../src/web/public/js/router.js');
const mounted = [];
const routes = {
  settings: {
    async load() {
      return {
        default: {
          title: 'settings',
          css: '/css/settings.css',
          async mount() { mounted.push('settings'); },
        },
      };
    },
  },
  digest: {
    async load() {
      return { default: { title: 'digest', async mount() { mounted.push('digest'); } } };
    },
  },
  broken: {
    async load() {
      return {
        default: {
          title: 'broken',
          css: '/css/broken.css',
          async mount() { mounted.push('broken'); },
        },
      };
    },
  },
};
const rootChildren = [];
const root = {
  replaceChildren() { rootChildren.length = 0; },
  appendChild(node) { rootChildren.push(node); },
};
const router = createRouter({ root, routes });

const firstRoute = router.route();
await new Promise(resolve => setImmediate(resolve));
assert.equal(appendedLinks.length, 1, '首次进入设置页必须插入其页面样式');
assert.deepEqual(mounted, [], '页面样式 load 完成前不得 mount，避免浏览器默认控件样式闪烁');
appendedLinks[0].onload();
await firstRoute;
assert.deepEqual(mounted, ['settings']);

globalThis.location.hash = '#/digest';
await router.route();
globalThis.location.hash = '#/settings';
await router.route();
assert.equal(appendedLinks.length, 1, '再次进入同一页面必须复用已加载样式，不能重复插入 link');
assert.deepEqual(mounted, ['settings', 'digest', 'settings']);

globalThis.location.hash = '#/broken';
const expectedErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => { expectedErrors.push(args.map(String).join(' ')); };
try {
  const brokenRoute = router.route();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(appendedLinks.length, 2);
  appendedLinks[1].onerror();
  await brokenRoute;
} finally {
  console.error = originalConsoleError;
}
assert.equal(mounted.includes('broken'), false, '样式加载失败时不得挂载无样式页面');
assert.equal(rootChildren.at(-1)?.className, 'page-load-failure', '样式加载失败必须显示页面加载失败占位');
assert.match(expectedErrors.join('\n'), /page css load failed: broken/, '样式加载失败必须留下可诊断日志');

console.log('web router css readiness tests passed');
