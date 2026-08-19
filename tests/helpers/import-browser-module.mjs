import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_PUBLIC_ROOT = path.join(ROOT, 'src', 'web', 'public');
const LOCAL_IMPORT_RE = /(?:from\s*|import\s*)['"]([^'"]+)['"]/g;

function localImportPath(specifier, importer) {
  if (specifier.startsWith('/js/')) return path.join(WEB_PUBLIC_ROOT, specifier.slice(1));
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.resolve(path.dirname(importer), specifier);
  }
  return '';
}
export function createBrowserModuleLoader() {
  const urls = new Map();

  async function moduleUrl(file) {
    const absolute = path.resolve(file);
    if (!absolute.startsWith(`${WEB_PUBLIC_ROOT}${path.sep}`)) {
      throw new Error(`浏览器模块越出 public 目录:${absolute}`);
    }
    if (urls.has(absolute)) return urls.get(absolute);
    const pending = (async () => {
      const source = await fsp.readFile(absolute, 'utf8');
      const matches = [...source.matchAll(LOCAL_IMPORT_RE)];
      let cursor = 0;
      let transformed = '';
      for (const match of matches) {
        const specifier = match[1];
        const resolved = localImportPath(specifier, absolute);
        if (!resolved) continue;
        const specifierStart = match.index + match[0].indexOf(specifier);
        transformed += source.slice(cursor, specifierStart);
        transformed += await moduleUrl(resolved);
        cursor = specifierStart + specifier.length;
      }
      transformed += source.slice(cursor);
      return `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`;
    })();
    urls.set(absolute, pending);
    return pending;
  }

  return {
    async load(relativePath) {
      const file = path.resolve(WEB_PUBLIC_ROOT, relativePath);
      return import(await moduleUrl(file));
    },
  };
}
