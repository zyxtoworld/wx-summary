// 极简状态容器:get/set/update/subscribe,按键通知。
// 不做代理、不做深比较——页面自己保证 set 的是新引用。
export function createStore(initial = {}) {
  const state = { ...(initial && typeof initial === 'object' ? initial : {}) };
  const listeners = new Map(); // key -> Set<fn>
  const anyListeners = new Set();

  function reportListenerError(error) {
    const message = 'store listener failed';
    const consoleTarget = globalThis.console;
    try {
      if (typeof consoleTarget?.error === 'function') {
        consoleTarget.error(message, error);
        return;
      }
    } catch {}
    try {
      if (typeof consoleTarget?.warn === 'function') {
        consoleTarget.warn(message, error);
        return;
      }
    } catch {}
    try { globalThis.reportError?.(error); } catch {}
  }

  function get(key, fallback = undefined) {
    return Object.hasOwn(state, key) ? state[key] : fallback;
  }

  function notify(key, value, previous) {
    const bucket = listeners.get(key);
    if (bucket) {
      for (const fn of [...bucket]) {
        try { fn(value, previous, key); } catch (error) { reportListenerError(error); }
      }
    }
    for (const fn of [...anyListeners]) {
      try { fn(key, value, previous); } catch (error) { reportListenerError(error); }
    }
  }

  function set(key, value) {
    const previous = state[key];
    if (Object.is(previous, value)) return value;
    state[key] = value;
    notify(key, value, previous);
    return value;
  }

  function update(key, updater) {
    if (typeof updater !== 'function') throw new TypeError('store.update 需要函数');
    return set(key, updater(get(key)));
  }

  // 返回取消订阅函数。key 传 '*' 订阅所有变化。
  function subscribe(key, fn) {
    if (typeof fn !== 'function') return () => {};
    if (key === '*') {
      anyListeners.add(fn);
      return () => anyListeners.delete(fn);
    }
    const name = String(key || '');
    if (!listeners.has(name)) listeners.set(name, new Set());
    const bucket = listeners.get(name);
    bucket.add(fn);
    return () => bucket.delete(fn);
  }

  return { get, set, update, subscribe };
}
