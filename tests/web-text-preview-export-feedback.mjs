import assert from 'node:assert/strict';
import fs from 'node:fs';
import { textPreviewExportFeedback } from '../src/web/public/js/pages/digest/text-preview-export-feedback.js';
import { classifyLocalActionRecovery } from '../src/web/public/js/shared/local-action-recovery-state.js';

assert.deepEqual(
  textPreviewExportFeedback({ recovery: 'verified', path: 'synthetic/preview.md', redacted: false }),
  {
    type: 'success',
    toast: '已导出:synthetic/preview.md',
    status: '已导出:synthetic/preview.md',
  },
  '只有核对完成的导出才能显示成功',
);

assert.deepEqual(
  textPreviewExportFeedback({ recovery: 'committed_unverified', path: 'synthetic/preview.md', redacted: true }),
  {
    type: 'warn',
    toast: 'Markdown 已写入,但本地服务未能完成核对;请在历史页或输出目录确认。',
    status: '已写入:synthetic/preview.md(内容已按隐私设置脱敏;核对待完成)',
  },
  '已提交但核对未完成时不得谎报成功，并且必须保留脱敏状态',
);

assert.deepEqual(
  textPreviewExportFeedback({ recovery: 'failed', path: '', redacted: false }),
  {
    type: 'warn',
    toast: 'Markdown 已写入,但本地服务未能完成核对;请在历史页或输出目录确认。',
    status: '已写入:(路径未知)(核对待完成)',
  },
  '核对失败时仍要告诉用户写入与核对是两个状态',
);

const cleanupFailedResponse = {
  local_action_committed: true,
  verified: true,
  item: { relative_path: 'synthetic/preview.md' },
  local_action_recovery_cleanup_failed: true,
};
assert.equal(classifyLocalActionRecovery(cleanupFailedResponse), 'committed_unverified',
  '浏览器 marker 清理失败时,已 verified 响应必须回到待核对状态');
assert.equal(
  textPreviewExportFeedback({
    recovery: classifyLocalActionRecovery(cleanupFailedResponse),
    path: cleanupFailedResponse.item.relative_path,
  }).type,
  'warn',
  'Markdown 导出不得把 marker 清理失败投影成成功提示',
);

const source = fs.readFileSync(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
assert.match(source, /textPreviewExportFeedback\(\{[\s\S]*?recovery,[\s\S]*?path,[\s\S]*?redacted:/);
assert.match(source, /feedback\.type === 'success'/);
assert.doesNotMatch(
  source.slice(source.indexOf("exportBtn.addEventListener('click'"), source.indexOf("downloadBtn.addEventListener('click'")),
  /ui\.toastSuccess\(`已导出:/,
  '导出响应不得绕过核对分类直接显示成功',
);

console.log('web text preview export feedback tests passed');
