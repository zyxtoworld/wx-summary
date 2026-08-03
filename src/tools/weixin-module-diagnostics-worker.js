import { getWeixinModuleEvidence } from '../wxenv/discovery.js';

async function main() {
  try {
    const result = await getWeixinModuleEvidence();
    process.stdout.write(`${JSON.stringify(result || {})}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: String(e?.message || e || '微信模块证据扫描失败'),
      code: String(e?.code || '').trim(),
    })}\n`);
  }
}

main().catch(e => {
  try {
    process.stderr.write(String(e?.stack || e?.message || e || '微信模块证据子进程失败'));
  } catch {}
  process.exitCode = 1;
});
