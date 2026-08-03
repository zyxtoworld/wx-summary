import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');
const routeSource = appSource.slice(appSource.indexOf('async function route('), appSource.indexOf('function focusRouteHeading'));
const settingsSource = appSource.slice(appSource.indexOf('async function renderSettings()'), appSource.indexOf('async function renderSetup()'));

assert.ok(
  settingsSource.includes('id="settings-loading-title"')
    && settingsSource.includes("$app.innerHTML = ''")
    && settingsSource.includes("$app.appendChild(tplOf('tpl-settings'))"),
  'the settings route fixture must exercise an asynchronously replaced loading heading',
);
assert.ok(
  routeSource.includes('if (!focusedByIntent && !focusClaimedByRenderedPage) {')
    && routeSource.includes('routeFocusApplied = false;')
    && routeSource.includes('applyDefaultRouteFocus();'),
  'after an async route replaces its focused loading DOM, routing must allow the final page heading to claim focus again',
);

console.log('async route focus restoration contract passed');
