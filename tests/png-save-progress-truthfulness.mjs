import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fsp.readFile(path.join(ROOT, 'src', 'web', 'public', 'js', 'app.js'), 'utf8');

const saveStart = source.indexOf('async function saveRenderedCanvas');
const saveEnd = source.indexOf('\nfunction renderTextPreview', saveStart);
const saveSource = source.slice(saveStart, saveEnd);
assert.ok(saveStart >= 0 && saveEnd > saveStart);
assert.match(saveSource, /保存结果 · 写入文件并更新历史/,
  'the in-flight request must describe the real combined server commit');

const responseIndex = saveSource.indexOf("saved = await api('/api/save-render'");
const responseSettledIndex = saveSource.indexOf('const softStoppedAfterCurrent', responseIndex);
const postResponseSource = saveSource.slice(responseSettledIndex);
assert.ok(responseIndex >= 0 && responseSettledIndex > responseIndex);
assert.doesNotMatch(postResponseSource, /name: 'saving:history'[\s\S]{0,220}status: 'running'/,
  'after the save response there is no real history work left to report as running');
assert.doesNotMatch(postResponseSource, /await waitForVisibleDigestProgress\(null\)/,
  'confirmed saves must not pause to manufacture a visible progress step');
assert.match(postResponseSource, /name: 'saving:history'[\s\S]{0,220}status: commitWarning \? 'warn' : 'done'/,
  'the response should immediately publish the confirmed history outcome');

const callerStart = source.indexOf('const saved = await saveRenderedCanvas(digest, canvas');
const callerEnd = source.indexOf('} catch (e) {', callerStart);
const callerSource = source.slice(callerStart, callerEnd);
const terminalStageIndex = callerSource.indexOf('markSavedDigestProgressTerminal');
const resultRowIndex = callerSource.indexOf('setDigestBatchResult(i, {');
assert.ok(terminalStageIndex >= 0 && resultRowIndex > terminalStageIndex,
  'the per-group progress stage must be terminal before its batch result row becomes done');

console.log('PNG save progress truthfulness tests passed');
