import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/web/public/js/app.js', import.meta.url), 'utf8');
const coordinatorStart = source.indexOf('function digestCanvasSupersededError(');
const frameStart = source.indexOf('async function drawDigestCanvasFrame(', coordinatorStart);
assert.ok(coordinatorStart >= 0 && frameStart > coordinatorStart, 'visible Canvas redraw coordinator must wrap the frame renderer');
const coordinatorSource = source.slice(coordinatorStart, frameStart);

const context = vm.createContext({ AbortController, Promise, queueMicrotask });
vm.runInContext(`
  let _digestVisibleCanvasDrawSequence = 0;
  let _digestVisibleCanvasDrawState = null;
  let _digestCanvasRestoreController = null;
  const visibleCanvas = {
    width: 17,
    height: 19,
    hidden: false,
    style: { width: 'old' },
    payload: 'old',
    getContext() {
      return { drawImage(source) { visibleCanvas.payload = source.payload; } };
    },
  };
  const jobs = [];
  const document = {
    getElementById(id) { return id === 'digest-canvas' ? visibleCanvas : null; },
    createElement(tag) {
      if (tag !== 'canvas') throw new Error('unexpected element');
      return { width: 0, height: 0, hidden: false, style: {}, payload: '' };
    },
  };
  function digestAbortError(message) { return Object.assign(new Error(message), { name: 'AbortError' }); }
  function throwIfDigestCanvasAborted(signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : digestAbortError('aborted');
  }
  function abortDigestCanvasRestore() { _digestCanvasRestoreController = null; }
  function clearDigestRerenderPreview() {}
  function updateDigestPreviewActionLock() {}
  function currentDigestRenderSelection() { return {}; }
  function waitForPromiseWithSignal(promise) { return promise; }
  function drawDigestCanvasFrame(digest, target, selection, options) {
    return new Promise((resolve, reject) => jobs.push({
      digest,
      target,
      signal: options.signal,
      resolve() {
        target.width = digest.width;
        target.height = digest.height;
        target.style.width = digest.cssWidth;
        target.payload = digest.id;
        resolve(target);
      },
      reject,
    }));
  }
  ${coordinatorSource}
  globalThis.draw = drawDigestCanvas;
  globalThis.waitStable = waitForStableDigestCanvas;
  globalThis.jobs = jobs;
  globalThis.visible = visibleCanvas;
`, context);

const first = context.draw({ id: 'first', width: 100, height: 200, cssWidth: '100px' });
const second = context.draw({ id: 'second', width: 300, height: 400, cssWidth: '300px' });
assert.equal(context.visible.payload, 'old', 'in-flight work must not mutate the visible Canvas');
context.jobs[1].resolve();
assert.equal((await second).payload, 'second');
assert.equal(context.visible.payload, 'second');
context.jobs[0].resolve();
await assert.rejects(first, error => error?.code === 'digest_canvas_superseded');
assert.equal(context.visible.payload, 'second', 'a late old frame must never overwrite the latest committed frame');

const third = context.draw({ id: 'third', width: 500, height: 600, cssWidth: '500px' });
let stableSettled = false;
const stable = context.waitStable().then(value => {
  stableSettled = true;
  return value;
});
await Promise.resolve();
assert.equal(stableSettled, false, 'PNG actions must wait while the latest visible frame is still drawing');
context.jobs[2].resolve();
await third;
assert.equal((await stable).payload, 'third');

const artifactSource = source.slice(source.indexOf('async function digestPngArtifactForAction('), source.indexOf('function notifyLocalProgress('));
assert.ok(artifactSource.includes('await waitForStableDigestCanvas({ signal })'));
const downloadSource = source.slice(source.indexOf('async function downloadCanvas('), source.indexOf('function imageSizeLabel('));
const copySource = source.slice(source.indexOf('async function copyCanvas('), source.indexOf('\nfunction ', source.indexOf('async function copyCanvas(') + 10));
assert.ok(downloadSource.includes("await digestPngArtifactForAction('下载 PNG'"));
assert.ok(copySource.includes("await digestPngArtifactForAction('复制图片'"));

