import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const koffi = require('koffi');

const dllPath = process.argv[2] || '';
const input = await readStdin();
if (!dllPath || !input.length || input.subarray(0, 4).toString('ascii') !== 'wxgf') {
  process.exit(2);
}

try {
  const WxAMConfig = koffi.struct('WxAMConfig', { mode: 'int' });
  const dll = koffi.load(dllPath);
  const decode = dll.func('int64 __stdcall wxam_dec_wxam2pic_5(void*, int, void*, _Inout_ int*, WxAMConfig*)');
  const maxSize = 64 * 1024 * 1024;
  for (const mode of [1, 2, 0, 3]) {
    const output = Buffer.allocUnsafe(maxSize);
    const outputSize = [maxSize];
    const config = { mode };
    const ret = decode(input, input.length, output, outputSize, config);
    const size = Number(outputSize[0] || 0);
    if (Number(ret) === 0 && size > 0 && size <= output.length) {
      process.stdout.write(output.subarray(0, size));
      process.exit(0);
    }
  }
} catch {
  // The parent process treats any non-zero exit as "native wxgf decode unavailable".
}

process.exit(2);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}
