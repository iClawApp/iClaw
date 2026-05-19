import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findAvailablePort,
  isProcessAlive,
  lockFilePath,
  readLockFile,
  shouldAutoOpenBrowser,
  writeLockFile,
} from '../../src/startup';

describe('startup', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function useTmpDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'iclaw-startup-'));
    dirs.push(dir);
    process.env.DB_PATH = join(dir, 'iclaw.db');
    return dir;
  }

  it('shouldAutoOpenBrowser is opt-in via ICLAW_OPEN_BROWSER=1', () => {
    const prev = process.env.ICLAW_OPEN_BROWSER;
    const prevEnv = process.env.NODE_ENV;
    delete process.env.ICLAW_OPEN_BROWSER;
    process.env.NODE_ENV = 'development';
    expect(shouldAutoOpenBrowser()).toBe(false);
    process.env.ICLAW_OPEN_BROWSER = '1';
    expect(shouldAutoOpenBrowser()).toBe(true);
    if (prev === undefined) delete process.env.ICLAW_OPEN_BROWSER;
    else process.env.ICLAW_OPEN_BROWSER = prev;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  });

  it('isProcessAlive returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for a non-existent pid', () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it('writes and reads the lock file next to DB_PATH', () => {
    useTmpDb();
    writeLockFile({
      pid: 42,
      port: 3001,
      host: '127.0.0.1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(readLockFile()).toEqual({
      pid: 42,
      port: 3001,
      host: '127.0.0.1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(lockFilePath()).toBe(join(process.env.DB_PATH!, '..', 'iclaw.lock.json'));
    expect(fs.existsSync(lockFilePath())).toBe(true);
  });

  it('findAvailablePort skips a port that is already bound', async () => {
    const dir = useTmpDb();
    const busy = 39_000 + Math.floor(Math.random() * 1000);
    const holder = net.createServer();
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(busy, '127.0.0.1', () => resolve());
    });
    try {
      const free = await findAvailablePort(busy);
      expect(free).toBe(busy + 1);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
    expect(dir).toBeTruthy();
  });
});
