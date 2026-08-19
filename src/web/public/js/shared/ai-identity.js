function text(value) {
  return String(value || '').trim();
}

// 只保存 Key 的不可逆短指纹,避免把密钥原文挂在状态对象上。
function secretFingerprint(value) {
  const input = text(value);
  let first = 2166136261;
  let second = 2654435761;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + index), 2246822519);
  }
  return `${input.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

// 模型列表只绑定提供方、端点和 Key；用户选择哪个模型不改变列表来源。
export function llmEndpointIdentity({ provider, base_url, api_key, settings_revision } = {}) {
  const key = text(api_key);
  return [
    text(provider) || 'openai',
    text(base_url),
    key ? `typed:${secretFingerprint(key)}` : 'saved',
    `revision:${text(settings_revision)}`,
  ].join('|');
}

// 端点、Key、主模型和长上下文模型任一变化都必须使旧连通测试失效。
export function llmIdentity({ provider, base_url, api_key, model, long_context_model, settings_revision } = {}) {
  return [
    llmEndpointIdentity({ provider, base_url, api_key, settings_revision }),
    text(model),
    text(long_context_model),
  ].join('|');
}
