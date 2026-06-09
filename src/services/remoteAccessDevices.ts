/**
 * Persistent trusted devices for Remote Access (per tunnel).
 */

import { randomBytes } from 'node:crypto';
import { db } from '../db/database';

export interface RemoteAccessDevice {
  id: string;
  tunnelId: string;
  name: string | null;
  userAgent: string | null;
  publicKey: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

interface Row {
  id: string;
  tunnel_id: string;
  name: string | null;
  user_agent: string | null;
  public_key: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

const LIST_BY_TUNNEL = db.prepare<[string], Row>(
  `SELECT * FROM remote_access_devices
    WHERE tunnel_id = ?
    ORDER BY last_seen_at DESC`,
);
const GET = db.prepare<[string, string], Row>(
  `SELECT * FROM remote_access_devices WHERE id = ? AND tunnel_id = ?`,
);
const GET_ACTIVE = db.prepare<[string, string], Row>(
  `SELECT * FROM remote_access_devices
    WHERE id = ? AND tunnel_id = ? AND revoked_at IS NULL`,
);
const INSERT = db.prepare(`
  INSERT INTO remote_access_devices
    (id, tunnel_id, name, user_agent, public_key, created_at, last_seen_at, revoked_at)
  VALUES
    (@id, @tunnel_id, @name, @user_agent, @public_key, @created_at, @last_seen_at, NULL)
`);
const TOUCH_SEEN = db.prepare(
  'UPDATE remote_access_devices SET last_seen_at = ? WHERE id = ? AND tunnel_id = ?',
);
const REVOKE = db.prepare(
  'UPDATE remote_access_devices SET revoked_at = ? WHERE id = ? AND tunnel_id = ? AND revoked_at IS NULL',
);
const DELETE_FOR_TUNNEL = db.prepare('DELETE FROM remote_access_devices WHERE tunnel_id = ?');

function rowToDevice(row: Row): RemoteAccessDevice {
  return {
    id: row.id,
    tunnelId: row.tunnel_id,
    name: row.name,
    userAgent: row.user_agent,
    publicKey: row.public_key,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export function generateDeviceId(): string {
  return `d-${randomBytes(8).toString('hex')}`;
}

export const remoteAccessDevices = {
  listByTunnel(tunnelId: string): RemoteAccessDevice[] {
    return LIST_BY_TUNNEL.all(tunnelId).map(rowToDevice);
  },

  listActiveByTunnel(tunnelId: string): RemoteAccessDevice[] {
    return remoteAccessDevices.listByTunnel(tunnelId).filter((d) => d.revokedAt == null);
  },

  get(tunnelId: string, deviceId: string): RemoteAccessDevice | null {
    const row = GET.get(deviceId, tunnelId);
    return row ? rowToDevice(row) : null;
  },

  getActive(tunnelId: string, deviceId: string): RemoteAccessDevice | null {
    const row = GET_ACTIVE.get(deviceId, tunnelId);
    return row ? rowToDevice(row) : null;
  },

  register(opts: {
    tunnelId: string;
    publicKey: string;
    name?: string | null | undefined;
    userAgent?: string | null | undefined;
  }): RemoteAccessDevice {
    const now = Date.now();
    const id = generateDeviceId();
    const name = opts.name?.trim().slice(0, 128) || null;
    const userAgent = opts.userAgent?.trim().slice(0, 512) || null;
    INSERT.run({
      id,
      tunnel_id: opts.tunnelId,
      name,
      user_agent: userAgent,
      public_key: opts.publicKey,
      created_at: now,
      last_seen_at: now,
    });
    return remoteAccessDevices.get(opts.tunnelId, id)!;
  },

  touchLastSeen(tunnelId: string, deviceId: string, at = Date.now()): void {
    TOUCH_SEEN.run(at, deviceId, tunnelId);
  },

  revoke(tunnelId: string, deviceId: string, at = Date.now()): boolean {
    const info = REVOKE.run(at, deviceId, tunnelId);
    return info.changes > 0;
  },

  deleteAllForTunnel(tunnelId: string): void {
    DELETE_FOR_TUNNEL.run(tunnelId);
  },
};
