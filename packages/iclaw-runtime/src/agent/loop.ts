/**
 * Model-agnostic agent loop.
 *
 * Calls any OpenRouter model that supports tool calling.
 * Streams text deltas and tool events back to the caller via async generator.
 */
import OpenAI from 'openai';

import { TOOL_DEFINITIONS, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, READ_SUMMARY_TOOL, ANALYZE_LINK_TOOL, executeTool, type ToolContext, type ToolName } from './tools.js';
import { dumpPrompt, newTurnId } from './prompt-dump.js';

export interface AgentOptions {
  apiKey: string;
  model: string;
  allowedFolders: string[];
  /** Per-folder access levels. When omitted, all allowed folders are writable. */
  folderAccess?: { path: string; readonly: boolean }[];
  /** Shell backend for run_command (Docker sandbox). Omit to disable commands. */
  runShell?: (command: string, cwd: string) => Promise<string>;
  /**
   * Sandbox backend for analyze_link (yt-dlp). Runs in the session's container
   * so yt-dlp never parses untrusted data on the host. Omit to drop the tool
   * (no Docker → analyze_link not offered, falls back to web_fetch/web_search).
   */
  linkSandbox?: (command: string) => Promise<string>;
  /**
   * Incognito (read-only, ephemeral): file reads are unrestricted (read
   * anywhere; secrets still refused), write_file is disabled, run_command is
   * sandboxed read-only, and the `web_fetch` research tool is exposed.
   */
  incognito?: boolean;
  systemPrompt?: string;
  onWriteApproval?: (filePath: string, content: string) => Promise<boolean>;
  /** Abort the in-flight turn (user pressed Stop). Stops the model stream and
   *  ends the loop cleanly between rounds. */
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'approval_request'; changeId: string; path: string; content: string }
  | { type: 'done'; tokens?: number; cached?: number }
  | { type: 'error'; message: string };

export type Message = OpenAI.Chat.ChatCompletionMessageParam;

/** Max tool-call rounds per turn before we stop (env-tunable for long tasks). */
const MAX_ROUNDS = Math.max(1, Number(process.env.ICLAW_MAX_ROUNDS) || 40);

/** Turn a provider/SDK error into a concise, user-facing message. */
function describeApiError(err: unknown): string {
  const e = err as {
    status?: number;
    code?: number | string;
    error?: { code?: number; metadata?: { error_type?: string } };
    message?: string;
  };
  const code = e?.status ?? e?.code ?? e?.error?.code;
  const isRateLimit = code === 429 || e?.error?.metadata?.error_type === 'rate_limit_exceeded';
  if (isRateLimit) {
    return 'Rate limit reached on the model provider (429). Wait a few seconds and try again, ' +
      'or switch to a model with higher limits (ICLAW_MODEL).';
  }
  return e?.message || String(err);
}

// Mid-turn compaction budget: once the in-flight message array passes this many
// chars, stub out all but the last few tool outputs (they're already acted on;
// the model can re-run a tool if it truly needs the data again).
const INTURN_COMPACT_CHARS = Number(process.env.ICLAW_INTURN_COMPACT_CHARS) || 32_000;
const INTURN_KEEP_TOOL_MSGS = Number(process.env.ICLAW_INTURN_KEEP_TOOL_MSGS) || 6;

/**
 * Shrink old tool-result messages in-place when the turn's context grows too
 * large. Keeps message structure (assistant↔tool pairing + tool_call_ids) intact
 * for API validity — only replaces stale tool *content* with a short stub. No
 * extra model call. Shared by the Work/Incognito loop and the Sandbox loop.
 */
export function shrinkOldToolOutputs(messages: Message[]): void {
  let total = 0;
  for (const m of messages) total += typeof m.content === 'string' ? m.content.length : 0;
  if (total <= INTURN_COMPACT_CHARS) return;

  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'tool') toolIdx.push(i);
  const stubCount = toolIdx.length - INTURN_KEEP_TOOL_MSGS;
  for (let k = 0; k < stubCount; k++) {
    const i = toolIdx[k];
    const content = (messages[i] as { content?: unknown }).content;
    if (typeof content === 'string' && content.length > 160) {
      messages[i] = {
        ...messages[i],
        content: `[earlier tool output omitted to save context — was ${content.length.toLocaleString()} chars; re-run the tool if you need it again]`,
      } as Message;
    }
  }
}

