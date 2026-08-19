import assert from 'node:assert/strict';
import {
  mdFileActionCheck,
  markdownRecoveryInstruction,
  markdownSourceReferenceAvailable,
  markdownSourceCheck,
} from '../src/web/public/js/pages/history/format.js';

const missingSourceMarkdown = {
  artifact_type: 'text_preview_md',
  digest_id: 'md-missing-source',
  history_item_key: 'history-md-missing-source',
  file_exists: false,
  file_version: 'missing:v1',
};
assert.equal(markdownSourceReferenceAvailable(missingSourceMarkdown), false);
assert.match(markdownRecoveryInstruction(missingSourceMarkdown), /总结页重新生成文本预览并导出 MD/);
assert.equal(mdFileActionCheck(missingSourceMarkdown).ok, false,
  'a missing source-less Markdown artifact cannot be opened as if it still existed');

const sourceBackedMarkdown = {
  ...missingSourceMarkdown,
  source_digest_id: 'source-digest-1',
};
assert.equal(markdownSourceReferenceAvailable(sourceBackedMarkdown), true);
assert.match(markdownRecoveryInstruction(sourceBackedMarkdown), /源摘要重新导出/);

const availableMarkdown = {
  ...sourceBackedMarkdown,
  file_exists: true,
  file_version: 'sha256-md',
  export_policy_revision: 'policy-v1',
};
assert.equal(mdFileActionCheck(availableMarkdown).ok, true);
assert.equal(markdownSourceCheck(availableMarkdown).ok, true);

console.log('history Markdown regeneration recovery contract passed');
