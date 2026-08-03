import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const start = app.indexOf('function localStatusPngRevealSummary(');
const end = app.indexOf('\n  function localStatusDisplayItem(', start);
assert.ok(start >= 0 && end > start, 'local PNG reveal status helper must remain available');

const source = app.slice(start, end);
assert.match(source, /missing_current_png_save_evidence/,
  'a recorded reveal without a current saved-PNG target must have its own state');
assert.match(source, /已记录到定位 PNG，但当前服务还没有“最近保存的长图”作为验收目标/,
  'the UI must not claim that no reveal was recorded when only the current saved-PNG target is missing');
assert.match(source, /已记录到定位 PNG，但它不是当前最近保存的长图/,
  'the UI must explain a reveal bound to an older PNG');
assert.match(source, /尚未记录到定位已保存 PNG 的操作；定位 MD 不计入这项图片验收/,
  'the no-evidence copy must remain reserved for a genuinely missing PNG reveal');

const displayStart = app.indexOf('function localStatusDisplayItem(');
const displayEnd = app.indexOf('\n  async function refreshAcceptanceChecks(', displayStart);
const displaySource = app.slice(displayStart, displayEnd);
assert.match(displaySource, /const b8HasRecordedReveal = !!item\?\.latest_evidence/,
  'the B8 card must distinguish an existing reveal record from no evidence');
assert.match(displaySource, /state: completed \? '已记录' : \(failed \? '需要重试' : \(b8HasRecordedReveal \? '需定位当前图' : '等待操作'\)\)/,
  'the B8 state label must identify recorded-but-stale reveal evidence');
assert.match(displaySource, /summary: localStatusPngRevealSummary\(item, \{ completed, failed \}\)/,
  'the B8 card must use the evidence-aware summary');

console.log('local status PNG reveal display tests passed');
