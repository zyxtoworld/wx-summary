// hash 路由 + 页面动态加载 + 离开守卫。
import { focusRouteHeading } from './shared/route-focus.js';
// 页面插件接口(详见 src/web/AGENTS.md):
//   export default {
//     title: '页面名',
//     css: '/css/xxx.css',   // 可选,router 去重注入
//     mount(el, ctx) {},        // ctx = { api, store, navigate, ui, session }
//     unmount() {},             // 可选清理
//     canLeave() {},            // 可选离开守卫,返回 false 阻止切换
//   }
//
// 并发模型(修复双挂载竞态):
// - 所有路由执行严格串行:requestRoute() 把请求挂上同一条 Promise 链;
// - 链外只保留"当前 location.hash 即目标",排队的多个请求自然合并为最新一个;
// - 单次 performRoute 内,旧页 unmount → 清空 #app → 加载 → mount 全程独占 #app,
//   mount 期间到达的新请求只会在本次 mount 完成后立刻卸载并切换,
//   任何时刻 #app 里只有一个页面的内容;
// - 幂等:目标路由与当前页面相同则直接跳过(navigate/replace 与 start 的重复调用消重)。
const DEFAULT_ROUTE = 'digest';

export function registeredRouteName(name, routes = {}, fallback = DEFAULT_ROUTE) {
  const requested = String(name || '').trim() || fallback;
  const registered = Object.keys(routes || {});
  if (!registered.length || Object.hasOwn(routes, requested)) return requested;
  if (Object.hasOwn(routes, fallback)) return fallback;
  return registered[0] || fallback;
}

// 托盘定位令牌:启动 URL 带 ?focus=<24hex> 时,index.html 已把令牌写入窗口标题,
// 这里负责在路由切换设置标题时保留标记,并在 15 秒后清除标记与 URL 参数
// (对齐 src/tray/open-web-foreground.ps1 的 wx-focus-<token> 查找)。
const LAUNCH_FOCUS_TOKEN = /^[a-f0-9]{24}$/.test(String(window.__WX_LAUNCH_FOCUS_TOKEN__ || ''))
  ? String(window.__WX_LAUNCH_FOCUS_TOKEN__)
  : '';
const LAUNCH_FOCUS_TITLE_TTL_MS = 15_000;
let launchFocusTitleActive = !!LAUNCH_FOCUS_TOKEN;

