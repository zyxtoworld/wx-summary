import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';
import { findHistoryItem, listHistory, restoreHistoryDigestToCurrentOutput, saveRenderedPng } from '../src/renderer/output.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `history-output-roots-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const OLD_ROOT = path.join(TEST_ROOT, 'old');
const CURRENT_ROOT = path.join(TEST_ROOT, 'current');
const READ_ONLY_MISSING_ROOT = path.join(TEST_ROOT, 'read-only-missing');
const DIGEST_ID = 'history-output-root-regression';
const RESTORE_DIGEST_ID = 'history-output-root-restore-regression';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function settingsFor(base) {
  return {
    output: {
      dir: `./${toProjectRelative(base)}`,
      retention_days: 0,
    },
  };
}

async function main() {
  const previousScope = process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
  process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = TEST_ROOT;
  try {
    const oldDay = path.join(OLD_ROOT, '2026-07-22');
    await fsp.mkdir(oldDay, { recursive: true });
    await fsp.mkdir(CURRENT_ROOT, { recursive: true });
    await fsp.writeFile(path.join(oldDay, `${DIGEST_ID}.png`), PNG);
    await fsp.writeFile(path.join(OLD_ROOT, 'index.json'), JSON.stringify([{
      digest_id: DIGEST_ID,
      group: '旧输出目录回归群',
      created_at: '2026-07-22T12:00:00.000Z',
      since: '2026-07-22 00:00:00',
      until: '2026-07-22 23:59:59',
      relative_path: `2026-07-22/${DIGEST_ID}.png`,
    }], null, 2));
    const restoreSourceDigest = {
      digest_id: RESTORE_DIGEST_ID,
      group: '旧目录恢复回归群',
      since: '2026-07-22 00:00:00',
      until: '2026-07-22 23:59:59',
      message_count: 1,
      model: 'test-model',
      headline: '旧目录缺失 PNG 应恢复到当前输出目录',
      highlights: ['摘要 JSON 仍可用'],
      topics: [{ title: '恢复测试', participants: [], summary: '验证旧目录不会被改写。', need_followup: false }],
      created_at: '2026-07-22T12:30:00.000Z',
    };
    const restoreSourceSaved = await saveRenderedPng({
      settings: settingsFor(OLD_ROOT),
      digest: restoreSourceDigest,
      png_buffer: PNG,
      save_operation_id: 'history-output-roots-source',
    });

    const beforeSwitch = await listHistory(settingsFor(OLD_ROOT), { limit: 20, bypassCache: true });
    const beforeSwitchItem = beforeSwitch.items.find(item => item.digest_id === DIGEST_ID);
    assert.ok(beforeSwitchItem, '切换前，历史必须能从原输出目录正常读取');
    assert.equal(beforeSwitchItem.history_current, true, '切换前的历史必须属于当前输出目录');

    const readOnlyMissing = await listHistory(settingsFor(READ_ONLY_MISSING_ROOT), {
      limit: 20,
      bypassCache: true,
      readOnly: true,
    });
    const readOnlyOldItem = readOnlyMissing.items.find(item => item.digest_id === DIGEST_ID);
    assert.ok(readOnlyOldItem, '当前输出目录尚不存在时，只读历史仍必须识别旧输出目录');
    assert.equal(readOnlyOldItem.history_current, false, '不存在的当前输出目录不能把旧历史误标为当前记录');
    const readOnlyMissingCreated = await fsp.lstat(READ_ONLY_MISSING_ROOT).then(
      () => true,
      error => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      },
    );
    assert.equal(readOnlyMissingCreated, false, '只读历史查询不能创建当前配置的输出目录');

    const result = await listHistory(settingsFor(CURRENT_ROOT), { limit: 20, bypassCache: true });
    const oldItem = result.items.find(item => item.digest_id === DIGEST_ID);
    assert.ok(oldItem, '切换输出目录后，旧输出目录的历史必须仍能被发现');
    assert.equal(oldItem.history_current, false, '旧输出目录的历史必须标记为非当前目录');
    assert.equal(oldItem.history_output_relative_path, toProjectRelative(OLD_ROOT), '旧历史必须携带其实际输出目录，供后续文件操作定位');
    assert.ok(oldItem.history_item_key, '旧历史必须携带稳定记录密钥');
    assert.ok(result.history_base_count >= 2, '历史合并必须包含当前和旧输出目录');

    const found = await findHistoryItem(settingsFor(CURRENT_ROOT), DIGEST_ID, {
      history_item_key: oldItem.history_item_key,
    });
    assert.ok(found, '旧历史必须能按记录密钥找回');
    assert.equal(path.resolve(found._history_base), path.resolve(OLD_ROOT), '旧历史后续操作必须使用旧输出目录作为根路径');

    await fsp.rm(restoreSourceSaved.file_path, { force: true });
    const afterSourceLoss = await listHistory(settingsFor(CURRENT_ROOT), { limit: 20, bypassCache: true });
    const restoreCandidate = afterSourceLoss.items.find(item => item.digest_id === RESTORE_DIGEST_ID);
    assert.ok(restoreCandidate, '旧目录中仅缺失 PNG 的摘要必须仍可定位');
    assert.equal(restoreCandidate.history_current, false, '恢复源必须仍标记为旧输出目录');
    assert.equal(restoreCandidate.file_exists, false, '测试应先确认旧 PNG 已删除');
    const restoreSource = await findHistoryItem(settingsFor(CURRENT_ROOT), RESTORE_DIGEST_ID, {
      history_item_key: restoreCandidate.history_item_key,
    });
    assert.ok(restoreSource, '恢复前必须能按旧记录密钥重新定位摘要');
    const restored = await restoreHistoryDigestToCurrentOutput({
      settings: settingsFor(CURRENT_ROOT),
      item: restoreSource,
      digest: restoreSourceDigest,
      png_buffer: PNG,
      save_operation_id: 'history-output-roots-restore',
    });
    assert.equal(restored.history_current, true, '恢复结果必须属于当前输出目录');
    assert.notEqual(restored.digest_id, RESTORE_DIGEST_ID, '恢复必须创建新摘要标识，不能覆盖旧历史');
    assert.ok(path.resolve(restored.file_path).startsWith(path.resolve(CURRENT_ROOT)), '恢复 PNG 必须写入当前输出目录');
    assert.ok(path.resolve(restored.digest_path).startsWith(path.resolve(CURRENT_ROOT)), '恢复摘要 JSON 必须写入当前输出目录');
    assert.equal(restored.source_digest_id, RESTORE_DIGEST_ID, '恢复结果必须记录来源摘要编号');
    assert.equal(restored.source_history_item_key, restoreCandidate.history_item_key, '恢复结果必须记录来源历史键');
    assert.equal(await fsp.stat(restoreSourceSaved.file_path).then(() => true, () => false), false, '恢复不得在旧目录重建或改写原 PNG');
    const restoredDigest = JSON.parse(await fsp.readFile(restored.digest_path, 'utf-8'));
    assert.equal(restoredDigest.source_digest_id, RESTORE_DIGEST_ID, '恢复摘要 JSON 必须持久化来源摘要编号');
    assert.equal(restoredDigest.source_history_item_key, restoreCandidate.history_item_key, '恢复摘要 JSON 必须持久化来源历史键');
    const oldIndexAfterRestore = JSON.parse(await fsp.readFile(path.join(OLD_ROOT, 'index.json'), 'utf-8'));
    assert.equal(oldIndexAfterRestore.some(item => item.digest_id === restored.digest_id), false, '恢复不得向旧输出目录历史索引写入新记录');
  } finally {
    if (previousScope === undefined) delete process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE;
    else process.env.WX_SUMMARY_HISTORY_DISCOVERY_TEST_SCOPE = previousScope;
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('history output root tests passed');
}

await main();
