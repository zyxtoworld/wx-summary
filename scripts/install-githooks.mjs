import { chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, '.githooks', 'pre-commit');

try {
  if (!existsSync(path.join(root, '.git')) || !existsSync(hook)) process.exit(0);
  try {
    chmodSync(hook, 0o755);
  } catch {
    // hooksPath still helps on platforms/filesystems that ignore POSIX modes.
  }
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  });
} catch {
  // Installing hooks is a developer convenience; never block npm install/startup.
}
