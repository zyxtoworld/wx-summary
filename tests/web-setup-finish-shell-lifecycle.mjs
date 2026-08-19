import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/setup/index.js', import.meta.url),
  'utf8',
);

function extractFunction(moduleSource, marker) {
  const start = moduleSource.indexOf(marker);
  assert.ok(start >= 0, `缺少生产函数: ${marker}`);
  const open = moduleSource.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < moduleSource.length; index += 1) {
    const char = moduleSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return moduleSource.slice(start, index + 1);
  }
  throw new Error(`生产函数未闭合: ${marker}`);
}

const goFinishSource = extractFunction(source, '  async function goFinish()');

async function runFinish(finish, { destroyed = false, invoke = true } = {}) {
  const notices = [];
  let generation = 0;
  let refreshCount = 0;
  const page = {
    destroyed,
    busy: false,
    completionNavigationPending: false,
  };
  const step = { finish };
  const goFinish = new Function(
    'stepBusy',
    'currentStep',
    'w',
    'page',
    'refreshButtons',
    'showPageNotice',
    `${goFinishSource}\nreturn goFinish;`,
  )(
    () => page.busy,
    () => step,
    { beginAsync() { generation += 1; return generation; } },
    page,
    () => { refreshCount += 1; },
    (kind, text) => { notices.push({ kind, text }); },
  );
  const outcome = invoke === false ? undefined : await goFinish();
  return { outcome, notices, page, refreshCount, goFinish };
}

const rejected = await runFinish(async () => {
  throw new Error('完成复核失败');
});
assert.equal(rejected.outcome, undefined, '完成动作异常应由壳层收口,不应向按钮事件泄漏拒绝');
assert.deepEqual(rejected.notices, [{ kind: 'err', text: '完成复核失败' }],
  '完成动作普通异常必须投影为可操作错误提示');
assert.equal(rejected.page.busy, false, '完成动作异常后必须释放壳层 busy');
assert.equal(rejected.refreshCount, 2, '完成动作异常后必须刷新按钮状态');

const cancelled = await runFinish(async () => {
  const error = new Error('页面已离开');
  error.name = 'AbortError';
  error.status = 499;
  throw error;
});
assert.deepEqual(cancelled.notices, [], '页面取消不得投影失败提示');
assert.equal(cancelled.page.busy, false, '页面取消后仍必须释放壳层 busy');

// 完成步骤已请求内部导航,但浏览器的 hashchange/router 消费仍在后续任务。
// 这段窗口内不能因为 goFinish finally 释放 busy 就再次启动同一完成动作。
{
  let finishCalls = 0;
  let navigationRequests = 0;
  const harness = await runFinish(async () => {
    finishCalls += 1;
    navigationRequests += 1;
    return true;
  }, { invoke: false });
  await harness.goFinish();
  assert.equal(navigationRequests, 1, '第一次完成应只请求一次内部导航');
  await harness.goFinish();
  assert.equal(finishCalls, 1,
    '内部导航尚未消费时,第二次完成点击不得再次启动 finish');
}

console.log('web setup finish shell lifecycle tests passed');
