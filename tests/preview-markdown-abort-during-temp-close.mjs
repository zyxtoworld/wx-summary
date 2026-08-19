import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const testRoot = path.join(OUTPUTS_DIR, `preview-abort-close-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const outputRoot = path.join(testRoot, 'digests');
const operationId = `preview_abort_${crypto.randomUUID().replaceAll('-', '')}`;
const cancellation = Object.assign(new Error('文本预览 caller 已取消'), {
  name: 'AbortError',
  status: 499,
});

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = testRoot;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = testRoot;

const { savePreviewMarkdown } = await import(`../src/renderer/output.js?preview-abort-close-${process.pid}`);

function settingsFor(base) {
  return {
    settings_revision: 'preview-abort-close-v1',
    export_policy_revision: 'preview-abort-close-v1',
    output: {
      dir: `./${toProjectRelative(base)}`,
      retention_days: 30,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function main() {
  const originalOpen = fsp.open;
  const originalLink = fsp.link;
  const closeGate = deferred();
  const closeStarted = deferred();
  let tempCloseCount = 0;
  let linkCount = 0;
  let wrappedTempHandle = null;

  fsp.open = async (file, flags, ...rest) => {
    const realHandle = await originalOpen(file, flags, ...rest);
    if (flags !== 'wx' || !String(file).endsWith('.tmp')) return realHandle;
    wrappedTempHandle = realHandle;
    return {
      writeFile: (...args) => realHandle.writeFile(...args),
      sync: (...args) => realHandle.sync(...args),
      async close() {
        tempCloseCount += 1;
        closeStarted.resolve();
        await closeGate.promise;
        return realHandle.close();
      },
    };
  };
  fsp.link = async (...args) => {
    linkCount += 1;
    return originalLink(...args);
  };

  const controller = new AbortController();
  const pending = savePreviewMarkdown({
    settings: settingsFor(outputRoot),
    title: '取消 close 竞态',
    markdown: '# 取消 close 竞态\n\n内容不应在取消后发布。',
    save_operation_id: operationId,
    signal: controller.signal,
  });

  try {
    await closeStarted.promise;
    controller.abort(cancellation);
    closeGate.resolve();
    const outcome = await pending.then(
      value => ({ value }),
      error => ({ error }),
    );
    assert.equal(outcome.error?.status, 499,
      '临时文件 close 期间取消必须保持 renderer 既有 499 取消合同');
    assert.equal(outcome.error?.name, 'AbortError',
      '临时文件 close 期间取消必须保持 AbortError 合同');
    assert.equal(tempCloseCount, 1, '临时文件句柄只能关闭一次');
    assert.equal(linkCount, 0,
      '取消后的临时文件不得进入真实 Markdown link/publish 阶段');
    assert.ok(wrappedTempHandle, '测试必须确实经过真实 savePreviewMarkdown 临时文件句柄');
  } finally {
    fsp.open = originalOpen;
    fsp.link = originalLink;
    await fsp.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
console.log('preview markdown abort during temp close tests passed');
