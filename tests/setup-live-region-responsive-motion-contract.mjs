import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const html = await fsp.readFile(new URL('../src/web/views/index.html', import.meta.url), 'utf8');
const app = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const css = await fsp.readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

const setupTemplate = html.slice(html.indexOf('<template id="tpl-setup">'), html.indexOf('</template>', html.indexOf('<template id="tpl-setup">')));
const bodyEnd = setupTemplate.indexOf('</div>', setupTemplate.indexOf('id="setup-body"'));
const stableStatusAt = setupTemplate.indexOf('id="setup-live-status"');
assert.ok(stableStatusAt > bodyEnd, 'setup live status must remain outside the replaceable setup-body');
assert.match(setupTemplate, /id="setup-live-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);

const setupStart = app.indexOf('async function renderSetup(');
const setupEnd = app.indexOf('\nasync function ', setupStart + 20);
const setupSource = app.slice(setupStart, setupEnd > setupStart ? setupEnd : app.length);
assert.match(setupSource, /function setSetupLiveStatus\(/, 'setup should update one stable live status helper');
assert.match(setupSource, /\$body\.setAttribute\('aria-busy', 'true'\)/, 'group-list loading must mark the replaceable body busy');
assert.match(setupSource, /\$body\.removeAttribute\('aria-busy'\)/, 'every terminal group-list state must clear busy');
assert.match(setupSource, /setSetupLiveStatus\([^)]*读取[\s\S]*?setSetupLiveStatus\([^)]*已读取/s, 'group-list progress and success must both reach the stable status');
assert.match(setupSource, /setSetupLiveStatus\(statusText,[\s\S]*?alert:/, 'group-list failures must expose alert semantics through the stable status');

const mobile = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('@media', css.indexOf('@media (max-width: 900px)') + 1));
assert.doesNotMatch(mobile, /\.nav\s*\{[^}]*order:\s*2;/s, 'mobile header visual order must not move navigation after later DOM controls');
assert.doesNotMatch(mobile, /\.topbar-right\s*\{[^}]*order:\s*1;/s, 'mobile header visual order must follow DOM tab order');

const sectionNav = app.slice(app.indexOf('function scrollSettingsTabIntoView('), app.indexOf('function bindSettingsSectionNavigation('));
assert.match(sectionNav, /preferredScrollBehavior\(\)/, 'settings tab scrolling must honor reduced-motion preference');
assert.doesNotMatch(sectionNav, /focusTab \|\| scrollPanel \? 'smooth'/, 'settings tab activation must not force smooth scrolling');

console.log('setup live-region, responsive-order, and motion contracts passed');
