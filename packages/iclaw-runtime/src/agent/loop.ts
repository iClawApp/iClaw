/**
 * Model-agnostic agent loop.
 *
 * Calls any OpenRouter model that supports tool calling.
 * Streams text deltas and tool events back to the caller via async generator.
 */
import OpenAI from 'openai';

import { TOOL_DEFINITIONS, executeTool, type ToolContext, type ToolName } from './tools.js';

export interface AgentOptions {
  apiKey: string;
  model: string;
  allowedFolders: string[];
  /** Per-folder access levels. When omitted, all allowed folders are writable. */
  folderAccess?: { path: string; readonly: boolean }[];
  /** Shell backend for run_command (Docker sandbox). Omit to disable commands. */
  runShell?: (command: string, cwd: string) => Promise<string>;
  systemPrompt?: string;
  onWriteApproval?: (filePath: string, content: string) => Promise<boolean>;
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'approval_request'; changeId: string; path: string; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type Message = OpenAI.Chat.ChatCompletionMessageParam;

const DEFAULT_SYSTEM = `You are a helpful AI assistant running in Work Mode.
You have access to the user's selected folders via tools.
Be concise. When writing files, always propose the change first in text before calling write_file.
Never access paths outside the allowed folders.`;

/**
 * Build the per-turn system message. The base rules and the folder-access
 * summary are ALWAYS included so the model knows which folders are read-only
 * (and won't waste calls writing to them); any host-supplied prompt (project
 * context) is appended rather than replacing the base.
 */
function buildSystemPrompt(opts: AgentOptions): string {
  const parts = [DEFAULT_SYSTEM];

  const folders = opts.folderAccess?.length
    ? opts.folderAccess
    : opts.allowedFolders.map((path) => ({ path, readonly: false }));
  if (folders.length) {
    const lines = folders.map(
      (f) => `- ${f.path} (${f.readonly ? 'READ-ONLY: you may read/list/search but NOT write or run commands here' : 'read & write'})`,
    );
    parts.push(
      `\nFolders available this session:\n${lines.join('\n')}\n` +
        `Writes and shell commands only work in read & write folders; respect this and tell the user if they ask to modify a read-only folder.`,
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
    requestWriteApproval: opts.onWriteApproval ?? (async () => true),
  };

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(opts) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  // Max tool-call rounds to prevent infinite loops
  for (let round = 0; round < 20; round++) {
    let textBuffer = '';
    const toolCallBuffers: Record<string, { name: string; arguments: string }> = {};

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create({
        model: opts.model,
        messages,
        tools: TOOL_DEFINITIONS as unknown as OpenAI.Chat.ChatCompletionTool[],
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

    const toolCalls = Object.values(toolCallBuffers);

    // No tool calls → model is done
    if (toolCalls.length === 0 || finishReason === 'stop') {
      if (textBuffer) {
        messages.push({ role: 'assistant', content: textBuffer });
      }
      yield { type: 'done' };
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

  yield { type: 'error', message: 'Agent loop exceeded maximum rounds' };
}
