import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const settingsSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'pages', 'settings', 'index.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'shared', 'settings-runtime-sync.js'), 'utf8');

assert.match(settingsSource, /function ensureNoticeBar\(\)[\s\S]*?重新载入设置[\s\S]*?保存全部草稿并刷新[\s\S]*?暂不[\s\S]*?settings-notice/, '设置更新通知必须复用稳定通知条并提供载入、保存刷新和暂不操作');
assert.match(settingsSource, /async function confirmReloadDiscardingDrafts\(trigger = null\)[\s\S]*?hasUnsavedDrafts\(\)[\s\S]*?confirmDialog[\s\S]*?refreshFromServer/, '普通草稿或账号级草稿存在时重新载入必须先确认,然后从服务端刷新');
assert.match(settingsSource, /function markStale\([\s\S]*?hasUnsavedDrafts\(\)[\s\S]*?showNotice\(/, '检测到设置版本变化时必须通过统一草稿状态保留草稿提示并显示稳定通知条');
assert.match(settingsSource, /const focusProbe = createLatestSettingsRevisionProbe\(/, '设置页必须使用单飞版本探测器');
assert.match(settingsSource, /const onFocus = \(\)[\s\S]*?focusProbe\.request\(\)[\s\S]*?window\.addEventListener\('focus', onFocus\)/, '窗口重新获得焦点时必须探测最新设置版本');
assert.match(settingsSource, /focusProbe\.dispose\(\)/, '设置页卸载时必须停止版本探测器');
assert.match(settingsSource, /const focusProbe = createLatestSettingsRevisionProbe\(\{[\s\S]*?onError:[\s\S]*?设置版本探测失败/, '后台版本探测失败必须被受控处理,不得形成未处理 Promise rejection');

assert.match(runtimeSource, /let activePromise = null;\s*let rerunRequested = false;/, '版本探测器必须维护单飞请求与重跑标记');
assert.match(runtimeSource, /if \(activePromise\) \{[\s\S]*?rerunRequested = true;[\s\S]*?return activePromise;/, '探测请求并发时必须合并为一次请求并安排重跑');
assert.match(runtimeSource, /do \{[\s\S]*?rerunRequested = false;[\s\S]*?\} while \(rerunRequested && active\(\)\)/, '版本探测器必须在并发请求期间发生变化后再跑一轮');
assert.match(runtimeSource, /dispose\(\) \{[\s\S]*?disposed = true;[\s\S]*?rerunRequested = false;/, '版本探测器销毁时必须停止后续重跑');
assert.match(runtimeSource, /catch \(error\) \{[\s\S]*?onError\(error\)[\s\S]*?\} while \(rerunRequested && active\(\)\)/, '探测失败必须上报并继续兑现已经排队的最后一次探测');

console.log('settings state retry focus contract passed');
