import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../src/wxdb/index.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function listChatroomsFromWxDb(');
const end = source.indexOf('\nfunction ', start);
const listSource = source.slice(start, end > start ? end : undefined);

assert.ok(start >= 0, 'group-list reader must remain available');
assert.doesNotMatch(listSource, /projectMirrorScopeIncludesDbFile\(account, 'digest', sessionDbRef\)/, 'a contact-only refresh must not reuse an older digest session database');
assert.doesNotMatch(listSource, /session\.db 未参与本次群身份新鲜性检查；已复用项目内已验证副本/, 'group progress must not describe an old session snapshot as current enrichment');
assert.match(listSource, /当前群列表副本没有包含同批次复核的 session\.db/, 'degraded group reads must explain why recent-message metadata is unavailable');

console.log('group-list session freshness contract tests passed');
