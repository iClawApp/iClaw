import { describe, it, expect } from 'vitest';

import {
  hostToContainerPath,
  translateCommandPaths,
} from '../../packages/iclaw-runtime/src/work-container';

const WIN = 'win32' as NodeJS.Platform;
const POSIX = 'linux' as NodeJS.Platform;

describe('hostToContainerPath', () => {
  it('is the identity on macOS/Linux (same-path mounting)', () => {
    expect(hostToContainerPath('/Users/foo/proj', POSIX)).toBe('/Users/foo/proj');
    expect(hostToContainerPath('/home/foo/proj', POSIX)).toBe('/home/foo/proj');
  });

  it('maps a Windows drive path to the Docker Desktop convention', () => {
    expect(hostToContainerPath('C:\\Users\\foo\\proj', WIN)).toBe('/c/Users/foo/proj');
    expect(hostToContainerPath('D:\\work', WIN)).toBe('/d/work');
  });

  it('lowercases the drive letter and normalizes slashes', () => {
    expect(hostToContainerPath('C:/Users/foo', WIN)).toBe('/c/Users/foo');
    expect(hostToContainerPath('Z:\\a\\b\\c', WIN)).toBe('/z/a/b/c');
  });

  it('falls back to slash-normalization for non-drive paths', () => {
    expect(hostToContainerPath('\\\\server\\share\\f', WIN)).toBe('//server/share/f');
  });
});

describe('translateCommandPaths', () => {
  it('leaves commands untouched on macOS/Linux', () => {
    const cmd = 'cat /Users/foo/proj/file.txt';
    expect(translateCommandPaths(cmd, POSIX)).toBe(cmd);
  });

  it('rewrites a drive path whole (root + tail) in both slash forms', () => {
    expect(translateCommandPaths('cat C:\\Users\\foo\\proj\\a.txt', WIN)).toBe(
      'cat /c/Users/foo/proj/a.txt',
    );
    expect(translateCommandPaths('cat C:/Users/foo/proj/a.txt', WIN)).toBe(
      'cat /c/Users/foo/proj/a.txt',
    );
  });

  it('translates multiple paths in one command', () => {
    expect(translateCommandPaths('cp C:\\a\\x.txt D:\\b\\y.txt', WIN)).toBe(
      'cp /c/a/x.txt /d/b/y.txt',
    );
  });

  it('stops the path token at shell metacharacters', () => {
    expect(translateCommandPaths('cd C:\\proj && ls', WIN)).toBe('cd /c/proj && ls');
    expect(translateCommandPaths('cat C:\\a.txt|wc -l', WIN)).toBe('cat /c/a.txt|wc -l');
    expect(translateCommandPaths('(cd C:\\p; ls)', WIN)).toBe('(cd /c/p; ls)');
  });

  it('leaves a quoted path tail intact at the closing quote', () => {
    expect(translateCommandPaths('cat "C:\\a\\b.txt"', WIN)).toBe('cat "/c/a/b.txt"');
  });

  it('does not touch non-drive tokens', () => {
    expect(translateCommandPaths('echo 10:30', WIN)).toBe('echo 10:30');
    expect(translateCommandPaths('git log --oneline', WIN)).toBe('git log --oneline');
  });
});
