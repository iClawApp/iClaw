/**
 * Model-agnostic agent loop.
 *
 * Calls any OpenRouter model that supports tool calling.
 * Streams text deltas and tool events back to the caller via async generator.
 */
import OpenAI from 'openai';

import { TOOL_DEFINITIONS, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, READ_SUMMARY_TOOL, ANALYZE_LINK_TOOL, executeTool, type ToolContext, type ToolName, type SavingsNote } from './tools.js';
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
  /**
   * Image data URLs (`data:<mime>;base64,…`) for THIS turn's user message —
   * files the user dropped into the chat. Sent once as vision blocks so the
   * model literally sees them; NOT stored in history (one-shot, expensive).
   */
  images?: string[];
  onWriteApproval?: (filePath: string, content: string) => Promise<boolean>;
  /** Abort the in-flight turn (user pressed Stop). Stops the model stream and
   *  ends the loop cleanly between rounds. */
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'note'; note: SavingsNote }
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
// chars, stub out all but a few tool outputs (they're already acted on; the model
// can re-run a tool if it truly needs the data again). Lowered to 16k — recent
// work turns plateau around 15–20k, so a 32k gate almost never fired and the
// whole history was resent every round (O(n²) tokens). Like Hermes' compressor we
// keep the FIRST few tool outputs (early task context) as well as the last few.
const INTURN_COMPACT_CHARS = Number(process.env.ICLAW_INTURN_COMPACT_CHARS) || 16_000;
const INTURN_KEEP_TOOL_MSGS = Number(process.env.ICLAW_INTURN_KEEP_TOOL_MSGS) || 6;
const INTURN_KEEP_FIRST_TOOL_MSGS = Number(process.env.ICLAW_INTURN_KEEP_FIRST_TOOL_MSGS) || 2;

/**
 * Shrink old tool-result messages in-place when the turn's context grows too
 * large. Keeps message structure (assistant↔tool pairing + tool_call_ids) intact
 * for API validity — only replaces stale tool *content* with a short stub. No
 * extra model call. Shared by the Work/Incognito loop and the Sandbox loop.
 *
 * Protects the first `INTURN_KEEP_FIRST_TOOL_MSGS` and last `INTURN_KEEP_TOOL_MSGS`
 * tool outputs; only the middle gets stubbed (mirrors Hermes' protect_first_n /
 * protect_last_n).
 */
export function shrinkOldToolOutputs(messages: Message[]): void {
  let total = 0;
  for (const m of messages) total += typeof m.content === 'string' ? m.content.length : 0;
  if (total <= INTURN_COMPACT_CHARS) return;

  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'tool') toolIdx.push(i);
  const keepFirst = INTURN_KEEP_FIRST_TOOL_MSGS;
  const keepLast = INTURN_KEEP_TOOL_MSGS;
  for (let k = keepFirst; k < toolIdx.length - keepLast; k++) {
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

/**
 * Prompt caching (#2): mark the static prefix (system prompt + tool schemas) with
 * an OpenRouter/Anthropic `cache_control: ephemeral` breakpoint so it isn't re-
 * billed at full price on every round. The system block is the one guaranteed-
 * stable prefix every round (tools ride with it), so one breakpoint there caches
 * ~1.2k tokens of overhead per round. OpenRouter strips the hint for providers
 * that don't support it (e.g. DeepSeek already caches automatically), so this is
 * safe across models. Off only when ICLAW_PROMPT_CACHE=off.
 *
 * Returns a NEW array (doesn't mutate `messages`) with the system content
 * converted to the parts form Anthropic needs for a cache breakpoint.
 */
export function withPromptCaching(messages: Message[]): Message[] {
  if (process.env.ICLAW_PROMPT_CACHE === 'off') return messages;
  const i = messages.findIndex((m) => m.role === 'system');
  if (i === -1) return messages;
  const sys = messages[i];
  if (typeof sys.content !== 'string' || !sys.content) return messages;
  const out = messages.slice();
  out[i] = {
    role: 'system',
    content: [
      { type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } },
    ],
  } as unknown as Message;
  return out;
}

/**
 * Tool-loop guardrail (#5): a turn can waste rounds (and tokens) re-issuing the
 * SAME tool call with identical args — a stuck model retrying a failed read, or
 * looping. Track call signatures; once one repeats past the limit, short-circuit
 * with a nudge instead of executing it again (mirrors Hermes' tool_loop_guardrails).
 */
const TOOL_REPEAT_LIMIT = Math.max(1, Number(process.env.ICLAW_TOOL_REPEAT_LIMIT) || 3);

export function makeToolGuard(): { check(name: string, rawArgs: string): string | null } {
  const counts = new Map<string, number>();
  return {
    check(name: string, rawArgs: string): string | null {
      const sig = `${name}:${rawArgs}`;
      const n = (counts.get(sig) ?? 0) + 1;
      counts.set(sig, n);
      if (n > TOOL_REPEAT_LIMIT) {
        return `Guardrail: you've already called ${name} with these exact arguments ${n - 1} times this turn ` +
          `and got the same result. Not running it again. Change the arguments, try a different tool, ` +
          `or tell the user what's blocking you.`;
      }
      return null;
    },
  };
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
/** One-line identity so the model doesn't hallucinate being Claude/GPT. */
function identityLine(model: string): string {
  return `You are iClaw, a private AI assistant${model ? `, powered by ${model}` : ''}. If asked what you are, say exactly that — never claim to be ChatGPT, Claude, Gemini or any other product.`;
}

function buildSystemPrompt(opts: AgentOptions): string {
  if (opts.incognito) {
    const parts = [identityLine(opts.model), INCOGNITO_SYSTEM];
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

  const parts = [identityLine(opts.model), DEFAULT_SYSTEM];

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

  // A tool may emit a savings note mid-call (analyze_link). Collect it here and
  // flush as a `note` event right after the tool_result it belongs to.
  const pendingNotes: SavingsNote[] = [];
  const toolCtx: ToolContext = {
    allowedFolders: opts.allowedFolders,
    folderAccess: opts.folderAccess,
    runShell: opts.runShell,
    linkSandbox: opts.linkSandbox,
    readOnly: opts.incognito,
    readAnywhere: opts.incognito,
    requestWriteApproval: opts.onWriteApproval ?? (async () => true),
    onNote: (note) => pendingNotes.push(note),
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

  // When the user dropped image(s), send the turn's user message as a
  // multimodal content array (text + image blocks) so a vision model sees them.
  // History keeps only the text form (the caller stores `userMessage`), so the
  // images aren't re-sent every round.
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
    { role: 'system', content: buildSystemPrompt(opts) },
    ...history,
    userMsg,
  ];

  // Token usage across all rounds (dev-mode display). `turnCached` = how many
  // prompt tokens were served from the provider's prefix cache.
  let turnTokens = 0;
  let turnCached = 0;
  const dumpTurnId = newTurnId();
  const dumpMode = opts.incognito ? 'incognito' : 'work';
  const guard = makeToolGuard();

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
          messages: withPromptCaching(messages),
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

      // Guardrail: refuse to re-run an identical call that's already looping.
      const blocked = guard.check(tc.name, tc.arguments);
      const result = blocked ?? (await executeTool(tc.name as ToolName, parsedArgs, toolCtx));

      yield { type: 'tool_result', name: tc.name, result };
      while (pendingNotes.length) yield { type: 'note', note: pendingNotes.shift()! };

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
