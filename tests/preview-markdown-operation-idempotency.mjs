import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `preview-markdown-operation-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const OUTPUT_ROOT = path.join(TEST_ROOT, 'digests');
const OPERATION_ID = `preview_operation_${crypto.randomUUID().replaceAll('-', '')}`;

process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
process.env.WX_SUMMARY_INCLUDE_ACCEPTANCE_HISTORY_FIXTURE_ROOTS = TEST_ROOT;

const {
  listHistory,
  savePreviewMarkdown,
} = await import('../src/renderer/output.js');

function settingsFor(base) {
  return {
    settings_revision: 'preview-markdown-operation-v1',
    export_policy_revision: 'preview-markdown-operation-v1',
    output: {
      dir: `./${toProjectRelative(base)}`,
      retention_days: 30,
    },
  };
}

async function main() {
  const settings = settingsFor(OUTPUT_ROOT);
  const title = '幂等文本预览';
  const markdown = '# 幂等文本预览\n\n这份内容只能保存一次。\n';
  const metadata = {
    group: title,
    groups: [title],
    digest_ids: ['preview-markdown-operation-digest'],
    account_id: 'preview-operation-account',
    account_label: 'preview-operation-account',
    since: '2026-07-30 09:00:00',
    until: '2026-07-30 10:00:00',
    message_count: 2,
    complete: true,
    done: 1,
    total: 1,
  };
  try {
    const first = await savePreviewMarkdown({
      settings,
      title,
      markdown,
      history: true,
      metadata,
      save_operation_id: OPERATION_ID,
    });
    const second = await savePreviewMarkdown({
      settings,
      title,
      markdown,
      history: true,
      metadata,
      save_operation_id: OPERATION_ID,
    });

    assert.equal(second.save_operation_reused, true, '同一 MD 操作必须复用已存在文件');
    assert.equal(second.file_path, first.file_path, '同一 MD 操作不能生成第二个文件名');
    assert.equal(second.digest_id, first.digest_id, '同一 MD 操作必须保留稳定历史标识');
    const previewDir = path.join(OUTPUT_ROOT, 'previews');
    const markdownFiles = (await fsp.readdir(previewDir)).filter(name => name.endsWith('.md'));
    assert.equal(markdownFiles.length, 1, '同一 MD 操作只能留下一个 Markdown 文件');

    const history = await listHistory(settings, { offset: 0, limit: 20, bypassCache: true });
    assert.equal(history.items.filter(item => item.digest_id === first.digest_id).length, 1, '同一 MD 操作只能留下一个历史索引项');

    await assert.rejects(
      () => savePreviewMarkdown({
        settings,
        title,
        markdown: '# 幂等文本预览\n\n内容已变化。\n',
        history: true,
        metadata,
        save_operation_id: OPERATION_ID,
      }),
      error => error?.code === 'preview_markdown_operation_mismatch',
      '相同操作标识对应不同内容必须拒绝复用',
    );
    assert.equal(await fsp.stat(first.file_path).then(stat => stat.isFile(), () => false), true, '内容冲突不能删除原有 MD');

    let barrierCalls = 0;
    await assert.rejects(
      () => savePreviewMarkdown({
        settings,
        title,
        markdown,
        history: true,
        metadata,
        save_operation_id: OPERATION_ID,
        commitBarrier: () => {
          barrierCalls += 1;
          if (barrierCalls >= 2) throw new Error('模拟复用文件后的提交校验失败');
        },
      }),
      /模拟复用文件后的提交校验失败/,
      '复用文件后的提交校验失败应该原样返回',
    );
    assert.equal(await fsp.stat(first.file_path).then(stat => stat.isFile(), () => false), true, '复用文件后的失败不能删除已经导出的 MD');
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('preview markdown operation idempotency test passed');
}

await main();
