/**
 * Secure Mode runner.
 *
 * Agent loop runs on the HOST (can reach OpenRouter).
 * Tool execution happens INSIDE a Docker container (isolated, no network).
 *
 * This way:
 *   - Model calls → host → OpenRouter  (needs network)
 *   - File/shell tools → Docker container  (isolated, --network none)
 */
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { runAgentTurn, type Message } from './agent/loop.js';
import type { AgentEvent, AgentOptions } from './agent/loop.js';
import type { ToolContext } from './agent/tools.js';

const execFileAsync = promisify(execFile);

const CONTAINER_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'node:22-slim';
const CONTAINER_TIMEOUT = 30_000;

/** Start a disposable Docker container for tool execution. Returns cleanup fn. */
async function startSandbox(): Promise<{ containerName: string; workspaceDir: string; cleanup: () => void }> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'iclaw-secure-'));
  const containerName = `iclaw-secure-${randomUUID().slice(0, 8)}`;

  // Start a long-running container with a sleep loop so we can docker exec into it
  spawn('docker', [
    'run', '--rm', '-d',
    '--name', containerName,
    '--network', 'none',
    '--memory', '512m',
    '--cpus', '1',
    '-v', `${workspaceDir}:/workspace:rw`,
    '--workdir', '/workspace',
    CONTAINER_IMAGE,
    'sleep', '3600',
  ], { stdio: 'ignore' });

  // Wait a moment for container to start
  await new Promise((r) => setTimeout(r, 1500));

  const cleanup = (): void => {
    try { execFile('docker', ['rm', '-f', containerName], () => {}); } catch {}
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
  };

  return { containerName, workspaceDir, cleanup };
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

/** Read a file from the container workspace. */
function readFromWorkspace(workspaceDir: string, filePath: string): string {
  const safe = basename(filePath);
  const full = join(workspaceDir, safe);
  if (!existsSync(full)) return `File not found: ${safe}`;
  return readFileSync(full, 'utf-8');
}

/** Write a file to the container workspace. */
function writeToWorkspace(workspaceDir: string, filePath: string, content: string): string {
  const safe = basename(filePath);
  const full = join(workspaceDir, safe);
  writeFileSync(full, content, 'utf-8');
  return `Written: /workspace/${safe}`;
}

/** List files in the container workspace. */
async function listWorkspace(containerName: string): Promise<string> {
  return execInContainer(containerName, 'ls -la /workspace');
}

export type SecureEvent = AgentEvent;

/**
 * Run a turn in Secure Mode.
 * Agent loop on host, tools execute in Docker sandbox.
 */
export async function* runSecureTurn(
  history: { role: string; content: string }[],
  userMessage: string,
  opts: { apiKey: string; model: string; systemPrompt?: string },
): AsyncGenerator<SecureEvent> {
  let sandbox: Awaited<ReturnType<typeof startSandbox>> | null = null;

  try {
    sandbox = await startSandbox();
    const { containerName, workspaceDir } = sandbox;

    // Tool context — executes inside Docker
    const toolCtx: ToolContext = {
      allowedFolders: [workspaceDir],
      requestWriteApproval: async () => true, // auto-approve in sandbox
    };

    // Override tool execution to use Docker for bash/write/read
    const sandboxToolCtx: ToolContext = {
      ...toolCtx,
      // We pass this ctx but override executeTool below
    };

    const agentOpts: AgentOptions = {
      apiKey: opts.apiKey,
      model: opts.model,
      allowedFolders: [workspaceDir],
      systemPrompt: opts.systemPrompt ??
        `You are running in a secure isolated sandbox.
You can run commands and read/write files in /workspace only.
The sandbox has no internet access.
Be concise.`,
      onWriteApproval: async () => true,
    };

    // Monkey-patch tool execution to use docker exec
    // We import executeTool and wrap it
    const { executeTool } = await import('./agent/tools.js');
    const origExecute = executeTool;

    // We need to intercept at the loop level — pass custom tool executor
    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    // Run the agent loop with sandbox-aware tool execution
    const gen = runSecureAgentLoop(messages, userMessage, agentOpts, containerName, workspaceDir);

    for await (const event of gen) {
      yield event;
    }
  } finally {
    sandbox?.cleanup();
  }
}

/** Agent loop with tool execution routed through Docker. */
async function* runSecureAgentLoop(
  history: Message[],
  userMessage: string,
  opts: AgentOptions,
  containerName: string,
  workspaceDir: string,
): AsyncGenerator<SecureEvent> {
  const OpenAI = (await import('openai')).default;
  const { TOOL_DEFINITIONS } = await import('./agent/tools.js');

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
        tools: TOOL_DEFINITIONS as any,
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

    // Execute tools inside Docker
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments); } catch {}

      yield { type: 'tool_start', name: tc.name, input: args };

      let result: string;
      try {
        if (tc.name === 'run_command') {
          result = await execInContainer(containerName, String(args.command ?? ''));
        } else if (tc.name === 'write_file') {
          result = writeToWorkspace(workspaceDir, String(args.path ?? 'file.txt'), String(args.content ?? ''));
        } else if (tc.name === 'read_file') {
          result = readFromWorkspace(workspaceDir, String(args.path ?? ''));
        } else if (tc.name === 'list_files') {
          result = await listWorkspace(containerName);
        } else if (tc.name === 'search_files') {
          result = await execInContainer(containerName, `grep -r ${JSON.stringify(String(args.query ?? ''))} /workspace 2>/dev/null | head -20`);
        } else {
          result = `Tool not available in secure mode: ${tc.name}`;
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      yield { type: 'tool_result', name: tc.name, result };
      messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: result });
    }
  }

  yield { type: 'error', message: 'Agent loop exceeded maximum rounds' };
}
