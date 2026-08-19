export function serviceStatePayloadIsValid(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.need_setup === 'boolean'
    && !!value.wechat
    && typeof value.wechat === 'object'
    && !Array.isArray(value.wechat);
}

export function requireServiceStatePayload(value) {
  if (!serviceStatePayloadIsValid(value)) {
    const error = new Error('服务状态响应无效，请刷新页面重试。');
    error.status = 502;
    error.code = 'service_state_response_invalid';
    throw error;
  }
  return value;
}
