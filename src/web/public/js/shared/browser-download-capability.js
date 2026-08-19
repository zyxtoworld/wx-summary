export function browserDownloadCapability({
  documentRef = globalThis.document,
  urlApi = globalThis.URL,
  requireObjectUrl = false,
} = {}) {
  let anchor = null;
  try {
    anchor = documentRef?.createElement?.('a') || null;
  } catch {}
  if (!anchor || !('download' in anchor) || typeof anchor.click !== 'function') {
    return { supported: false, reason: 'anchor_download_unsupported' };
  }
  if (requireObjectUrl
    && (typeof urlApi?.createObjectURL !== 'function' || typeof urlApi?.revokeObjectURL !== 'function')) {
    return { supported: false, reason: 'object_url_unsupported' };
  }
  return { supported: true, reason: '' };
}

export function browserDownloadUnsupportedMessage({
  artifactLabel = '文件',
  savedArtifact = false,
  revealSupported = false,
  copySupported = false,
  copyLabel = '复制内容',
} = {}) {
  const label = String(artifactLabel || '文件').trim() || '文件';
  const recovery = [];
  if (savedArtifact && revealSupported) recovery.push(`可用“在文件夹中显示”定位${label}`);
  if (copySupported) recovery.push(`可改用“${String(copyLabel || '复制内容').trim() || '复制内容'}”`);
  const nextStep = recovery.length
    ? `${recovery.join('；')}。`
    : '请升级浏览器或改用支持文件下载的浏览器。';
  const labelGap = /^[A-Za-z0-9]/.test(label) ? ' ' : '';
  return `当前浏览器不支持可靠的文件下载，已停止准备${labelGap}${label}。${nextStep}`;
}

export function assertBrowserDownloadSupported(options = {}) {
  const capability = browserDownloadCapability(options);
  if (capability.supported) return capability;
  const error = new Error(browserDownloadUnsupportedMessage());
  error.status = 501;
  error.code = 'browser_download_unsupported';
  error.userMessage = error.message;
  error.capabilityReason = capability.reason;
  throw error;
}
