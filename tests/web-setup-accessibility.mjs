import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configureLiveRegion } from '../src/web/public/js/ui/live-region.js';

const attrs = new Map();
const node = { setAttribute(name, value) { attrs.set(name, String(value)); } };
assert.equal(configureLiveRegion(node), node);
assert.equal(attrs.get('role'), 'status');
assert.equal(attrs.get('aria-live'), 'polite');
assert.equal(attrs.get('aria-atomic'), 'true');

const alertAttrs = new Map();
const alert = { setAttribute(name, value) { alertAttrs.set(name, String(value)); } };
configureLiveRegion(alert, { role: 'alert', politeness: 'assertive', atomic: false });
assert.equal(alertAttrs.get('role'), 'alert');
assert.equal(alertAttrs.get('aria-live'), 'assertive');
assert.equal(alertAttrs.has('aria-atomic'), false);

const keyStepSource = await readFile(
  new URL('../src/web/public/js/pages/setup/step-key.js', import.meta.url),
  'utf8',
);
assert.match(
  keyStepSource,
  /const manualLabel = el\('label', 'setup-section-title', '手动输入密钥候选'\);/,
  '手动密钥输入必须使用持久可见的原生 label，不能只依赖 placeholder',
);
assert.match(
  keyStepSource,
  /keyInput\.id = 'setup-manual-key-candidates';[\s\S]*?manualLabel\.htmlFor = keyInput\.id;/,
  '手动密钥 label 必须明确关联 textarea',
);
assert.match(
  keyStepSource,
  /manualSection\.append\(manualLabel, manualHint, keyInput, manualActions\);/,
  '关联后的手动密钥 label 必须进入实际生产 DOM',
);

console.log('web setup accessibility tests passed');
