/**
 * Secure Mode runner.
 *
 * Agent loop runs on the HOST (can reach OpenRouter).
 * Tool execution happens INSIDE a Docker container (isolated).
 *
 * Per-turn container lifecycle:
 *   start container → execute turn → stop container → (keep workspace dir)
 * Next turn: start NEW container with SAME workspace volume.
 * This allows changing network settings per message while preserving files.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type { AgentEvent, AgentOptions, Message } from './agent/loop.js';

const execFileAsync = promisify(execFile);

// Secure sandbox image: Chromium + agent-browser baked in (build-secure.sh).
// Falls back to node:22-slim if the image isn't built yet — file/command tools
// still work, only browsing is unavailable.
const CONTAINER_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'iclaw-secure:latest';
const CONTAINER_TIMEOUT = 30_000;
const BROWSE_TIMEOUT = 45_000;

export type SecureEvent = AgentEvent;

const SECURE_PREFIX = 'iclaw-secure-';

// Persistent root for Secure workspaces. NOT tmpdir(): macOS prunes /var/folders
// after a few idle days, which is shorter than our 7-day TTL. A stable dir means
// workspaces (and their TTL) genuinely survive runtime restarts.
const SECURE_DATA_DIR = process.env.ICLAW_SECURE_DATA_DIR || join(homedir(), '.iclaw', 'secure');

/** Metadata persisted alongside a workspace so sessions survive restarts. */
export interface SessionMeta {
  key?: string;          // stable identity (e.g. "chat:156") for reconnection
  lastActivity: number;  // ms; TTL counts from here
  ttlMs: number;         // 0 = never
  secure: boolean;
  model?: string;
}

function metaPathFor(workspaceDir: string): string {
  return `${workspaceDir}.meta.json`;
}

/**
 * Create a persistent workspace directory. Lives under SECURE_DATA_DIR so it
 * survives restarts (reaped only by TTL).
 */
export function createSecureWorkspace(): string {
  mkdirSync(SECURE_DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(SECURE_DATA_DIR, `${SECURE_PREFIX}`));
  // The sandbox runs as the non-root `node` user; make the bind-mounted dir
  // writable to it (mkdtemp defaults to 0700 owned by the host user).
  try { chmodSync(dir, 0o777); } catch {}
  return dir;
}

/** Destroy a workspace directory and its metadata sidecar. */
export function destroySecureWorkspace(workspaceDir: string): void {
  try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
  try { rmSync(metaPathFor(workspaceDir), { force: true }); } catch {}
}

/** Persist session metadata next to (not inside) the workspace. */
export function writeSessionMeta(workspaceDir: string, meta: SessionMeta): void {
  try { writeFileSync(metaPathFor(workspaceDir), JSON.stringify(meta), 'utf-8'); } catch {}
}

/** List every persisted workspace dir with its metadata (for startup reload). */
export function listPersistedWorkspaces(): { dir: string; meta: SessionMeta | null }[] {
  const out: { dir: string; meta: SessionMeta | null }[] = [];
  let entries;
  try { entries = readdirSync(SECURE_DATA_DIR, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SECURE_PREFIX)) continue;
    const dir = join(SECURE_DATA_DIR, entry.name);
    let meta: SessionMeta | null = null;
    try { meta = JSON.parse(readFileSync(metaPathFor(dir), 'utf-8')) as SessionMeta; } catch {}
    out.push({ dir, meta });
  }
  return out;
}

/**
 * Kill containers left running by a previous runtime process. Containers are
 * pure runtime (no data), so this is always safe — unlike workspace dirs, which
 * carry the user's files and are reaped only by TTL (see sessions.ts reload).
 */
export async function killOrphanContainers(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'docker', ['ps', '-aq', '--filter', `name=${SECURE_PREFIX}`],
      { timeout: 10_000 },
    );
    const ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return 0;
    await execFileAsync('docker', ['rm', '-f', ...ids], { timeout: 30_000 }).catch(() => {});
    return ids.length;
  } catch {
    return 0; // Docker not installed/running — nothing to clean.
  }
}

/**
 * Start a container with the given workspace. Returns containerName.
 * Fail-closed: if Docker can't start the sandbox we throw, so the caller
 * aborts the turn instead of silently running file ops outside isolation.
 *
 * The container is long-lived (`sleep`) and reused across turns by the session
 * manager — see sessions.ts. It is recreated only when the network setting
 * changes or after an idle period.
 */
