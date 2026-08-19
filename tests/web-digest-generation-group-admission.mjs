import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { digestGenerationGroupAdmission } from '../src/web/public/js/pages/digest/generation-admission.js';

assert.deepEqual(
  digestGenerationGroupAdmission({ groupsStatus: 'idle', selectedCount: 2 }),
  { allowed: false, reason: '群列表尚未准备完成，请等待刷新后再生成。' },
  '恢复的旧选择不得在首次群列表到达前直接生成',
);
assert.deepEqual(
  digestGenerationGroupAdmission({ groupsStatus: 'loading', selectedCount: 2 }),
  { allowed: false, reason: '群列表正在刷新，请等待完成后再生成。' },
  '刷新期间不得使用旧群快照生成',
);
assert.deepEqual(
  digestGenerationGroupAdmission({ groupsStatus: 'error', selectedCount: 2 }),
  { allowed: false, reason: '群列表读取失败，请先重试。' },
  '读取失败后不得继续使用上一次群快照生成',
);
assert.deepEqual(
  digestGenerationGroupAdmission({ groupsStatus: 'ready', selectedCount: 0 }),
  { allowed: false, reason: '请先选择至少一个群。' },
);
assert.deepEqual(
  digestGenerationGroupAdmission({ groupsStatus: 'ready', selectedCount: 2 }),
  { allowed: true, reason: '' },
  '只有当前群列表 ready 且仍有选择时才允许生成',
);
assert.equal(
  digestGenerationGroupAdmission({ locked: true, groupsStatus: 'ready', selectedCount: 2 }).allowed,
  false,
  '统一忙态必须优先拒绝生成重入',
);

const source = await readFile(new URL('../src/web/public/js/pages/digest/index.js', import.meta.url), 'utf8');
assert.match(source,
  /const admission = digestGenerationGroupAdmission\(\{[\s\S]*?locked: digestInputsLocked\(\),[\s\S]*?groupsStatus: page\.groupsStatus,[\s\S]*?selectedCount: page\.selected\.size,[\s\S]*?\}\);[\s\S]*?if \(!admission\.allowed\) \{/,
  '生成入口自身必须执行群快照 admission，不能只依赖按钮 disabled');
assert.match(source,
  /function syncSelectionUi\(\) \{[\s\S]*?const admission = digestGenerationGroupAdmission\([\s\S]*?generateBtn\.disabled = !admission\.allowed;[\s\S]*?previewBtn\.disabled = !admission\.allowed;/,
  '生成按钮必须随 idle/loading/error/ready 状态同步禁用');
assert.match(source,
  /page\.groupsStatus = 'loading';[\s\S]{0,300}?syncSelectionUi\(\);[\s\S]*?page\.groupsStatus = 'error';[\s\S]{0,500}?syncSelectionUi\(\);/,
  '群列表进入 loading/error 时必须立即同步生成按钮');

console.log('web digest generation group admission tests passed');
