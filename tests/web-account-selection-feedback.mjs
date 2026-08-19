import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReplaceableNotice } from '../src/web/public/js/shared/replaceable-notice.js';

const events = [];
const notices = createReplaceableNotice((message, type) => {
  const handle = {
    dismiss() { events.push(`dismiss:${message}`); },
  };
  events.push(`show:${type}:${message}`);
  return handle;
});

notices.show('存在未保存草稿', 'warn');
notices.show('账号已切换', 'success');
assert.deepEqual(events, [
  'show:warn:存在未保存草稿',
  'dismiss:存在未保存草稿',
  'show:success:账号已切换',
], '成功反馈出现前必须撤销同一账号选择槽位中的阻止提示');

notices.clear();
assert.equal(events.at(-1), 'dismiss:账号已切换');
notices.clear();
assert.equal(events.filter(event => event === 'dismiss:账号已切换').length, 1,
  '重复清理必须幂等');

const mainSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');
assert.match(mainSource,
  /const accountSelectionNotice = createReplaceableNotice\([\s\S]*?ui\.toast\(message, \{ type \}\)/,
  '壳层必须为账号选择反馈创建独立可替换槽位');
assert.match(mainSource,
  /onBlocked: message => accountSelectionNotice\.show\(message, 'warn'\)[\s\S]*?onSelected: account => accountSelectionNotice\.show\([\s\S]*?'success',?\s*\)/,
  '阻止与成功反馈必须共用同一槽位，不能留下矛盾提示');

console.log('web account selection feedback tests passed');
