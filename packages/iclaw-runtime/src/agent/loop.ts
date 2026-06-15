/**
 * Model-agnostic agent loop.
 *
 * Calls any OpenRouter model that supports tool calling.
 * Streams text deltas and tool events back to the caller via async generator.
 */
import OpenAI from 'openai';

import { TOOL_DEFINITIONS, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, READ_SUMMARY_TOOL, ANALYZE_LINK_TOOL, SHOW_IMAGE_TOOL, GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL, CREATE_TASK_TOOL, UPDATE_PLAN_TOOL, SET_TIMER_TOOL, CHECK_JOB_TOOL, UPDATE_CALENDAR_TOOL, SET_REMINDER_TOOL, RECALL_TOOL_OUTPUT_TOOL, DEEP_RESEARCH_TOOL, executeTool, normalizeFetchUrl, normalizeSearchQuery, type ToolContext, type ToolName, type SavingsNote, type ImageRef } from './tools.js';
import { SOCIAL_SEARCH_TOOL } from './social.js';
import { BROWSER_TOOLS } from './browser.js';
import { dumpPrompt, newTurnId } from './prompt-dump.js';
import { resolveTurnModel } from './model-capabilities.js';

export interface AgentOptions {
  apiKey: string;
  model: string;
  allowedFolders: string[];
  /** Per-folder access levels. When omitted, all allowed folders are writable. */
  folderAccess?: { path: string; readonly: boolean }[] | undefined;
  /** Shell backend for run_command (Docker sandbox). Omit to disable commands. */
  runShell?: ((command: string, cwd: string) => Promise<string>) | undefined;
  /** Background-job backend (run_command background:true). Wired with runShell. */
  startJob?: ((command: string, cwd: string) => Promise<string>) | undefined;
  /** Background-job poller (check_job). Wired with runShell. */
  checkJob?: ((jobId: string) => Promise<string>) | undefined;
  /**
   * Sandbox backend for analyze_link (yt-dlp). Runs in the session's container
   * so yt-dlp never parses untrusted data on the host. Omit to drop the tool
   * (no Docker → analyze_link not offered, falls back to web_fetch/web_search).
   */
  linkSandbox?: ((command: string) => Promise<string>) | undefined;
  /**
   * Incognito (read-only, ephemeral): file reads are unrestricted (read
   * anywhere; secrets still refused), write_file is disabled, run_command is
   * sandboxed read-only, and the `web_fetch` research tool is exposed.
   */
  incognito?: boolean | undefined;
  systemPrompt?: string | undefined;
  /**
   * Character tool allowlist (by tool name). When set, the turn's tools are
   * intersected with it — a character can only NARROW what the mode already
   * allows, never widen it. Omit for no character restriction.
   */
  characterTools?: string[] | undefined;
  /**
   * Specialist chat: offer the create_task tool so the model can decide to spin
   * a multi-step request into a tracked task (host-fulfilled) instead of doing
   * it inline. Added on top of (never narrowed by) the character allowlist.
   */
  canCreateTasks?: boolean | undefined;
  /**
   * Autonomous run: raise the tool-round ceiling (to ICLAW_AUTONOMOUS_MAX_ROUNDS,
   * default 200) so the agent can iterate on a long task, and offer the set_timer
   * tool so it can pause and resume itself. The existing dead-round breaker +
   * tool-repeat guard still protect against a runaway loop, so the high ceiling
   * only ever helps a genuinely productive long run.
   */
  autonomous?: boolean | undefined;
  /**
   * Hard override for the tool-round ceiling this turn. When set it wins over the
   * autonomous/default values — for future per-task tuning. Omit to use the
   * autonomous (200) / normal (40) default.
   */
  maxRounds?: number | undefined;
  /**
   * Image data URLs (`data:<mime>;base64,…`) for THIS turn's user message —
   * files the user dropped into the chat. Sent once as vision blocks so the
   * model literally sees them; NOT stored in history (one-shot, expensive).
   */
  images?: string[] | undefined;
  onWriteApproval?: ((filePath: string, content: string) => Promise<boolean>) | undefined;
  /** Abort the in-flight turn (user pressed Stop). Stops the model stream and
   *  ends the loop cleanly between rounds. */
  signal?: AbortSignal | undefined;
  /**
   * Offer the deep_research tool (context-isolation sub-agent). Defaults to on;
   * the sub-agent's own nested turn sets this false to prevent recursive nesting.
   */
  allowDeepResearch?: boolean | undefined;
  /**
   * Active project id (or null) — threaded to ToolContext so the browser_* tools
   * pick the per-project browser profile. Omitted → the "shared" profile.
   */
  projectId?: number | null | undefined;
}

/** A single step in the agent's live task plan (update_plan tool). */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done';
export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

/**
 * Validate + clamp the model's update_plan payload into clean PlanStep[]. Drops
 * malformed/blank entries, coerces an unknown status to 'pending', clips long
 * step text, and caps the list — a plan is a handful of steps, not a novel.
 */
