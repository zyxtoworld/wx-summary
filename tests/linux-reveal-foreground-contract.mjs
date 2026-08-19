import assert from 'node:assert/strict';
import { __mainInternals } from '../src/main.js';

const linux = __mainInternals.localRevealForegroundEvidence('linux');
assert.deepEqual(linux, {
  foreground_requested: false,
  foreground_verified: false,
  foreground_label: '在文件管理器中定位',
  foreground_note: '桌面环境可能让文件管理器留在后台。',
}, 'Linux reveal evidence must never claim a foreground request or verification');

const mac = __mainInternals.localRevealForegroundEvidence('darwin', { requested: true, verified: false });
assert.equal(mac.foreground_requested, true);
assert.equal(mac.foreground_verified, false);
assert.equal(mac.foreground_note, '');

console.log('Linux reveal foreground contract passed');
