export function requireSettingsDiagnosticsResult(value, expectedScope) {
  const scope = String(expectedScope || '').trim();
  const service = value?.service;
  const valid = ['light', 'full', 'acceptance'].includes(scope)
    && value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.ok === true
    && typeof value.generated_at === 'string'
    && value.generated_at.trim().length > 0
    && value.diagnostic_scope === scope
    && service
    && typeof service === 'object'
    && !Array.isArray(service)
    && Array.isArray(value.log_tail)
    && value.log_tail.every(line => typeof line === 'string');
  if (!valid) {
    const error = new Error('诊断导出响应无效，请稍后重试。');
    error.status = 502;
    error.code = 'settings_diagnostics_response_invalid';
    throw error;
  }
  return value;
}
