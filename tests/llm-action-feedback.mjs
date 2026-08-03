import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const indexSource = await fsp.readFile(new URL('../src/web/views/index.html', import.meta.url), 'utf8');

assert.doesNotMatch(
  indexSource,
  /id="s-(?:list-models|test-llm)"[^>]*\sdisabled(?:\s|>)/,
  'AI actions must be clickable before the form is complete so their inline validation can explain what is missing',
);
assert.match(
  appSource,
  /settingsSaveBusy\(\)[\s\S]*?hardBlocked: true[\s\S]*?settingsPageObservedRevisionStale\(\)[\s\S]*?hardBlocked: true/,
  'only active saves and stale settings revisions should hard-disable AI actions',
);
assert.match(
  appSource,
  /const hardBlocked = gate\?\.hardBlocked === true;[\s\S]*?setButtonKeepDisabled\(button, hardBlocked\)[\s\S]*?aria-disabled[\s\S]*?blocked/,
  'ordinary form validation failures should remain focusable/clickable while exposing aria-disabled state',
);
assert.match(
  appSource,
  /if \(!requireCurrentLlmEndpoint\(\$st\)\) return;[\s\S]*?if \(!requireCurrentLlmEndpoint\(\$st, \{ requireModel: true \}\)\) return;/,
  'click handlers must surface the concrete model-list and connectivity validation errors inline',
);

console.log('LLM action feedback tests passed');
