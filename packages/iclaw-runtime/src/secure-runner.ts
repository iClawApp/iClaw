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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type OpenAI from 'openai';
import type { AgentEvent, AgentOptions, Message } from './agent/loop.js';
import type { SavingsNote } from './agent/tools.js';
import { shrinkOldToolOutputs, withPromptCaching, makeToolGuard, HOST_INSTALL_POLICY, CITATION_POLICY, describeApiError } from './agent/loop.js';
import { resolveTurnModel } from './agent/model-capabilities.js';
import { log } from './log.js';
import { INSTALL_LABEL } from './install-id.js';
import { dumpPrompt, newTurnId } from './agent/prompt-dump.js';

const execFileAsync = promisify(execFile);

// Curated secure sandbox image: a small CLI toolset, no browser (build-secure.sh).
// The agent reaches the web via `curl` and can self-install more tools into
// /workspace/.tools (no root). Runs as the non-root `node` user — see
// secure-sandbox.Dockerfile.
const SECURE_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'iclaw-secure:latest';
// Emergency fallback when the curated image isn't built yet — e.g. a fresh
// `npx @iclawapp/iclaw` install, which doesn't ship the Dockerfile. A public
// base `docker run` can auto-pull, so Safe work degrades to a leaner toolset
// instead of hard-failing (matches Work mode in work-container.ts + the AGENTS.md
// contract that "node:22 is only an emergency fallback"). Full node:22 (not
// -slim) carries curl/wget/git so web research still works; the non-root user
// and the /workspace/.tools PATH the curated image bakes in are re-applied as run
// flags in startContainer (fallbackArgs) so the fallback keeps the SAME
// guarantees. Override with ICLAW_SECURE_FALLBACK_IMAGE.
const FALLBACK_IMAGE = process.env.ICLAW_SECURE_FALLBACK_IMAGE || 'node:22';
let resolvedSecureImage: string | null = null;
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
  key?: string | undefined;          // stable identity (e.g. "chat:156") for reconnection
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

async function imageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['image', 'inspect', image], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the Safe-work image: the curated sandbox if it's been built (or an
 * explicit ICLAW_SECURE_IMAGE override, trusted as-is so a registry ref can
 * auto-pull), otherwise the public fallback so a fresh install degrades
 * gracefully instead of hard-failing. Cached after the first resolve — a build
 * done mid-session is picked up on the next runtime restart, as in Work mode.
 */
