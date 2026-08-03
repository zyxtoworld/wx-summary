import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';
import { savePreviewMarkdown } from '../src/renderer/output.js';

const testRoot = path.join(OUTPUTS_DIR, `preview-markdown-provenance-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const groups = Array.from({ length: 200 }, (_, index) => `来源群-${index + 1}`);
const digestIds = Array.from({ length: 200 }, (_, index) => `source-digest-${String(index + 1).padStart(3, '0')}`);
const settings = {
  settings_revision: 'preview-provenance-v1',
  export_policy_revision: 'preview-provenance-v1',
  output: { dir: `./${toProjectRelative(testRoot)}` },
};

try {
  const item = await savePreviewMarkdown({
    settings,
    title: '来源追溯测试',
    markdown: '# 来源追溯测试\n',
    history: true,
    metadata: {
      group: '来源追溯测试',
      groups,
      digest_ids: digestIds,
      complete: true,
      done: groups.length,
      total: groups.length,
    },
  });

  assert.deepEqual(item.groups, groups, 'the committed Markdown history item must retain every supported source group');
  assert.deepEqual(item.digest_ids, digestIds, 'the committed Markdown history item must retain every supported source digest id');

  const sidecar = JSON.parse(await fsp.readFile(`${item.file_path}.meta.json`, 'utf8'));
  assert.deepEqual(sidecar.item?.groups, groups, 'sidecar recovery metadata must retain the full supported source-group list');
  assert.deepEqual(sidecar.item?.digest_ids, digestIds, 'sidecar recovery metadata must retain the full supported source-digest list');

  const boundedItem = await savePreviewMarkdown({
    settings,
    title: '来源编号边界测试',
    markdown: '# 来源编号边界测试\n',
    history: true,
    metadata: { group: '来源编号边界测试', digest_ids: ['x'.repeat(600_000)] },
  });
  assert.equal(boundedItem.digest_ids?.[0]?.length, 320, 'a client-supplied source digest id must be bounded before persistence');
  const boundedSidecarStat = await fsp.stat(`${boundedItem.file_path}.meta.json`);
  assert.ok(boundedSidecarStat.size <= 512 * 1024, 'a committed Markdown sidecar must remain within its own read limit');
} finally {
  await fsp.rm(testRoot, { recursive: true, force: true });
}

console.log('preview Markdown provenance contract passed');
