import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

assert.ok(
  css.includes(`main {
    padding: var(--gap-3);
    max-width: 100vw;
    overflow-x: clip;
  }`),
  'mobile main must clip horizontal overflow without becoming the scroll container for sticky settings tabs',
);

console.log('mobile settings sticky scroll-container contract passed');
