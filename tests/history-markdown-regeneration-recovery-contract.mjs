import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const cardActionsSource = appSource.slice(
  appSource.indexOf('function historyCardActionsHtml'),
  appSource.indexOf('function historyThumbnailIssue'),
);
const cardRecoveryBindingSource = appSource.slice(
  appSource.indexOf('function bindHistoryCardMarkdownRegenerateAction'),
  appSource.indexOf('function bindHistoryCardImageAction'),
);
const modalSource = appSource.slice(
  appSource.indexOf('function showHistoryMarkdownModal'),
  appSource.indexOf('function showHistoryModal'),
);
const artifactNoteSource = appSource.slice(
  appSource.indexOf('function historyArtifactNote'),
  appSource.indexOf('function historySourceNote'),
);

assert.ok(
  appSource.includes('function historyMarkdownRecoveryInstruction(item = {})')
    && appSource.includes("historyMarkdownSourceReferenceAvailable(item)")
    && appSource.includes('请回到总结页重新生成文本预览并导出 MD'),
  'unavailable Markdown should distinguish source-backed re-export from text-preview regeneration',
);
assert.ok(
  cardActionsSource.includes('data-history-regenerate-preview')
    && cardActionsSource.includes('historyMarkdownSourceReferenceAvailable(item)')
    && cardActionsSource.includes('historyMarkdownRecoveryInstruction(item)'),
  'an unavailable Markdown card without a source digest must expose a real regeneration action',
);
assert.ok(
  cardRecoveryBindingSource.includes("card?.querySelector?.('[data-history-regenerate-preview]')")
    && cardRecoveryBindingSource.includes("navigateTo('#/digest', { routeIfSame: true })")
    && cardRecoveryBindingSource.includes('showHistoryCardUnavailable'),
  'the card regeneration action must re-resolve the current card and navigate through the guarded router',
);
assert.ok(
  modalSource.includes('data-regenerate-preview')
    && modalSource.includes('regeneratePreviewButton')
    && modalSource.includes("navigateTo('#/digest', { routeIfSame: true })")
    && modalSource.includes('closeModal()'),
  'the unavailable Markdown modal must offer the same regeneration route and close cleanly before navigation',
);
assert.ok(
  artifactNoteSource.includes('historyMarkdownRecoveryInstruction(item)')
    && !artifactNoteSource.includes('请从原摘要重新导出 MD。'),
  'history notes must not tell source-less text previews to use a source summary that does not exist',
);

console.log('history Markdown regeneration recovery contract passed');
