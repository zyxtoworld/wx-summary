import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/web/public/js/pages/history/index.js', import.meta.url), 'utf8');
assert.match(
  source,
  /还没有历史记录。先到「总结」页生成并保存长图。/,
  '历史空状态必须使用完整中文句子，不能在用户可见文案中留下英文分号',
);
assert.doesNotMatch(
  source,
  /还没有历史记录[;；]/,
  '历史空状态的完整句子后不得继续拼接分号',
);

console.log('web history empty-state text tests passed');
