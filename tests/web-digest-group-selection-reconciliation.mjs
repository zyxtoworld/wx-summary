import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcileDigestGroupSelection } from '../src/web/public/js/pages/digest/group-selection.js';
import { createDigestDraftScopeLifecycle } from '../src/web/public/js/pages/digest/draft-scope.js';

const selected = new Set(['group-current', 'group-removed']);
const groups = [{ id: 'group-current' }];

const loading = reconcileDigestGroupSelection({
  selectedIds: selected,
  groups,
  authoritative: false,
});
assert.deepEqual([...loading.selectedIds], ['group-current', 'group-removed']);
assert.equal(loading.changed, false, '刷新中的旧群快照不是权威结果，不得提前裁剪草稿选择');

const ready = reconcileDigestGroupSelection({
  selectedIds: selected,
  groups,
  authoritative: true,
});
assert.deepEqual([...ready.selectedIds], ['group-current']);
assert.deepEqual(ready.removedIds, ['group-removed']);
assert.equal(ready.changed, true, '权威群列表必须移除草稿中已失效的群');
assert.deepEqual([...selected], ['group-current', 'group-removed'], '协调器不得原地改写调用方集合');

const empty = reconcileDigestGroupSelection({
  selectedIds: new Set(['group-removed']),
  groups: [],
  authoritative: true,
});
assert.equal(empty.selectedIds.size, 0);
assert.equal(empty.changed, true);

// 真实时序：首次进入时 state 尚未到达，群列表先 ready；随后 state 恢复目标 scope 草稿。
{
  const scope = '["PROJECT_ROOT","account-a"]';
  let pageSelected = new Set();
  let storedDraft = { selected_group_ids: ['group-current', 'group-removed'] };
  const writes = [];
  const lifecycle = createDigestDraftScopeLifecycle({
    readDraft: () => ({ ok: true, draft: storedDraft }),
    writeDraft: (_scope, draft) => {
      storedDraft = draft;
      writes.push(draft);
      return true;
    },
    resetDraft: () => { pageSelected = new Set(); },
    applyDraft: draft => { pageSelected = new Set(draft.selected_group_ids); },
    snapshot: () => ({ selected_group_ids: [...pageSelected] }),
    isMeaningful: draft => draft.selected_group_ids.length > 0,
  });

  assert.equal(lifecycle.reconcile('', {
    accountIdentity: 'id:account-a',
  }).status, 'waiting');
  const restored = lifecycle.reconcile(scope, {
    accountIdentity: 'id:account-a',
    accountFingerprint: 'fingerprint-a',
  });
  assert.equal(restored.status, 'restored');
  assert.deepEqual([...pageSelected], ['group-current', 'group-removed']);

  const reconciled = reconcileDigestGroupSelection({
    selectedIds: pageSelected,
    groups: [{ id: 'group-current' }],
    authoritative: true,
  });
  pageSelected = reconciled.selectedIds;
  if (reconciled.changed) {
    lifecycle.markEdited();
    lifecycle.persist(scope, { accountFingerprint: 'fingerprint-a' });
  }
  assert.deepEqual([...pageSelected], ['group-current']);
  assert.deepEqual(writes, [{ selected_group_ids: ['group-current'] }],
    'state 晚到后裁剪结果必须写回目标账号草稿，不能下次再次恢复失效选择');
}

const pageSource = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
assert.match(
  pageSource,
  /function reconcileGroupSelection\([\s\S]*?reconcileDigestGroupSelection\([\s\S]*?scheduleDraftSave\(\)/,
  '生产页必须通过唯一协调入口裁剪失效选择并持久化清理结果',
);
assert.match(
  pageSource,
  /page\.groups = groups;[\s\S]{0,300}?page\.groupsStatus = 'ready';[\s\S]{0,500}?reconcileGroupSelection\(/,
  '群列表请求成功后必须按权威结果协调草稿选择',
);
assert.match(
  pageSource,
  /const draftResult = restoreDraft\(\);[\s\S]{0,500}?reconcileGroupSelection\(/,
  '晚到 state 恢复账号草稿后必须再次按已就绪群列表协调选择',
);

console.log('web digest group selection reconciliation tests passed');
