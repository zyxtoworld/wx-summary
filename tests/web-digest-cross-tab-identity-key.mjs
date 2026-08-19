import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCrossTabTaskRunner } from '../src/web/public/js/shared/cross-tab-task-runner.js';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);

function extractFunction(sourceText, marker) {
  const start = sourceText.indexOf(marker);
  assert.ok(start >= 0, `必须能定位生产函数 ${marker}`);
  const signatureEnd = sourceText.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, `${marker} 必须有函数体`);
  const open = sourceText.indexOf('{', signatureEnd + 2);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`' || char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${marker} 函数体未闭合`);
}

const taskIdSource = extractFunction(
  source,
  source.includes('async function digestCrossTabTaskId(')
    ? 'async function digestCrossTabTaskId('
    : 'function digestCrossTabTaskId(',
);
const digestCrossTabTaskId = await new Function(
  `return (async () => { ${taskIdSource}; return digestCrossTabTaskId; })();`,
)();

// 这两组输入均符合生产账号/指纹格式,但旧的 32 位 FNV key 会碰撞。
const accountA = {
  id: 'acct-6b48fdaf-13017',
  fingerprint: '8a4e8f428cf285b9151873c45af0ec53ecef05960c71fffd49ecc13830e91337',
};
const accountB = {
  id: 'acct-6c7bad14-70932',
  fingerprint: 'eca0b563ff889b66d13f7b8d38a76788ec776547b4c861fad30f8911877eaf3c',
};

const taskIdA = await digestCrossTabTaskId(accountA.id, accountA.fingerprint);
const taskIdB = await digestCrossTabTaskId(accountB.id, accountB.fingerprint);
assert.match(taskIdA, /^digest-[0-9a-f]{64}$/,
  '摘要跨标签 task id 必须是固定长度的安全十六进制 key');
assert.notEqual(taskIdA, taskIdB,
  '不同账号身份不得因哈希碰撞共享摘要 Web Lock');

const heldNames = new Set();
const lockNames = [];
const locks = {
  request(name, _options, callback) {
    lockNames.push(name);
    if (heldNames.has(name)) return Promise.resolve(callback(null));
    heldNames.add(name);
    const result = callback({ name });
    return Promise.resolve(result).finally(() => { heldNames.delete(name); });
  },
};

const runnerA = createCrossTabTaskRunner({ locks, namespace: 'digest-generation' });
const runnerB = createCrossTabTaskRunner({ locks, namespace: 'digest-generation' });
const leaseA = await runnerA.acquire(taskIdA, { ifAvailable: true });
assert.equal(leaseA.acquired, true, '账号 A 必须先取得自己的生成 owner');
const leaseB = await runnerB.acquire(taskIdB, { ifAvailable: true });
assert.equal(leaseB.acquired, true,
  '账号 B 与 A 身份不同,必须能并行取得独立 owner');
assert.notEqual(lockNames[0], lockNames[1], '不同身份必须映射到不同的 Web Lock 名称');
assert.equal(leaseA.release(), true);
assert.equal(leaseB.release(), true);

console.log('web digest cross-tab identity key tests passed');
