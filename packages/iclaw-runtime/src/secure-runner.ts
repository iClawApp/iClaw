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

import type OpenAI from 'openai';
import type { AgentEvent, AgentOptions, Message } from './agent/loop.js';
import type { SavingsNote } from './agent/tools.js';
import { shrinkOldToolOutputs, withPromptCaching, makeToolGuard, HOST_INSTALL_POLICY } from './agent/loop.js';
import { INSTALL_LABEL } from './install-id.js';
import { dumpPrompt, newTurnId } from './agent/prompt-dump.js';

const execFileAsync = promisify(execFile);

// Slim secure sandbox image: a small CLI toolset, no browser (build-secure.sh).
// The agent reaches the web via `curl` and can self-install more tools into
// /workspace/.tools (no root).
const CONTAINER_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'iclaw-secure:latest';
const CONTAINER_TIMEOUT = 30_000;
/** Max tool-call rounds per turn (env-tunable for long multi-step tasks). */
const MAX_ROUNDS = Math.max(1, Number(process.env.ICLAW_MAX_ROUNDS) || 40);

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
  // Pre-create the runtime tool dirs the container puts on PATH (.tools/bin for
  // downloaded static binaries, .tools/npm for `npm i -g`). They live inside the
  // workspace, so self-installed tools persist across container restarts and are
  // auto-deleted with the workspace when its TTL expires. World-writable so the
  // non-root container user can install into them.
  for (const sub of ['.tools', '.tools/bin', '.tools/npm']) {
    const p = join(dir, sub);
    try { mkdirSync(p, { recursive: true }); chmodSync(p, 0o777); } catch {}
  }
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
    // Scope to THIS install's Secure containers (name AND install label) so a
    // second iClaw install can't reap ours.
    const { stdout } = await execFileAsync(
      'docker', ['ps', '-aq', '--filter', `name=${SECURE_PREFIX}`, '--filter', `label=${INSTALL_LABEL}`],
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
      '--label', INSTALL_LABEL,
      ...networkArgs,
      // No browser any more, so the default 64MB /dev/shm is fine and 512MB is
      // plenty of headroom for shell/node tasks. Tunable via env.
      '--memory', process.env.ICLAW_SECURE_MEMORY || '512m',
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

function editInWorkspace(workspaceDir: string, filePath: string, oldStr: string, newStr: string): string {
  if (!oldStr) return 'edit_file requires old_string — the exact text to replace.';
  const safe = basename(filePath);
  const full = join(workspaceDir, safe);
  if (!existsSync(full)) return `File not found: ${safe}`;
  const content = readFileSync(full, 'utf-8');
  const first = content.indexOf(oldStr);
  if (first === -1) return 'old_string not found — copy the exact text (including whitespace) from the file.';
  if (content.indexOf(oldStr, first + oldStr.length) !== -1) {
    return 'old_string is not unique — add more surrounding context so it matches one place.';
  }
  writeFileSync(full, content.slice(0, first) + newStr + content.slice(first + oldStr.length), 'utf-8');
  return `Edited: /workspace/${safe}`;
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
    signal?: AbortSignal;
    /** Image data URLs for dropped files — shown to the model as vision blocks. */
    images?: string[];
  },
): AsyncGenerator<SecureEvent> {
  const networkEnabled = opts.networkEnabled ?? false;

  // The sandbox base prompt (identity + operating rules) is ALWAYS included; any
  // caller-supplied prompt (e.g. project context) is APPENDED, not replaced —
  // otherwise a project chat would lose the identity and the sandbox rules.
  const secureBasePrompt = `You are iClaw, a private AI assistant${opts.model ? `, powered by ${opts.model}` : ''}. If asked what you are, say exactly that — never claim to be ChatGPT, Claude, Gemini or another product.
You are running in a secure isolated sandbox. This is the "work on a COPY" mode: the user does NOT trust the source, so everything happens inside /workspace and their real computer is never touched.
You can run commands and read/write files in /workspace only.
What's already here: any folders the user selected are COPIED into /workspace (originals untouched), and any files they dropped are saved here too. To examine an untrusted repo, archive, or URL, bring it in yourself — \`git clone <url>\`, \`unzip <file>\`, or \`curl -O <url>\` — into /workspace. Never expect or use host paths; only /workspace exists.
Work efficiently — each tool call is one step and steps are limited. Chain related
shell commands into a single run_command with && (e.g. \`git clone <url> repo && cd repo && pip install -r requirements.txt\`) instead of one command per step, and don't re-run exploratory commands you've already seen.
Preinstalled CLIs: git, rg (ripgrep), jq, curl, node, unzip/zip, less, tree.
You can install more tools yourself, no root needed${networkEnabled ? '' : ' (requires network, which is currently OFF — ask the user to enable it)'}: download a static binary into /workspace/.tools/bin (already on PATH) with curl, or run \`npm i -g <pkg>\`. Self-installed tools live in the workspace, so they persist across turns and are removed automatically when the workspace expires.
Network is ${networkEnabled ? 'enabled' : 'disabled'}.${
    networkEnabled
      ? '\nTo fetch web pages or APIs, use run_command with `curl -s <url>` (there is no browser in this sandbox).' +
        '\nFor a link\'s actual content, prefer the analyze_link tool (YouTube videos: subtitles/transcript). ' +
        'Use mode:"summary" with a short purpose by default to save tokens; mode:"full" only when you need exact wording.'
      : ''
  }
Be concise.
${HOST_INSTALL_POLICY}`;
  const systemPrompt = opts.systemPrompt?.trim()
    ? `${secureBasePrompt}\n\n${opts.systemPrompt.trim()}`
    : secureBasePrompt;

  const gen = runSecureAgentLoop(
    history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    userMessage,
    {
      apiKey: opts.apiKey,
      model: opts.model,
      allowedFolders: [opts.workspaceDir],
      signal: opts.signal,
      images: opts.images,
      systemPrompt,
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
  const { TOOL_DEFINITIONS, ANALYZE_LINK_TOOL, analyzeLink, clampMiddle, compressCommandOutput, TOOL_OUTPUT_MAX_CHARS } =
    await import('./agent/tools.js');

  // analyze_link is appended (not part of core TOOL_DEFINITIONS) and runs its
  // network work INSIDE this container, so it respects the same network gate.
  const tools = [...TOOL_DEFINITIONS, ANALYZE_LINK_TOOL];

  // Buffer for analyze_link savings notes, flushed as `note` events per tool call.
  const savingsNotes: SavingsNote[] = [];

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
  });

  // Dropped images → multimodal user message (text + vision blocks), seen once.
  const userMsg: OpenAI.Chat.ChatCompletionUserMessageParam = opts.images?.length
    ? {
        role: 'user',
        content: [
          { type: 'text', text: userMessage },
          ...opts.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      }
    : { role: 'user', content: userMessage };

  const messages: Message[] = [
    { role: 'system', content: opts.systemPrompt ?? 'You are a helpful assistant in a secure sandbox.' },
    ...history,
    userMsg,
  ];

  let turnTokens = 0;
  let turnCached = 0;
  const dumpTurnId = newTurnId();
  const guard = makeToolGuard();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // User pressed Stop between rounds → end cleanly (partial text already sent).
    if (opts.signal?.aborted) {
      yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
      return;
    }
    let textBuffer = '';
    const toolCallBuffers: Record<string, { name: string; arguments: string }> = {};

    dumpPrompt({ turnId: dumpTurnId, mode: 'secure', model: opts.model, round, messages, tools });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stream: AsyncIterable<any>;
    try {
      stream = await client.chat.completions.create(
        {
          model: opts.model,
          messages: withPromptCaching(messages),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: tools as any,
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: opts.signal },
      );
    } catch (err) {
      if (opts.signal?.aborted) {
        yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
        return;
      }
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }

    let finishReason: string | null = null;
    try {
      for await (const chunk of stream) {
        if (chunk.usage?.total_tokens) turnTokens += chunk.usage.total_tokens;
        if (chunk.usage?.prompt_tokens_details?.cached_tokens) turnCached += chunk.usage.prompt_tokens_details.cached_tokens;
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
    } catch (err) {
      // Stop pressed mid-stream → clean end; otherwise surface the error.
      if (opts.signal?.aborted) {
        yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
        return;
      }
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }

    const toolCalls = Object.values(toolCallBuffers);
    if (toolCalls.length === 0 || finishReason === 'stop') {
      if (textBuffer) messages.push({ role: 'assistant', content: textBuffer });
      yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
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
      const blocked = guard.check(tc.name, tc.arguments);
      if (blocked) {
        result = blocked;
      } else if (tc.name === 'run_command') {
        result = clampMiddle(compressCommandOutput(await execInContainer(containerName, String(args.command ?? ''))), TOOL_OUTPUT_MAX_CHARS);
      } else if (tc.name === 'write_file') {
        result = writeToWorkspace(workspaceDir, String(args.path ?? 'file.txt'), String(args.content ?? ''));
      } else if (tc.name === 'edit_file') {
        result = editInWorkspace(workspaceDir, String(args.path ?? ''), String(args.old_string ?? ''), String(args.new_string ?? ''));
      } else if (tc.name === 'read_file') {
        result = readFromWorkspace(workspaceDir, String(args.path ?? ''));
      } else if (tc.name === 'list_files') {
        result = await execInContainer(containerName, 'ls -la /workspace');
      } else if (tc.name === 'search_files') {
        result = await execInContainer(containerName, `grep -r ${JSON.stringify(String(args.query ?? ''))} /workspace 2>/dev/null | head -20`);
      } else if (tc.name === 'analyze_link') {
        // Runs its fetch inside this same container (network honours the gate).
        result = await analyzeLink(args, {
          runInSandbox: (command) => execInContainer(containerName, command),
          networkEnabled,
          onNote: (note) => savingsNotes.push(note),
        });
      } else {
        result = `Tool not available in secure mode: ${tc.name}`;
      }

      yield { type: 'tool_result', name: tc.name, result };
      while (savingsNotes.length) yield { type: 'note', note: savingsNotes.shift()! };
      messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: result });
    }
    shrinkOldToolOutputs(messages); // mid-turn compaction (see loop.ts)
  }

  yield { type: 'error', message: `Reached the step limit (${MAX_ROUNDS} tool rounds). Send "continue" to keep going, or raise ICLAW_MAX_ROUNDS.` };
}
