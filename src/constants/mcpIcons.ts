/**
 * Brand-logo resolver for MCP servers shown on role cards — same idea as
 * openclaw-release-radar's `surfaces.ts`: map a name to a monochrome simple-icon
 * under public/icons/<stem>.svg, rendered as a CSS mask tinted with currentColor.
 * '_generic'/'mcp' are neutral fallbacks when we have no brand icon.
 */

export interface McpBadge {
  /** Filename stem under public/icons/<icon>.svg. */
  icon: string;
  /** Human label, e.g. "Notion". */
  label: string;
}

// Order matters — first match wins. Matched against `name + description`.
const KNOWN: { re: RegExp; icon: string; label: string }[] = [
  { re: /notion/i, icon: 'notion', label: 'Notion' },
  { re: /linear/i, icon: 'linear', label: 'Linear' },
  { re: /github/i, icon: 'github', label: 'GitHub' },
  { re: /(gdrive|google[-_ ]?drive|googledrive)/i, icon: 'googledrive', label: 'Google Drive' },
  { re: /(gmail|google[-_ ]?mail)/i, icon: 'gmail', label: 'Gmail' },
  { re: /slack/i, icon: 'slack', label: 'Slack' },
  { re: /discord/i, icon: 'discord', label: 'Discord' },
  { re: /telegram/i, icon: 'telegram', label: 'Telegram' },
];

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Resolve one MCP server to its display badge. */
export function mcpServerBadge(server: { name: string; description?: string }): McpBadge {
  const hay = `${server.name} ${server.description ?? ''}`;
  for (const k of KNOWN) if (k.re.test(hay)) return { icon: k.icon, label: k.label };
  // No brand match → neutral MCP mark, labelled by the server name.
  return { icon: 'mcp', label: capitalize(server.name) || 'MCP' };
}

/** Resolve a role's MCP servers to deduped badges (for gallery cards). */
export function mcpBadges(
  servers?: { name: string; description?: string }[] | null,
): McpBadge[] {
  if (!servers || servers.length === 0) return [];
  const seen = new Set<string>();
  const out: McpBadge[] = [];
  for (const s of servers) {
    const b = mcpServerBadge(s);
    const key = `${b.icon}|${b.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/** Distinct tool badges across all roles — powers the gallery's tool filter chips. */
export function distinctMcpBadges(
  templates: { mcpServers?: { name: string; description?: string }[] | null }[],
): McpBadge[] {
  const seen = new Set<string>();
  const out: McpBadge[] = [];
  for (const t of templates) {
    for (const b of mcpBadges(t.mcpServers)) {
      const key = `${b.icon}|${b.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'en'));
}
