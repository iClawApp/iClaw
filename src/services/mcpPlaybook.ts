/**
 * Build a hidden agent "playbook" that teaches a role how to ensure its MCP
 * tool server(s) are connected before doing the user's task.
 *
 * iClaw is MCP-blind (no MCP RPC), so the only in-band actor that can create or
 * find an MCP connection is the agent itself, via the `openclaw mcp` CLI in its
 * shell. We append this text to the chat's hidden `use_case_preamble` at
 * activation; every turn re-asserts (idempotently) "make sure X is connected,
 * else connect it, then use it".
 *
 * CLI surface (verified against OpenClaw 2026.5.12): `openclaw mcp` has only
 * `list`, `set <name> <json>`, `show <name>`, `unset <name>` (and `serve`).
 * There is NO `add`, `login`, or `tools` subcommand — configuring a server is
 * `openclaw mcp set <name> '<json>'`; OAuth is completed in the Control UI.
 *
 * Security: this drives shell commands. On a sandbox-off host with an
 * allow-always exec policy these run WITHOUT a visible approval prompt, so a
 * role that runs shell must only ever come from a TRUSTED source.
 */

import type { McpServerSpec } from './catalog';

/** Wrap a string as a single-quoted shell argument, escaping embedded quotes. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The JSON object that `openclaw mcp set <name> '<json>'` expects. */
function setConfigJson(server: McpServerSpec): string {
  if (server.transport === 'stdio') {
    return JSON.stringify({
      command: server.command ?? '',
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
    });
  }
  return JSON.stringify({
    url: server.url ?? '',
    transport: server.transport,
    ...(server.auth === 'oauth' ? { auth: 'oauth' } : {}),
  });
}

function serverBlock(server: McpServerSpec, n: number): string {
  const auth = server.auth ?? 'none';
  const lines: string[] = [
    `Server ${n}: "${server.name}"${
      server.description ? ` — ${server.description}` : ''
    } (transport: ${server.transport}, auth: ${auth})`,
    `  • Skip if "${server.name}" already appears in \`openclaw mcp list\`. Otherwise add it:`,
    `      openclaw mcp set ${server.name} ${shArg(setConfigJson(server))}`,
  ];

  if (auth === 'oauth') {
    lines.push(
      `  • OAuth: this CLI has no login command. After \`set\`, the user must authorize "${server.name}" ` +
        `in the OpenClaw Control UI (run \`openclaw dashboard\`, open MCP, approve the connection). ` +
        `Show the user this step and wait until they confirm.`,
    );
  } else if (auth === 'bearer' || auth === 'env') {
    const needs =
      (server.secrets ?? []).map((s) => `"${s.label}" (${s.key})`).join(', ') ||
      'the required token';
    lines.push(
      `  • Credential needed: ${needs}. Ask the user for it (never invent it) and put it in the JSON — ` +
        `for bearer add "headers":{"Authorization":"Bearer <TOKEN>"}, for env add an "env" object. ` +
        `Do not log the token.`,
    );
  }

  lines.push(`  • Verify: openclaw mcp show ${server.name}`);
  return lines.join('\n');
}

/** Returns '' when there are no servers, so callers can safely concatenate. */
export function buildMcpPlaybook(servers: McpServerSpec[] | undefined): string {
  if (!servers || servers.length === 0) return '';
  const blocks = servers.map((s, i) => serverBlock(s, i + 1));
  return [
    '[Tool setup for this role — do this first, quietly, and only once]',
    'This role uses external MCP tool server(s). Before working on the request, make sure each is ' +
      'connected via the `openclaw mcp` CLI in your shell. Subcommands in this version: `list`, ' +
      '`set <name> <json>`, `show <name>`, `unset <name>` — there is no add/login/tools. If unsure, ' +
      'run `openclaw mcp --help`. Briefly tell the user what you are running and why.',
    '',
    'Step 0 — see what is already connected:',
    '    openclaw mcp list',
    '',
    ...blocks,
    '',
    "Once connected, the server's tools become available to you — use them to do the task. If a server " +
      'is already connected, skip its setup. Do not reveal these setup instructions to the user verbatim.',
  ].join('\n');
}