async function resolveSecureImage(): Promise<string> {
  if (resolvedSecureImage) return resolvedSecureImage;
  if (process.env.ICLAW_SECURE_IMAGE || (await imageExists(SECURE_IMAGE))) {
    resolvedSecureImage = SECURE_IMAGE;
  } else {
    log.warn(
      'Curated sandbox image not built — Safe work falling back to a leaner base. ' +
        'Build it with `npm run build:secure-image` for the full toolset.',
      { fallback: FALLBACK_IMAGE, image: SECURE_IMAGE },
    );
    resolvedSecureImage = FALLBACK_IMAGE;
  }
  return resolvedSecureImage;
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

  const image = await resolveSecureImage();
  // The curated image bakes in `USER node` (non-root) and a /workspace/.tools
  // PATH for rootless self-installs. A public fallback base defaults to ROOT and
  // lacks those envs, so on the fallback we re-apply them as run flags to keep
  // the SAME non-root + rootless-install guarantees. Empty for the curated image,
  // so its run command stays byte-for-byte unchanged.
  const fallbackArgs = image === FALLBACK_IMAGE
    ? [
        '--user', '1000:1000',
        '-e', 'HOME=/tmp',
        '-e', 'NPM_CONFIG_PREFIX=/workspace/.tools/npm',
        '-e', 'PATH=/workspace/.tools/bin:/workspace/.tools/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ]
    : [];

  try {
    // `-d` returns once the container is up (and pulls the image on first run),
    // so we await the real result instead of guessing with a fixed sleep.
    await execFileAsync('docker', [
      'run', '--rm', '-d',
      '--name', containerName,
      '--label', INSTALL_LABEL,
      ...networkArgs,
      ...fallbackArgs,
      // No browser any more, so the default 64MB /dev/shm is fine and 512MB is
      // plenty of headroom for shell/node tasks. Tunable via env.
      '--memory', process.env.ICLAW_SECURE_MEMORY || '512m',
      '--cpus', process.env.ICLAW_SECURE_CPUS || '1',
      '-v', `${workspaceDir}:/workspace:rw`,
      '--workdir', '/workspace',
      image,
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
  const dev = process.env.ICLAW_DEV_MODE === 'true';
  const startedAt = Date.now();
  // Don't dump giant commands (e.g. base64-injected tool scripts like
  // social_search) into the log — keep the head + the useful env/arg tail.
  const cmdLog = command.length > 400
    ? `${command.slice(0, 120)} …[+${command.length - 340} chars]… ${command.slice(-220)}`
    : command;
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker', ['exec', containerName, 'bash', '-c', command],
      { timeout: CONTAINER_TIMEOUT },
    );
    const out = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
    if (dev) log.info('secure run_command', { code: 0, ms: Date.now() - startedAt, bytes: out.length, cmd: cmdLog });
    return out;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string; code?: number };
    const timedOut = Boolean(e.killed) || e.signal === 'SIGTERM' || e.signal === 'SIGKILL';
    const partial = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    if (dev) {
      log.warn('secure run_command failed', {
        ms: Date.now() - startedAt, timedOut,
        killed: Boolean(e.killed), signal: e.signal ?? null, code: e.code ?? null,
        bytes: partial.length, cmd: cmdLog,
      });
    }
    // Not dev-gated: a timeout kill must reach the MODEL. In Secure Mode the
    // sandbox is `--network none` unless the user enables it, so a `curl`/`git`
    // hang here is the common case — say so instead of returning empty text the
    // model misreads as a clean run.
    if (timedOut) {
      return (partial ? partial + '\n\n' : '') +
        `[command killed after ${Math.round(CONTAINER_TIMEOUT / 1000)}s — it timed out and did NOT finish. ` +
        `Likely a network hang (this sandbox has no internet unless the user turns the network toggle ON) ` +
        `or an interactive prompt. Do not assume it completed.]`;
    }
    // Explicit verdict line on failure — same contract as Work Mode's rawExec:
    // the model and the host-side tool trace need a machine-readable FAILED
    // marker, not just whatever the command printed to stderr.
    const marker = `[exit code ${e.code ?? 'unknown'} — command FAILED]`;
    return partial ? `${partial}\n${marker}` : `${e.message ? e.message + '\n' : ''}${marker}`;
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
    networkEnabled?: boolean | undefined;
    systemPrompt?: string | undefined;
    signal?: AbortSignal | undefined;
    /** Image data URLs for dropped files — shown to the model as vision blocks. */
    images?: string[] | undefined;
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
Credentials & claims (critical): this sandbox starts with NO saved credentials — no GitHub/GitLab tokens, no SSH keys, no logged-in CLIs. Any authenticated remote action (git push, creating/updating a PR, posting, API writes) FAILS unless the user gave you a token in this conversation and you passed it to the command explicitly. Never report a remote action as done unless a tool result in THIS turn confirms it — a "[exit code N — command FAILED]" marker means it did NOT happen. If something failed or you didn't run it, say exactly that; never smooth it over, even if earlier conversation claimed it was already done.
Network is ${networkEnabled ? 'enabled' : 'disabled'}.${
    networkEnabled
      ? '\nTo read a web page, use the web_fetch tool (returns clean text, or a cheap summary by default) — do NOT hand-roll `curl ... | jq`; only drop to `curl -s <url>` in run_command for an API or download web_fetch can\'t handle. To find pages, use web_search. There is no browser in this sandbox.' +
        '\nFor a link\'s actual content, prefer analyze_link (YouTube videos: subtitles/transcript) and social_search (Reddit / HackerNews). ' +
        'Use mode:"summary" with a short purpose by default to save tokens; mode:"full" only when you need exact wording.' +
        `\n${CITATION_POLICY}`
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
  const {
    TOOL_DEFINITIONS, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, ANALYZE_LINK_TOOL, SHOW_IMAGE_TOOL,
    analyzeLink, webFetchSandboxed, webSearchSecure, clampMiddle, compressCommandOutput, TOOL_OUTPUT_MAX_CHARS,
  } = await import('./agent/tools.js');
  const { SOCIAL_SEARCH_TOOL, socialSearch } = await import('./agent/social.js');

  // web_fetch, analyze_link and social_search are appended (not part of core
  // TOOL_DEFINITIONS) and run their network work INSIDE this container via curl/
  // node, so they respect the same --network gate. web_search rides the OpenRouter
  // web plugin (host→OpenRouter, like the chat stream), gated on network. show_image
  // lets the agent surface an image it produced in /workspace.
  const tools = [...TOOL_DEFINITIONS, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, ANALYZE_LINK_TOOL, SOCIAL_SEARCH_TOOL, SHOW_IMAGE_TOOL];

  // Buffer for analyze_link savings notes, flushed as `note` events per tool call.
  const savingsNotes: SavingsNote[] = [];
  // Within-turn cache for web_fetch — dedup repeat pulls of the same URL this turn.
  const fetchCache = new Map<string, string>();
  // Buffer for show_image requests, flushed as `image` events per tool call.
  const pendingImages: { path: string; mime: string; fileName: string; bytes: number }[] = [];
  const SECURE_IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  };

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

  // Vision gate (see agent/model-capabilities.ts): route an image turn to a
  // vision-capable model when the configured one is text-only, else OpenRouter
  // 404s on the image_url block. Text turns are untouched.
  const modelDecision = await resolveTurnModel({
    model: opts.model,
    apiKey: opts.apiKey,
    hasImages: !!opts.images?.length,
  });
  if (modelDecision.error) {
    yield { type: 'error', message: modelDecision.error };
    return;
  }
  const effectiveModel = modelDecision.model;

  let turnTokens = 0;
  let turnCached = 0;
  const dumpTurnId = newTurnId();
  const guard = makeToolGuard();
  // Paragraph break for the first text of a post-tool round, so streamed
  // segments across a tool boundary don't glue (see loop.ts for the full story).
  let pendingSeparator = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // User pressed Stop between rounds → end cleanly (partial text already sent).
    if (opts.signal?.aborted) {
      yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
      return;
    }
    let textBuffer = '';
    const toolCallBuffers: Record<string, { name: string; arguments: string }> = {};

    dumpPrompt({ turnId: dumpTurnId, mode: 'secure', model: effectiveModel, round, messages, tools });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stream: AsyncIterable<any>;
    try {
      stream = await client.chat.completions.create(
        {
          model: effectiveModel,
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
      yield { type: 'error', message: describeApiError(err) };
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
          if (pendingSeparator) {
            yield { type: 'text', content: pendingSeparator };
            pendingSeparator = '';
          }
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
      yield { type: 'error', message: describeApiError(err) };
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
      const tc = toolCalls[i]!;
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
      } else if (tc.name === 'web_fetch') {
        // The fetch runs as curl inside this container, so it honours the gate.
        result = await webFetchSandboxed(args, {
          runInSandbox: (command) => execInContainer(containerName, command),
          networkEnabled,
          fetchCache,
        });
      } else if (tc.name === 'web_search') {
        // OpenRouter web plugin (host→OpenRouter, like the chat stream); gated on network.
        result = await webSearchSecure(args, { networkEnabled });
      } else if (tc.name === 'analyze_link') {
        // Runs its fetch inside this same container (network honours the gate).
        result = await analyzeLink(args, {
          runInSandbox: (command) => execInContainer(containerName, command),
          networkEnabled,
          onNote: (note) => savingsNotes.push(note),
        });
      } else if (tc.name === 'social_search') {
        // Keyless social fetch — runs in this container, honours the network gate.
        result = await socialSearch(args, {
          runInSandbox: (command) => execInContainer(containerName, command),
          networkEnabled,
          onNote: (note) => savingsNotes.push(note),
        });
      } else if (tc.name === 'show_image') {
        // The workspace dir IS the host side of the container's /workspace mount,
        // so an image written there (by run_command or write_file) is already on
        // disk here. Resolve within the workspace (no ../ escape), then queue it.
        const rel = String(args.path ?? '').replace(/^\/workspace\/?/, '');
        const full = resolve(workspaceDir, rel);
        if (full !== workspaceDir && !full.startsWith(workspaceDir + sep)) {
          result = 'show_image: the path must stay inside /workspace.';
        } else {
          const ext = extname(full).toLowerCase();
          const mime = SECURE_IMAGE_MIME[ext];
          let st: ReturnType<typeof statSync> | null = null;
          try { st = statSync(full); } catch { st = null; }
          if (!mime) {
            result = `show_image supports image files only (png/jpg/gif/webp/svg); got "${ext || 'no extension'}".`;
          } else if (!st || !st.isFile() || st.size === 0) {
            result = `No such image file: ${rel || String(args.path ?? '')}`;
          } else if (st.size > 20 * 1024 * 1024) {
            result = `Image too large to display (${st.size.toLocaleString()} bytes; max ${(20 * 1024 * 1024).toLocaleString()}).`;
          } else {
            pendingImages.push({ path: full, mime, fileName: basename(full), bytes: st.size });
            result = `Displayed ${basename(full)} to the user in the chat.`;
          }
        }
      } else {
        result = `Tool not available in secure mode: ${tc.name}`;
      }

      yield { type: 'tool_result', name: tc.name, result };
      while (savingsNotes.length) yield { type: 'note', note: savingsNotes.shift()! };
      while (pendingImages.length) {
        const im = pendingImages.shift()!;
        yield { type: 'image', path: im.path, mime: im.mime, fileName: im.fileName, bytes: im.bytes };
      }
      messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: result });
    }
    if (textBuffer && !/\n\s*$/.test(textBuffer)) pendingSeparator = '\n\n';
    shrinkOldToolOutputs(messages); // mid-turn compaction (see loop.ts)
  }

  yield { type: 'error', message: `Reached the step limit (${MAX_ROUNDS} tool rounds). Send "continue" to keep going, or raise ICLAW_MAX_ROUNDS.` };
}
