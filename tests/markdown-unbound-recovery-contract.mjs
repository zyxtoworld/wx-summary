import assert from 'node:assert/strict';
import {
  mdFileActionCheck,
  markdownRecoveryInstruction,
} from '../src/web/public/js/pages/history/format.js';

const unbound = {
  artifact_type: 'text_preview_md',
  digest_id: 'unbound-md',
  history_item_key: 'history-unbound-md',
  file_exists: true,
  file_version: 'sha256-unbound',
  export_policy_revision: 'policy-v1',
  history_commit_failed: true,
  local_action_after_commit_reason: 'history_failed_after_commit',
};

const check = mdFileActionCheck(unbound);
assert.equal(check.ok, false,
  'a Markdown file that was written but not indexed must not expose direct download/reveal actions');
assert.match(check.reason, /未绑定文件/);
assert.match(markdownRecoveryInstruction(unbound), /设置页核对输出目录/);

const normal = { ...unbound, history_commit_failed: false, local_action_after_commit_reason: '' };
assert.equal(mdFileActionCheck(normal).ok, true,
  'a definitively indexed Markdown file remains directly usable');

console.log('markdown unbound recovery contract passed');