const themeSource = source.slice(source.indexOf('// ---------- 主题 ----------'), source.indexOf('function normalizeAppHash'));
assert.ok(themeSource.includes('APP_THEME_CHANGED_EVENT'));
assert.ok(themeSource.includes('window.dispatchEvent(new CustomEvent(APP_THEME_CHANGED_EVENT'));
const autoThemeSource = source.slice(source.indexOf('function scheduleAutoDigestThemeRedraw('), source.indexOf('\nfunction ', source.indexOf('function scheduleAutoDigestThemeRedraw(') + 10));
assert.ok(autoThemeSource.includes("normalizeDigestTheme(_state_digest.theme) !== 'auto'"));
assert.ok(autoThemeSource.includes('redrawLastDigestWithSelection('));
assert.ok(autoThemeSource.includes('_autoDigestThemeRedrawPending = true'));
assert.ok(source.includes('if (_autoDigestThemeRedrawPending && !locked) scheduleAutoDigestThemeRedraw();'));
assert.ok(source.includes("window.addEventListener(APP_THEME_CHANGED_EVENT, scheduleAutoDigestThemeRedraw)"));

const themeContext = vm.createContext({ Promise, queueMicrotask });
vm.runInContext(`
  let _autoDigestThemeRedrawScheduled = false;
  let _autoDigestThemeRedrawPending = false;
  let generating = true;
  let redrawCount = 0;
  const APP_THEME_CHANGED_EVENT = 'theme-change';
  const _state_digest = { theme: 'auto', lastDigest: { id: 'digest' }, rerenderSaving: false };
  const document = { getElementById() { return { classList: { contains() { return false; } } }; } };
  const window = { addEventListener(name, listener) { globalThis.themeListener = listener; } };
  function normalizeDigestTheme(value) { return value; }
  function digestOutputStillGenerating() { return generating; }
  function currentDigestRenderSelection() { return { theme: 'auto' }; }
  async function redrawLastDigestWithSelection() { redrawCount += 1; }
  function showDigestRenderError(error) { throw error; }
  ${autoThemeSource}
  globalThis.releaseGeneration = () => { generating = false; };
  globalThis.retryPendingTheme = () => {
    if (_autoDigestThemeRedrawPending) scheduleAutoDigestThemeRedraw();
  };
  globalThis.themeState = () => ({ pending: _autoDigestThemeRedrawPending, redrawCount });
`, themeContext);

themeContext.themeListener();
await Promise.resolve();
assert.deepEqual({ ...themeContext.themeState() }, { pending: true, redrawCount: 0 }, 'a theme change during generation must stay pending');
themeContext.releaseGeneration();
themeContext.retryPendingTheme();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual({ ...themeContext.themeState() }, { pending: false, redrawCount: 1 }, 'the pending auto theme must redraw once after generation settles');

const redrawSource = source.slice(source.indexOf('async function redrawLastDigestWithSelection('), source.indexOf('function scheduleAutoDigestThemeRedraw('));
assert.ok(redrawSource.includes("if (err?.code === 'digest_canvas_superseded' || err?.name === 'AbortError') throw err;"));

const setupFocusSource = source.slice(source.indexOf('function focusSetupStepContent('), source.indexOf('\n  function ', source.indexOf('function focusSetupStepContent(') + 10));
assert.ok(setupFocusSource.includes("$body.querySelector('input:not([type=\"hidden\"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href]')"));
const setupBackSource = source.slice(source.indexOf("$back.addEventListener('click'"), source.indexOf("$next.addEventListener('click'"));
assert.ok(setupBackSource.indexOf('paint();') < setupBackSource.indexOf('focusSetupStepContent();'));
assert.ok(source.includes("if (step !== startedStep) focusSetupStepContent();"));

console.log('digest Canvas redraw coordinator tests passed');
