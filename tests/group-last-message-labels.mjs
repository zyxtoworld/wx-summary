import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

const fmtTimeAgo = Function(`${extractFunction('fmtTimeAgo')}; return fmtTimeAgo;`)();
const digestGroupSessionWarning = Function(`${extractFunction('digestGroupSessionWarning')}; return digestGroupSessionWarning;`)();

assert.equal(fmtTimeAgo(0, 'unknown'), '消息时间未知', 'missing session timestamps must not claim a group has no recent messages');
assert.equal(fmtTimeAgo(0, 'session_unavailable'), '消息时间未知', 'an unavailable optional session database must remain a timestamp issue');
assert.equal(fmtTimeAgo(0, ''), '消息时间未知', 'an absent unclassified timestamp must not be interpreted as message absence');
assert.equal(fmtTimeAgo(0, 'untrusted_time'), '消息时间异常', 'implausible raw timestamps should remain visibly distinct from missing timestamps');

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
