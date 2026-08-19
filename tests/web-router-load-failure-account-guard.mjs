import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/web/public/js/store.js';
import {
  accountSwitchLoadingMessage,
  createAccountSelectionController,
} from '../src/web/public/js/shared/account-selection.js';

const mainSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');
assert.match(mainSource,
  /onRouteLoadingFailure:\s*name\s*=>\s*\{[\s\S]*?accountSwitchLoadingMessage\(name\)[\s\S]*?store\.get\('accountSwitchGuard'\)[\s\S]*?store\.set\('accountSwitchGuard', null\)/,
  '壳层必须接收路由加载失败并只清理自己设置的 loading guard');

globalThis.window = { __WX_LAUNCH_FOCUS_TOKEN__: '', addEventListener() {} };
globalThis.location = new URL('http://wx-summary.test/#/old');
globalThis.history = {
  state: null,
  replaceState(_state, _title, value) {
    globalThis.location.href = new URL(String(value), globalThis.location.href).href;
  },
};

const links = [];
globalThis.document = {
  title: '',
  head: {
    appendChild(link) { links.push(link); },
  },
  querySelectorAll() { return []; },
  createElement(tagName) {
    return {
      tagName: String(tagName).toUpperCase(),
      className: '',
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

async function runFailureCase(label, routes, failCss = false) {
  const accountA = { id: `${label}-a` };
  const accountB = { id: `${label}-b` };
  const store = createStore({
    account: accountA,
    accountSwitchGuard: null,
  });
  const blocked = [];
  const selection = createAccountSelectionController({
    store,
    onBlocked: message => blocked.push(message),
  });
  const root = {
    scrollTop: 0,
    replaceChildren() {},
    appendChild() {},
  };
  let failureCalls = 0;
  const router = createRouter({
    root,
    routes,
    onRouteLoading(name) {
      store.set('accountSwitchGuard', accountSwitchLoadingMessage(name));
    },
    onRouteLoadingFailure(name, error) {
      failureCalls += 1;
      assert.equal(store.get('accountSwitchGuard'), accountSwitchLoadingMessage(name),
        `${label}: failure callback 必须看到自己持有的 loading guard`);
      store.set('accountSwitchGuard', null);
      assert.ok(error, `${label}: failure callback 必须收到错误`);
    },
  });

  globalThis.location.hash = '#/old';
  await router.route();
  globalThis.location.hash = '#/broken';
  const navigation = router.route();
  if (failCss) {
    await new Promise(resolve => setImmediate(resolve));
    links.at(-1)?.onerror?.();
  }
  await navigation;

  assert.equal(failureCalls, 1, `${label}: 失败导航必须通知壳层一次`);
  assert.equal(store.get('accountSwitchGuard'), null,
    `${label}: 失败占位页不能遗留页面加载 guard`);
  assert.equal(selection.select(accountB, { userInitiated: true }).blocked, false,
    `${label}: 失败后用户必须仍能切换账号`);
  assert.deepEqual(blocked, [], `${label}: 失败后不应继续阻断账号菜单`);
}

await runFailureCase('load', {
  old: { async load() { return { default: { title: '旧页', async mount() {} } }; } },
  broken: { async load() { throw new Error('模块加载失败'); } },
});

await runFailureCase('mount', {
  old: { async load() { return { default: { title: '旧页', async mount() {} } }; } },
  broken: {
    async load() {
      return { default: { title: '坏页', async mount() { throw new Error('挂载失败'); } } };
    },
  },
});

await runFailureCase('css', {
  old: { async load() { return { default: { title: '旧页', async mount() {} } }; } },
  broken: {
    async load() {
      return { default: { title: '坏页', css: '/css/broken.css', async mount() {} } };
    },
  },
}, true);

console.log('web router load failure account guard tests passed');