function routeNameFromHash(hash = location.hash) {
  const clean = String(hash || '').replace(/^#\/?/, '').split(/[?#]/)[0].trim();
  return clean || DEFAULT_ROUTE;
}

export function createRouter({
  root,
  routes = {},
  ctx = {},
  onRouteChange = null,
  onRouteLoading = null,
  onRouteLoadingFailure = null,
  pageTitle = name => name,
} = {}) {
  if (!root) throw new Error('router 需要内容根节点');
  const injectedCss = new Map();
  let current = null; // { name, module, cleanup }
  let navChain = Promise.resolve(); // 串行导航链
  let pending = false;              // 链外是否有待消化的路由请求
  let requestRevision = 0;          // 区分守卫等待期间到达的新导航
  let started = false;

  function loadCss(href) {
    const url = String(href || '').trim();
    if (!url) return Promise.resolve();
    const existing = injectedCss.get(url);
    if (existing) return existing;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.pageCss = url;
    const ready = new Promise((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => {
        injectedCss.delete(url);
        link.remove?.();
        reject(new Error(`页面样式加载失败:${url}`));
      };
    });
    injectedCss.set(url, ready);
    document.head.appendChild(link);
    return ready;
  }

  function setNavActive(name) {
    for (const item of document.querySelectorAll('.nav-item[data-route]')) {
      const active = item.dataset.route === name;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
  }

  function focusNavEntry(name) {
    for (const item of document.querySelectorAll('.nav-item[data-route]')) {
      if (item.dataset.route !== name || typeof item.focus !== 'function') continue;
      item.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  function canonicalizeRouteHash(name) {
    const expected = `#/${name}`;
    if (location.hash === expected) return;
    const url = new URL(location.href);
    url.hash = expected;
    history.replaceState(history.state, document.title, url);
  }

  // 页面加载失败占位:绝不静默。
  function renderLoadFailure(name, error) {
    const message = String(error?.message || error || '未知错误');
    const section = document.createElement('section');
    section.className = 'page-load-failure';
    const title = document.createElement('h2');
    title.textContent = '页面加载失败';
    const detail = document.createElement('p');
    detail.textContent = `路由 #/${name} 对应的页面模块加载失败:${message}`;
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = '请刷新页面重试;若持续失败,请查看服务日志。';
    section.append(title, detail, hint);
    return {
      title: '加载失败',
      failure: error,
      module: {
        title: '加载失败',
        mount(el) { el.appendChild(section); },
      },
    };
  }

  function reportRouteLoadingFailure(name, error, page = current?.module) {
    try {
      page?.onRouteLoadingFailure?.(name, error);
    } catch (callbackError) {
      // 页面失败反馈属于诊断路径;无论它是否异常,路由都必须保持失败占位。
      console.error('route loading failure callback failed', callbackError);
    }
    try {
      onRouteLoadingFailure?.(name, error);
    } catch (callbackError) {
      console.error('shell route loading failure callback failed', callbackError);
    }
  }

  async function loadPageModule(name) {
    const entry = routes[name];
    try {
      const module = entry && typeof entry.load === 'function'
        ? await entry.load()
        : await import(`/js/pages/${name}/index.js`);
      const page = module?.default;
      if (!page || typeof page.mount !== 'function') {
        throw new Error('页面模块缺少默认导出的 mount(el, ctx)');
      }
      return { title: page.title || name, module: page };
    } catch (error) {
      console.error(`page load failed: ${name}`, error);
      return renderLoadFailure(name, error);
    }
  }

  // 单次导航执行。调用方保证串行(只在导航链上运行)。
  async function performRoute(revision) {
    let name = registeredRouteName(routeNameFromHash(), routes);
    const targetIsCurrent = () => registeredRouteName(routeNameFromHash(), routes) === name;
    // 幂等:目标就是当前页面时不做任何事(覆盖 navigate(replace)+start() 等重复触发)。
    if (current?.name === name) {
      canonicalizeRouteHash(name);
      return;
    }

    // 离开守卫:当前页面可以拒绝(例如生成进行中)。
    if (current?.name && typeof current.module.canLeave === 'function') {
      const guardedHash = String(location.hash || '');
      let allowed = true;
      try {
        allowed = await current.module.canLeave(name);
      } catch (error) {
        console.error('canLeave guard failed', error);
        allowed = false;
      }
      // 离开许可只属于发起守卫时的目标。等待期间一旦出现新请求或 hash
      // 变化，本轮立即退出，由 pending 队列按最新目标重新执行守卫。
      if (requestRevision !== revision || String(location.hash || '') !== guardedHash) return;
      if (allowed === false) {
        canonicalizeRouteHash(current.name);
        focusNavEntry(current.name);
        return;
      }
    }

    // 在卸载旧页、动态加载新页和 mount 之间,页面自己的账号守卫可能暂时
    // 不存在;通知壳层先切到 fail-closed 的加载状态,直到新页注册自己的守卫。
    try {
      onRouteLoading?.(name, current?.name || '');
    } catch (error) {
      // 这是守卫链的一部分,失败时必须停在旧页;否则壳层可能仍允许账号切换,
      // 而旧页已卸载、新页尚未注册 guard,形成可操作的安全空窗。
      console.error('route loading guard failed', error);
      reportRouteLoadingFailure(name, error);
      if (current?.name) {
        canonicalizeRouteHash(current.name);
        focusNavEntry(current.name);
      } else {
        const failure = renderLoadFailure(name, error);
        root.replaceChildren();
        document.title = `${failure.title} · 微信群总结`;
        setNavActive(name);
        failure.module.mount(root);
        current = { name, module: failure.module, cleanup: null };
      }
      return;
    }

    canonicalizeRouteHash(name);

    // 先卸载旧页面。
    if (current) {
      try { await current.module.unmount?.(); } catch (error) { console.error('page unmount failed', error); }
      try { await current.cleanup?.(); } catch (error) { console.error('page cleanup failed', error); }
      current = null;
    }
    if (!targetIsCurrent()) return;
    root.replaceChildren();
    // 每次进入新页面从内容顶部开始;页面自己的焦点/视图恢复在 mount 内完成。
    root.scrollTop = 0;

    let loaded = await loadPageModule(name);
    if (!targetIsCurrent()) return;
    if (loaded.failure) reportRouteLoadingFailure(name, loaded.failure, null);

    if (loaded.module.css) {
      try {
        // 页面私有 CSS 是 mount 的前置条件；否则带 transition 的控件会从浏览器
        // 默认样式过渡到页面样式，首次进入时产生明显闪烁。
        await loadCss(loaded.module.css);
      } catch (error) {
        console.error(`page css load failed: ${name}`, error);
        loaded = renderLoadFailure(name, error);
        if (targetIsCurrent()) reportRouteLoadingFailure(name, error, null);
      }
    }
    if (!targetIsCurrent()) return;
    document.title = launchFocusTitleActive
      ? `${loaded.title} · 微信群总结 · wx-focus-${LAUNCH_FOCUS_TOKEN}`
      : `${loaded.title} · 微信群总结`;
    setNavActive(name);

    // mount 全程独占 #app;期间到达的路由请求在 mount 完成后由导航链立刻消化
    // (下一步迭代会先卸载本页再挂载新页)。
    let cleanup = null;
    try {
      const mountResult = await loaded.module.mount(root, ctx);
      if (typeof mountResult === 'function') cleanup = mountResult;
    } catch (error) {
      console.error(`page mount failed: ${name}`, error);
      root.replaceChildren();
      const failure = renderLoadFailure(name, error);
      failure.module.mount(root);
      reportRouteLoadingFailure(name, error, null);
      current = { name, module: failure.module, cleanup: null };
      return;
    }
    current = { name, module: loaded.module, cleanup };
    focusRouteHeading(root);
    try { onRouteChange?.(name, loaded.module); } catch {}
  }

  async function drainQueue() {
    // 每次迭代重读 location.hash:排队的多个请求只保留最新目标。
    while (pending) {
      pending = false;
      const revision = requestRevision;
      await performRoute(revision);
    }
  }

  function requestRoute() {
    requestRevision += 1;
    pending = true;
    navChain = navChain.then(drainQueue).catch(error => {
      console.error('router navigation failed', error);
    });
    return navChain;
  }

  function navigate(target, { replace = false } = {}) {
    const hash = target.startsWith('#') ? target : `#/${String(target || '').replace(/^\/+/, '')}`;
    if (location.hash === hash) {
      // hash 未变:hashchange 不会触发,主动请求一次(幂等)。
      void requestRoute();
      return;
    }
    if (replace) {
      const url = new URL(location.href);
      url.hash = hash;
      history.replaceState(history.state, document.title, url);
      // replaceState 不触发 hashchange,主动请求。
      void requestRoute();
      return;
    }
    location.hash = hash; // hashchange → requestRoute
  }

  function start() {
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      const url = new URL(location.href);
      url.hash = `#/${DEFAULT_ROUTE}`;
      history.replaceState(history.state, document.title, url);
    }
    if (!started) {
      started = true;
      window.addEventListener('hashchange', () => { void requestRoute(); });
    }
    if (launchFocusTitleActive) {
      // 托盘定位窗口已被用户看到/点击,15 秒后撤掉标题里的定位令牌与 URL 参数。
      setTimeout(() => {
        launchFocusTitleActive = false;
        try {
          const next = new URL(location.href);
          next.searchParams.delete('focus');
          history.replaceState(history.state, document.title, `${next.pathname}${next.search}${next.hash}`);
        } catch {}
        if (current?.module?.title) document.title = `${current.module.title} · 微信群总结`;
      }, LAUNCH_FOCUS_TITLE_TTL_MS);
    }
    void requestRoute();
  }

  return {
    start,
    navigate,
    route: () => requestRoute(),
    currentName: () => current?.name || registeredRouteName(routeNameFromHash(), routes),
  };
}
