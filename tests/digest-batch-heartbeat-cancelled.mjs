import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const fixtureRelative = `outputs/.tmp/digest-batch-heartbeat-cancelled-${process.pid}-${Date.now()}`;
const fixturePath = path.resolve(fixtureRelative);
const bootstrapToken = `heartbeat-cancelled-bootstrap-${process.pid}-${Date.now()}`;
const port = 40000 + (process.pid % 10000);

process.env.WX_SUMMARY_ACCEPTANCE_MODE = '1';
process.env.WX_SUMMARY_ACCEPTANCE_DATA_DIR = fixtureRelative;
process.env.WX_SUMMARY_ACCEPTANCE_WXDB_TMP_DIR = `${fixtureRelative}/runtime-tmp/wxdb`;
process.env.WX_SUMMARY_NO_RUNTIME_FILE = '1';
process.env.WX_SUMMARY_ALLOW_EXTERNAL_TEST_DB = '1';
process.env.WX_SUMMARY_BOOTSTRAP_TOKEN = bootstrapToken;
process.env.WX_SUMMARY_NO_OPEN = '1';
process.argv.push('--port', String(port));

await fs.mkdir(fixturePath, { recursive: true });

async function removeFixturePath() {
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await fs.rm(fixturePath, { recursive: true, force: true });
      try {
        await fs.lstat(fixturePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 12) await new Promise(resolve => setTimeout(resolve, 100 * attempt));
  }
  throw new Error(`failed to remove owned heartbeat fixture: ${fixturePath}`, { cause: lastError });
}

let server = null;
try {
  const { main } = await import('../src/main.js');
  server = await main();
  assert.ok(server?.listening, 'the real service caller should start an isolated loopback server');
  const actualPort = server.address()?.port;
  assert.ok(Number.isInteger(actualPort) && actualPort > 0, 'the isolated service should expose its actual port');

  const sessionResponse = await fetch(`http://127.0.0.1:${actualPort}/api/session?bootstrap=${encodeURIComponent(bootstrapToken)}`);
  assert.equal(sessionResponse.status, 200, 'the isolated service should exchange the bootstrap token');
  const session = await sessionResponse.json();
  assert.ok(session.token && session.service_instance_id, 'the session exchange should return API and service-instance credentials');

  const post = async (pathname, body) => fetch(`http://127.0.0.1:${actualPort}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WX-Token': session.token,
    },
    body: JSON.stringify(body),
  });
  const batch = {
    batch_id: `heartbeat-cancelled-${process.pid}-${Date.now()}`,
    batch_token: `heartbeat-cancelled-token-${process.pid}-${Date.now()}`,
    service_instance_id: session.service_instance_id,
  };

  const cancelled = await post('/api/digest-cancel', {
    ...batch,
    reason: 'test_cancel_before_late_heartbeat',
    abort_saves: true,
  });
  assert.equal(cancelled.status, 200, 'the real cancel route should accept an unregistered owner tombstone');
  assert.equal((await cancelled.json()).cancelled, true, 'the cancel route should persist the cancellation tombstone');

  const lateHeartbeat = await post('/api/digest-batch-heartbeat', batch);
  const lateHeartbeatBody = await lateHeartbeat.json();
  assert.equal(lateHeartbeat.status, 499, 'a heartbeat arriving after cancellation must be rejected as cancelled');
  assert.equal(lateHeartbeatBody.code, 'digest_batch_cancelled', 'a cancelled batch heartbeat must keep the stable cancellation contract');
  assert.notEqual(lateHeartbeatBody.active, true, 'a late heartbeat must not resurrect the cancelled active lease');

  console.log('digest batch cancelled heartbeat tests passed');
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  // main() 启动后还有同进程的后台探测；Windows 上它可能在 HTTP server
  // close 后短暂重建空 runtime-tmp。只重试本测试唯一目录，并把持久残留
  // 保持为硬失败，不能用一次 rm 的 ENOTEMPTY 制造随机门禁结果。
  await removeFixturePath();
}
