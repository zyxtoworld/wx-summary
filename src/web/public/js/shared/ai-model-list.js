export function requireAiModelList(payload) {
  const validPayload = payload && typeof payload === 'object' && !Array.isArray(payload);
  const models = validPayload ? payload.models : null;
  const validModels = Array.isArray(models)
    && models.every(model => model
      && typeof model === 'object'
      && !Array.isArray(model)
      && String(model.id || '').trim());
  if (!validModels) {
    const error = new Error('模型列表响应格式无效，请重试。');
    error.status = 502;
    error.code = 'ai_model_list_response_invalid';
    throw error;
  }
  return models;
}
