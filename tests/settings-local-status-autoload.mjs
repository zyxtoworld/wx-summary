import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'web', 'views', 'index.html'), 'utf8');

const start = source.indexOf('async function refreshAcceptanceChecks()');
const end = source.indexOf('// 关于', start);
assert.notEqual(start, -1, 'local-status refresh implementation should exist');
assert.notEqual(end, -1, 'local-status refresh block should have a stable boundary');
const block = source.slice(start, end);

assert.ok(block.includes('function runAcceptanceRefresh'), 'local status should use one deduplicated refresh entry point');
assert.ok(block.includes('acceptanceRefreshPromise'), 'local status should coalesce repeated activation while a read is in flight');
assert.ok(block.includes("event?.detail?.section !== 'acceptance'"), 'only activating the local-status tab should trigger its automatic read');
assert.ok(block.includes("window.addEventListener(SETTINGS_SECTION_ACTIVATED_EVENT, onAcceptanceSectionActivated)"), 'local status should react when its settings tab is opened');
assert.ok(block.includes("registerRouteCleanup(() => window.removeEventListener(SETTINGS_SECTION_ACTIVATED_EVENT, onAcceptanceSectionActivated))"), 'local-status activation binding should be removed with the settings route');
assert.ok(block.includes("if (settingsSectionIsActive('acceptance')) void runAcceptanceRefresh({ automatic: true })"), 'restoring settings directly to the local-status tab should immediately load it');
assert.ok(block.includes("refreshAcceptanceButton.addEventListener('click', () => void runAcceptanceRefresh())"), 'manual refresh should share the same in-flight guard');
assert.ok(indexHtml.includes('正在准备本机状态...'), 'the local-status placeholder should not tell users to perform a redundant first refresh');
assert.equal(indexHtml.includes('需要时点击刷新查看本机运行状态。'), false, 'opening local status should not leave an empty manual-refresh instruction');

console.log('settings local-status autoload contract passed');
