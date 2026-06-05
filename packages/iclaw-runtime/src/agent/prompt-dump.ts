/**
 * Dev-mode prompt dumper.
 *
 * When ICLAW_DEV_MODE=true, every request we send to the model (the full
 * messages array + tool schemas, i.e. exactly what burns prompt tokens) is
 * appended to a per-turn JSONL file, with a per-section size breakdown so you
 * can see WHAT is heavy (system prompt vs tool schemas vs history).
 *
 * Self-limiting: files older than 24h are deleted, and the directory is trimmed
 * (oldest-first) to stay under 50 MB. Best-effort and fully wrapped in try/catch
 * — dumping must never break or slow down a real turn.
 *
 * Location: $ICLAW_DEV_PROMPT_DIR or ~/.iclaw/dev-prompts/<turnId>.jsonl
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 50 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 30_000;

let lastSweep = 0;

function enabled(): boolean {
  return process.env.ICLAW_DEV_MODE === 'true';
}

function dir(): string {
  return process.env.ICLAW_DEV_PROMPT_DIR || path.join(os.homedir(), '.iclaw', 'dev-prompts');
}

export function newTurnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface DumpRecord {
  turnId: string;
  mode: string;
  model: string;
  round: number;
  messages: readonly unknown[];
  tools?: readonly unknown[];
}

function summarize(messages: readonly unknown[], tools?: readonly unknown[]) {
  const charsByRole: Record<string, number> = {};
  let messageChars = 0;
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown };
    const role = m.role || 'unknown';
    const c = typeof m.content === 'string'
      ? m.content.length
      : JSON.stringify(m.content ?? '').length;
    charsByRole[role] = (charsByRole[role] || 0) + c;
    messageChars += c;
  }
  const toolChars = tools ? JSON.stringify(tools).length : 0;
  return {
    chars_by_role: charsByRole,
    chars_messages: messageChars,
    chars_tools: toolChars,
    // ~4 chars/token — a rough guide, not the billed count.
    approx_tokens: Math.ceil((messageChars + toolChars) / 4),
  };
}

export function dumpPrompt(rec: DumpRecord): void {
  if (!enabled()) return;
  try {
    const d = dir();
    fs.mkdirSync(d, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      mode: rec.mode,
      model: rec.model,
      round: rec.round,
      sizes: summarize(rec.messages, rec.tools),
      messages: rec.messages,
      tools: rec.tools,
    }) + '\n';
    fs.appendFileSync(path.join(d, `${rec.turnId}.jsonl`), line);
    sweep(d);
  } catch {
    // dev-only; never surface
  }
}

function sweep(d: string): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  try {
    const files = fs.readdirSync(d)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(d, f);
        try { const st = fs.statSync(p); return { p, mtime: st.mtimeMs, size: st.size }; }
        catch { return null; }
      })
      .filter((x): x is { p: string; mtime: number; size: number } => x != null);

    // 1) TTL: drop anything older than 24h.
    const live: { p: string; mtime: number; size: number }[] = [];
    for (const f of files) {
      if (now - f.mtime > TTL_MS) { try { fs.rmSync(f.p, { force: true }); } catch { /* */ } }
      else live.push(f);
    }
    // 2) Size cap: trim oldest until under 50 MB.
    let total = live.reduce((a, f) => a + f.size, 0);
    if (total > MAX_BYTES) {
      live.sort((a, b) => a.mtime - b.mtime);
      for (const f of live) {
        if (total <= MAX_BYTES) break;
        try { fs.rmSync(f.p, { force: true }); total -= f.size; } catch { /* */ }
      }
    }
  } catch {
    // ignore
  }
}
