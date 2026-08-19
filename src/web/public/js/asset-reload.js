export function assetReloadGuardKey(serverVersion) {
  return `wx-summary:asset-reload:${serverVersion || 'unknown'}`;
}

// 页面资源恢复是一次性状态机：检查中、已安排重载、手动恢复、等待服务重启
// 都必须吞掉后续 409，避免重复探测、重复重载和永久提示堆叠。
export function createAssetReloadCoordinator({
  assetVersion = '',
  readState,
  storage,
  showRestartRequiredNotice = () => {},
  showReloadScheduledNotice = () => {},
  showManualReloadNotice = () => {},
  scheduleReload = () => {},
} = {}) {
  if (typeof readState !== 'function') throw new TypeError('readState is required');

  const version = String(assetVersion || '').trim();
  let status = 'idle';

  return async function requestGuardedAssetReload() {
    if (status !== 'idle') return;
    status = 'checking';
    try {
      let data = null;
      let stateReadFailed = false;
      try {
        data = await readState();
      } catch {
        stateReadFailed = true;
      }

      const serverVersion = String(data?.asset_version || '').trim();
      const sourceVersion = String(data?.source_asset_version || '').trim();
      if (stateReadFailed || !serverVersion) {
        showManualReloadNotice();
        status = 'manual-required';
        return;
      }
      if (sourceVersion && sourceVersion !== serverVersion) {
        showRestartRequiredNotice();
        status = 'restart-required';
        return;
      }

      const key = assetReloadGuardKey(serverVersion);
      let alreadyReloaded = false;
      let guardAvailable = true;
      try {
        alreadyReloaded = storage?.getItem(key) === version;
        if (!alreadyReloaded) storage?.setItem(key, version);
      } catch {
        guardAvailable = false;
      }

      if (!guardAvailable || alreadyReloaded) {
        showManualReloadNotice();
        status = 'manual-required';
        return;
      }

      showReloadScheduledNotice();
      scheduleReload();
      status = 'reload-scheduled';
    } finally {
      if (status === 'checking') status = 'idle';
    }
  };
}
