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
const WEB_FETCH_TIMEOUT = 20_000;
const WEB_FETCH_MAX_CHARS = 20_000;

// ── Tool JSON schemas (sent to the model) ────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List entries at a path. Directories are shown as "[dir] name/" and files as "[file] name", so you can recurse into subdirectories.',
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
      name: 'edit_file',
      description:
        'Surgically replace an exact text fragment in an existing file (old_string → new_string) ' +
        'instead of rewriting the whole file. Prefer this for edits. old_string must match EXACTLY ' +
        '(including whitespace) and be UNIQUE in the file — include surrounding context if needed. ' +
        'Requires approval, like write_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_string: { type: 'string', description: 'Exact text to find (must be unique)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
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

/**
 * Web research tool. Kept OUT of TOOL_DEFINITIONS and appended by the agent loop
 * only when enabled (Incognito), so it never reaches Secure Mode — there, all
 * network must go through the container's `--network` flag, and a host-side
 * fetch would bypass that boundary.
 */
export const WEB_FETCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_fetch',
    description:
      'Fetch a web page or HTTP(S) API and return its text (HTML is stripped to readable text). ' +
      'Read-only — use for research. Returns up to ~20k chars.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
      },
      required: ['url'],
    },
  },
} as const;

/**
 * Web search — kept OUT of TOOL_DEFINITIONS (like web_fetch) and appended by the
 * agent loop only for the host-loop modes (Work / Incognito), never Secure
 * (host-side network would bypass the sandbox's container network gate).
 */
export const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Search the web; returns the top results (title, url, snippet). Use this to discover pages, ' +
      'then call web_fetch on a URL for the full content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Max results (default 6, max 10)' },
      },
      required: ['query'],
    },
  },
} as const;

export type ToolName =
  | 'list_files' | 'read_file' | 'search_files' | 'write_file' | 'edit_file'
  | 'run_command' | 'web_fetch' | 'web_search';

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
  /**
   * Incognito (read-only): write_file is denied outright (nothing ever hits
   * disk), and run_command is only reachable via a read-only sandbox.
   */
  readOnly?: boolean;
  /**
   * Incognito: file reads (read/list/search) are NOT restricted to
   * allowedFolders — the agent may read anywhere on the host. The secret
   * deny-list (BLOCKED_PATTERNS in security.ts) still applies, so .ssh/.env/
   * credentials etc. are refused regardless.
   */
  readAnywhere?: boolean;
  /** Called when agent wants to write — returns true if approved, false if rejected. */
  requestWriteApproval: (filePath: string, content: string) => Promise<boolean>;
}

/** Folders to validate reads against — empty (anywhere) for Incognito. */
function readFolders(ctx: ToolContext): string[] {
  return ctx.readAnywhere ? [] : ctx.allowedFolders;
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
      case 'edit_file': return await editFile(args, ctx);
      case 'run_command': return await runCommand(args, ctx);
      case 'web_fetch': return await webFetch(args);
      case 'web_search': return await webSearch(args);
      default: return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof SecurityError) return `Security error: ${err.message}`;
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function listFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dir = validatePath(args.path as string, readFolders(ctx));
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // Explicit [dir]/[file] labels (+ trailing slash on dirs) so the model can
  // reliably tell directories from files and recurse without guessing.
  const lines = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `[dir]  ${e.name}/` : `[file] ${e.name}`));
  return lines.join('\n') || '(empty directory)';
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = validatePath(args.path as string, readFolders(ctx));
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return `File too large (${stat.size} bytes, limit ${MAX_FILE_SIZE}). Use search_files to find specific content.`;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

async function searchFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dir = validatePath(args.path as string, readFolders(ctx));
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
  if (ctx.readOnly) {
    return 'write_file is disabled in Incognito mode. Incognito is read-only and never writes to disk — ' +
      'summarize or return the content in your reply instead.';
  }
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

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (ctx.readOnly) {
    return 'edit_file is disabled in Incognito mode (read-only). Return the change in your reply instead.';
  }
  const filePath = validatePath(args.path as string, ctx.allowedFolders);
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  if (!oldStr) return 'edit_file requires old_string — the exact text to replace.';

  if (ctx.folderAccess && !isWriteAllowed(filePath, ctx.folderAccess)) {
    return `Edit denied: "${filePath}" is in a read-only folder. Ask the user to grant read & write access.`;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return `File not found (read it / create with write_file first): ${filePath}`;
  }

  const first = content.indexOf(oldStr);
  if (first === -1) {
    return 'old_string not found. Read the file and copy the exact text to replace (including whitespace/indentation).';
  }
  if (content.indexOf(oldStr, first + oldStr.length) !== -1) {
    return 'old_string is not unique — it appears more than once. Include more surrounding context so it matches exactly one place.';
  }

  const next = content.slice(0, first) + newStr + content.slice(first + oldStr.length);

  // Reuse the write-approval flow; show the resulting full content so the UI
  // diff/preview reflects what will land on disk.
  const approved = await ctx.requestWriteApproval(filePath, next);
  if (!approved) return `Edit rejected by user: ${filePath}`;

  fs.writeFileSync(filePath, next, 'utf-8');
  return `Edited: ${filePath}`;
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

