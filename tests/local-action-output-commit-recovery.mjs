import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const runId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = `outputs/.tmp/local-action-output-commit-${runId}`;
process.env.WX_SUMMARY_NO_RUNTIME_FILE = '1';

const { OUTPUTS_DIR, TMP_DIR, toProjectRelative } = await import('../src/lib/paths.js');
const { savePreviewMarkdown, saveRenderedPng } = await import('../src/renderer/output.js');
const { __mainInternals } = await import('../src/main.js');

const TEST_ROOT = path.join(OUTPUTS_DIR, `local-action-output-commit-${runId}`);
const OUTPUT_ROOT = path.join(TEST_ROOT, 'digests');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function settingsFor(base) {
  return {
    settings_revision: 'local-action-output-commit-v1',
    export_policy_revision: 'local-action-output-commit-v1',
    output: {
      dir: `./${toProjectRelative(base)}`,
      retention_days: 30,
    },
  };
}

function actionEvidence(kind, actionId, commitEvidencePath) {
  return {
    kind,
    action_id: actionId,
    requested_at: new Date().toISOString(),
    action_state: 'prepared',
    local_action_committed: false,
    verification_pending: false,
    verified: false,
    _commit_evidence_path: commitEvidencePath,
  };
}

async function writeCommitEvidence(file, payload) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const settings = settingsFor(OUTPUT_ROOT);
  const files = [];
  try {
    const pngActionId = `output-png-${crypto.randomUUID().replaceAll('-', '')}`;
    const png = await saveRenderedPng({
      settings,
      digest: {
        digest_id: `local-action-output-png-${runId}`,
        group: '本地动作 PNG 恢复',
        since: '2026-07-30 09:00:00',
        until: '2026-07-30 10:00:00',
        message_count: 1,
        model: 'test-model',
        headline: '提交标记必须绑定实际 PNG 和摘要版本',
        highlights: ['恢复测试'],
        topics: [],
        created_at: '2026-07-30T10:00:00.000Z',
      },
      png_buffer: PNG,
      save_operation_id: `local-action-output-png-${runId}`,
    });
    const pngCommitPath = __mainInternals.localActionCommitEvidencePath(pngActionId);
    files.push(pngCommitPath);
    const pngCommit = __mainInternals.localActionOutputCommitEvidencePayload('committed', png, {
      actionId: pngActionId,
      kind: 'save_render',
      preparedAt: new Date().toISOString(),
    });
    await writeCommitEvidence(pngCommitPath, pngCommit);
    const pngEvidence = actionEvidence('save_render', pngActionId, pngCommitPath);
    assert.equal(
      await __mainInternals.reconcileRestoredLocalActionCommitEvidence(pngEvidence, { restarted: false, settings }),
      true,
      'PNG 提交标记应能恢复已提交的本地保存操作',
    );
    assert.equal(pngEvidence.local_action_committed, true, 'PNG 恢复必须明确标记为已提交');
    assert.equal(pngEvidence.item?.history_item_key, png.history_item_key, 'PNG 恢复必须回填实际历史项');
    assert.equal(pngEvidence.file_version, png.file_version, 'PNG 恢复必须核对并回填当前文件版本');
    assert.equal(pngEvidence.digest_file_version, png.digest_file_version, 'PNG 恢复必须核对并回填当前摘要版本');

    const badPngActionId = `output-png-bad-${crypto.randomUUID().replaceAll('-', '')}`;
    const badPngCommitPath = __mainInternals.localActionCommitEvidencePath(badPngActionId);
    files.push(badPngCommitPath);
    await writeCommitEvidence(badPngCommitPath, {
      ...pngCommit,
      action_id: badPngActionId,
      item: { ...pngCommit.item, file_version: `${pngCommit.item.file_version}-changed` },
    });
    const badPngEvidence = actionEvidence('save_render', badPngActionId, badPngCommitPath);
    assert.equal(
      await __mainInternals.reconcileRestoredLocalActionCommitEvidence(badPngEvidence, { restarted: false, settings }),
      true,
      '版本不匹配的 PNG 标记也应被明确处理而非静默忽略',
    );
    assert.notEqual(badPngEvidence.local_action_committed, true, '文件版本不匹配时不能把 PNG 操作伪装为成功');
    assert.equal(badPngEvidence._output_action_commit_mismatch, 'file_version', '文件版本不匹配必须保留明确原因');
    assert.equal(badPngEvidence._discard_after_restore, true, '无效标记不能永久阻塞同一操作的安全重试');

    const markdown = '# 本地动作 MD 恢复\n\n提交标记在最终完成前也必须可核验。\n';
    const metadata = {
      group: '本地动作 MD 恢复',
      groups: ['本地动作 MD 恢复'],
      digest_ids: [png.digest_id],
      account_id: 'local-action-output-account',
      account_label: 'local-action-output-account',
      since: '2026-07-30 09:00:00',
      until: '2026-07-30 10:00:00',
      message_count: 1,
      complete: true,
      done: 1,
      total: 1,
    };
    const operationA = __mainInternals.previewExportSaveOperationId({
      title: '本地动作 MD 恢复',
      markdown,
      metadata,
      settings,
    });
    const operationB = __mainInternals.previewExportSaveOperationId({
      title: '本地动作 MD 恢复',
      markdown,
      metadata: { ...metadata, groups: [...metadata.groups], digest_ids: [...metadata.digest_ids] },
      settings,
    });
    const changedOperation = __mainInternals.previewExportSaveOperationId({
      title: '本地动作 MD 恢复',
      markdown: `${markdown}\n已变化。\n`,
      metadata,
      settings,
    });
    assert.equal(operationA, operationB, '同一导出内容和上下文必须生成稳定操作标识');
    assert.notEqual(operationA, changedOperation, '内容变化必须生成新的 MD 操作标识');

    const md = await savePreviewMarkdown({
      settings,
      title: '本地动作 MD 恢复',
      markdown,
      history: true,
      metadata,
      save_operation_id: operationA,
    });
    const mdActionId = `output-md-${crypto.randomUUID().replaceAll('-', '')}`;
    const mdCommitPath = __mainInternals.localActionCommitEvidencePath(mdActionId);
    files.push(mdCommitPath);
    const mdCommit = __mainInternals.localActionOutputCommitEvidencePayload('prepared', md, {
      actionId: mdActionId,
      kind: 'export_preview',
      preparedAt: new Date().toISOString(),
    });
    await writeCommitEvidence(mdCommitPath, mdCommit);
    const mdEvidence = actionEvidence('export_preview', mdActionId, mdCommitPath);
    assert.equal(
      await __mainInternals.reconcileRestoredLocalActionCommitEvidence(mdEvidence, { restarted: false, settings }),
      true,
      '已索引 MD 的 prepared 标记应能恢复为已提交操作',
    );
    assert.equal(mdEvidence.local_action_committed, true, 'MD 恢复必须明确标记为已提交');
    assert.equal(mdEvidence.item?.relative_path, md.relative_path, 'MD 恢复必须绑定实际导出文件');
    assert.equal(mdEvidence.file_version, md.file_version, 'MD 恢复必须核对当前文件版本');
  } finally {
    await Promise.all(files.map(file => fsp.rm(file, { force: true }).catch(() => {})));
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
    await fsp.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  }
  console.log('local action output commit recovery tests passed');
}

await main();