export function normalizePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const r = it as { step?: unknown; status?: unknown };
    const step = typeof r.step === 'string' ? r.step.trim() : '';
    if (!step) continue;
    const s = typeof r.status === 'string' ? r.status.trim().toLowerCase() : 'pending';
    const status: PlanStepStatus = s === 'done' || s === 'in_progress' ? s : 'pending';
    out.push({ step: step.length > 200 ? step.slice(0, 199) + '…' : step, status });
    if (out.length >= 20) break;
  }
  return out;
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'note'; note: SavingsNote }
  | { type: 'image'; path: string; mime: string; fileName: string; bytes: number; generated?: boolean | undefined }
  | { type: 'approval_request'; changeId: string; path: string; content: string }
  | { type: 'create_task'; title: string; goal: string }
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'set_timer'; seconds: number; note: string }
  | { type: 'calendar'; entries: CalendarEntry[] }
  | { type: 'reminder'; event: string; date: string; leadDays: number[]; recurring: 'none' | 'yearly' }
  | { type: 'done'; tokens?: number | undefined; cached?: number | undefined; reasoning?: number | undefined }
  | { type: 'error'; message: string };

export type Message = OpenAI.Chat.ChatCompletionMessageParam;

/** Max tool-call rounds per turn before we stop (env-tunable for long tasks). */
const MAX_ROUNDS = Math.max(1, Number(process.env.ICLAW_MAX_ROUNDS) || 40);
/** Higher ceiling for autonomous runs — the agent iterates on a long task until
 *  done (the dead-round breaker + repeat guard still cut off a stuck loop). */
const AUTONOMOUS_MAX_ROUNDS = Math.max(1, Number(process.env.ICLAW_AUTONOMOUS_MAX_ROUNDS) || 200);

/** A planned post the agent adds to the content calendar (update_calendar tool). */
export interface CalendarEntry {
  /** Day as YYYY-MM-DD. */
  date: string;
  text: string;
  platform: string;
  status: 'idea' | 'draft';
}

/**
 * Validate + clamp the model's update_calendar payload. Drops entries without a
 * valid YYYY-MM-DD date or non-empty text, clips long text, defaults status to
 * 'draft' (the agent can only plan/draft — never "posted", since there's no real
 * posting integration), and caps the batch.
 */
export function normalizeCalendarEntries(raw: unknown): CalendarEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarEntry[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const r = it as { date?: unknown; text?: unknown; platform?: unknown; status?: unknown };
    const date = typeof r.date === 'string' ? r.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!text) continue;
    const platform = typeof r.platform === 'string' ? r.platform.trim().slice(0, 40) : '';
    const s = typeof r.status === 'string' ? r.status.trim().toLowerCase() : 'draft';
    const status: CalendarEntry['status'] = s === 'idea' ? 'idea' : 'draft';
    out.push({ date, text: text.length > 300 ? text.slice(0, 299) + '…' : text, platform, status });
    if (out.length >= 60) break;
  }
  return out;
}

/** A date-based reminder the agent sets (set_reminder tool). */
export interface ReminderRequest {
  event: string;
  /** YYYY-MM-DD (this occurrence). */
  date: string;
  /** Days-before to ping, far → near, e.g. [14, 7, 3]. */
  leadDays: number[];
  recurring: 'none' | 'yearly';
}

/**
 * Validate the model's set_reminder payload. Requires a non-empty event + a
 * YYYY-MM-DD date; lead_days are clamped (0–365), deduped, sorted far→near, and
 * default to [1]; recurring is 'yearly' or 'none'. Returns null if invalid.
 */
export function normalizeReminder(raw: unknown): ReminderRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { event?: unknown; date?: unknown; lead_days?: unknown; recurring?: unknown };
  const eventRaw = typeof r.event === 'string' ? r.event.trim() : '';
  const date = typeof r.date === 'string' ? r.date.trim() : '';
  if (!eventRaw || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  let leadDays = Array.isArray(r.lead_days)
    ? r.lead_days.map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n >= 0 && n <= 365)
    : [];
  leadDays = Array.from(new Set(leadDays)).sort((a, b) => b - a);
  if (leadDays.length === 0) leadDays = [1];
  if (leadDays.length > 10) leadDays = leadDays.slice(0, 10);
  const recurring = r.recurring === 'yearly' ? 'yearly' : 'none';
  const event = eventRaw.length > 120 ? eventRaw.slice(0, 119) + '…' : eventRaw;
  return { event, date, leadDays, recurring };
}

/** Clamp a set_timer "minutes" arg to a sane range (1 min … 24 h); null if invalid. */
export function clampTimerMinutes(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const m = Math.round(n);
  if (m < 1) return null;
  return Math.min(m, 1440);
}

/**
 * Resolve a set_timer delay (seconds) from a `seconds` and/or `minutes` arg.
 * `seconds` wins; falls back to minutes×60. Clamped 5 s … 24 h; null if neither
 * is a usable number — so the model can poll tightly (10–30 s) or wait long.
 */
export function clampTimerSeconds(secondsRaw: unknown, minutesRaw: unknown): number | null {
  const s = typeof secondsRaw === 'number' ? secondsRaw : Number(secondsRaw);
  if (Number.isFinite(s) && s > 0) return Math.min(Math.max(Math.round(s), 5), 86_400);
  const m = clampTimerMinutes(minutesRaw);
  return m == null ? null : Math.min(m * 60, 86_400);
}

