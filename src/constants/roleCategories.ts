/** Fixed categories for the Roles gallery create form. */
export const ROLE_CATEGORIES = [
  'Marketing',
  'Sales',
  'Productivity',
  'Finance',
  'Operations',
  'Other',
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export function mergeRoleCategories(existing: string[]): string[] {
  const set = new Set<string>(ROLE_CATEGORIES);
  for (const c of existing) {
    const t = c.trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'en'));
}

export function isRoleCategory(value: string): value is RoleCategory {
  return (ROLE_CATEGORIES as readonly string[]).includes(value);
}