const DEFAULT_SYSTEM = `Work Mode: read/search/edit/create files in the selected folders, run shell commands, and research the web (web_search then web_fetch).
Prefer edit_file over rewriting whole files. For a large file you only need the gist of, use read_summary (cheap) instead of read_file. The user approves every write in the UI — don't paste file contents or ask "is this correct?"; just act, then briefly say what you did.
Be efficient: chain shell steps with && in one call, don't repeat commands. Never go outside the allowed folders.
Keep replies short — don't echo back long file listings or file contents; summarize in a line or two.`;

const INCOGNITO_SYSTEM = `Incognito: private, READ-ONLY research. You can read files anywhere, search, run a read-only shell in the selected folders, and use web_search/web_fetch.
You CANNOT write — never claim you saved or changed anything. This chat is ephemeral: nothing is stored. Be concise; put findings in your reply.`;

/**
 * Build the per-turn system message. The base rules and the folder-access
 * summary are ALWAYS included so the model knows which folders are read-only
 * (and won't waste calls writing to them); any host-supplied prompt (project
 * context) is appended rather than replacing the base.
 */
function buildSystemPrompt(opts: AgentOptions): string {
  if (opts.incognito) {
    const parts = [INCOGNITO_SYSTEM];
    if (opts.allowedFolders.length) {
      parts.push(
        `\nShell folders (read-only): ${opts.allowedFolders.join(', ')}. File reads aren't limited to these; secrets are always refused.`,
      );
    } else {
      parts.push('\nNo shell folders selected — run_command is off; use read_file / search_files / web_fetch.');
    }
    if (opts.systemPrompt?.trim()) parts.push(`\n${opts.systemPrompt.trim()}`);
    return parts.join('\n');
  }

  const parts = [DEFAULT_SYSTEM];

  const folders = opts.folderAccess?.length
    ? opts.folderAccess
    : opts.allowedFolders.map((path) => ({ path, readonly: false }));
  if (folders.length) {
    const lines = folders.map((f) => `- ${f.path} (${f.readonly ? 'read-only' : 'rw'})`);
    parts.push(
      `\nFolders (use these exact paths):\n${lines.join('\n')}\n` +
        `Never write or run commands in a read-only folder — say it's read-only and offer a rw folder instead.`,
    );
  }

  if (opts.systemPrompt?.trim()) parts.push(`\n${opts.systemPrompt.trim()}`);
  return parts.join('\n');
}

/**
 * Run one user turn. Yields events as the agent works.
 * Handles multi-step tool loops automatically.
 */
