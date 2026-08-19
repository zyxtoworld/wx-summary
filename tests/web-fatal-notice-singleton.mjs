import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/web/public/js/main.js', import.meta.url), 'utf8');

assert.match(
  mainSource,
  /import\s+\{\s*createFatalNotices\s*\}\s+from\s+'\.\/fatal-notices\.js';/,
  '应用壳必须使用生产 fatal-notices 协调器，不能让每个 API 失败各自新建致命弹窗',
);
assert.match(mainSource, /const\s+fatalNotices\s*=\s*createFatalNotices\s*\(/);
assert.doesNotMatch(mainSource, /function\s+show(?:RestartRequired|SessionInvalid)Notice\s*\(/);
assert.equal(
  (mainSource.match(/fatalNotices\.showRestartRequiredNotice\(\)/g) || []).length,
  2,
  '资源核验与 API 版本闸门必须汇入同一个重启提示实例',
);
assert.equal(
  (mainSource.match(/fatalNotices\.showSessionInvalidNotice\(\)/g) || []).length,
  1,
  '运行期会话失效必须汇入同一个会话提示实例',
);

const originalDocument = globalThis.document;

function fakeElement(tagName) {
  return {
    tagName,
    className: '',
    textContent: '',
    children: [],
    append(...children) { this.children.push(...children); },
  };
}

globalThis.document = { createElement: fakeElement };

try {
  const { createFatalNotices } = await import('../src/web/public/js/fatal-notices.js');
  const opened = [];
  const reloads = [];
  let restartPreparations = 0;
  const notices = createFatalNotices({
    openModal(options) {
      const handle = { index: opened.length };
      opened.push({ options, handle });
      return handle;
    },
    reload: () => reloads.push('reload'),
    beforeRestartReload: () => { restartPreparations += 1; },
  });

  const sessionA = notices.showSessionInvalidNotice();
  const sessionB = notices.showSessionInvalidNotice();
  assert.equal(opened.length, 1, '并发会话失效只能打开一个不可关闭弹窗');
  assert.equal(sessionA, sessionB, '重复会话失效必须返回同一个弹窗句柄');
  assert.equal(opened[0].options.title, '会话已失效');
  assert.equal(opened[0].options.dismissible, false);
  assert.deepEqual(opened[0].options.actions.map(action => action.label), ['刷新页面']);

  const restartA = notices.showRestartRequiredNotice();
  const restartB = notices.showRestartRequiredNotice();
  assert.equal(opened.length, 2, '重启提示与会话提示状态独立，但同类重启提示只能打开一次');
  assert.equal(restartA, restartB, '重复重启提示必须返回同一个弹窗句柄');
  assert.equal(opened[1].options.title, '本地服务需要重启');
  assert.equal(opened[1].options.dismissible, false);
  assert.deepEqual(opened[1].options.actions.map(action => action.label), ['我已重启,刷新页面']);

  await opened[0].options.actions[0].onClick();
  assert.equal(reloads.length, 1);
  assert.equal(restartPreparations, 0);
  await opened[1].options.actions[0].onClick();
  assert.equal(reloads.length, 2);
  assert.equal(restartPreparations, 1, '重启确认必须先清掉资源重载守卫');

  let attempts = 0;
  const retryable = createFatalNotices({
    openModal() {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic modal failure');
      return { ok: true };
    },
    reload() {},
  });
  assert.throws(() => retryable.showSessionInvalidNotice(), /synthetic modal failure/);
  assert.deepEqual(retryable.showSessionInvalidNotice(), { ok: true });
  assert.equal(attempts, 2, '弹窗创建失败不能永久吞掉后续可恢复尝试');
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}

console.log('web fatal notice singleton checks passed');
