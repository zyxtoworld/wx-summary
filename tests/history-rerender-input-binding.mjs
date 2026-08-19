import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const mainSource = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const outputSource = await fs.readFile(new URL('../src/renderer/output.js', import.meta.url), 'utf8');
const historyDigestRoute = mainSource.slice(
  mainSource.indexOf("if (pathname.startsWith('/api/history-digest/')"),
  mainSource.indexOf("if (pathname === '/api/preview-rerender-history'"),
);
const previewRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/preview-rerender-history'"),
  mainSource.indexOf("if (pathname === '/api/rerender-history'"),
);
const saveRoute = mainSource.slice(
  mainSource.indexOf("if (pathname === '/api/rerender-history'"),
  mainSource.indexOf("if (pathname === '/api/reveal'"),
);

assert.ok(mainSource.includes('function historyRerenderInputVersion('), 'the server must derive an opaque version from the browser-visible rerender input');
assert.ok(historyDigestRoute.includes('rerender_input_version:'), 'saved-history reads must return the input version used by browser Canvas');
assert.ok(previewRoute.includes('historyRerenderInputVersionFromRequest(body)'), 'preview uploads must require the caller input version');
assert.ok(previewRoute.includes("code: 'history_rerender_input_changed'"), 'a changed privacy/redaction input must reject stale preview uploads');
assert.ok(previewRoute.indexOf('historyRerenderInputVersionFromRequest(body)') < previewRoute.indexOf('rememberHistoryRerenderPreview('), 'input version validation must happen before a browser PNG enters the preview cache');
assert.ok(previewRoute.indexOf('const settings = await loadSettings()') < previewRoute.indexOf('readPngUploadToTemp('), 'stale history, output-directory, and rerender-input checks must run before accepting a large browser PNG upload');
assert.ok(previewRoute.includes('await validatePngFile(uploadedPngFile'), 'history rerender preview uploads must validate the temporary PNG through the streaming file validator');
assert.ok(previewRoute.indexOf('await validatePngFile(uploadedPngFile') < previewRoute.indexOf('const pngBuffer = await fsp.readFile(uploadedPngFile)'), 'history rerender preview uploads must finish streaming validation before retaining the compressed PNG buffer');
assert.ok(saveRoute.includes('historyRerenderInputVersionFromRequest(body)'), 'saving a cached preview must carry the same input version contract');
assert.ok(saveRoute.indexOf('historyRerenderInputVersionFromRequest(body)') < saveRoute.indexOf('claimHistoryRerenderPreviewToken('), 'stale rerender input must fail before claiming a one-time PNG credential');
assert.ok(saveRoute.includes('validated_png_sha256: previewClaim.sha256'), 'saving a server-validated history preview must pass its immutable SHA256 binding to the output writer');
assert.ok(outputSource.includes('validated_png_sha256 = \'\'') && outputSource.includes('trustedPngBufferFromValidatedHash'), 'the output writer must skip a second full PNG inflate only when the supplied buffer matches a server-validated SHA256');

console.log('history rerender input binding tests passed');
