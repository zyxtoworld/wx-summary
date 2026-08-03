import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TMP_DIR } from '../src/lib/paths.js';
import {
  getAccountGroupCursorState,
  setAccountGroupCursorState,
} from '../src/store/cursors.js';

const file = path.join(TMP_DIR, `cursor-shard-anchor-${process.pid}.json`);
const accountIdentity = 'wxacct_1234567890abcdef12345678';
const groupId = 'anchor-contract@chatroom';
const position = {
  row_id: 81,
  generation: 'a'.repeat(64),
  anchor_hash: 'b'.repeat(64),
};

try {
  await setAccountGroupCursorState(accountIdentity, groupId, {
    last_seq: 'ts:1|seq:1|lid:1|sid:x|id:y',
    scheduled_window_until: '2026-08-03 15:00:00',
    shard_row_positions_initialized: true,
    shard_row_positions: {
      'message_7.db': position,
      'message_8.db': 12,
    },
  }, { file });

  const loaded = await getAccountGroupCursorState(accountIdentity, groupId, { file });
  assert.deepEqual(loaded.shard_row_positions, {
    'message_7.db': position,
    'message_8.db': 12,
  }, 'cursor storage must round-trip anchored records while retaining legacy numeric positions for safe migration');

  await assert.rejects(
    setAccountGroupCursorState(accountIdentity, 'collision@chatroom', {
      last_seq: 'ts:2|seq:2|lid:2|sid:x|id:y',
      scheduled_window_until: '2026-08-03 15:01:00',
      shard_row_positions_initialized: true,
      shard_row_positions: {
        'message_1.db': 100,
        'MESSAGE_1.DB': 1000,
      },
    }, { file }),
    error => error?.code === 'CURSORS_INVALID_ENTRY',
    'cursor storage must reject normalized shard-key collisions instead of overwriting a watermark',
  );
} finally {
  await fsp.rm(file, { force: true });
}

console.log('cursor shard-anchor roundtrip tests passed');
