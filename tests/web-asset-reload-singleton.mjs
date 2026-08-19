import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');

assert.match(
  mainSource,
  /import\s+\{[^}]*\bcreateAssetReloadCoordinator\b[^}]*\}\s+from\s+'\.\/asset-reload\.js';/,
  '页面资源恢复必须使用持有终态的生产协调器',
);
assert.match(mainSource, /const\s+requestGuardedAssetReload\s*=\s*createAssetReloadCoordinator\s*\(/);
assert.doesNotMatch(mainSource, /let\s+assetReloadInFlight\s*=/);
assert.doesNotMatch(mainSource, /async\s+function\s+requestGuardedAssetReload\s*\(/);

const { createAssetReloadCoordinator } = await import('../src/web/public/js/asset-reload.js');

function memoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

{
  let stateReads = 0;
  let manualNotices = 0;
  let reloadNotices = 0;
  const requestReload = createAssetReloadCoordinator({
    assetVersion: 'asset-a',
    readState: async () => {
      stateReads += 1;
      return { asset_version: 'asset-a', source_asset_version: 'asset-a' };
    },
    storage: memoryStorage([['wx-summary:asset-reload:asset-a', 'asset-a']]),
    showRestartRequiredNotice() { throw new Error('unexpected restart notice'); },
    showReloadScheduledNotice() { reloadNotices += 1; },
    showManualReloadNotice() { manualNotices += 1; },
    scheduleReload() { throw new Error('unexpected reload'); },
  });

  await Promise.all([requestReload(), requestReload()]);
  await requestReload();
  assert.equal(stateReads, 1, '进入手动恢复终态后不得再次探测服务版本');
  assert.equal(manualNotices, 1, '持续过期只显示一条永久手动刷新提示');
  assert.equal(reloadNotices, 0);
}

{
  let releaseState;
  let stateReads = 0;
  let reloadNotices = 0;
  let scheduled = 0;
  const storage = memoryStorage();
  const stateReady = new Promise(resolve => { releaseState = resolve; });
  const requestReload = createAssetReloadCoordinator({
    assetVersion: 'asset-b',
    readState: async () => {
      stateReads += 1;
      await stateReady;
      return { asset_version: 'asset-b', source_asset_version: 'asset-b' };
    },
    storage,
    showRestartRequiredNotice() { throw new Error('unexpected restart notice'); },
    showReloadScheduledNotice() { reloadNotices += 1; },
    showManualReloadNotice() { throw new Error('unexpected manual notice'); },
    scheduleReload() { scheduled += 1; },
  });

  const first = requestReload();
  const concurrent = requestReload();
  releaseState();
  await Promise.all([first, concurrent]);
  await requestReload();
  assert.equal(stateReads, 1, '检查中与已安排重载两种状态都必须合并重复请求');
  assert.equal(reloadNotices, 1);
  assert.equal(scheduled, 1, '同一页面会话只能安排一次自动重载');
  assert.equal(storage.getItem('wx-summary:asset-reload:asset-b'), 'asset-b');
}

{
  let stateReads = 0;
  let restartNotices = 0;
  const requestReload = createAssetReloadCoordinator({
    assetVersion: 'asset-c',
    readState: async () => {
      stateReads += 1;
      return { asset_version: 'served-c', source_asset_version: 'source-c' };
    },
    storage: memoryStorage(),
    showRestartRequiredNotice() { restartNotices += 1; },
    showReloadScheduledNotice() { throw new Error('unexpected reload notice'); },
    showManualReloadNotice() { throw new Error('unexpected manual notice'); },
    scheduleReload() { throw new Error('unexpected reload'); },
  });

  await requestReload();
  await requestReload();
  assert.equal(stateReads, 1);
  assert.equal(restartNotices, 1, '源码与服务资源不一致时只显示一个重启提示');
}

{
  let manualNotices = 0;
  let reloadNotices = 0;
  let scheduled = 0;
  const requestReload = createAssetReloadCoordinator({
    assetVersion: 'asset-d',
    readState: async () => ({ asset_version: 'asset-d', source_asset_version: 'asset-d' }),
    storage: {
      getItem() { throw new Error('synthetic storage denial'); },
      setItem() { throw new Error('unexpected storage write'); },
    },
    showRestartRequiredNotice() { throw new Error('unexpected restart notice'); },
    showReloadScheduledNotice() { reloadNotices += 1; },
    showManualReloadNotice() { manualNotices += 1; },
    scheduleReload() { scheduled += 1; },
  });

  await requestReload();
  await requestReload();
  assert.equal(manualNotices, 1, '无法持久化循环守卫时必须 fail-closed 转为手动刷新');
  assert.equal(reloadNotices, 0);
  assert.equal(scheduled, 0, '没有可持久化守卫时禁止安排自动重载');
}

{
  let manualNotices = 0;
  let reloadNotices = 0;
  let scheduled = 0;
  const requestReload = createAssetReloadCoordinator({
    assetVersion: 'asset-f',
    readState: async () => {
      throw new Error('无法读取服务版本');
    },
    storage: memoryStorage(),
    showRestartRequiredNotice() { throw new Error('无法读取版本时不得提示重启服务'); },
    showReloadScheduledNotice() { reloadNotices += 1; },
    showManualReloadNotice() { manualNotices += 1; },
    scheduleReload() { scheduled += 1; },
  });

  await requestReload();
  assert.equal(manualNotices, 1,
    '无法读取服务版本时必须转为手动恢复,不能把未知版本当成可自动重载');
  assert.equal(reloadNotices, 0, '版本事实未知时不得显示已安排自动重载');
  assert.equal(scheduled, 0, '版本事实未知时不得安排自动重载');
}

{
  let stateReads = 0;
  let restartAttempts = 0;
  const requestReload = createAssetReloadCoordinator({
    assetVersion: 'asset-e',
    readState: async () => {
      stateReads += 1;
      return { asset_version: 'served-e', source_asset_version: 'source-e' };
    },
    storage: memoryStorage(),
    showRestartRequiredNotice() {
      restartAttempts += 1;
      if (restartAttempts === 1) throw new Error('synthetic restart notice failure');
    },
    showReloadScheduledNotice() { throw new Error('unexpected reload notice'); },
    showManualReloadNotice() { throw new Error('unexpected manual notice'); },
    scheduleReload() { throw new Error('unexpected reload'); },
  });

  await assert.rejects(requestReload(), /synthetic restart notice failure/);
  await requestReload();
  assert.equal(stateReads, 2, '提示创建失败后必须释放检查状态并允许重新取证');
  assert.equal(restartAttempts, 2, '提示创建失败不能永久吞掉后续恢复机会');
}

console.log('web asset reload singleton checks passed');
