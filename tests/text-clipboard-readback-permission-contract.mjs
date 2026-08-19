import assert from 'node:assert/strict';
import { readBrowserTextClipboardIfAlreadyPermitted } from '../src/web/public/js/shared/clipboard-permission.js';

let reads = 0;
const navigatorTarget = {
  clipboard: {
    async readText() {
      reads += 1;
      return '已授权文本';
    },
  },
};

const skipped = await readBrowserTextClipboardIfAlreadyPermitted({
  navigatorTarget,
  permission: 'prompt',
});
assert.equal(skipped.skipped, true);
assert.equal(skipped.error?.code, 'BROWSER_CLIPBOARD_READBACK_NOT_PREAUTHORIZED');
assert.equal(reads, 0, 'prompt/denied/unknown states must not trigger a permission request or readback');

const read = await readBrowserTextClipboardIfAlreadyPermitted({
  navigatorTarget,
  permission: 'granted',
});
assert.deepEqual(read, { value: '已授权文本', skipped: false, error: null });
assert.equal(reads, 1);

const unavailable = await readBrowserTextClipboardIfAlreadyPermitted({
  navigatorTarget: {},
  permission: 'granted',
});
assert.equal(unavailable.error?.code, 'BROWSER_CLIPBOARD_READBACK_UNAVAILABLE');

console.log('text clipboard readback permission contract passed');
