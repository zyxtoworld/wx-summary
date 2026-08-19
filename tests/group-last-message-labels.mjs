import assert from 'node:assert/strict';
import {
  digestGroupSessionWarning,
  formatGroupLastMessageLabel,
} from '../src/web/public/js/pages/digest/group-status.js';

assert.equal(formatGroupLastMessageLabel(0, 'unknown'), '消息时间未知');
assert.equal(formatGroupLastMessageLabel(0, 'session_unavailable'), '消息时间未知');
assert.equal(formatGroupLastMessageLabel(0, ''), '消息时间未知');
assert.equal(formatGroupLastMessageLabel(0, 'untrusted_time'), '消息时间异常');
assert.match(formatGroupLastMessageLabel(Date.parse('2026-08-07T00:00:00Z'), 'ok'), /^8\/7$/);

const unknownWarning = digestGroupSessionWarning([{ last_msg_status: 'unknown' }]);
assert.match(unknownWarning, /消息时间未知/);
assert.match(unknownWarning, /只影响排序/);
assert.match(unknownWarning, /生成仍按所选范围读取消息/);

const mixedWarning = digestGroupSessionWarning([
  { source_detail: 'session_only', last_msg_status: 'unknown' },
  { last_msg_status: 'untrusted_time' },
]);
assert.match(mixedWarning, /消息时间异常/);
assert.match(mixedWarning, /群名可能显示为原始 ID/);

console.log('group last-message labels contract passed');
