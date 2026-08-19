import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/web/public/js/pages/digest/index.js', import.meta.url),
  'utf8',
);
const renderStart = source.indexOf('async function renderCurrentResult(index)');
const renderEnd = source.indexOf('\n  function currentSavedItem()', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, '必须能定位生产结果渲染函数');

function makeNode() {
  return {
    children: [],
    replaceCount: 0,
    replaceChildren(...children) {
      this.children = children;
      this.replaceCount += 1;
    },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener() {},
    setAttribute() {},
    querySelectorAll() { return []; },
  };
}

const page = {
  destroyed: false,
  generation: 0,
  currentResultIndex: 0,
  doneResults: [{ target: { group_name: 'group-a' }, digest: { digest_id: 'digest-a' } }],
  renderOptions: { theme: 'auto', fontSize: 'normal', accentColor: '#07c160' },
  generationRender: null,
};
const resultSlot = makeNode();
const canvasWrap = makeNode();
const tabs = makeNode();
const identity = makeNode();
const resultStatus = makeNode();
const card = makeNode();
let resultUi = null;
let renderCalls = 0;
let renderStateVersion = 0;
let currentRenderToken = null;
const resultRenderState = {
  begin() {
    currentRenderToken = ++renderStateVersion;
    return currentRenderToken;
  },
  isCurrent(token) { return token === currentRenderToken; },
  invalidate() { currentRenderToken = null; },
};

const timers = [];
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = callback => {
  timers.push(callback);
  return timers.length - 1;
};

try {
  const renderCurrentResult = new Function(
    'page',
    'resultRenderState',
    'resultUi',
    'buildResultCard',
    'resultSlot',
    'wireResultActions',
    'el',
    'setSegmentedButtonState',
    'digestInputsLocked',
    'createRenderProgressTracker',
    'alive',
    'ui',
    'renderDigestToCanvas',
    'syncDigestPreviewIdentity',
    'createResultZoomTrigger',
    'openZoomModal',
    'updateResultActionState',
    `${source.slice(renderStart, renderEnd)}; return renderCurrentResult;`,
  )(
    page,
    resultRenderState,
    resultUi,
    () => ({ card, tabs, identity, canvasWrap, resultStatus }),
    resultSlot,
    () => {},
    (tag, className, text) => ({ tag, className, text, addEventListener() {}, setAttribute() {} }),
    () => {},
    () => false,
    () => ({ start() {}, stop() {}, }),
    token => !page.destroyed && token === page.generation,
    { spinner: () => ({ spinner: true }) },
    () => {
      renderCalls += 1;
      return { canvas: makeNode(), width: 640, height: 480 };
    },
    () => {},
    () => ({ addEventListener() {}, setAttribute() {} }),
    () => {},
    () => {},
  );

  const pending = renderCurrentResult(0);
  assert.equal(timers.length, 1, '结果渲染必须登记可控的延迟阶段');
  const canvasWritesBeforeDestroy = canvasWrap.replaceCount;

  // 真实页面 destroy 的 owner 失效边界: generation、render lease 同时失效。
  page.destroyed = true;
  page.generation += 1;
  resultRenderState.invalidate();
  timers.shift()();

  assert.equal(await pending, false, '页面销毁后的渲染必须返回 stale/cancelled');
  assert.equal(renderCalls, 0, '页面销毁后不得再调用 Canvas renderer');
  assert.equal(canvasWrap.replaceCount, canvasWritesBeforeDestroy,
    '页面销毁后不得再写入结果 canvas slot');
} finally {
  globalThis.setTimeout = originalSetTimeout;
}

console.log('web digest render destroy lifecycle tests passed');
