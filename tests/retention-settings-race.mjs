import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUTS_DIR, toProjectRelative } from '../src/lib/paths.js';
import { cleanupOldDigests, saveRenderedPng } from '../src/renderer/output.js';

const TEST_ROOT = path.join(OUTPUTS_DIR, `retention-settings-race-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function settingsFor(base) {
  return {
    settings_revision: 'retention-policy-v1',
    output: {
      dir: `./${toProjectRelative(base)}`,
      retention_days: 1,
    },
  };
}

async function fileExists(file) {
  return fsp.stat(file).then(stat => stat.isFile(), () => false);
}

async function main() {
  const settings = settingsFor(TEST_ROOT);
  try {
    const saved = await saveRenderedPng({
      settings,
      digest: {
        digest_id: 'retention-settings-race',
        group: 'retention settings race fixture',
        since: '2020-01-01 00:00:00',
        until: '2020-01-01 01:00:00',
        message_count: 1,
        model: 'test-model',
        headline: 'fixture',
        highlights: ['fixture'],
        topics: [],
        created_at: '2020-01-01T01:00:00.000Z',
      },
      png_buffer: PNG,
      save_operation_id: 'retention-settings-race-save',
    });

    const policyChanged = Object.assign(new Error('retention policy changed'), {
      code: 'retention_policy_changed',
    });
    let rejectedBarrierCalls = 0;
    await assert.rejects(
      cleanupOldDigests(settings, {
        commitBarrier: async commit => {
          rejectedBarrierCalls += 1;
          assert.equal(typeof commit, 'function', 'retention commit barrier must receive the bounded index commit');
          throw policyChanged;
        },
      }),
      error => error === policyChanged,
      'a changed settings generation must reject retention before the index commit',
    );
    assert.equal(rejectedBarrierCalls, 1, 'retention must cross the settings barrier exactly once');
    assert.equal(await fileExists(saved.file_path), true, 'a rejected retention commit must restore the staged PNG');
    assert.equal(await fileExists(saved.digest_path), true, 'a rejected retention commit must restore the staged digest JSON');
    const indexAfterReject = JSON.parse(await fsp.readFile(path.join(TEST_ROOT, 'index.json'), 'utf8'));
    assert.equal(indexAfterReject.some(item => item.digest_id === saved.digest_id), true, 'a rejected retention commit must preserve the history index entry');
    const pendingAfterReject = (await fsp.readdir(path.dirname(saved.file_path))).filter(name => name.includes('.retention-delete-'));
    assert.deepEqual(pendingAfterReject, [], 'a rejected retention commit must not leave staged transaction files behind');

    let acceptedBarrierCalls = 0;
    const cleaned = await cleanupOldDigests(settings, {
      commitBarrier: async commit => {
        acceptedBarrierCalls += 1;
        return commit();
      },
    });
    assert.equal(acceptedBarrierCalls, 1, 'an unchanged policy must commit through the settings barrier');
    assert.equal(cleaned.pruned, 1, 'the accepted cleanup should prune the expired fixture');
    assert.equal(await fileExists(saved.file_path), false, 'the accepted cleanup should remove the expired PNG');
    assert.equal(await fileExists(saved.digest_path), false, 'the accepted cleanup should remove the expired digest JSON');
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
  console.log('retention settings race test passed');
}

await main();
