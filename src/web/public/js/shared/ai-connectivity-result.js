export function requireAiConnectivityResult(payload) {
  const validPayload = payload && typeof payload === 'object' && !Array.isArray(payload);
  const results = validPayload ? payload.model_results : null;
  const structurallyValid = typeof payload?.ok === 'boolean'
    && typeof payload?.partial_ok === 'boolean'
    && Array.isArray(results)
    && results.length > 0
    && results.every(result => result
      && typeof result === 'object'
      && !Array.isArray(result)
      && ['model', 'long_context'].includes(String(result.role || '').trim())
      && String(result.model || '').trim()
      && typeof result.ok === 'boolean'
      && typeof result.partial_ok === 'boolean'
      && Array.isArray(result.capabilities)
      && result.capabilities.length > 0
      && result.capabilities.every(capability => capability
        && typeof capability === 'object'
        && !Array.isArray(capability)
        && String(capability.name || '').trim()
        && typeof capability.ok === 'boolean'));
  const allOk = structurallyValid && results.every(result => result.ok === true);
  const hasCapabilityFailures = structurallyValid && results.some(result => result.partial_ok === true
    || result.capabilities.some(capability => capability.ok === false));
  const anyUsableCapability = structurallyValid && results.some(result => result.ok === true
    || result.partial_ok === true
    || result.capabilities.some(capability => capability.ok === true));
  const expectedPartial = anyUsableCapability && (!allOk || hasCapabilityFailures);
  const validResults = structurallyValid
    && payload.ok === allOk
    && payload.partial_ok === expectedPartial;
  if (!validResults) {
    const error = new Error('AI 连通测试响应格式无效，请重试。');
    error.status = 502;
    error.code = 'ai_connectivity_response_invalid';
    throw error;
  }
  return payload;
}
