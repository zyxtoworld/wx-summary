import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fsp.readFile(
  path.join(ROOT, 'src', 'web', 'public', 'js', 'pages', 'digest', 'index.js'),
  'utf8',
);

const renderStart = source.indexOf('async function renderCurrentResult(index)');
const renderEnd = source.indexOf('\n  function currentSavedItem()', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, '总结页必须保留当前结果渲染函数');
const renderSource = source.slice(renderStart, renderEnd);
assert.match(renderSource, /page\.currentRender = rendered/, '画布渲染完成后必须绑定当前渲染结果');
assert.match(renderSource, /resultUi\.canvasWrap\.replaceChildren\(zoomTrigger\)/, '当前画布必须通过缩放触发器原子替换可见预览');

const savedItemStart = source.indexOf('function currentSavedItem()');
const saveStart = source.indexOf('async function saveCurrentPng()');
const saveEnd = source.indexOf('\n  async function copyCurrentImage()', saveStart);
assert.ok(savedItemStart >= 0 && saveStart > savedItemStart && saveEnd > saveStart,
  '总结页必须保留当前保存绑定和 PNG 保存流程');
const bindingSource = source.slice(savedItemStart, saveStart);
const saveSource = source.slice(saveStart, saveEnd);
assert.match(bindingSource, /page\.savedItems\.get\(String\(digest\.digest_id/, '当前保存文件必须按摘要 ID 读取');
assert.match(saveSource, /const result = await api\.postRaw\('\/api\/save-render'/, 'PNG 保存必须等待服务端保存响应');
assert.match(saveSource, /if \(result\?\.item && typeof result\.item === 'object'\) \{[\s\S]*?page\.savedItems\.set/s,
  '只有保存响应包含文件项时才能绑定 savedItems');
const postSaveSource = saveSource.slice(saveSource.indexOf("const result = await api.postRaw('/api/save-render'"));
assert.doesNotMatch(postSaveSource.slice(0, postSaveSource.indexOf("if (result?.item")), /page\.savedItems\.set/,
  '保存响应返回前不得污染当前保存绑定');

console.log('digest batch preview binding transaction tests passed');
