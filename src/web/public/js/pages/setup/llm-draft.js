import { llmEndpointIdentity, llmIdentity } from '../../shared/ai-identity.js';

export { llmEndpointIdentity, llmIdentity };

function text(value) {
  return String(value || '').trim();
}

export function rememberLlmDraft(wiz, form = {}) {
  if (!wiz?.llm) return;
  wiz.llm.provider = text(form.provider) || 'openai';
  wiz.llm.base_url = text(form.base_url);
  wiz.llm.api_key = text(form.api_key);
  wiz.llm.apiKeyTouched = Boolean(wiz.llm.api_key);
  wiz.llm.model = text(form.model);
  wiz.llm.long_context_model = text(form.long_context_model);
  wiz.llm.dirty = true;
}

export function llmFormPrefillValues(wiz) {
  const draft = wiz?.llm || {};
  if (draft.dirty === true) {
    return {
      provider: text(draft.provider) || 'openai',
      base_url: text(draft.base_url),
      api_key: text(draft.api_key),
      model: text(draft.model),
      long_context_model: text(draft.long_context_model),
    };
  }

  const saved = wiz?.settings?.llm || {};
  return {
    provider: ['openai', 'anthropic'].includes(saved.provider) ? saved.provider : 'openai',
    base_url: text(saved.base_url),
    api_key: '',
    model: text(saved.model),
    long_context_model: text(saved.long_context_model),
  };
}