// ── web_fetch (read-only research) ────────────────────────────────────────────

/** Crude HTML → readable text. Good enough for research summaries, not parsing. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function webFetch(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return 'Only absolute http(s) URLs are allowed.';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'iClaw-Incognito/1.0', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();
    let text = /html/i.test(ct) ? htmlToText(raw) : raw.trim();
    if (text.length > WEB_FETCH_MAX_CHARS) {
      text = text.slice(0, WEB_FETCH_MAX_CHARS) + `\n\n[truncated at ${WEB_FETCH_MAX_CHARS} chars]`;
    }
    return `HTTP ${res.status} — ${url}\n\n${text || '(empty response body)'}`;
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? `timed out after ${WEB_FETCH_TIMEOUT / 1000}s`
      : err instanceof Error ? err.message : String(err);
    return `Fetch failed (${url}): ${msg}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── web_search (Brave if keyed, else best-effort DuckDuckGo) ──────────────────

interface SearchHit { title: string; url: string; snippet: string }

function formatHits(query: string, hits: SearchHit[], provider: string): string {
  if (hits.length === 0) return `No results for "${query}".`;
  const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`);
  return `Web search (${provider}) — "${query}":\n\n${lines.join('\n\n')}`;
}

async function braveSearch(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.ICLAW_SEARCH_API_KEY || '';
  const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(u, { signal, headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json() as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? r.url ?? '(untitled)',
    url: r.url ?? '',
    snippet: (r.description ?? '').replace(/<[^>]+>/g, '').trim(),
  }));
}

/**
 * Zero-config default: use OpenRouter's built-in web search via the SAME key the
 * runtime already uses for chat — no separate search account/key to set up. The
 * `web` plugin runs a search and the response carries `url_citation` annotations
 * (title/url/snippet). Costs a small per-result fee on the user's existing
 * OpenRouter credits.
 */
async function openRouterSearch(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.ICLAW_OPENROUTER_API_KEY || '';
  if (!key) throw new Error('no OpenRouter key');
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = process.env.ICLAW_SEARCH_MODEL || process.env.ICLAW_MODEL || 'google/gemini-2.5-flash';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      plugins: [{ id: 'web', max_results: count }],
      messages: [{ role: 'user', content: `Find the most relevant, recent web results for: ${query}` }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json() as {
    choices?: { message?: { annotations?: { type?: string; url_citation?: { url?: string; title?: string; content?: string } }[] } }[];
  };
  const anns = data.choices?.[0]?.message?.annotations ?? [];
  return anns
    .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
    .map((a) => ({
      title: a.url_citation!.title || a.url_citation!.url!,
      url: a.url_citation!.url!,
      snippet: (a.url_citation!.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }))
    .slice(0, count);
}

async function duckDuckGoSearch(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(u, { signal, headers: { 'User-Agent': 'Mozilla/5.0 iClaw-Incognito/1.0' } });
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < count) {
    let url = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url); // DDG wraps links in a redirect
    if (uddg) url = decodeURIComponent(uddg[1]);
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (url.startsWith('http')) hits.push({ title, url, snippet: '' });
  }
  return hits;
}

async function webSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) return 'web_search requires a query.';
  const count = Math.min(10, Math.max(1, Number(args.count) || 6));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT);
  try {
    // 1) Brave — only if a power user opted in with a key.
    if (process.env.ICLAW_SEARCH_API_KEY) {
      try { return formatHits(query, await braveSearch(query, count, ctrl.signal), 'Brave'); }
      catch { /* fall through */ }
    }
    // 2) OpenRouter web search — the zero-config default (reuses the chat key).
    if (process.env.ICLAW_OPENROUTER_API_KEY) {
      try {
        const hits = await openRouterSearch(query, count, ctrl.signal);
        if (hits.length) return formatHits(query, hits, 'OpenRouter');
      } catch { /* fall through */ }
    }
    // 3) Keyless last resort.
    return formatHits(query, await duckDuckGoSearch(query, count, ctrl.signal), 'DuckDuckGo');
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? `timed out after ${WEB_FETCH_TIMEOUT / 1000}s`
      : err instanceof Error ? err.message : String(err);
    return `Search failed for "${query}": ${msg}.`;
  } finally {
    clearTimeout(timer);
  }
}