/** Turn a provider/SDK error into a concise, user-facing message. */
export function describeApiError(err: unknown): string {
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
  const msg = e?.message || String(err);
  // Model request timed out (the SDK's literal "Request timed out." or a connection
  // timeout) — usually a slow/stalled provider. Already auto-retried; give the user
  // something actionable instead of the bare SDK string.
  if (/request timed out|timed out|ETIMEDOUT|ECONNRESET|connection error/i.test(msg)) {
    return 'The model provider took too long to respond and the request timed out (it was retried). ' +
      'This is usually a temporary OpenRouter/provider stall — try again, or switch ICLAW_MODEL to a faster/more ' +
      'reliable model. For long work (image/video generation) run it in the background (run_command background:true) ' +
      'so a slow turn never blocks on it.';
  }
  // Non-vision model handed an image → OpenRouter 404 "No endpoints found that
  // support image input". The vision gate (resolveTurnModel) pre-empts this for
  // confirmed text-only models; this is the safety net for the unknown-capability
  // path (registry lookup failed, so we left the model as-is).
  if (code === 404 && /image input|support image/i.test(msg)) {
    return `This model can't accept images. Set ICLAW_VISION_MODEL to a vision-capable ` +
      `OpenRouter model (e.g. google/gemini-2.5-flash) to use photos.`;
  }
  return msg;
}

// Mid-turn compaction budget: once the in-flight message array passes this many
// chars, stub out all but a few tool outputs (they're already acted on; the model
// can re-run a tool if it truly needs the data again). Lowered to 16k — recent
// work turns plateau around 15–20k, so a 32k gate almost never fired and the
// whole history was resent every round (O(n²) tokens). Like Hermes' compressor we
// keep the FIRST few tool outputs (early task context) as well as the last few.
const INTURN_COMPACT_CHARS = Number(process.env.ICLAW_INTURN_COMPACT_CHARS) || 16_000;
// Keep only the last 3 tool outputs full (was 6). With heavy results (social_search
// ≈14k chars each) keeping 6 meant ~84k of full output re-sent EVERY round — the
// dominant token sink on research turns. The stubbed ones stay retrievable via
// recall_tool_output (see shrinkOldToolOutputs), so 3 is safe, not lossy.
const INTURN_KEEP_TOOL_MSGS = Number(process.env.ICLAW_INTURN_KEEP_TOOL_MSGS) || 3;
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
export function shrinkOldToolOutputs(messages: Message[], recallStore?: Map<string, string>): void {
  let total = 0;
  for (const m of messages) total += typeof m.content === 'string' ? m.content.length : 0;
  if (total <= INTURN_COMPACT_CHARS) return;

  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i]!.role === 'tool') toolIdx.push(i);
  const keepFirst = INTURN_KEEP_FIRST_TOOL_MSGS;
  const keepLast = INTURN_KEEP_TOOL_MSGS;
  for (let k = keepFirst; k < toolIdx.length - keepLast; k++) {
    const i = toolIdx[k]!;
    const content = (messages[i] as { content?: unknown }).content;
    if (typeof content === 'string' && content.length > 160) {
      // With a recall store, stash the full body (keyed by message index) so the
      // model can pull it back via recall_tool_output — lossless. Without one,
      // fall back to telling it to re-run the tool. The verdict line survives
      // either way (preserves FAILED markers; see toolResultVerdict).
      const head = `[earlier tool output omitted to save context — was ${content.length.toLocaleString()} chars; verdict: "${toolResultVerdict(content)}"; `;
      let stub: string;
      if (recallStore) {
        recallStore.set(String(i), content);
        stub = `${head}call recall_tool_output with id "${i}" to get the full result back]`;
      } else {
        stub = `${head}re-run the tool if you need it again]`;
      }
      messages[i] = { ...messages[i], content: stub } as Message;
    }
  }
}

/**
 * The one line of a tool result worth keeping when its body is compacted away:
 * an explicit shell verdict marker if present ("[exit code 128 — command
 * FAILED]", "[command killed after 60s …]"), else the first non-empty line.
 * Without this, mid-turn compaction erased the very evidence that an action
 * FAILED, leaving only the model's own optimistic narration in context — the
 * model then "remembered" failed pushes as successes.
 */
