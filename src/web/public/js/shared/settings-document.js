export function settingsDocumentRevision(value) {
  return String(value?.settings_revision || '').trim();
}

export function settingsDocumentIsValid(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !!settingsDocumentRevision(value);
}

export function requireSettingsDocument(value) {
  if (!settingsDocumentIsValid(value)) {
    const error = new TypeError('设置响应不是有效文档');
    error.status = 502;
    error.code = 'invalid_settings_document';
    throw error;
  }
  return value;
}

export function requireSettingsResponseDocument(value) {
  const document = requireSettingsDocument(value?.settings);
  const revision = String(value?.settings_revision || '').trim();
  if (!revision || revision !== settingsDocumentRevision(document)) {
    const error = new TypeError('设置响应版本与文档不一致');
    error.status = 502;
    error.code = 'invalid_settings_document';
    throw error;
  }
  return document;
}
