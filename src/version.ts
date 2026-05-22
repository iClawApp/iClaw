import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_NAME = '@iclawapp/iclaw';

let cachedVersion: string | undefined;

function findPackageRoot(): string {
  for (const start of [path.resolve(__dirname, '..'), process.cwd()]) {
    let dir = start;
    for (let i = 0; i < 50; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
            name?: string;
          };
          if (pkg.name === PACKAGE_NAME) return dir;
        } catch {
          /* try parent */
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(__dirname, '..');
}

/** Version of the running @iclawapp/iclaw package (from its package.json). */
export function getInstalledVersion(): string {
  if (cachedVersion) return cachedVersion;
  const root = findPackageRoot();
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { version?: string };
    cachedVersion =
      typeof pkg.version === 'string' && pkg.version.trim()
        ? pkg.version.trim()
        : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/** Compare `major.minor.patch` strings; positive if `a` is newer than `b`. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
