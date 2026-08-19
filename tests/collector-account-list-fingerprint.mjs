import assert from 'node:assert/strict';
import { __collectorInternals } from '../src/collector/index.js';
import { manualKeyAccountFingerprint } from '../src/config/settings.js';

const { accountListProjection } = __collectorInternals;

const rawAccount = {
  account_id: 'fixture-account',
  legacy_id: 'fixture-account',
  wxid: 'fixture-wxid',
  account_root: 'C:\\fixture\\account',
};
const projected = accountListProjection(rawAccount, { message: 'fixture' });

assert.equal(
  manualKeyAccountFingerprint(projected),
  manualKeyAccountFingerprint(rawAccount),
  '账号列表投影必须保留生成 canonical fingerprint 所需的 account_root，不能让列表 API 与状态 API 产生不同账号代际',
);

console.log('collector account list fingerprint tests passed');