export async function* runAgentTurn(
  history: Message[],
  userMessage: string,
  opts: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
  });

  const toolCtx: ToolContext = {
    allowedFolders: opts.allowedFolders,
    folderAccess: opts.folderAccess,
    runShell: opts.runShell,
    linkSandbox: opts.linkSandbox,
    readOnly: opts.incognito,
    readAnywhere: opts.incognito,
    requestWriteApproval: opts.onWriteApproval ?? (async () => true),
  };

  // Per-mode tool set. Incognito is read-only, so don't ship write_file/edit_file
  // schemas it can't use (saves prompt tokens). Web research tools run host-side
  // and are never exposed to Secure Mode (it has its own loop + container network
  // gate that a host-side fetch would bypass).
  const fileTools = opts.incognito
    ? TOOL_DEFINITIONS.filter((t) => t.function.name !== 'write_file' && t.function.name !== 'edit_file')
    : TOOL_DEFINITIONS;
  // analyze_link (yt-dlp in the session container) is offered only when a
  // sandbox backend is wired (Docker up). Without it, the model uses web_fetch.
  const tools = [
    ...fileTools, READ_SUMMARY_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL,
    ...(opts.linkSandbox ? [ANALYZE_LINK_TOOL] : []),
  ];

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(opts) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  // Token usage across all rounds (dev-mode display). `turnCached` = how many
  // prompt tokens were served from the provider's prefix cache.
  let turnTokens = 0;
  let turnCached = 0;
  const dumpTurnId = newTurnId();
  const dumpMode = opts.incognito ? 'incognito' : 'work';

  // Max tool-call rounds to prevent infinite loops (env-tunable: ICLAW_MAX_ROUNDS).
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // User pressed Stop between rounds → end cleanly (partial text already sent).
    if (opts.signal?.aborted) {
      yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
      return;
    }
    let textBuffer = '';
    const toolCallBuffers: Record<string, { name: string; arguments: string }> = {};

    // Dev mode: persist exactly what we're about to send (incl. tool schemas).
    dumpPrompt({ turnId: dumpTurnId, mode: dumpMode, model: opts.model, round, messages, tools });

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create(
        {
          model: opts.model,
          messages,
          tools: tools as unknown as OpenAI.Chat.ChatCompletionTool[],
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true }, // final chunk carries token usage
        },
        { signal: opts.signal },
      );
    } catch (err) {
      // Aborted by the user → not an error; end the turn cleanly.
      if (opts.signal?.aborted) {
        yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
        return;
      }
      yield { type: 'error', message: describeApiError(err) };
      return;
    }

    let finishReason: string | null = null;

    // The provider can inject an error MID-STREAM (e.g. a 429 surfaced as a JSON
    // error in the SSE body). Catch it here so the turn ends with a clean error
    // event instead of throwing out of the generator and leaving a truncated reply.
    try {
      for await (const chunk of stream) {
        // Usage rides in a final chunk that has no choices — capture it first.
        if (chunk.usage?.total_tokens) turnTokens += chunk.usage.total_tokens;
        const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
          ?.prompt_tokens_details?.cached_tokens;
        if (cached) turnCached += cached;
        const choice = chunk.choices[0];
        if (!choice) continue;

        finishReason = choice.finish_reason ?? finishReason;
        const delta = choice.delta;

        // Text content
        if (delta.content) {
          textBuffer += delta.content;
          yield { type: 'text', content: delta.content };
        }

        // Tool call accumulation
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = String(tc.index ?? 0);
            if (!toolCallBuffers[idx]) {
              toolCallBuffers[idx] = { name: '', arguments: '' };
            }
            if (tc.function?.name) toolCallBuffers[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments;
          }
        }
      }
    } catch (err) {
      // Aborted by the user → not an error; end the turn cleanly.
      if (opts.signal?.aborted) {
        yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
        return;
      }
      yield { type: 'error', message: describeApiError(err) };
      return;
    }

    const toolCalls = Object.values(toolCallBuffers);

    // No tool calls → model is done
    if (toolCalls.length === 0 || finishReason === 'stop') {
      if (textBuffer) {
        messages.push({ role: 'assistant', content: textBuffer });
      }
      yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined };
      return;
    }

    // Build assistant message with tool calls
    const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: textBuffer || null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);

    // Execute each tool call
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.arguments);
      } catch {
        parsedArgs = {};
      }

      yield { type: 'tool_start', name: tc.name, input: parsedArgs };

      const result = await executeTool(tc.name as ToolName, parsedArgs, toolCtx);

      yield { type: 'tool_result', name: tc.name, result };

      messages.push({
        role: 'tool',
        tool_call_id: `call_${i}`,
        content: result,
      });
    }
    // Mid-turn compaction: on a long multi-round task the accumulated tool
    // outputs would be resent every round (O(n²) tokens). Stub out old ones.
    shrinkOldToolOutputs(messages);
    // Continue loop — model will see tool results and respond
  }

  yield { type: 'error', message: `Reached the step limit (${MAX_ROUNDS} tool rounds). Send "continue" to keep going, or raise ICLAW_MAX_ROUNDS.` };
}
