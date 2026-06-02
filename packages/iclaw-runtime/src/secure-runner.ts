/**
 * Secure Mode runner — same agent loop as Work Mode but inside Docker.
 *
 * The agent runs in an isolated container:
 *  - no access to host filesystem (only temp workspace)
 *  - network disabled by default
 *  - container destroyed after session ends
 *
 * The agent loop (loop.ts) runs inside the container via a self-contained
 * Node script. Communication happens via stdin/stdout piped through Docker.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CONTAINER_IMAGE = process.env.ICLAW_SECURE_IMAGE || 'node:22-slim';
const COMMAND_TIMEOUT = 60_000;

export interface SecureRunOptions {
  apiKey: string;
  model: string;
  systemPrompt?: string;
}

export type SecureEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Run a single turn inside an isolated Docker container.
 * Yields events as the agent works, cleans up container when done.
 */
export async function* runSecureTurn(
  history: { role: string; content: string }[],
  userMessage: string,
  opts: SecureRunOptions,
): AsyncGenerator<SecureEvent> {
  // Create disposable temp workspace on host (mounted read-write into container)
  const workspaceDir = mkdtempSync(join(tmpdir(), 'iclaw-secure-'));
  const containerName = `iclaw-secure-${randomUUID().slice(0, 8)}`;

  // Inline agent script — runs inside container, talks via stdin/stdout JSON
  const agentScript = buildAgentScript(opts);

  try {
    const dockerArgs = [
      'run', '--rm',
      '--name', containerName,
      '--network', 'none',          // no network by default
      '--memory', '512m',           // memory limit
      '--cpus', '1',
      '--read-only',                // read-only root fs
      '--tmpfs', '/tmp:size=128m',  // writable tmp
      '-v', `${workspaceDir}:/workspace:rw`,
      '-e', `ANTHROPIC_API_KEY=${opts.apiKey}`,
      '-e', `ICLAW_MODEL=${opts.model}`,
      '--workdir', '/workspace',
      CONTAINER_IMAGE,
      'node', '--input-type=module',
    ];

    const container = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send the agent script + conversation via stdin
    const input = JSON.stringify({ history, userMessage, script: agentScript });
    container.stdin.write(`
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const input = ${JSON.stringify(input)};
const { history, userMessage, script } = JSON.parse(input);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const fn = new AsyncFunction('history', 'userMessage', 'apiKey', 'model', script);
fn(history, userMessage, process.env.ANTHROPIC_API_KEY, process.env.ICLAW_MODEL)
  .catch(e => { process.stdout.write(JSON.stringify({type:'error',message:String(e)})+'\n'); });
`);
    container.stdin.end();

    // Stream stdout events (newline-delimited JSON)
    let buf = '';
    container.stdout.on('data', (chunk: Buffer) => { buf += chunk.toString(); });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        container.kill();
        reject(new Error('Secure container timed out'));
      }, COMMAND_TIMEOUT);

      container.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          reject(new Error(`Container exited with code ${code}`));
        } else {
          resolve();
        }
      });
      container.on('error', reject);
    }).catch((err) => { buf += JSON.stringify({ type: 'error', message: err.message }) + '\n'; });

    // Parse and yield buffered events
    for (const line of buf.split('\n').filter(Boolean)) {
      try {
        yield JSON.parse(line) as SecureEvent;
      } catch {
        yield { type: 'text', content: line };
      }
    }

    if (!buf.includes('"type":"done"') && !buf.includes('"type":"error"')) {
      yield { type: 'done' };
    }
  } finally {
    // Always clean up
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
    try { spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' }); } catch {}
  }
}

/** Inline agent script that runs inside the container. Uses only built-in Node modules + openai. */
function buildAgentScript(_opts: SecureRunOptions): string {
  return `
const https = require('https');

// Minimal OpenAI-compatible fetch for Node without external deps
async function chatComplete(messages, tools, apiKey, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, tools, tool_choice: 'auto', stream: false });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const tools = [
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command in /workspace', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a file in /workspace', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from /workspace', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function executeTool(name, args) {
  try {
    if (name === 'run_command') {
      return execSync(args.command, { cwd: '/workspace', timeout: 30000, encoding: 'utf8' });
    }
    if (name === 'write_file') {
      const p = path.join('/workspace', path.basename(args.path));
      fs.writeFileSync(p, args.content);
      return 'Written: ' + p;
    }
    if (name === 'read_file') {
      const p = path.join('/workspace', path.basename(args.path));
      return fs.readFileSync(p, 'utf8');
    }
    return 'Unknown tool: ' + name;
  } catch(e) { return 'Error: ' + e.message; }
}

const messages = [
  { role: 'system', content: 'You are running in an isolated sandbox. You have access to /workspace only. Network is disabled.' },
  ...history,
  { role: 'user', content: userMessage },
];

for (let round = 0; round < 10; round++) {
  const res = await chatComplete(messages, tools, apiKey, model);
  const choice = res.choices?.[0];
  if (!choice) break;

  const msg = choice.message;
  if (msg.content) process.stdout.write(JSON.stringify({ type: 'text', content: msg.content }) + '\n');

  if (!msg.tool_calls || msg.tool_calls.length === 0) break;

  messages.push(msg);
  for (const tc of msg.tool_calls) {
    const args = JSON.parse(tc.function.arguments || '{}');
    process.stdout.write(JSON.stringify({ type: 'tool_start', name: tc.function.name }) + '\n');
    const result = executeTool(tc.function.name, args);
    process.stdout.write(JSON.stringify({ type: 'tool_result', name: tc.function.name, result: String(result).slice(0, 2000) }) + '\n');
    messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
  }
}
process.stdout.write(JSON.stringify({ type: 'done' }) + '\n');
`;
}
