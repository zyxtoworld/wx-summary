import assert from 'node:assert/strict';

const {
  assertBrowserDownloadSupported,
  browserDownloadCapability,
} = await import('../src/web/public/js/shared/browser-download-capability.js');

const supportedDocument = {
  createElement(tag) {
    assert.equal(tag, 'a');
    return { download: '', click() {} };
  },
};
const supportedUrlApi = {
  createObjectURL() { return 'blob:test'; },
  revokeObjectURL() {},
};

assert.deepEqual(
  browserDownloadCapability({ documentRef: supportedDocument, urlApi: supportedUrlApi, requireObjectUrl: true }),
  { supported: true, reason: '' },
  'anchor-download plus object-URL support should pass download preflight',
);
assert.deepEqual(
  browserDownloadCapability({
    documentRef: { createElement: () => ({ click() {} }) },
    urlApi: supportedUrlApi,
  }),
  { supported: false, reason: 'anchor_download_unsupported' },
  'a clickable anchor without download-attribute support must not be treated as a reliable download',
);
assert.deepEqual(
  browserDownloadCapability({ documentRef: supportedDocument, urlApi: {}, requireObjectUrl: true }),
  { supported: false, reason: 'object_url_unsupported' },
  'Blob downloads must require both object-URL creation and revocation',
);
assert.throws(
  () => assertBrowserDownloadSupported({
    documentRef: { createElement: () => ({ click() {} }) },
    urlApi: supportedUrlApi,
  }),
  error => error?.code === 'browser_download_unsupported'
    && error?.status === 501
    && /已停止准备文件/.test(error?.message || ''),
  'unsupported browsers should fail with an actionable stable error before preparing a file',
);

console.log('browser download capability tests passed');