export function toolResultVerdict(content: string): string {
  const lines = content.split('\n');
  const marker = lines.find((l) => /^\[(exit code |command killed )/.test(l.trim()));
  // Prefer a line with a word character: the "{" opening a JSON body carries no
  // signal, the line after it ("message": "Bad credentials") does.
  const firstWordy = lines.find((l) => /[A-Za-z0-9]/.test(l));
  const first = lines.find((l) => l.trim()) ?? '';
  const pick = (marker ?? firstWordy ?? first).trim().replace(/\s+/g, ' ');
  return pick.length > 120 ? pick.slice(0, 119) + '…' : pick;
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
  const sys = messages[i]!;
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

/**
 * Collapse a tool call into a repeat-signature. Keyed on EXACT args by default,
 * but web tools get a semantic key so the model can't dodge the guard by
 * rewording: `web_fetch` keys on the normalized URL alone (a tweaked `focus` or
 * `#anchor` is the SAME page), `web_search`/`social_search` on the normalized
 * query (word order / quoting / operators don't change the results). Malformed
 * args fall back to the exact-args key.
 */
function toolRepeatSignature(name: string, rawArgs: string): string {
  try {
    if (name === 'web_fetch') {
      const a = JSON.parse(rawArgs) as { url?: unknown };
      if (a.url) return `web_fetch:${normalizeFetchUrl(String(a.url))}`;
    } else if (name === 'web_search' || name === 'social_search') {
      const a = JSON.parse(rawArgs) as { query?: unknown };
      if (a.query) return `${name}:${normalizeSearchQuery(String(a.query))}`;
    }
  } catch {
    // fall through to exact-args signature
  }
  return `${name}:${rawArgs}`;
}

export function makeToolGuard(): { check(name: string, rawArgs: string): string | null } {
  const counts = new Map<string, number>();
  return {
    check(name: string, rawArgs: string): string | null {
      const sig = toolRepeatSignature(name, rawArgs);
      const n = (counts.get(sig) ?? 0) + 1;
      counts.set(sig, n);
      if (n > TOOL_REPEAT_LIMIT) {
        if (name === 'web_fetch') {
          return `Guardrail: you've already fetched this URL ${n - 1} times this turn — the page is identical ` +
            `no matter what 'focus' or '#anchor' you pass. Not fetching it again. Use what you already have, ` +
            `fetch a DIFFERENT url, or tell the user the data isn't available there.`;
        }
        if (name === 'web_search' || name === 'social_search') {
          return `Guardrail: you've already run this search ${n - 1} times this turn — rewording it returns the ` +
            `same results. Not running it again. Try a genuinely different source or tool, or tell the user what ` +
            `you couldn't find.`;
        }
        return `Guardrail: you've already called ${name} with these exact arguments ${n - 1} times this turn ` +
          `and got the same result. Not running it again. Change the arguments, try a different tool, ` +
          `or tell the user what's blocking you.`;
      }
      return null;
    },
  };
}

/** Dead-round circuit-breaker (#3): this many CONSECUTIVE rounds whose tool calls
 *  ALL came back empty / failed / timed-out / guard-blocked means the agent is
 *  spinning on data it can't get (e.g. login-gated stats). We then force it to
 *  conclude from what it has instead of grinding to MAX_ROUNDS. Env-tunable. */
const DEAD_ROUND_LIMIT = Math.max(1, Number(process.env.ICLAW_DEAD_ROUND_LIMIT) || 5);

/** True for a tool result that carried no new signal — fuels DEAD_ROUND_LIMIT.
 *  Matches the leading text of every "nothing useful" path in tools.ts
 *  (fetch/search failures, timeouts, empty results, the guard nudge). */
export function isLowValueResult(s: string): boolean {
  const t = s.trimStart();
  if (t.length === 0) return true;
  return (
    t.startsWith('Fetch failed') ||
    t.startsWith('Search failed') ||
    t.startsWith('Guardrail:') ||
    t.startsWith('No results for') ||
    t.startsWith('No files found') ||
    t.startsWith('(empty') ||
    t.startsWith('Only absolute http') ||
    t.startsWith('Security error:') ||
    /\btimed out after\b/.test(t)
  );
}

const DEFAULT_SYSTEM = `Work Mode: read/search/edit/create files in the selected folders, run shell commands, and research the web (web_search then web_fetch).
A question about a fact, price, or how something works → web_search.
Prefer edit_file over rewriting whole files. For a large file you only need the gist of, use read_summary (cheap) instead of read_file. The user approves every write in the UI — don't ask "is this correct?"; just act, then briefly say what you did.
Be efficient: chain shell steps with && in one call, don't repeat commands. Never go outside the allowed folders.
Keep replies short — don't echo back long file listings or file contents; summarize in a line or two.
Report only what tool results confirm. Never state that a command succeeded, a file changed, or a remote action (push, PR, message, API call) happened unless a tool result in THIS turn shows it — watch for "[exit code N — command FAILED]" markers. A step that failed or never ran must be reported as failed or not done, even if earlier conversation claimed otherwise.`;

/**
 * System-install policy (Section 3): the agent must not change the user's
 * computer. Shared by Work and Safe prompts. run_command runs in an isolated
 * sandbox, so installs there are harmless AND don't reach the host — which is
 * exactly why we say it in the prompt rather than guarding run_command (a guard
 * would wrongly block legitimate in-sandbox installs).
 */
export const HOST_INSTALL_POLICY = `System changes (important): your run_command runs in an isolated sandbox, so installing tools there is fine for the task but does NOT install anything on the user's actual computer. Never attempt or claim to make host system changes — installing Python, Node, Git, Docker, Homebrew or system packages on their machine, or editing their PATH. If a task genuinely needs something installed on their computer, tell them it changes their system, give the official install command or link, and ask them to run it themselves.`;

/**
 * Source-citation policy: when an answer rests on specific pages/threads the
 * agent actually fetched or searched, link them inline so the user can click
 * through — and only ever with a real URL from a tool result (models otherwise
 * fabricate plausible-but-dead links; the exact URLs are right there in the
 * web_fetch / social_search output). Cheap in tokens, big for trust. Gated to
 * web-enabled contexts by the caller. Shared by Secure / Work / Incognito.
 */
export const CITATION_POLICY = `Sources: when you use a page, thread or video you fetched or searched, link it inline — make the title itself a clickable markdown link to its exact URL from the tool result, not a bare URL or an end-of-reply list. Never invent a link or cite a source you didn't retrieve.`;

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
    const parts = [identityLine(opts.model), INCOGNITO_SYSTEM, CITATION_POLICY];
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

  const parts = [identityLine(opts.model), DEFAULT_SYSTEM, HOST_INSTALL_POLICY, CITATION_POLICY];

  // Image tools: steer the model to edit/compose existing photos rather than
  // regenerate from scratch — a common miss. Paths to this chat's photos, when
  // any exist, are appended below via opts.systemPrompt.
  parts.push(
    '\nImages: generate_image makes a NEW image from TEXT ONLY. To edit, restyle, dress, place, or COMBINE ' +
      'an existing or attached photo, call edit_image with its path(s) — never generate_image, even if the ' +
      'user says "generate". Images you generate/edit are delivered inline and saved with the chat, NOT in the ' +
      'work folders — never hunt for them with run_command/find/ls; reference them via the paths listed under ' +
      "this chat's photos, and bake any background/framing into the prompt.",
  );

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
/** Research toolset for the deep_research sub-agent: search + read only (no
 *  write/run) — narrows the sub-agent to pure investigation. */
const RESEARCH_TOOLSET = [
  'web_search', 'web_fetch', 'read_summary', 'analyze_link', 'social_search',
  'list_files', 'read_file', 'search_files',
];

const RESEARCH_SUBAGENT_PROMPT =
  'You are a research sub-agent. Investigate the brief thoroughly but economically, then return a SELF-CONTAINED synthesis — your entire reply is handed straight back to the main assistant as the research result, so make it complete and standalone and do NOT ask questions. ' +
  'Use web_search to find sources and read_summary for long pages; use social_search (ONE discovery call, small limit) to survey Reddit/Hacker News — never fetch community pages one by one. Triangulate at least two independent sources per claim, prefer primary and recent, and cite each claim with its source URL as an inline markdown link. Lead with the answer, then the key findings as bullets. A handful of focused calls, not dozens.';

/**
 * deep_research sub-agent (context isolation, like gpt-researcher /
 * open_deep_research). Runs a FRESH agent turn on `brief` with the research
 * toolset in its OWN throwaway context — only the final synthesis returns to the
 * caller, so the main chat never holds the dozens of raw search/fetch results.
 * The sub-turn's own context is itself compacted (shrinkOldToolOutputs), so
 * isolation compounds with mid-turn compaction. allowDeepResearch:false prevents
 * recursive nesting. Errors fold into the synthesis — a failed sub-agent must
 * never crash the parent turn.
 */
async function runIsolatedResearch(
  brief: string,
  opts: AgentOptions,
): Promise<{ synthesis: string; tokens: number; cached: number; reasoning: number }> {
  let synthesis = '';
  let tokens = 0;
  let cached = 0;
  let reasoning = 0;
  try {
    for await (const ev of runAgentTurn([], brief, {
      ...opts,
      systemPrompt: RESEARCH_SUBAGENT_PROMPT,
      characterTools: RESEARCH_TOOLSET, // pure research/read — no write/run
      canCreateTasks: false,
      autonomous: false,
      images: undefined,
      allowDeepResearch: false, // no recursive sub-agents
    })) {
      if (ev.type === 'text') synthesis += ev.content;
      else if (ev.type === 'done') {
        tokens = ev.tokens ?? 0;
        cached = ev.cached ?? 0;
        reasoning = ev.reasoning ?? 0;
      } else if (ev.type === 'error') {
        synthesis += `\n\n[research sub-agent error: ${ev.message}]`;
      }
    }
  } catch (err) {
    synthesis += `\n\n[research sub-agent failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
  const out = synthesis.trim();
  return {
    synthesis: out || '(the research sub-agent returned no synthesis — try a narrower brief)',
    tokens,
    cached,
    reasoning,
  };
}

export async function* runAgentTurn(
  history: Message[],
  userMessage: string,
  opts: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: opts.apiKey,
    // Without an explicit timeout the SDK waits its 10-minute default, so a
    // stalled provider hangs the whole turn before surfacing "Request timed out".
    // Cap a single completion at ICLAW_MODEL_TIMEOUT_MS (default 3 min) and let
    // the SDK retry transient failures (timeouts, 429s, 5xx) a couple of times.
    timeout: Number(process.env.ICLAW_MODEL_TIMEOUT_MS) || 180_000,
    maxRetries: Number(process.env.ICLAW_MODEL_MAX_RETRIES ?? 2),
  });

  // A tool may emit a savings note mid-call (analyze_link). Collect it here and
  // flush as a `note` event right after the tool_result it belongs to.
  const pendingNotes: SavingsNote[] = [];
  const pendingImages: ImageRef[] = [];
  const toolCtx: ToolContext = {
    allowedFolders: opts.allowedFolders,
    folderAccess: opts.folderAccess,
    runShell: opts.runShell,
    startJob: opts.startJob,
    checkJob: opts.checkJob,
    linkSandbox: opts.linkSandbox,
    readOnly: opts.incognito,
    readAnywhere: opts.incognito,
    requestWriteApproval: opts.onWriteApproval ?? (async () => true),
    onNote: (note) => pendingNotes.push(note),
    onImage: (image) => pendingImages.push(image),
    // Fresh per turn → web_fetch dedups repeat pulls of the same URL within this
    // turn (and never leaks fetched bodies across turns).
    fetchCache: new Map<string, string>(),
    // Fresh per turn → holds full bodies of tool results that mid-turn compaction
    // stubs, so recall_tool_output can bring them back instead of re-running.
    recallStore: new Map<string, string>(),
    // Picks the per-project browser profile for the browser_* tools.
    projectId: opts.projectId,
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
  const baseTools = [
    ...fileTools, READ_SUMMARY_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL,
    // show_image lets the agent surface a real image file inline. Not in
    // Incognito — that turn is ephemeral, so there's no message to attach to.
    ...(opts.incognito ? [] : [SHOW_IMAGE_TOOL, GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL]),
    // analyze_link + social_search both run in the session container, so both
    // are offered only when a sandbox backend is wired.
    ...(opts.linkSandbox ? [ANALYZE_LINK_TOOL, SOCIAL_SEARCH_TOOL] : []),
  ];
  // A character narrows the tool set to those tailored to its job. Intersect
  // (never widen): the mode gating above still decides what's on the table.
  const allowed =
    opts.characterTools && opts.characterTools.length
      ? baseTools.filter((t) => opts.characterTools!.includes(t.function.name))
      : baseTools;
  // Tools that sit ON TOP of the character allowlist — a character narrows the
  // mode's tools, but these stay available regardless:
  //  • create_task — a specialist chat can escalate a multi-step request to a
  //    tracked task (only when the session opts in).
  //  • update_plan — a universal, visible task checklist the user can watch; it
  //    keeps long multi-step / autonomous runs coherent and makes "what does
  //    done look like" explicit. Offered in every tool-capable turn.
  const onTop = [
    // recall_tool_output — infrastructure: lets the model pull back a tool result
    // that mid-turn compaction stubbed. Must survive character narrowing, so it
    // sits on top of the allowlist (every tool-capable turn can compact).
    RECALL_TOOL_OUTPUT_TOOL,
    // deep_research — context-isolation sub-agent. On top of the allowlist so any
    // research-capable turn can delegate; off inside the sub-agent itself (no
    // recursive nesting).
    ...(opts.allowDeepResearch === false ? [] : [DEEP_RESEARCH_TOOL]),
    ...(opts.canCreateTasks ? [CREATE_TASK_TOOL] : []),
    // update_plan renders + persists in Work-mode chats; Incognito is ephemeral
    // (nothing to render to), so skip it there.
    ...(opts.incognito ? [] : [UPDATE_PLAN_TOOL]),
    // set_timer needs a persistent chat to resume into (any Work/specialist chat
    // is one — only Incognito is ephemeral). Offered for ALL non-incognito turns
    // so a normal Work chat can poll a background job, not just autonomous runs.
    ...(opts.incognito ? [] : [SET_TIMER_TOOL]),
    // check_job polls a background command — only useful when the sandbox (and so
    // run_command background mode) is wired.
    ...(opts.runShell && !opts.incognito ? [CHECK_JOB_TOOL] : []),
    // update_calendar — only the calendar-panel specialists (Soshie/Ava) carry
    // it in their allowlist; gate on that, Work turns only.
    ...(opts.characterTools?.includes('update_calendar') && !opts.incognito
      ? [UPDATE_CALENDAR_TOOL]
      : []),
    // set_reminder — the personal assistant (Ava) carries it in her allowlist;
    // gate on that, Work turns only.
    ...(opts.characterTools?.includes('set_reminder') && !opts.incognito
      ? [SET_REMINDER_TOOL]
      : []),
    // Browser tools — a character opts in by listing any browser_* tool in its
    // allowlist (the browser operator does). Non-incognito only: a persistent,
    // logged-in browser profile contradicts the ephemeral incognito contract.
    ...(opts.characterTools?.some((t) => t.startsWith('browser_')) && !opts.incognito
      ? BROWSER_TOOLS
      : []),
  ];
  const tools = onTop.length ? [...allowed, ...onTop] : allowed;

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

  // Vision gate: an image-bearing turn on a text-only model would 404 at
  // OpenRouter ("No endpoints found that support image input"). Route it to a
  // vision-capable fallback (ICLAW_VISION_MODEL) when needed; text turns are
  // untouched and pay no lookup. See ./model-capabilities.ts.
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

  // Token usage across all rounds (dev-mode display). `turnCached` = how many
  // prompt tokens were served from the provider's prefix cache; `turnReasoning`
  // = how many completion tokens the model spent on hidden reasoning/thinking.
  let turnTokens = 0;
  let turnCached = 0;
  let turnReasoning = 0;
  const dumpTurnId = newTurnId();
  const dumpMode = opts.incognito ? 'incognito' : 'work';
  const guard = makeToolGuard();

  // Paragraph break to insert before the FIRST text of a round that follows a
  // tool call. The model streams a fresh sentence each round ("…the repo" →
  // run_command → "Oh, the repo is there!"); consumers concatenate text deltas
  // raw, so without this the two segments glue into "…the repoOh, the repo…".
  let pendingSeparator = '';

  // Dead-round circuit-breaker state: count consecutive all-low-value rounds;
  // once we trip, force the next round to answer with tools disabled.
  let deadStreak = 0;
  let forceConclude = false;

  // Tool-round ceiling for this turn: an explicit override wins, else autonomous
  // runs get the high ceiling (200) and normal runs the default (40). The guards
  // above (dead-round breaker, repeat guard) still stop a stuck loop early.
  const maxRounds = Math.max(1, opts.maxRounds ?? (opts.autonomous ? AUTONOMOUS_MAX_ROUNDS : MAX_ROUNDS));

  // Max tool-call rounds to prevent infinite loops (env-tunable: ICLAW_MAX_ROUNDS).
  for (let round = 0; round < maxRounds; round++) {
    // User pressed Stop between rounds → end cleanly (partial text already sent).
    if (opts.signal?.aborted) {
      yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined, reasoning: turnReasoning || undefined };
      return;
    }
    let textBuffer = '';
    const toolCallBuffers: Record<string, { name: string; arguments: string }> = {};

    // Dev mode: persist exactly what we're about to send (incl. tool schemas).
    dumpPrompt({ turnId: dumpTurnId, mode: dumpMode, model: effectiveModel, round, messages, tools });

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create(
        {
          model: effectiveModel,
          messages: withPromptCaching(messages),
          // Persona mode runs with no tools — omit the params entirely (an empty
          // `tools: []` with tool_choice is rejected by some providers).
          ...(tools.length
            ? {
                tools: tools as unknown as OpenAI.Chat.ChatCompletionTool[],
                // Normally 'auto'; after the dead-round breaker trips we send 'none'
                // so the model MUST produce a final answer instead of calling tools.
                tool_choice: forceConclude ? 'none' : 'auto',
              }
            : {}),
          stream: true,
          stream_options: { include_usage: true }, // final chunk carries token usage
        },
        { signal: opts.signal },
      );
    } catch (err) {
      // Aborted by the user → not an error; end the turn cleanly.
      if (opts.signal?.aborted) {
        yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined, reasoning: turnReasoning || undefined };
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
        // OpenRouter mirrors OpenAI's shape: hidden reasoning tokens are a subset
        // of completion_tokens, broken out here. Present only when the model
        // actually reasoned (absent for non-reasoning models / disabled thinking).
        const reasoning = (chunk.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)
          ?.completion_tokens_details?.reasoning_tokens;
        if (reasoning) turnReasoning += reasoning;
        const choice = chunk.choices[0];
        if (!choice) continue;

        finishReason = choice.finish_reason ?? finishReason;
        const delta = choice.delta;

        // Text content
        if (delta.content) {
          // First text after a tool round → emit the paragraph break so this
          // new segment doesn't fuse onto the previous round's last word.
          if (pendingSeparator) {
            yield { type: 'text', content: pendingSeparator };
            pendingSeparator = '';
          }
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
        yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined, reasoning: turnReasoning || undefined };
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
      yield { type: 'done', tokens: turnTokens || undefined, cached: turnCached || undefined, reasoning: turnReasoning || undefined };
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
    const roundResults: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.arguments);
      } catch {
        parsedArgs = {};
      }

      yield { type: 'tool_start', name: tc.name, input: parsedArgs };

      // Guardrail: refuse to re-run an identical call that's already looping.
      const blocked = guard.check(tc.name, tc.arguments);
      let result: string;
      if (blocked != null) {
        result = blocked;
      } else if (tc.name === 'create_task') {
        // Host-fulfilled: the runtime does not run this — it hands the job to the
        // host, which creates the iClaw task. Tell the model optimistically.
        const a = parsedArgs as { title?: string; goal?: string };
        const title = typeof a.title === 'string' ? a.title : '';
        const goal = typeof a.goal === 'string' ? a.goal : '';
        yield { type: 'create_task', title, goal };
        result = `Created a task on the board: "${title || goal.slice(0, 60)}". It will run and come back for your review.`;
      } else if (tc.name === 'update_plan') {
        // Host-rendered: the runtime doesn't "do" anything — it surfaces the
        // agent's working checklist so the user can watch progress (and so a long
        // autonomous run stays coherent). Validate, emit a plan event, and ack.
        const steps = normalizePlanSteps((parsedArgs as { steps?: unknown }).steps);
        if (steps.length === 0) {
          result = 'update_plan needs a non-empty "steps" array; each item is {step, status} where status is pending|in_progress|done.';
        } else {
          yield { type: 'plan', steps };
          const done = steps.filter((s) => s.status === 'done').length;
          result = `Plan updated — ${done}/${steps.length} steps done. Keep going; call update_plan again as steps complete.`;
        }
      } else if (tc.name === 'set_timer') {
        // Host-fulfilled: the runtime emits the request; the host schedules a
        // message that resumes THIS chat after the delay. The agent should wrap
        // up this turn now, so force a conclusion next round (tools off) — the
        // scheduled resume picks the work back up.
        const a = parsedArgs as { seconds?: unknown; minutes?: unknown; note?: unknown };
        const seconds = clampTimerSeconds(a.seconds, a.minutes);
        const note = typeof a.note === 'string' ? a.note.trim().slice(0, 500) : '';
        if (seconds == null) {
          result = 'set_timer needs "seconds" (5–86400) or "minutes" (1–1440) as a number.';
        } else {
          yield { type: 'set_timer', seconds, note };
          forceConclude = true;
          const human = seconds < 90 ? `${seconds} second${seconds === 1 ? '' : 's'}` : `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}`;
          result = `Timer set — this chat will resume in ${human} with your note. ` +
            `Briefly tell the user what you're waiting for, then stop; you'll continue automatically when it resumes.`;
        }
      } else if (tc.name === 'update_calendar') {
        // Host-fulfilled: the runtime emits the entries; the host merges them into
        // the chat's content calendar (server KV) and broadcasts the update.
        const entries = normalizeCalendarEntries((parsedArgs as { entries?: unknown }).entries);
        if (entries.length === 0) {
          result = 'update_calendar needs an "entries" array; each item is {date:"YYYY-MM-DD", text, platform?, status?}.';
        } else {
          yield { type: 'calendar', entries };
          result = `Added ${entries.length} post${entries.length === 1 ? '' : 's'} to the content calendar.`;
        }
      } else if (tc.name === 'set_reminder') {
        // Host-fulfilled: the runtime emits the request; the host gives the event
        // its own chat and schedules a ping at each lead time.
        const rem = normalizeReminder(parsedArgs);
        if (!rem) {
          result = 'set_reminder needs "event" (text) and "date" (YYYY-MM-DD); optional lead_days (e.g. [14,7,3]) and recurring ("yearly").';
        } else {
          yield { type: 'reminder', event: rem.event, date: rem.date, leadDays: rem.leadDays, recurring: rem.recurring };
          const leads = rem.leadDays
            .map((d) => (d === 0 ? 'on the day' : d === 1 ? '1 day before' : `${d} days before`))
            .join(', ');
          result = `Reminder set for "${rem.event}" on ${rem.date} — I'll ping you ${leads}${rem.recurring === 'yearly' ? ', every year' : ''}, in its own chat.`;
        }
      } else if (tc.name === 'deep_research') {
        const brief = String((parsedArgs as { brief?: unknown }).brief ?? '').trim();
        if (!brief) {
          result = 'deep_research needs a "brief" — the research question or goal to investigate.';
        } else {
          // Context isolation: a fresh sub-agent does the multi-tool research in
          // its OWN throwaway context; only the synthesis comes back here, so this
          // chat never accumulates the raw results. Its tokens still count toward
          // this turn so the cost stays visible.
          const r = await runIsolatedResearch(brief, opts);
          turnTokens += r.tokens;
          turnCached += r.cached;
          turnReasoning += r.reasoning;
          result = r.synthesis;
        }
      } else {
        result = await executeTool(tc.name as ToolName, parsedArgs, toolCtx);
      }
      roundResults.push(result);

      yield { type: 'tool_result', name: tc.name, result };
      while (pendingNotes.length) yield { type: 'note', note: pendingNotes.shift()! };
      while (pendingImages.length) {
        const im = pendingImages.shift()!;
        yield { type: 'image', path: im.path, mime: im.mime, fileName: im.fileName, bytes: im.bytes, generated: im.generated };
      }

      messages.push({
        role: 'tool',
        tool_call_id: `call_${i}`,
        content: result,
      });
    }
    // This round spoke before calling tools, and didn't end on a newline — the
    // next round's text is a separate thought, so arm a paragraph break for it.
    // (Leave a previously-armed break intact for tool-only rounds with no text.)
    if (textBuffer && !/\n\s*$/.test(textBuffer)) pendingSeparator = '\n\n';

    // Mid-turn compaction: on a long multi-round task the accumulated tool
    // outputs would be resent every round (O(n²) tokens). Stub out old ones,
    // stashing them in recallStore so recall_tool_output can bring them back.
    shrinkOldToolOutputs(messages, toolCtx.recallStore);

    // Dead-round circuit-breaker: if EVERY tool result this round was empty/
    // failed/timed-out/guard-blocked, the agent made no progress. After
    // DEAD_ROUND_LIMIT such rounds in a row, force a conclusion (tools off next
    // round) so we don't grind to MAX_ROUNDS re-trying data we can't reach.
    const allDead = roundResults.length > 0 && roundResults.every(isLowValueResult);
    deadStreak = allDead ? deadStreak + 1 : 0;
    if (deadStreak >= DEAD_ROUND_LIMIT && !forceConclude) {
      forceConclude = true;
      messages.push({
        role: 'user',
        content:
          `[system] The last ${deadStreak} tool rounds all came back empty, failed, timed out, or ` +
          `duplicate — you're not getting closer. Stop calling tools and answer now with what you've ` +
          `gathered, stating plainly which parts you could NOT find or verify. Do not invent numbers.`,
      });
    }
    // Continue loop — model will see tool results and respond
  }

  yield { type: 'error', message: `Reached the step limit (${maxRounds} tool rounds). Send "continue" to keep going, or raise ICLAW_MAX_ROUNDS.` };
}
