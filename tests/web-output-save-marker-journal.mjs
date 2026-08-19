import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDigestSaveTransactionMarkerBuffer } from '../src/renderer/output.js';

const separator = '\n\u001e';
const prepared = {
  schema: 'wx-summary.digest-save-transaction.v1',
  version: 1,
  state: 'prepared',
  operation_id: 'fixture-operation',
  prepared_at: '2026-08-09T00:00:00.000Z',
  committed_at: '',
  indexed_at: '',
  saved_file_version: '',
  saved_digest_file_version: '',
  digest: { digest_id: 'fixture-digest', headline: '完整摘要只保留在首条记录' },
};

function transition(state, extra = {}) {
  return {
    schema: 'wx-summary.digest-save-transition.v1',
    version: 1,
    operation_id: prepared.operation_id,
    state,
    ...extra,
  };
}

const committed = transition('committed', {
  committed_at: '2026-08-09T00:00:01.000Z',
  saved_file_version: 'file-v1',
  saved_digest_file_version: 'digest-v1',
});
const committedJournal = Buffer.from([
  JSON.stringify(prepared, null, 2),
  separator,
  JSON.stringify(committed),
  separator,
  '{"schema":"wx-summary.digest-save-transition.v1","state":',
].join(''), 'utf8');

assert.deepEqual(parseDigestSaveTransactionMarkerBuffer(committedJournal), {
  ...prepared,
  ...committed,
  schema: prepared.schema,
  version: prepared.version,
  digest: prepared.digest,
}, '尾部转移记录写到一半时必须回退到最后一条完整状态，且不能丢失首条摘要');

const indexed = transition('indexed', {
  committed_at: committed.committed_at,
  indexed_at: '2026-08-09T00:00:02.000Z',
  saved_file_version: committed.saved_file_version,
  saved_digest_file_version: committed.saved_digest_file_version,
});
const foreign = { ...transition('indexed'), operation_id: 'foreign-operation' };
const indexedJournal = Buffer.from([
  JSON.stringify(prepared),
  separator,
  JSON.stringify(committed),
  separator,
  JSON.stringify(foreign),
  separator,
  JSON.stringify(indexed),
].join(''), 'utf8');
const latest = parseDigestSaveTransactionMarkerBuffer(indexedJournal);
assert.equal(latest.state, 'indexed');
assert.equal(latest.indexed_at, indexed.indexed_at);
assert.equal(latest.operation_id, prepared.operation_id, '其他操作的转移记录不得污染当前事务');
assert.deepEqual(latest.digest, prepared.digest, '状态日志不得复制或替换大摘要主体');

assert.equal(parseDigestSaveTransactionMarkerBuffer(Buffer.from('{bad json')), null,
  '没有任何完整首记录时必须 fail closed');

const outputSource = await readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
assert.doesNotMatch(outputSource,
  /writeBinaryAtomic\((?:markerPath|transaction\.marker_path|current\.marker_path),\s*digestSaveTransactionMarkerBuffer/,
  '事务状态推进不得再覆盖刚发布的 marker，避免 Windows 删除共享冲突');
assert.equal((outputSource.match(/appendDigestSaveTransactionTransition\(/g) || []).length, 4,
  '生产实现必须定义一次追加器，并让 committed/recovery/indexed 三条状态路径全部使用它');

console.log('web output save marker journal tests passed');
