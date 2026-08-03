import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const appSource = await fsp.readFile(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const cssSource = await fsp.readFile(new URL('../src/web/public/css/app.css', import.meta.url), 'utf8');

const canvasStart = appSource.indexOf('async function drawDigestCanvas(');
const canvasEnd = appSource.indexOf('\nfunction assertDigestCanvasSize', canvasStart);
assert.ok(canvasStart >= 0 && canvasEnd > canvasStart, 'long-image drawing must expose an asynchronous cooperative renderer');
const canvasSource = appSource.slice(canvasStart, canvasEnd);
assert.ok(canvasSource.includes('{ onProgress = null, signal = null } = {}'), 'canvas rendering must accept the generation abort signal');
assert.ok((canvasSource.match(/await yieldDigestCanvasWork\(signal\)/g) || []).length >= 6,
  'measurement and painting must yield between bounded sections instead of monopolizing the browser thread');
assert.ok(canvasSource.includes('throwIfDigestCanvasAborted(signal)'), 'each cooperative yield must re-check cancellation');
assert.ok(appSource.includes('function digestCanvasMaxDevicePixels()')
  && appSource.includes('navigator?.deviceMemory')
  && appSource.includes('DIGEST_CANVAS_LOW_MEMORY_RGBA_BYTES'),
  'canvas allocation limits must be reduced for constrained/mobile devices instead of always allowing 160 MB');

const generationStart = appSource.indexOf('async function generateDigest(');
const generationEnd = appSource.indexOf('\nfunction digestPrepareConcurrency', generationStart);
const generationSource = appSource.slice(generationStart, generationEnd);
assert.ok(generationSource.includes('await drawDigestCanvas(digest, null, batchSnapshot.render, { onProgress: reportCanvasProgress, signal: controller.signal })'),
  'generation must await the cooperative renderer and pass its cancellation signal');
assert.ok(generationSource.includes('const textMarkdownFragments = new Array(targets.length)')
  && generationSource.includes('const markdownFragment = digestMarkdown(digest)')
  && generationSource.includes('paintIncrementalTextPreviewFragment(i, markdownFragment')
  && !generationSource.includes('const mergedMarkdown = digestMarkdownForDigests(mergedDigests)'),
  'multi-group text generation must append each Markdown fragment once instead of rebuilding all prior output after every group');

const incrementalStart = appSource.indexOf('function paintIncrementalTextPreviewFragment(');
const incrementalEnd = appSource.indexOf('\nfunction renderTextPreviews(', incrementalStart);
assert.ok(incrementalStart >= 0 && incrementalEnd > incrementalStart, 'incremental text preview painter must remain available');
const incrementalSource = appSource.slice(incrementalStart, incrementalEnd);
assert.ok(incrementalSource.includes('document.createElement(\'span\')')
  && incrementalSource.includes('insertBefore')
  && !incrementalSource.includes('digestMarkdownForDigests'),
  'partial text preview updates must insert one ordered DOM fragment without serializing the whole batch');

const mediumMediaStart = cssSource.indexOf('@media (max-width: 900px)');
const mediumMediaEnd = cssSource.indexOf('\n}', mediumMediaStart);
const mediumMediaSource = cssSource.slice(mediumMediaStart, mediumMediaEnd + 2);
assert.ok(mediumMediaSource.includes('.sidebar')
  && mediumMediaSource.includes('height: min(55dvh, 460px)')
  && mediumMediaSource.includes('position: relative'),
  'single-column tablet layout must bound the group sidebar before the 640px mobile breakpoint');

const saveButtonStart = appSource.indexOf('function syncSettingsSaveButton(');
const saveButtonEnd = appSource.indexOf('\n  function bindSettingsDirty', saveButtonStart);
assert.ok(appSource.slice(saveButtonStart, saveButtonEnd).includes('paintSettingsRevisionConflictNotice();'),
  'settings conflict messaging must repaint whenever any section changes dirty state');

console.log('frontend responsiveness contract tests passed');
