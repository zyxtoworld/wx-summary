import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

const setupRetryStart = app.indexOf('function attachSetupAccountRetry(');
const setupRetryEnd = app.indexOf('\n  async function setupSelectedAccountId(', setupRetryStart);
assert.ok(setupRetryStart >= 0 && setupRetryEnd > setupRetryStart, 'setup account retry source must be inspectable');
const setupRetrySource = app.slice(setupRetryStart, setupRetryEnd);
assert.ok(setupRetrySource.includes('restoreSetupStatusActionFocus'), 'setup account retry must restore keyboard focus after replacing its status actions');
assert.ok(setupRetrySource.includes('document.activeElement === event.currentTarget'), 'focus restoration must only be requested when the retry action owned focus');

const mobileTabsStart = css.lastIndexOf('  .settings-section-tabs {');
const mobileStart = css.lastIndexOf('@media (max-width: 640px)', mobileTabsStart);
const mobileEnd = css.indexOf('@media (prefers-reduced-motion: reduce)', mobileStart);
const mobileTabs = css.slice(mobileStart, mobileEnd);
assert.match(mobileTabs, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/, 'mobile settings tabs should use two stable columns');
assert.match(mobileTabs, /white-space:\s*normal/, 'mobile settings tab labels must be allowed to wrap');

console.log('app settings accessibility tests passed');
