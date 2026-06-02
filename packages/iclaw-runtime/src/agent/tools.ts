/**
 * Tool definitions (JSON schema for the model) + implementations.
 * All file operations are validated against allowedFolders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validatePath, isWriteAllowed, SecurityError } from './security.js';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 1_000_000; // 1 MB read limit
const COMMAND_TIMEOUT = 30_000;

// ── Tool JSON schemas (sent to the model) ────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List files and directories at a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for a string or pattern in files recursively.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search in' },
          query: { type: 'string', description: 'String to search for' },
          filePattern: { type: 'string', description: 'Optional glob pattern, e.g. "*.ts"' },
        },
        required: ['path', 'query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file. Requires user approval in Work Mode.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Run a shell command inside an allowed folder.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
          cwd: { type: 'string', description: 'Working directory (must be in allowed folders)' },
        },
        required: ['command', 'cwd'],
      },
    },
  },
] as const;

export type ToolName = 'list_files' | 'read_file' | 'search_files' | 'write_file' | 'run_command';

// ── Tool context (injected per-session) ──────────────────────────────────────

export interface ToolContext {
  allowedFolders: string[];
  /**
   * Per-folder access levels (path + readonly flag). When provided, write_file
   * is denied for paths under a read-only folder. When omitted (e.g. restored
   * sessions) all allowed folders are treated as writable.
   */
  folderAccess?: { path: string; readonly: boolean }[];
  /**
   * Runs a shell command for run_command. Injected so the host never executes
   * bash directly: Work Mode wires this to a Docker container with per-folder
   * :ro/:rw mounts (the kernel enforces read-only). When omitted (no Docker),
   * run_command is disabled and returns a guidance message — the strict
   * fallback that keeps read-only an honest guarantee.
   */
  runShell?: (command: string, cwd: string) => Promise<string>;
  /** Called when agent wants to write — returns true if approved, false if rejected. */
  requestWriteApproval: (filePath: string, content: string) => Promise<boolean>;
}

// ── Tool implementations ──────────────────────────────────────────────────────

export async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'list_files': return await listFiles(args, ctx);
      case 'read_file': return await readFile(args, ctx);
      case 'search_files': return await searchFiles(args, ctx);
      case 'write_file': return await writeFile(args, ctx);
      case 'run_command': return await runCommand(args, ctx);
      default: return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof SecurityError) return `Security error: ${err.message}`;
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function listFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dir = validatePath(args.path as string, ctx.allowedFolders);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
  return lines.join('\n') || '(empty)';
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = validatePath(args.path as string, ctx.allowedFolders);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return `File too large (${stat.size} bytes, limit ${MAX_FILE_SIZE}). Use search_files to find specific content.`;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

async function searchFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dir = validatePath(args.path as string, ctx.allowedFolders);
  const query = args.query as string;
  const pattern = (args.filePattern as string | undefined) ?? '';

  const grepArgs = ['-r', '--include', pattern || '*', '-l', '-m', '1', query, dir];
  try {
    const { stdout } = await execFileAsync('grep', grepArgs, { timeout: COMMAND_TIMEOUT });
    const files = stdout.trim().split('\n').filter(Boolean).slice(0, 20);
    if (files.length === 0) return 'No matches found.';

    // Show context lines for first 5 matches
    const results: string[] = [];
    for (const file of files.slice(0, 5)) {
      const { stdout: ctx2 } = await execFileAsync('grep', ['-n', query, file], { timeout: 5000 }).catch(() => ({ stdout: '' }));
      results.push(`${file}:\n${ctx2.trim()}`);
    }
    if (files.length > 5) results.push(`...and ${files.length - 5} more files`);
    return results.join('\n\n');
  } catch {
    return 'No matches found.';
  }
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = validatePath(args.path as string, ctx.allowedFolders);
  const content = args.content as string;

  if (ctx.folderAccess && !isWriteAllowed(filePath, ctx.folderAccess)) {
    return `Write denied: "${filePath}" is in a read-only folder. Ask the user to grant read & write access to this folder.`;
  }

  const approved = await ctx.requestWriteApproval(filePath, content);
  if (!approved) return `Write rejected by user: ${filePath}`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return `Written: ${filePath}`;
}

async function runCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  // Validate cwd is inside an allowed folder up front (clear error before we
  // hand off to the sandbox, and the container only mounts allowed folders).
  const cwd = validatePath(args.cwd as string, ctx.allowedFolders);
  const command = args.command as string;

  // No sandbox available → run_command is disabled. We never fall back to host
  // bash, because that can't enforce per-folder read-only. File tools still
  // work (write_file is path-checked on the host).
  if (!ctx.runShell) {
    return 'run_command is unavailable. Shell commands run in a Docker sandbox, which needs both ' +
      '(1) Docker installed and running, and (2) at least one folder explicitly selected for this chat. ' +
      'Ask the user to start Docker and/or add a folder. Meanwhile read_file / search_files / write_file still work.';
  }

  // The sandbox mounts read-only folders as :ro, so the kernel — not us —
  // rejects any write outside the read & write folders. Commands may freely
  // read from read-only folders.
  return ctx.runShell(command, cwd);
}
