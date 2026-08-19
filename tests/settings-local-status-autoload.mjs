import assert from 'node:assert/strict';
import { shouldAutoRefreshSystemStatus } from '../src/web/public/js/pages/settings/system-status.js';

assert.equal(shouldAutoRefreshSystemStatus(null), true, 'first activation must load local diagnostics automatically');
assert.equal(shouldAutoRefreshSystemStatus(undefined), true);
assert.equal(shouldAutoRefreshSystemStatus({ generated_at: '2026-08-07T00:00:00Z' }), false,
  're-activating a loaded section must not duplicate an in-flight/finished refresh');

console.log('settings local-status autoload contract passed');
