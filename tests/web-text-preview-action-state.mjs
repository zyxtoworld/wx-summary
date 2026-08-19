import assert from 'node:assert/strict';
import { createBrowserModuleLoader } from './helpers/import-browser-module.mjs';

const loader = createBrowserModuleLoader();
const { createTextPreviewActionState } = await loader.load('js/pages/digest/text-preview-action-state.js');
const state = createTextPreviewActionState();

const exportAction = state.begin('export');
assert.ok(exportAction, '导出开始时必须取得唯一 action lease');
assert.equal(state.isBusy(), true);
assert.equal(state.begin('copy'), null, '导出进行中不能并发复制');
assert.equal(state.isCurrent(exportAction), true);
assert.equal(state.signal(exportAction), exportAction.controller.signal);

assert.equal(state.invalidate('预览已更新'), true, '替换预览必须使旧动作失效');
assert.equal(exportAction.controller.signal.aborted, true, '失效必须中止旧请求');
assert.equal(state.isBusy(), false, '失效必须立即释放全局占用');
assert.equal(state.end(exportAction), false, '旧动作不能释放已经失效的占用');

const copyAction = state.begin('copy');
assert.ok(copyAction, '旧动作失效后可以开始新动作');
assert.equal(state.end(exportAction), false, '旧动作不能释放新动作');
assert.equal(state.end(copyAction), true);
assert.equal(state.isBusy(), false);

const downloadAction = state.begin('download');
assert.ok(downloadAction);
assert.equal(state.end(downloadAction), true);

console.log('web text preview action state tests passed');
