import assert from 'node:assert/strict';
import { createRecoveryActionState } from '../src/web/public/js/pages/digest/recovery-action-state.js';

const state = createRecoveryActionState();
const recover = state.begin('batch-recovery-1', 'recover');
assert.deepEqual({ batchId: recover.batchId, kind: recover.kind }, {
  batchId: 'batch-recovery-1',
  kind: 'recover',
});
assert.ok(recover.controller instanceof AbortController, '恢复 lease 必须持有自己的取消控制器');
assert.equal(recover.controller.signal.aborted, false);
assert.equal(state.begin('batch-recovery-1', 'recover'), null,
  '同一批次的 storage 变化不得重复启动恢复');
assert.equal(state.begin('batch-recovery-2', 'discard'), null,
  '恢复卡片 busy 时不得并发操作另一个批次');
assert.equal(state.isBusy(), true);
assert.equal(state.isCurrent(recover), true);
assert.equal(state.snapshot(), recover);

state.end({ batchId: recover.batchId, kind: recover.kind });
assert.equal(state.isBusy(), true, '非当前 lease 不得释放恢复锁');
state.end(recover);
assert.equal(state.isBusy(), false, '当前操作结束后必须释放恢复锁');
const discard = state.begin('batch-recovery-2', 'discard');
assert.equal(discard.kind, 'discard');
assert.equal(state.invalidate('账号已切换'), true, '上下文变化或卸载必须能失效当前恢复 lease');
assert.equal(discard.controller.signal.aborted, true, '失效恢复 lease 必须立即中止自己的请求');
assert.equal(discard.controller.signal.reason?.message, '账号已切换');
assert.equal(state.isBusy(), false);
const replacement = state.begin('batch-recovery-3', 'recover');
assert.ok(replacement, '旧 lease 失效后必须允许建立新的恢复 lease');
state.end(discard);
assert.equal(state.isCurrent(replacement), true,
  '旧 lease 晚到 end 不得清掉失效后新建的恢复 lease');
assert.equal(state.invalidate(), true);
assert.equal(state.invalidate(), false, '重复失效必须幂等');

console.log('web digest recovery action state tests passed');
