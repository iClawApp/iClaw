import { describe, expect, it } from 'vitest';
import { buildMcpPlaybook } from '../../src/services/mcpPlaybook';
import type { McpServerSpec } from '../../src/services/catalog';

describe('buildMcpPlaybook', () => {
  it('returns empty string for no servers', () => {
    expect(buildMcpPlaybook(undefined)).toBe('');
    expect(buildMcpPlaybook([])).toBe('');
  });

  it('uses `openclaw mcp set` with JSON for an OAuth http server (Notion-style)', () => {
    const out = buildMcpPlaybook([
      {
        name: 'notion',
        transport: 'streamable-http',
        url: 'https://mcp.notion.com/mcp',
        auth: 'oauth',
        description: 'Notion workspace',
      },
    ]);
    expect(out).toContain('openclaw mcp list');
    expect(out).toContain(
      `openclaw mcp set notion '{"url":"https://mcp.notion.com/mcp","transport":"streamable-http","auth":"oauth"}'`,
    );
    // must NOT emit CLI verbs that don't exist in this OpenClaw version
    expect(out).not.toContain('openclaw mcp add');
    expect(out).not.toContain('openclaw mcp login');
    // OAuth is completed in the Control UI here
    expect(out.toLowerCase()).toContain('control ui');
  });

  it('uses `openclaw mcp set` with command/args JSON for a stdio server (memory-style)', () => {
    const out = buildMcpPlaybook([
      {
        name: 'memory',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        auth: 'none',
      },
    ]);
    expect(out).toContain(
      `openclaw mcp set memory '{"command":"npx","args":["-y","@modelcontextprotocol/server-memory"]}'`,
    );
    expect(out).not.toContain('openclaw mcp login');
    expect(out).not.toContain('Credential needed');
  });

  it('asks for a credential on bearer/env auth without inventing it', () => {
    const out = buildMcpPlaybook([
      {
        name: 'linear',
        transport: 'streamable-http',
        url: 'https://mcp.linear.app/mcp',
        auth: 'bearer',
        secrets: [{ key: 'LINEAR_TOKEN', label: 'Linear API token' }],
      },
    ]);
    expect(out).toContain('Linear API token');
    expect(out).toContain('LINEAR_TOKEN');
    expect(out).toContain('Ask the user');
    expect(out).toContain('Authorization');
  });

  it('numbers multiple servers', () => {
    const out = buildMcpPlaybook([
      { name: 'a', transport: 'stdio', command: 'node' },
      { name: 'b', transport: 'sse', url: 'https://x.example/sse' },
    ]);
    expect(out).toContain('Server 1: "a"');
    expect(out).toContain('Server 2: "b"');
  });
});
