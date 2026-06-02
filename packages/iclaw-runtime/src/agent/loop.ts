/**
 * Model-agnostic agent loop.
 *
 * Calls any OpenRouter model that supports tool calling.
 * Streams text deltas and tool events back to the caller via async generator.
 */
import OpenAI from 'openai';

import { TOOL_DEFINITIONS, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, executeTool, type ToolContext, type ToolName } from './tools.js';
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
   * Incognito (read-only, ephemeral): file reads are unrestricted (read
   * anywhere; secrets still refused), write_file is disabled, run_command is
   * sandboxed read-only, and the `web_fetch` research tool is exposed.
   */
  incognito?: boolean;
  systemPrompt?: string;
  onWriteApproval?: (filePath: string, content: string) => Promise<boolean>;
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'approval_request'; changeId: string; path: string; content: string }
  | { type: 'done'; tokens?: number }
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

const DEFAULT_SYSTEM = `You are a helpful AI assistant running in Work Mode.
You can read, search, edit and create files in the user's selected folders, run shell
commands, and research the web (web_search to find pages, web_fetch to read one).
Prefer edit_file for changes to existing files (surgical old_string→new_string) and
write_file only for new files or full rewrites.
Be concise and act directly: when a change is needed, just call the tool. The user sees
and approves every write in the UI, so do NOT paste file contents into your reply
beforehand or ask "is this correct?" — only narrate briefly what you changed after.
Work efficiently — each tool call is one step and steps are limited. Chain related shell
commands into a single run_command with && instead of one per step, and don't repeat
exploratory commands you've already run.
Never access paths outside the allowed folders.`;

const INCOGNITO_SYSTEM = `You are a private, READ-ONLY research assistant running in Incognito mode.
You can: read files (anywhere on this computer), search them, run read-only shell commands in the user's selected folders, and fetch the web with web_fetch.
You CANNOT change anything: write_file is disabled and the shell runs in a read-only sandbox — never claim you saved, created, or edited a file.
This conversation is EPHEMERAL: nothing is stored and nothing is added to project memory. Deliver findings directly in your reply; the user copies what they need.
Be concise.`;

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
        `\nThe read-only shell (run_command) may run in these folders:\n` +
          opts.allowedFolders.map((f) => `- ${f}`).join('\n') +
          `\nFile reads (read_file/search_files) are NOT limited to these — you may read elsewhere too. Secret files are always refused.`,
      );
    } else {
      parts.push(
        '\nNo folders are selected for the shell, so run_command is unavailable. Use read_file / search_files / web_fetch.',
      );
    }
    if (opts.systemPrompt?.trim()) parts.push(`\n${opts.systemPrompt.trim()}`);
    return parts.join('\n');
  }

  const parts = [DEFAULT_SYSTEM];

  const folders = opts.folderAccess?.length
    ? opts.folderAccess
    : opts.allowedFolders.map((path) => ({ path, readonly: false }));
  if (folders.length) {
    const lines = folders.map(
      (f) => `- ${f.path} (${f.readonly ? 'READ-ONLY: you may read/list/search but NOT write or run commands here' : 'read & write'})`,
    );
    parts.push(
      `\nFolders available this session (use these exact paths):\n${lines.join('\n')}\n` +
        `Before writing a file or running a command, check this list. If the target is in a ` +
        `READ-ONLY folder, do NOT attempt or propose the change — say it's read-only and offer to ` +
        `either write to a read & write folder instead or have the user switch that folder to read & write.`,
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
    readOnly: opts.incognito,
    readAnywhere: opts.incognito,
    requestWriteApproval: opts.onWriteApproval ?? (async () => true),
  };

  // Web research tools are available on the host loop (Work + Incognito). They
  // run host-side, so they're never exposed to Secure Mode (which has its own
  // loop) — that would bypass the sandbox's container network gate.
  const tools = [...TOOL_DEFINITIONS, WEB_FETCH_TOOL, WEB_SEARCH_TOOL];

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(opts) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  // Total tokens billed across all rounds of this turn (dev-mode display).
  let turnTokens = 0;
  const dumpTurnId = newTurnId();
  const dumpMode = opts.incognito ? 'incognito' : 'work';

  // Max tool-call rounds to prevent infinite loops (env-tunable: ICLAW_MAX_ROUNDS).
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let textBuffer = '';
    const toolCallBuffers: Record<string, { name: string; arguments: string }> = {};

    // Dev mode: persist exactly what we're about to send (incl. tool schemas).
    dumpPrompt({ turnId: dumpTurnId, mode: dumpMode, model: opts.model, round, messages, tools });

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create({
        model: opts.model,
        messages,
        tools: tools as unknown as OpenAI.Chat.ChatCompletionTool[],
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true }, // final chunk carries token usage
      });
    } catch (err) {
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
      yield { type: 'error', message: describeApiError(err) };
      return;
    }

    const toolCalls = Object.values(toolCallBuffers);

    // No tool calls → model is done
    if (toolCalls.length === 0 || finishReason === 'stop') {
      if (textBuffer) {
        messages.push({ role: 'assistant', content: textBuffer });
      }
      yield { type: 'done', tokens: turnTokens || undefined };
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
    // Continue loop — model will see tool results and respond
  }

  yield { type: 'error', message: `Reached the step limit (${MAX_ROUNDS} tool rounds). Send "continue" to keep going, or raise ICLAW_MAX_ROUNDS.` };
}
