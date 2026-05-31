import { describe, expect, it } from 'vitest';
import { mcpServerBadge, mcpBadges, distinctMcpBadges } from '../../src/constants/mcpIcons';

describe('mcpServerBadge', () => {
  it('maps known brands to their simple-icon stem', () => {
    expect(mcpServerBadge({ name: 'notion' })).toEqual({ icon: 'notion', label: 'Notion' });
    expect(mcpServerBadge({ name: 'github' })).toEqual({ icon: 'github', label: 'GitHub' });
    expect(mcpServerBadge({ name: 'linear' })).toEqual({ icon: 'linear', label: 'Linear' });
  });

  it('falls back to the generic mcp mark for unknown servers (label = name)', () => {
    expect(mcpServerBadge({ name: 'memory' })).toEqual({ icon: 'mcp', label: 'Memory' });
    expect(mcpServerBadge({ name: 'acme-internal' })).toEqual({ icon: 'mcp', label: 'Acme-internal' });
  });

  it('matches a brand named in the description too', () => {
    expect(mcpServerBadge({ name: 'kb', description: 'Notion workspace' }).icon).toBe('notion');
  });
});

describe('mcpBadges', () => {
  it('returns [] for none', () => {
    expect(mcpBadges(undefined)).toEqual([]);
    expect(mcpBadges([])).toEqual([]);
  });

  it('dedupes by icon+label', () => {
    const b = mcpBadges([{ name: 'notion' }, { name: 'notion' }, { name: 'memory' }]);
    expect(b).toHaveLength(2);
    expect(b.map((x) => x.icon)).toEqual(['notion', 'mcp']);
  });
});

describe('distinctMcpBadges', () => {
  it('collects unique tool badges across roles, sorted by label', () => {
    const out = distinctMcpBadges([
      { mcpServers: [{ name: 'notion' }] },
      { mcpServers: [{ name: 'memory' }] },
      { mcpServers: [{ name: 'notion' }] }, // dup across roles
      {}, // role with no MCP
    ]);
    expect(out.map((b) => b.label)).toEqual(['Memory', 'Notion']);
  });

  it('returns [] when no role has MCP servers', () => {
    expect(distinctMcpBadges([{}, { mcpServers: [] }])).toEqual([]);
  });
});
