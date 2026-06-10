/**
 * Roles registry — the curated set of digital specialist workers.
 *
 * Curated, NOT a marketplace. Roles are added here deliberately, in waves (see
 * docs/roles-spec.md). The first role proven end-to-end is `content-strategist`;
 * the rest land as their integration is ready. Progressive disclosure (don't dump
 * all of them at once) is handled by `visibleRoles()`.
 */

import type { RoleManifest } from './types';
import { contentStrategist } from './content-strategist';

export type { RoleManifest, RoleTool, ToolScope, ConnectMethod } from './types';

/** Every role we ship, in build/disclosure order. */
export const ALL_ROLES: readonly RoleManifest[] = [contentStrategist];

const byId = new Map(ALL_ROLES.map((r) => [r.id, r]));

/** Look up a role manifest by id, or undefined. */
export function getRole(id: string): RoleManifest | undefined {
  return byId.get(id);
}

/**
 * Roles to surface for a user right now (progressive disclosure).
 *
 * We never show everything at once. `maturity` is a coarse signal (e.g. how many
 * chats / how many roles already run) the caller derives; higher unlocks later
 * waves. For now everything is wave 1, so this returns the wave-1 set — but the
 * gate is in place so adding waves 2+ doesn't dump them on a brand-new user.
 */
export function visibleRoles(maturity = 0): RoleManifest[] {
  const maxWave = maturity >= 3 ? 99 : 1; // refine the curve as more roles land
  return ALL_ROLES.filter((r) => r.wave <= maxWave);
}
