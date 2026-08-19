import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const mainSource = await fsp.readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const routeStart = mainSource.indexOf("if (pathname === '/api/rerender-history' && req.method === 'POST')");
const routeEnd = mainSource.indexOf("if (pathname === '/api/reveal' && req.method === 'POST')", routeStart);
const routeSource = mainSource.slice(routeStart, routeEnd);
assert.ok(routeSource.includes('local_action_committed: evidence.local_action_committed === true'), 'history rerender response must expose its persisted commit evidence');

console.log('history rerender success contract passed');