export async function startContainer(workspaceDir: string, networkEnabled: boolean): Promise<string> {
  const containerName = `iclaw-secure-${randomUUID().slice(0, 8)}`;

  const networkArgs = networkEnabled ? [] : ['--network', 'none'];

  try {
    // `-d` returns once the container is up (and pulls the image on first run),
    // so we await the real result instead of guessing with a fixed sleep.
    await execFileAsync('docker', [
      'run', '--rm', '-d',
      '--name', containerName,
      ...networkArgs,
      // Chromium needs headroom and a larger /dev/shm than the 64MB default,
      // or it crashes on launch. Bumped from 512m now that the image ships a
      // browser. Tunable via env for smaller/larger hosts.
      '--memory', process.env.ICLAW_SECURE_MEMORY || '1g',
      '--shm-size', process.env.ICLAW_SECURE_SHM || '256m',
      '--cpus', process.env.ICLAW_SECURE_CPUS || '1',
      '-v', `${workspaceDir}:/workspace:rw`,
      '--workdir', '/workspace',
      CONTAINER_IMAGE,
      'sleep', '86400',
    ], { timeout: 60_000 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `Secure sandbox failed to start — is Docker running? ${(e.stderr || e.message || '').slice(0, 200)}`,
    );
  }
  return containerName;
}

/** Stop a container (workspace is preserved on host). */
export function stopContainer(containerName: string): void {
  try { execFile('docker', ['rm', '-f', containerName], () => {}); } catch {}
}

/** True if a container with this name is up. Used for warm-reuse liveness. */
export async function isContainerRunning(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'docker', ['inspect', '-f', '{{.State.Running}}', containerName],
      { timeout: 5_000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Execute a command inside the sandbox container. */
async function execInContainer(containerName: string, command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker', ['exec', containerName, 'bash', '-c', command],
      { timeout: CONTAINER_TIMEOUT },
    );
    return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim() || 'Error';
  }
}

function readFromWorkspace(workspaceDir: string, filePath: string): string {
  const safe = basename(filePath);
  const full = join(workspaceDir, safe);
  if (!existsSync(full)) return `File not found: ${safe}`;
  return readFileSync(full, 'utf-8');
}

function writeToWorkspace(workspaceDir: string, filePath: string, content: string): string {
  const safe = basename(filePath);
  const full = join(workspaceDir, safe);
  writeFileSync(full, content, 'utf-8');
  return `Written: /workspace/${safe}`;
}

/**
 * Run one turn in Secure Mode.
 *
 * The container is owned and reused by the session manager (warm reuse): it is
 * passed in here, and NOT torn down at the end of the turn. Lifecycle (create
 * on network change, reap on idle) lives in sessions.ts.
 */
export async function* runSecureTurn(
  history: { role: string; content: string }[],
  userMessage: string,
  opts: {
    apiKey: string;
    model: string;
    workspaceDir: string;
    containerName: string;
    networkEnabled?: boolean;
    systemPrompt?: string;
  },
): AsyncGenerator<SecureEvent> {
  const networkEnabled = opts.networkEnabled ?? false;

  const gen = runSecureAgentLoop(
    history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    userMessage,
    {
      apiKey: opts.apiKey,
      model: opts.model,
      allowedFolders: [opts.workspaceDir],
      systemPrompt: opts.systemPrompt ??
        `You are running in a secure isolated sandbox.
You can run commands and read/write files in /workspace only.
Network is ${networkEnabled ? 'enabled' : 'disabled'}.${
          networkEnabled
            ? '\nFor raw HTTP / JSON APIs, use run_command with `curl -s <url>` — do NOT use the browser. ' +
              'Use the `browse` tool to read rendered HTML pages. For interactive browsing ' +
              '(click, fill, screenshot) run the `agent-browser` CLI via run_command, e.g. ' +
              '`agent-browser open <url>` then `agent-browser snapshot -i`.'
            : ''
        }
Be concise.`,
      onWriteApproval: async () => true,
    },
    opts.containerName,
    opts.workspaceDir,
    networkEnabled,
  );

  for await (const event of gen) {
    yield event;
  }
}

async function* runSecureAgentLoop(
  history: Message[],
  userMessage: string,
  opts: AgentOptions,
  containerName: string,
  workspaceDir: string,
  networkEnabled: boolean,
): AsyncGenerator<SecureEvent> {
  const OpenAI = (await import('openai')).default;
  const { TOOL_DEFINITIONS } = await import('./agent/tools.js');

  // `browse` is only offered when network is on. Even if a model tried to call
  // it otherwise, the dedicated browser container is the real boundary.
  const tools = networkEnabled ? [...TOOL_DEFINITIONS, BROWSE_TOOL] : TOOL_DEFINITIONS;

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
  });

  const messages: Message[] = [
    { role: 'system', content: opts.systemPrompt ?? 'You are a helpful assistant in a secure sandbox.' },
    ...history,
    { role: 'user', content: userMessage },
  ];

  for (let round = 0; round < 20; round++) {
    let textBuffer = '';
    const toolCallBuffers: Record<string, { name: string; arguments: string }> = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stream: AsyncIterable<any>;
    try {
      stream = await client.chat.completions.create({
        model: opts.model,
        messages,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: tools as any,
        tool_choice: 'auto',
        stream: true,
      });
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }

    let finishReason: string | null = null;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta;
      if (delta.content) {
        textBuffer += delta.content;
        yield { type: 'text', content: delta.content };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = String(tc.index ?? 0);
          if (!toolCallBuffers[idx]) toolCallBuffers[idx] = { name: '', arguments: '' };
          if (tc.function?.name) toolCallBuffers[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments;
        }
      }
    }

    const toolCalls = Object.values(toolCallBuffers);
    if (toolCalls.length === 0 || finishReason === 'stop') {
      if (textBuffer) messages.push({ role: 'assistant', content: textBuffer });
      yield { type: 'done' };
      return;
    }

    messages.push({
      role: 'assistant',
      content: textBuffer || null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    } as Message);

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments); } catch {}

      yield { type: 'tool_start', name: tc.name, input: args };

      let result: string;
      if (tc.name === 'run_command') {
        result = await execInContainer(containerName, String(args.command ?? ''));
      } else if (tc.name === 'write_file') {
        result = writeToWorkspace(workspaceDir, String(args.path ?? 'file.txt'), String(args.content ?? ''));
      } else if (tc.name === 'read_file') {
        result = readFromWorkspace(workspaceDir, String(args.path ?? ''));
      } else if (tc.name === 'list_files') {
        result = await execInContainer(containerName, 'ls -la /workspace');
      } else if (tc.name === 'search_files') {
        result = await execInContainer(containerName, `grep -r ${JSON.stringify(String(args.query ?? ''))} /workspace 2>/dev/null | head -20`);
      } else if (tc.name === 'browse') {
        result = await browseInContainer(containerName, String(args.url ?? ''), networkEnabled);
      } else {
        result = `Tool not available in secure mode: ${tc.name}`;
      }

      yield { type: 'tool_result', name: tc.name, result };
      messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: result });
    }
  }

  yield { type: 'error', message: 'Agent loop exceeded maximum rounds' };
}

