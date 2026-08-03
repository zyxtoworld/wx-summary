import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');

assert.ok(
  source.includes('const textPreviewActionButtons = [')
    && source.includes('textPreviewCopyButton,\n    textPreviewExportButton,')
    && source.includes('withBusyButtons(textPreviewActionButtons, copyTextPreviewMarkdown)')
    && source.includes('withBusyButtons(textPreviewActionButtons, exportTextPreviewMarkdown)')
    && source.includes('withBusyButtons(textPreviewActionButtons, revealTextPreviewMarkdown)'),
  'text preview actions sharing one status surface must share one busy lane',
);
const exportTextPreviewSource = source.slice(
  source.indexOf('async function exportTextPreviewMarkdown'),
  source.indexOf('async function downloadTextPreviewMarkdown'),
);
const copyTextPreviewSource = source.slice(
  source.indexOf('async function copyTextPreviewMarkdown'),
  source.indexOf('async function revealTextPreviewMarkdown'),
);
assert.doesNotMatch(
  exportTextPreviewSource,
  /if \(button\?\.dataset\.busy === '1'\) return/,
  'the shared busy lane already owns the export button marker; the export action must not reject its own wrapper marker',
);
assert.doesNotMatch(
  copyTextPreviewSource,
  /if \(button\?\.dataset\.busy === '1'\) return/,
  'the shared busy lane already owns the copy button marker; the copy action must not reject its own wrapper marker',
);
assert.ok(
  source.includes('const digestPreviewActionButtons = [')
    && source.includes('digestPreviewDownloadButton,\n    previewCopyButton,')
    && source.includes('withBusyButtons(digestPreviewActionButtons, downloadCanvas)')
    && source.includes('withBusyButtons(digestPreviewActionButtons, copyCanvas)')
    && source.includes('withBusyButtons(digestPreviewActionButtons, copyDigestSavedPngPath)'),
  'saved PNG preview actions sharing one status surface must share one busy lane',
);
assert.ok(
  source.includes('const historyMarkdownModalActionButtons = [')
    && source.includes('openMdSourceButton,\n    downloadMdButton,')
    && (source.match(/withBusyButtons\(historyMarkdownModalActionButtons/g) || []).length >= 5,
  'history Markdown modal actions must serialize writes to their shared status',
);
assert.ok(
  source.includes('const historyModalActionButtons = [')
    && source.includes('downloadButton,\n    copyButton,\n    revealButton,')
    && source.includes('withBusyButtons(historyModalActionButtons, openHistoryImageZoom)')
    && source.includes('withBusyButtons(historyModalActionButtons, async () => {')
    && (source.match(/withBusyButtons\(historyModalActionButtons/g) || []).length >= 11,
  'history PNG modal actions, including zoom and rerender, must share one busy lane',
);

console.log('shared action status serialization tests passed');
