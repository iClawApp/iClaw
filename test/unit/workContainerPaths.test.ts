import { describe, it, expect } from 'vitest';

import {
  toWorkMounts,
  hostToContainer,
  containerToHost,
  translateCommandPaths,
} from '../../packages/iclaw-runtime/src/work-container';

const WIN = 'win32' as NodeJS.Platform;
const POSIX = 'linux' as NodeJS.Platform;

describe('toWorkMounts', () => {
  it('assigns normalized /work/<n> paths and basename labels', () => {
    const mounts = toWorkMounts([
      { path: '/Users/me/project', readonly: false },
      { path: '/Users/me/Downloads', readonly: true },
    ]);
    expect(mounts[0]).toMatchObject({
      path: '/Users/me/project',
      containerPath: '/work/0',
      readonly: false,
      label: 'project',
    });
    expect(mounts[1]).toMatchObject({ containerPath: '/work/1', readonly: true, label: 'Downloads' });
  });

  it('derives a label from a Windows path', () => {
    const [m] = toWorkMounts([{ path: 'C:\\Users\\me\\app', readonly: false }]);
    expect(m.label).toBe('app');
    expect(m.containerPath).toBe('/work/0');
  });
});

describe('hostToContainer', () => {
  const mounts = toWorkMounts([
    { path: '/Users/me/project', readonly: false },
    { path: '/Users/me/Downloads', readonly: true },
  ]);

  it('maps the folder root and nested paths', () => {
    expect(hostToContainer('/Users/me/project', mounts, POSIX)).toBe('/work/0');
    expect(hostToContainer('/Users/me/project/src/a.ts', mounts, POSIX)).toBe('/work/0/src/a.ts');
    expect(hostToContainer('/Users/me/Downloads/x', mounts, POSIX)).toBe('/work/1/x');
  });

  it('returns null for a path outside every mount', () => {
    expect(hostToContainer('/etc/passwd', mounts, POSIX)).toBeNull();
    expect(hostToContainer('/Users/me/projectX/y', mounts, POSIX)).toBeNull();
  });

  it('prefers the longest (nested) mount root', () => {
    const nested = toWorkMounts([
      { path: '/a', readonly: false },
      { path: '/a/b', readonly: false },
    ]);
    expect(hostToContainer('/a/b/c', nested, POSIX)).toBe('/work/1/c');
  });

  it('maps Windows drive paths case-insensitively', () => {
    const win = toWorkMounts([{ path: 'C:\\Users\\me\\app', readonly: false }]);
    expect(hostToContainer('C:\\Users\\me\\app\\src\\x.ts', win, WIN)).toBe('/work/0/src/x.ts');
    expect(hostToContainer('c:/users/me/app/y', win, WIN)).toBe('/work/0/y');
  });
});

describe('containerToHost', () => {
  it('reverses the mapping with the host separator', () => {
    const posix = toWorkMounts([{ path: '/Users/me/project', readonly: false }]);
    expect(containerToHost('/work/0/src/a.ts', posix)).toBe('/Users/me/project/src/a.ts');
    expect(containerToHost('/work/0', posix)).toBe('/Users/me/project');

    const win = toWorkMounts([{ path: 'C:\\Users\\me\\app', readonly: false }]);
    expect(containerToHost('/work/0/src/x.ts', win)).toBe('C:\\Users\\me\\app\\src\\x.ts');
  });
});

describe('translateCommandPaths', () => {
  const mounts = toWorkMounts([{ path: '/Users/me/project', readonly: false }]);

  it('rewrites a host root + tail to its container path', () => {
    expect(translateCommandPaths('cat /Users/me/project/a.txt', mounts, POSIX)).toBe(
      'cat /work/0/a.txt',
    );
    expect(translateCommandPaths('cd /Users/me/project && ls', mounts, POSIX)).toBe(
      'cd /work/0 && ls',
    );
  });

  it('rewrites Windows roots whole, in both slash forms', () => {
    const win = toWorkMounts([{ path: 'C:\\Users\\me\\app', readonly: false }]);
    expect(translateCommandPaths('cat C:\\Users\\me\\app\\a.txt', win, WIN)).toBe('cat /work/0/a.txt');
    expect(translateCommandPaths('cat C:/Users/me/app/a.txt', win, WIN)).toBe('cat /work/0/a.txt');
  });

  it('stops at shell metacharacters and leaves unrelated paths alone', () => {
    expect(translateCommandPaths('cat /Users/me/project/a|wc -l', mounts, POSIX)).toBe(
      'cat /work/0/a|wc -l',
    );
    expect(translateCommandPaths('ls /etc/hosts', mounts, POSIX)).toBe('ls /etc/hosts');
  });

  it('does not match a root inside a longer sibling path', () => {
    const ms = toWorkMounts([{ path: '/a', readonly: false }]);
    // /abc is a different folder — must stay untouched.
    expect(translateCommandPaths('ls /abc/x', ms, POSIX)).toBe('ls /abc/x');
    // The exact root (and nested) still map.
    expect(translateCommandPaths('ls /a/x', ms, POSIX)).toBe('ls /work/0/x');
    expect(translateCommandPaths('cd /a && ls', ms, POSIX)).toBe('cd /work/0 && ls');
  });

  it('prefers the longest mount root', () => {
    const nested = toWorkMounts([
      { path: '/a', readonly: false },
      { path: '/a/b', readonly: false },
    ]);
    expect(translateCommandPaths('cd /a/b/c', nested, POSIX)).toBe('cd /work/1/c');
  });
});
