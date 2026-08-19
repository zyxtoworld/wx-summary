import assert from 'node:assert/strict';
import {
  llmFormPrefillValues,
  rememberLlmDraft,
} from '../src/web/public/js/pages/setup/llm-draft.js';

const wiz = {
  settings: {
    llm: {
      provider: 'openai',
      base_url: 'https://saved.example/v1',
      model: 'saved-model',
      long_context_model: 'saved-long-model',
      api_key_set: true,
    },
  },
  llm: {
    provider: 'openai',
    base_url: '',
    api_key: '',
    apiKeyTouched: false,
    model: '',
    long_context_model: '',
    dirty: false,
  },
};

rememberLlmDraft(wiz, {
  provider: 'openai',
  base_url: 'https://draft.example/v1',
  api_key: 'test-only-key',
  model: 'auto',
  long_context_model: 'auto-long',
});

assert.deepEqual(llmFormPrefillValues(wiz), {
  provider: 'openai',
  base_url: 'https://draft.example/v1',
  api_key: 'test-only-key',
  model: 'auto',
  long_context_model: 'auto-long',
}, '返回向导步骤后必须恢复当前会话内未保存的 AI 草稿,不能被服务端旧设置覆盖');

wiz.llm.dirty = false;
assert.deepEqual(llmFormPrefillValues(wiz), {
  provider: 'openai',
  base_url: 'https://saved.example/v1',
  api_key: '',
  model: 'saved-model',
  long_context_model: 'saved-long-model',
}, '没有草稿时仍应从服务端设置预填,且不回显已保存密钥');

console.log('web setup draft navigation tests passed');
