// 设置页初始化响应的最小状态门控。
// 只有完整采用(包含分区 repaint)成功后,才允许清除 fail-closed 状态。
import { requireSettingsDocument } from '../../shared/settings-document.js';

export function createSettingsInitializationGate() {
  let failed = false;

  async function load(loader, apply, { isCurrent = () => true } = {}) {
    if (typeof loader !== 'function') {
      failed = true;
      return { ok: false, error: new TypeError('设置加载函数无效') };
    }
    try {
      const settings = await loader();
      if (typeof isCurrent === 'function' && isCurrent() !== true) {
        failed = true;
        return {
          ok: false,
          stale: true,
          error: Object.assign(new Error('设置初始化响应已过期'), {
            code: 'settings_initialization_stale',
          }),
        };
      }
      return attempt(settings, apply);
    } catch (error) {
      failed = true;
      return { ok: false, error };
    }
  }

  function attempt(settings, apply) {
    let document;
    try {
      document = requireSettingsDocument(settings);
    } catch (error) {
      failed = true;
      return { ok: false, error };
    }
    if (typeof apply !== 'function') {
      failed = true;
      return { ok: false, error: new TypeError('设置采用函数无效') };
    }
    try {
      const applied = apply(document);
      if (applied !== true) {
        failed = true;
        return {
          ok: false,
          error: Object.assign(new Error('设置采用未完成'), {
            code: 'settings_adoption_incomplete',
          }),
        };
      }
    } catch (error) {
      failed = true;
      return { ok: false, error };
    }
    failed = false;
    return { ok: true };
  }

  return {
    isFailed() {
      return failed;
    },
    attempt,
    load,
  };
}

// 初始化期间账号上下文可能变化;同一页面只保留一个运行器,旧代次完成后自动
// 重新以最新 generation 执行,避免把旧文档静默丢掉后永远停在 skeleton。
export function createSettingsInitializationLifecycle({
  getGeneration = () => 0,
  isActive = () => true,
  run,
  onSuccess = () => {},
  onFailure = () => {},
} = {}) {
  if (typeof run !== 'function') throw new TypeError('settings initialization lifecycle requires a run callback');
  let running = null;
  let disposed = false;

  const active = () => !disposed && isActive() !== false;
  const start = () => {
    if (!active()) return Promise.resolve({ ok: false, cancelled: true });
    if (running) return running;
    const execute = async () => {
      while (active()) {
        const generation = getGeneration();
        try {
          const value = await run(generation);
          if (!active()) return { ok: false, cancelled: true };
          if (getGeneration() !== generation) continue;
          onSuccess(value, generation);
          return { ok: true, value, generation };
        } catch (error) {
          if (!active()) return { ok: false, cancelled: true, error };
          if (getGeneration() !== generation) continue;
          onFailure(error, generation);
          return { ok: false, error, generation };
        }
      }
      return { ok: false, cancelled: true };
    };
    const tracked = execute().finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    return tracked;
  };

  return {
    start,
    dispose() {
      disposed = true;
    },
    isRunning() {
      return !!running;
    },
  };
}