// ── Browser tool (network-gated, isolated) ──────────────────────────────────

/** Schema appended to the secure tool list only when network is enabled. */
const BROWSE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'browse',
    description:
      'Open a web page and return its visible content. Available only when network access is enabled. ' +
      'For interactive browsing (click, fill, screenshot) use run_command with the `agent-browser` CLI.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open' },
      },
      required: ['url'],
    },
  },
} as const;

/** Shell-safe single-quote wrap (URL is pre-validated to exclude quotes). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Open a URL with the `agent-browser` CLI *inside* the per-turn sandbox
 * container and return the page's accessibility snapshot (text).
 *
 * Safety is systemic, not prompt-based:
 *  - only offered when the user's network toggle is on (re-checked here);
 *  - the browser runs in the same isolated container as the rest of the turn,
 *    so when network is off it has `--network none` and physically can't reach
 *    anything — no allowlist or prompt rule is doing the enforcing;
 *  - hard exec timeout; container is torn down at end of turn.
 */
async function browseInContainer(containerName: string, url: string, networkEnabled: boolean): Promise<string> {
  if (!networkEnabled) return 'Network is disabled — enable network access to browse.';
  if (!/^https?:\/\/[^\s'"]+$/i.test(url)) return 'Only absolute http(s) URLs are allowed.';

  try {
    // Use `bash -c` (NOT `-lc`): a login shell re-sources /etc/profile and drops
    // /pnpm from PATH, which is where agent-browser is installed. `docker exec`
    // already inherits the image's ENV PATH (incl. /pnpm).
    const cmd = `agent-browser open ${shQuote(url)} >/dev/null 2>&1 && agent-browser snapshot -c 2>/dev/null | head -c 8000`;
    const { stdout, stderr } = await execFileAsync(
      'docker', ['exec', containerName, 'bash', '-c', cmd],
      { timeout: BROWSE_TIMEOUT, maxBuffer: 8_000_000 },
    );
    const out = (stdout || stderr).trim();
    return out || '(page returned no readable content)';
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = (e.stderr || e.message || 'error').slice(0, 300);
    return `Browse failed (is the "${CONTAINER_IMAGE}" image built with agent-browser?): ${detail}`;
  }
}
