import assert from 'node:assert/strict';
import {
  localStatusDisplayItem,
  localStatusPngRevealSummary,
} from '../src/web/public/js/pages/settings/system-status.js';

assert.match(localStatusPngRevealSummary({}), /尚未记录到定位已保存 PNG/);
assert.match(localStatusPngRevealSummary({ latest_evidence: {}, target_binding: { current: false } }), /不是当前最近保存的长图/);
assert.match(localStatusPngRevealSummary({ latest_evidence: {}, target_binding: { current: true } }), /最近保存的长图作为验收目标/);

const recorded = localStatusDisplayItem({
  id: 'B8',
  status: 'needs_user_confirmation',
  ready_for_user_confirmation: false,
  software_evidence_status: 'reveal_requested_needs_visual_confirmation',
  latest_evidence: { file_kind: 'png' },
  target_binding: { current: true },
});
assert.equal(recorded.status, 'needs_user_confirmation', 'display enrichment must not change the check protocol status');
assert.equal(recorded.display_status, '需定位当前图');
assert.match(recorded.software_evidence_summary, /最近保存的长图/);

const complete = localStatusDisplayItem({
  id: 'B8',
  status: 'needs_user_confirmation',
  ready_for_user_confirmation: true,
  latest_evidence: { file_kind: 'png' },
  target_binding: { current: true },
});
assert.equal(complete.display_status, '已记录');

console.log('local status PNG reveal display tests passed');
