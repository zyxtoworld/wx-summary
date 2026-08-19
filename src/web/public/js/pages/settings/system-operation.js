// 设置页本机状态请求协调器：同一时刻只允许一个诊断读取操作。
export function createSettingsSystemOperation() {
  let active = null;

  return {
    run(task) {
      if (active) return active;

      let started;
      try {
        started = Promise.resolve(task());
      } catch (error) {
        started = Promise.reject(error);
      }

      const tracked = started.finally(() => {
        if (active === tracked) active = null;
      });
      active = tracked;
      return tracked;
    },

    invalidate() {
      if (!active) return false;
      active = null;
      return true;
    },
  };
}
