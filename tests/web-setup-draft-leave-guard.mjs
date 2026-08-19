import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { confirmSetupLeave } from '../src/web/public/js/pages/setup/leave-guard.js';

function wizard({ llmDirty = false, keyDraft = '' } = {}) {
  return {
    llm: { dirty: llmDirty },
    key: { draft: keyDraft },
  };
}

let prompts = [];
const confirmDialog = async options => {
  prompts.push(options);
  return false;
};

assert.equal(await confirmSetupLeave({ wiz: wizard(), busy: false, confirmDialog }), true,
  '无忙态且无草稿时应直接允许离开');
assert.equal(prompts.length, 0, '干净状态不应弹确认框');

assert.equal(await confirmSetupLeave({ wiz: wizard({ llmDirty: true }), busy: false, confirmDialog }), false,
  'AI 草稿存在时取消确认必须阻止离开');
assert.equal(prompts.length, 1);
assert.match(prompts[0].message, /未保存.*离开.*丢失/,
  'AI 草稿离开提示必须说明未保存内容会丢失');

prompts = [];
assert.equal(await confirmSetupLeave({ wiz: wizard({ keyDraft: '  synthetic-candidate  ' }), busy: false, confirmDialog }), false,
  '手动密钥草稿存在时必须进入离开确认');
assert.equal(prompts.length, 1);

prompts = [];
assert.equal(await confirmSetupLeave({ wiz: wizard({ keyDraft: '   ' }), busy: false, confirmDialog }), true,
  '只有空白字符的密钥输入不是有意义草稿');
assert.equal(prompts.length, 0);

prompts = [];
assert.equal(await confirmSetupLeave({ wiz: wizard(), busy: true, confirmDialog }), false,
  '请求进行中取消确认必须继续阻止离开');
assert.equal(prompts.length, 1);
assert.match(prompts[0].message, /验证或保存正在进行/,
  '忙态必须保留原有异步操作取消语义');

prompts = [];
assert.equal(await confirmSetupLeave({
  wiz: wizard({ llmDirty: true }),
  busy: false,
  confirmDialog: async options => {
    prompts.push(options);
    return true;
  },
}), true, '用户明确确认后应允许离开');
assert.equal(prompts.length, 1);

assert.equal(await confirmSetupLeave({
  wiz: wizard({ llmDirty: true }),
  busy: false,
  confirmDialog: null,
}), false, '缺少确认能力时必须 fail-closed 保留草稿');

await assert.doesNotReject(
  async () => {
    const allowed = await confirmSetupLeave({
      wiz: wizard({ llmDirty: true }),
      busy: false,
      confirmDialog: async () => { throw new Error('确认组件异常'); },
    });
    assert.equal(allowed, false,
      '确认组件抛错时必须按拒绝处理,不得让离开守卫向 caller 泄漏 rejected Promise');
  },
  '确认组件抛错不得让 setup canLeave 产生未收口的 rejected Promise',
);

const setupIndex = await readFile(new URL('../src/web/public/js/pages/setup/index.js', import.meta.url), 'utf8');
assert.match(setupIndex, /import \{ createSetupLeaveGuard \} from '\.\/leave-guard\.js';/,
  'setup 生产页面必须接入共享离开守卫');
assert.match(setupIndex, /page\.confirmLeave = createSetupLeaveGuard\(\(\) => \(\{[\s\S]*?busy: !page\.initializing && stepBusy\(\),[\s\S]*?wiz,[\s\S]*?confirmDialog: ui\.confirmDialog/,
  '生产 canLeave 必须排除可安全中止的首屏恢复，并把真实步骤 busy 与 wizard 草稿交给离开守卫');

console.log('web setup draft leave guard tests passed');
