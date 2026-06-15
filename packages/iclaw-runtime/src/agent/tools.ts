/**
 * Tool definitions (JSON schema for the model) + implementations.
 * All file operations are validated against allowedFolders.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { validatePath, isWriteAllowed, SecurityError } from './security.js';

// Bundled ripgrep binary — shipped as a dependency so it's ALWAYS present (no
// per-host "is rg installed?" branching, no grep fallback). We drive it with
// our own ignore list (below), so it works the same with or without git.
// @vscode/ripgrep is CommonJS with no type declarations, so pull rgPath through
// createRequire rather than an ESM import (avoids the export-shape mismatch).
const { rgPath } = createRequire(import.meta.url)('@vscode/ripgrep') as { rgPath: string };

const execFileAsync = promisify(execFile);

// Refuse to slurp a huge file into memory at all (use search_files instead).
const MAX_FILE_BYTES = Number(process.env.ICLAW_MAX_FILE_BYTES) || 5_000_000;
const COMMAND_TIMEOUT = 30_000;
const WEB_FETCH_TIMEOUT = 20_000;
const WEB_FETCH_MAX_CHARS = 20_000;
// web_fetch in Secure Mode runs the fetch as `curl` INSIDE the sandbox; cap the
// body we pull back over the `docker exec` stdout pipe (well under its ~1MB
// buffer). The host then strips/summarizes it down to WEB_FETCH_MAX_CHARS anyway,
// so this only bounds the transport, not what the model sees.
const WEB_FETCH_SANDBOX_BODY_CAP = Number(process.env.ICLAW_WEB_FETCH_BODY_CAP) || 800_000;
const CURL_META_MARKER = '__ICLAW_FETCH_META__';
const CURL_ERR_MARKER = '__ICLAW_FETCH_ERR__';

// ── Token-saving output caps ──────────────────────────────────────────────────
// Tool outputs are the biggest token sink in multi-turn chats: they land in the
// history and get resent every round. Cap what we hand back to the model.
const MAX_FILE_READ_CHARS = Number(process.env.ICLAW_MAX_FILE_READ) || 16_000;
const MAX_CMD_OUTPUT_CHARS = Number(process.env.ICLAW_MAX_CMD_OUTPUT) || 8_000;
const MAX_LIST_ENTRIES = Number(process.env.ICLAW_MAX_LIST_ENTRIES) || 200;
// search_files: cap matching lines returned per file so a high-frequency term
// can't dump a whole file into history.
const MAX_MATCH_LINES_PER_FILE = Number(process.env.ICLAW_MAX_MATCH_LINES) || 30;

// Directories to never descend into when searching. Different stacks bury huge
// generated trees in different places (JS node_modules, Rust target, Python
// .venv/__pycache__, Java .gradle, …); scanning them is what made unscoped
// searches time out. This is OUR list, fed to ripgrep as ignore globs, so it
// applies whether or not the user has git. ripgrep additionally skips binary
// files (videos/photos/archives/office docs) and follows no symlinks — exactly
// the behaviour a non-technical user's media-heavy folders need.
// Override the whole set with ICLAW_SEARCH_EXCLUDE_DIRS (comma-separated).
const SEARCH_EXCLUDE_DIRS = (process.env.ICLAW_SEARCH_EXCLUDE_DIRS
  ? process.env.ICLAW_SEARCH_EXCLUDE_DIRS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['node_modules', '.git', '.svn', '.hg', '.cache', '.next', '.nuxt', 'dist', 'build',
     'out', 'target', 'vendor', '.venv', 'venv', '.tox', '__pycache__', '.mypy_cache',
     '.pytest_cache', '.gradle', '.idea', 'Pods', '.terraform', '.tools']);

// Cheap-model summarizer (read_summary, web_fetch summarize). Moves the cost of
// reading big content onto a cheap model; the expensive model + history only
// carry the short summary.
const SUMMARY_MODEL = process.env.ICLAW_SUMMARY_MODEL || 'minimax/minimax-m2.7';
const SUMMARY_MAX_INPUT_CHARS = Number(process.env.ICLAW_SUMMARY_MAX_INPUT) || 60_000;

export const TOOL_OUTPUT_MAX_CHARS = MAX_CMD_OUTPUT_CHARS;

/**
 * Compress raw command output before it lands in history (rtk-inspired, but
 * generic + lossless-for-signal — no per-command filters that could hide a
 * failing test or an error the agent needs). Runs BEFORE clampMiddle so the cap
 * keeps real content instead of progress-bar/ANSI noise. Four safe passes:
 *   1. strip ANSI escape codes (colours, cursor moves) — pure noise to a model,
 *      and confirmed present in real run_command output (e.g. "\x1b[95m…\x1b[0m");
 *   2. collapse carriage-return progress lines to their final state (npm/pip/
 *      docker/git "Downloading 12%…100%" → just the last frame);
 *   3. dedupe runs of ≥3 identical consecutive lines into one + "(×N)";
 *   4. squeeze 3+ blank lines down to one.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function compressCommandOutput(s: string): string {
  if (!s) return s;
  let text = s.replace(ANSI_RE, '');
  // Carriage-return progress: keep only what survives the last \r on each line.
  text = text
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
  // Dedupe runs of ≥3 identical, non-blank consecutive lines into one + "(×N)".
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const cur = lines[i]!;
    let j = i + 1;
    while (j < lines.length && lines[j] === cur) j++;
    const run = j - i;
    if (run >= 3 && cur.trim()) out.push(`${cur}  …(×${run})`);
    else for (let k = i; k < j; k++) out.push(lines[k]!);
    i = j;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Keep the head and tail of long output (errors are usually at the end). */
export function clampMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return s.slice(0, head) +
    `\n\n…[truncated ${(s.length - max).toLocaleString()} of ${s.length.toLocaleString()} chars — refine the command or use search_files/read_file]…\n\n` +
    s.slice(s.length - tail);
}

// ── Tool JSON schemas (sent to the model) ────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List a directory. Dirs show as "[dir] name/", files as "[file] name".',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Find files. To LOCATE a file by its name (e.g. "where is config.json?"), pass "name" — it returns just the matching paths, cheaply. To search file CONTENTS, pass "query". Omit "path" to cover ALL folders you have access to in one call — do that instead of searching them one by one.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search. Omit to search every accessible folder in one call.' },
          name: { type: 'string', description: 'Locate files by NAME or fragment (case-insensitive), returning paths only. Use this to find where a file lives — not "query".' },
          query: { type: 'string', description: 'Search file CONTENTS for this string. Use "name" instead when you just want to locate a file.' },
          filePattern: { type: 'string', description: 'Optional glob to limit which files "query" searches, e.g. "*.ts"' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or overwrite a whole file (needs approval). Use edit_file to change existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Replace an exact, UNIQUE snippet in a file (old_string→new_string). Preferred for edits; needs approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_string: { type: 'string', description: 'Exact unique text to replace' },
          new_string: { type: 'string', description: 'Replacement' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description:
        'Run a shell command in an allowed folder. Chain steps with && to save calls. ' +
        'Foreground commands are killed after a timeout (~60s) — for anything that legitimately ' +
        'takes longer (image/video generation, long installs/builds, polling a remote job) set ' +
        'background:true. That returns a job_id immediately; then use set_timer to wait and check_job ' +
        'to poll it. Do NOT run long jobs in the foreground and assume they finished.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command' },
          cwd: { type: 'string', description: 'Working dir (allowed folder)' },
          background: { type: 'boolean', description: 'Run detached and return a job_id immediately (for long-running work). Poll with check_job; wait with set_timer.' },
        },
        required: ['command', 'cwd'],
      },
    },
  },
] as const;

/**
 * Web research tool. Kept OUT of TOOL_DEFINITIONS and appended by the agent loop
 * only when enabled (Incognito), so it never reaches Secure Mode — there, all
 * network must go through the container's `--network` flag, and a host-side
 * fetch would bypass that boundary.
 */
export const WEB_FETCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_fetch',
    description: 'Fetch an http(s) URL and return its text (HTML stripped). Read-only. By default returns a concise summary (cheaper). GitHub repo/file URLs are auto-redirected to raw markdown/source, and Reddit links to old.reddit.com (server-rendered, fetchable). Set summarize:false when you need the EXACT text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL. A github.com repo or /blob/ file link is fetched as raw README/source; a reddit.com link via old.reddit.com.' },
        summarize: { type: 'boolean', description: 'Defaults to true (concise gist). Set false to get the exact page text — do this for full lists, precise numbers/dates, source code, or anything you will quote verbatim.' },
        focus: { type: 'string', description: 'What the summary should focus on (only used when summarizing).' },
      },
      required: ['url'],
    },
  },
} as const;

/**
 * create_task — hand a multi-step job to the project's task board instead of
 * doing it inline. The runtime does NOT execute this tool itself; it emits a
 * 'create_task' AgentEvent and the host fulfils it (creates an iClaw task).
 * Offered only when the session opts in (canCreateTasks) — i.e. a specialist
 * chat where the model should decide chat-vs-task on its own.
 */
export const CREATE_TASK_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_task',
    description:
      "Spin a request into a tracked task on the project board instead of answering inline. Use ONLY for multi-step work worth tracking and reviewing (e.g. 'plan a month of posts', 'audit the whole site'); answer quick questions and small edits directly in chat. The task runs as you, this specialist.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, e.g. "Plan a month of launch posts".' },
        goal: { type: 'string', description: 'The full brief — what done looks like, with the specifics from this conversation.' },
      },
      required: ['goal'],
    },
  },
} as const;

/**
 * update_plan — the agent's live, user-visible task checklist. The runtime does
 * NOT execute it; it emits a 'plan' AgentEvent the host renders in the chat so
 * the user can watch progress in real time. It's the concrete vehicle for a
 * clear "definition of done" and keeps long multi-step / autonomous runs
 * coherent. Added on top of the character allowlist (like create_task), so every
 * tool-capable turn can use it.
 */
export const UPDATE_PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_plan',
    description:
      'Maintain a short, visible plan for a multi-step task so the user can watch your progress. ' +
      "Call it ONCE early to lay out the steps (aim for 3–7), then again each time a step's status changes. " +
      'Always resend the WHOLE ordered list (it replaces the previous plan). Keep exactly one step "in_progress". ' +
      "Skip it for one-shot answers or trivial edits — it's for real multi-step work.",
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The full ordered list of steps. Resend all of them on every call.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: 'Short imperative description of the step.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'done'],
                description: 'pending = not started; in_progress = working on it now (exactly one); done = finished.',
              },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
} as const;

/**
 * set_timer — self-scheduling. The runtime does NOT execute it; it emits a
 * 'set_timer' AgentEvent and the host schedules a message that resumes THIS chat
 * after the delay (via scheduler.ts / scheduled_messages). Lets a long task pause
 * and pick itself back up — "kick off a background job, wait 30s, re-check,
 * continue". Seconds granularity so it pairs with check_job for tight polling.
 */
export const SET_TIMER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'set_timer',
    description:
      'Pause and resume yourself later. Use ONLY when the right next step is to WAIT — you started a long/background ' +
      'process, you want to re-check a job/file after some time, or you are rate-limited. The chat resumes ' +
      'automatically after the delay with your note, and you continue from there. Typical poll loop: start a ' +
      'background job → set_timer 30s → check_job → if still running, set_timer 10s → repeat. Do NOT use it to ' +
      'stall on work you can do right now.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to wait before resuming, in seconds (5–86400). Use this for polling.' },
        minutes: { type: 'number', description: 'Alternative to seconds, for longer waits (1–1440). Ignored if seconds is set.' },
        note: { type: 'string', description: 'A short instruction to your future self — what to do/check when you resume (e.g. the job_id to poll).' },
      },
    },
  },
} as const;

/**
 * check_job — poll a background command started with run_command(background:true).
 * Executes directly in the runtime (reads the job's output tail + exit state from
 * the sandbox container). Offered only when a sandbox backend is wired.
 */
export const CHECK_JOB_TOOL = {
  type: 'function' as const,
  function: {
    name: 'check_job',
    description:
      'Check on a background command (started via run_command with background:true). Returns its output so far ' +
      'plus whether it is still RUNNING or DONE (with exit code). If still running, set_timer for a bit and check ' +
      'again — do not assume it finished.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by run_command(background:true).' },
      },
      required: ['job_id'],
    },
  },
} as const;

/**
 * update_calendar — for the social-media / assistant specialist: drop planned
 * posts onto the content-calendar UI the user sees. The runtime does NOT execute
 * it; it emits a 'calendar' AgentEvent and the host merges the entries into the
 * chat's calendar (server KV) + broadcasts the update. Offered only when the
 * character's tool allowlist includes 'update_calendar' (Soshie / Ava).
 */
export const UPDATE_CALENDAR_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_calendar',
    description:
      'Add planned posts to the content calendar the user can see (the planner panel). ' +
      'Use it after you have planned posts, so they land on real days — not just in chat. ' +
      'Pick real upcoming dates. You can add ideas and drafts; you cannot mark something "posted" ' +
      '(there is no real posting integration yet — be honest about that).',
    parameters: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          description: 'The posts to add to the calendar.',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Day for the post, as YYYY-MM-DD.' },
              text: { type: 'string', description: 'The post / caption text, or a short idea.' },
              platform: { type: 'string', description: 'Optional platform, e.g. Instagram, LinkedIn, X, TikTok.' },
              status: { type: 'string', enum: ['idea', 'draft'], description: 'idea = just a slot; draft = written. Defaults to draft.' },
            },
            required: ['date', 'text'],
          },
        },
      },
      required: ['entries'],
    },
  },
} as const;

/**
 * set_reminder — for the personal-assistant specialist: a real, date-based
 * reminder for an event (birthday, renewal, deadline). The runtime does NOT
 * execute it; it emits a 'reminder' AgentEvent and the host gives the event its
 * own dedicated chat (reused by name — e.g. the same birthday next year) and
 * schedules a ping at each lead time before the date. Unlike set_timer (minutes,
 * for autonomy resume), this is days/weeks/months out. Offered only when the
 * character's allowlist includes 'set_reminder' (Ava).
 */
export const SET_REMINDER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'set_reminder',
    description:
      'Set a reminder for a specific real-world event (a birthday, a renewal, a deadline). The reminder gets its OWN ' +
      'dedicated chat — reusing the same name reuses the same chat (e.g. the same birthday next year) — and you will be ' +
      'pinged there at each lead time before the date. Use this for "remind me about X on a date"; use set_timer ' +
      'instead for "continue this task in N minutes".',
    parameters: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Short name of what to remember, e.g. "Mom\'s birthday". The same name reuses the same reminder chat.' },
        date: { type: 'string', description: 'The event date as YYYY-MM-DD (this occurrence).' },
        lead_days: { type: 'array', items: { type: 'number' }, description: 'How many days before the date to ping — e.g. [14, 7, 3] or [1]. Defaults to [1].' },
        recurring: { type: 'string', enum: ['none', 'yearly'], description: 'yearly for birthdays/anniversaries (re-arms next year in the same chat). Defaults to none.' },
      },
      required: ['event', 'date'],
    },
  },
} as const;

/**
 * read_summary — read a file and return a SHORT summary via a cheap model,
 * instead of dumping the whole file into the expensive model's context (and
 * history). Host-loop only (Work / Incognito); kept out of Secure, since the
 * summary call is a host-side network request that would bypass the sandbox's
 * container network gate.
 */
export const READ_SUMMARY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_summary',
    description: 'Read a file and return a SHORT summary (cheap model) — for when you just need the gist of a large file. Use read_file when you need exact content to edit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        focus: { type: 'string', description: 'What to focus the summary on (optional)' },
      },
      required: ['path'],
    },
  },
} as const;

/**
 * Web search — kept OUT of TOOL_DEFINITIONS (like web_fetch) and appended by the
 * agent loop only for the host-loop modes (Work / Incognito), never Secure
 * (host-side network would bypass the sandbox's container network gate).
 */
export const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: 'Search the web; returns top results (title, url, snippet). Then web_fetch a URL for details.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Max results (default 6)' },
      },
      required: ['query'],
    },
  },
} as const;

/**
 * show_image — display an image file to the user INLINE in the chat.
 *
 * Kept OUT of TOOL_DEFINITIONS and appended by the loop (like the web tools).
 * Use after creating or locating an image the user should actually SEE — a
 * chart, diagram, QR code, screenshot, rendered figure. The path must be a real
 * image file inside one of the allowed folders.
 */
export const SHOW_IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'show_image',
    description:
      'Display an image FILE to the user inline in the chat. Use right after you create or find an image ' +
      'the user should see (a chart/plot, diagram, QR code, screenshot, rendered figure). Pass the path to a ' +
      'PNG/JPG/GIF/WebP/SVG inside an allowed folder. Do NOT use for text output — only real image files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the image file (PNG/JPG/GIF/WebP/SVG) inside an allowed folder.' },
        caption: { type: 'string', description: 'Optional short caption shown with the image.' },
      },
      required: ['path'],
    },
  },
} as const;

/**
 * generate_image — create a NEW image from a text prompt and show it inline.
 *
 * Kept OUT of TOOL_DEFINITIONS and appended by the loop (like show_image). Runs
 * host-side: a chat/completions call to OpenRouter with modalities:["image"] on
 * the SAME key the runtime uses for chat. Default model is Nano Banana
 * (google/gemini-2.5-flash-image); override with ICLAW_IMAGE_GEN_MODEL. Not in
 * Secure (network is gated inside the container) or Incognito (ephemeral turn,
 * nothing to attach to).
 */
export const GENERATE_IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'generate_image',
    description:
      'Generate NEW image(s) from text description(s) and show them to the user inline. Use when asked to ' +
      'create/draw/make a picture, illustration, logo, icon, social graphic, or mockup. For ONE image pass ' +
      '"prompt"; for SEVERAL at once pass "prompts" (an array) — they are generated IN PARALLEL, far faster ' +
      'than calling this tool repeatedly (use it for variants, sets, or multiple characters; up to 6 per call). ' +
      'Each prompt should be detailed — subject, style, composition, colours, any aspect ratio as words ' +
      '(e.g. "16:9 widescreen"). This makes images from TEXT ONLY — if the request relies on an existing or ' +
      'attached photo (edit/restyle it, or combine photos), use edit_image instead, even if the user says "generate".',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of ONE image to create.' },
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Detailed descriptions of SEVERAL images to create at once, in parallel (up to 6). Use instead of "prompt" when the user wants multiple images/variants.',
        },
      },
    },
  },
} as const;

/**
 * edit_image — transform an EXISTING image file with a text instruction.
 *
 * Same host-side OpenRouter path as generate_image; the source image is sent as
 * a base64 image_url alongside the instruction. Default model is Nano Banana
 * (google/gemini-2.5-flash-image), which edits natively; override with
 * ICLAW_IMAGE_EDIT_MODEL. The `path` is validated against allowedFolders exactly
 * like show_image.
 */
export const EDIT_IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'edit_image',
    description:
      'Edit or COMBINE existing photo(s) with a text instruction and show the result inline — restyle, ' +
      'add/remove elements, change the background, inpaint, OR fuse several images (e.g. put the person from ' +
      'one photo into the outfit/scene from another). Pass 1..N raster images (png/jpg/webp/gif) in "paths"; ' +
      'for photos the user attached to the chat, use the EXACT path(s) from the "[The user attached…]" note. ' +
      '"prompt" describes the result. Use this even when the user says "generate" if their request relies on ' +
      'existing or attached photos. For a brand-new image from only a text description, use generate_image.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more source image paths (png/jpg/webp/gif) inside an allowed folder. Several paths → Nano Banana fuses them into one image.',
        },
        prompt: { type: 'string', description: 'What the resulting image should be — the edit, or how to combine the inputs.' },
      },
      required: ['paths', 'prompt'],
    },
  },
} as const;

/**
 * analyze_link — extract the *content* behind a URL (not the raw HTML).
 *
 * Kept OUT of TOOL_DEFINITIONS and appended by the loop, like the web tools.
 * Unlike web_fetch/web_search (host-side), this runs ENTIRELY inside the
 * sandbox: the loop injects a `runInSandbox` callback wired to the container,
 * so the network egress respects the same container network gate. First handler
 * is YouTube (subtitles via yt-dlp); the registry is built to grow to more
 * sites without touching the schema.
 *
 * `mode` is the token lever: "summary" (default) hands the extracted text to a
 * cheap model focused on `purpose` and returns only the gist; "full" returns the
 * cleaned text (clamped). Always prefer "summary" unless you need exact wording.
 */
export const ANALYZE_LINK_TOOL = {
  type: 'function' as const,
  function: {
    name: 'analyze_link',
    description:
      'Extract and read the content behind a URL (currently: YouTube video subtitles/transcript). ' +
      'Runs in the sandbox. Use mode:"summary" (default, cheap) for the gist; mode:"full" only when ' +
      'you need exact wording. Always pass a short "purpose" so the summary keeps what you actually need. ' +
      'For plain web articles use web_fetch instead.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL (e.g. a YouTube video link)' },
        mode: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary = cheap, purpose-focused gist (default); full = cleaned transcript (clamped)',
        },
        purpose: {
          type: 'string',
          description: 'One short sentence on what you need from the link — drives the summary extraction',
        },
      },
      required: ['url'],
    },
  },
} as const;

/**
 * recall_tool_output — bring back the full body of an earlier tool result that
 * mid-turn compaction stubbed out of context (see shrinkOldToolOutputs). Lets the
 * model retrieve a result by id instead of re-running the tool, so compaction is
 * lossless. The id is the stub's message index, stashed in ctx.recallStore.
 */
export const RECALL_TOOL_OUTPUT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'recall_tool_output',
    description:
      'Bring back the FULL result of an earlier tool call that was shortened to save context. ' +
      'When you see a stub like \'[earlier tool output omitted … call recall_tool_output with id "42" …]\', ' +
      'call this with that id to get the original content back — cheaper and faster than re-running the tool.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id shown in the omitted-output stub (e.g. "42").' },
      },
      required: ['id'],
    },
  },
} as const;

/**
 * deep_research — delegate a multi-source investigation to an isolated research
 * sub-agent (context isolation, à la gpt-researcher / open_deep_research). The
 * sub-agent runs its own tool loop in a throwaway context and returns only a
 * cited synthesis, so the MAIN chat never accumulates the dozens of raw
 * search/fetch results. Handled inline in the loop (spawns a nested runAgentTurn),
 * not via executeTool — so it is NOT in ToolName.
 */
export const DEEP_RESEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'deep_research',
    description:
      'Delegate a research question to an isolated research sub-agent: it runs many searches/reads in its OWN context and returns a single self-contained, cited synthesis — so THIS chat never piles up dozens of raw results. ' +
      'Prefer this for any multi-source investigation ("research X", "compare A vs B", "what do people say about Y") instead of running many web_search / web_fetch / social_search calls here yourself. For one quick lookup, just use web_search directly.',
    parameters: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: 'The research question/goal with any needed context. The sub-agent sees ONLY this — make it self-contained.',
        },
      },
      required: ['brief'],
    },
  },
} as const;

export type ToolName =
  | 'list_files' | 'read_file' | 'read_summary' | 'search_files' | 'write_file' | 'edit_file'
  | 'run_command' | 'check_job' | 'web_fetch' | 'web_search' | 'analyze_link' | 'social_search' | 'show_image'
  | 'generate_image' | 'edit_image' | 'recall_tool_output';

/** A host image the agent asked to display inline (via show_image / generate_image). */
export interface ImageRef {
  /** Absolute HOST path of the image. show_image: inside an allowed folder (re-
   *  validated host-side). generate_image/edit_image: a runtime-created temp file
   *  (path is NOT model-controlled — the host trusts it and deletes it after). */
  path: string;
  mime: string;
  fileName: string;
  bytes: number;
  /** True for generate_image/edit_image output (temp file, not folder-gated). */
  generated?: boolean | undefined;
}

/**
 * A token/cost saving worth surfacing in the chat. Emitted when a tool fed the
 * main model a cheap SUMMARY instead of the full extracted content (e.g.
 * analyze_link summary mode reads a long video transcript but hands the model
 * only the gist). The loop forwards it as a `note` event → a chat system note.
 */
export interface SavingsNote {
  /** Which tool produced the saving — drives the chat-note wording. */
  kind: 'analyze_link' | 'read_file' | 'read_summary' | 'run_command' | 'search';
  /** Short human label for the source, e.g. "YouTube transcript". */
  source: string;
  /**
   * Whole-percent of content NOT sent to the main model (1 - delivered/full).
   * Present only when we actually hold BOTH numbers as a byproduct of normal
   * work (read_file/read_summary/run_command/analyze_link). Omitted for `search`,
   * where ripgrep trims long lines but never reports how many bytes it dropped —
   * so we surface a quantity-free "trimmed oversized output" note instead of a
   * fabricated percentage.
   */
  savedPct?: number;
  /** Chars the model would have ingested otherwise (full). */
  fullChars?: number;
  /** Chars actually delivered to the model. */
  deliveredChars?: number;
}

// Only post a "saved you X%" note when the win is real and worth mentioning —
// a tiny truncation isn't worth a chat row. Both gates must pass.
const SAVINGS_MIN_FULL_CHARS = 4_000;
const SAVINGS_MIN_PCT = 30;

/**
 * Emit a "saved you X%" note IFF we already hold both the full and delivered
 * sizes (zero extra work — just a subtraction) and the saving clears the gates.
 * Used by read_file / read_summary / run_command truncation. Never fabricates a
 * baseline; if the numbers aren't both in hand, the caller simply doesn't call.
 */
function emitTruncationSaving(
  ctx: ToolContext,
  kind: SavingsNote['kind'],
  source: string,
  fullChars: number,
  deliveredChars: number,
): void {
  if (!ctx.onNote || fullChars < SAVINGS_MIN_FULL_CHARS || deliveredChars >= fullChars) return;
  const savedPct = Math.round((1 - deliveredChars / fullChars) * 100);
  if (savedPct < SAVINGS_MIN_PCT) return;
  ctx.onNote({ kind, source, savedPct, fullChars, deliveredChars });
}

// ── Tool context (injected per-session) ──────────────────────────────────────

export interface ToolContext {
  allowedFolders: string[];
  /**
   * Per-folder access levels (path + readonly flag). When provided, write_file
   * is denied for paths under a read-only folder. When omitted (e.g. restored
   * sessions) all allowed folders are treated as writable.
   */
  folderAccess?: { path: string; readonly: boolean }[] | undefined;
  /**
   * Runs a shell command for run_command. Injected so the host never executes
   * bash directly: Work Mode wires this to a Docker container with per-folder
   * :ro/:rw mounts (the kernel enforces read-only). When omitted (no Docker),
   * run_command is disabled and returns a guidance message — the strict
   * fallback that keeps read-only an honest guarantee.
   */
  runShell?: ((command: string, cwd: string) => Promise<string>) | undefined;
  /**
   * Launch a long-running command in the BACKGROUND (detached in the sandbox
   * container) and return a short job id immediately — for work that can't fit
   * the foreground command timeout (image/video generation, big installs). The
   * process survives turn boundaries; the agent re-polls with checkJob. Wired
   * only when runShell is (both need the container). */
  startJob?: ((command: string, cwd: string) => Promise<string>) | undefined;
  /** Poll a background job started by startJob: returns its output tail + state. */
  checkJob?: ((jobId: string) => Promise<string>) | undefined;
  /**
   * Runs an analyze_link helper command inside the session's sandbox container
   * (warm-reused; yt-dlp self-installs once). Injected so yt-dlp — which parses
   * untrusted YouTube data — never runs on the host. Omitted when no Docker →
   * analyze_link returns a guidance message.
   */
  linkSandbox?: ((command: string) => Promise<string>) | undefined;
  /**
   * Incognito (read-only): write_file is denied outright (nothing ever hits
   * disk), and run_command is only reachable via a read-only sandbox.
   */
  readOnly?: boolean | undefined;
  /**
   * Incognito: file reads (read/list/search) are NOT restricted to
   * allowedFolders — the agent may read anywhere on the host. The secret
   * deny-list (BLOCKED_PATTERNS in security.ts) still applies, so .ssh/.env/
   * credentials etc. are refused regardless.
   */
  readAnywhere?: boolean | undefined;
  /** Called when agent wants to write — returns true if approved, false if rejected. */
  requestWriteApproval: (filePath: string, content: string) => Promise<boolean>;
  /**
   * Optional sink for a user-visible "saved N% cost" note (analyze_link summary
   * mode). The agent loop wires this to forward a `note` event to the chat.
   */
  onNote?: ((note: SavingsNote) => void) | undefined;
  /**
   * Optional sink for show_image: an image file (already validated to live
   * inside an allowed folder) the agent wants displayed inline in the chat. The
   * loop wires this to emit an `image` event the host turns into an attachment.
   */
  onImage?: ((image: ImageRef) => void) | undefined;
  /**
   * Within-turn cache of fetched page bodies, keyed by normalized URL
   * (`normalizeFetchUrl`). A research turn often re-fetches the same page with a
   * tweaked `focus`; with this set, web_fetch serves the body from memory and
   * re-summarizes for the new focus instead of re-hitting the network. Created
   * fresh per turn by the loop; absent → caching off (each fetch goes to network).
   */
  fetchCache?: Map<string, string> | undefined;
  /**
   * Within-turn store of full tool outputs that mid-turn compaction stubbed out
   * of context, keyed by the stub's id (the tool message's array index). The
   * recall_tool_output tool reads from it, so shrinking is LOSSLESS — the model
   * can pull a result back instead of re-running the tool. Created fresh per turn
   * by the loop; absent → compaction falls back to a "re-run the tool" stub.
   */
  recallStore?: Map<string, string> | undefined;
  /**
   * Active project id (or null = no project). Picks the per-project, persistent
   * browser profile for the browser_* tools so logins/cookies are isolated per
   * project and never touch the user's main browser.
   */
  projectId?: number | null | undefined;
}

/** Folders to validate reads against — empty (anywhere) for Incognito. */
function readFolders(ctx: ToolContext): string[] {
  return ctx.readAnywhere ? [] : ctx.allowedFolders;
}

// ── Tool implementations ──────────────────────────────────────────────────────

export async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  try {
    // Browser tools live in their own (lazily-loaded) module — Playwright only
    // loads when the agent actually drives a browser.
    if (name.startsWith('browser_')) {
      const { executeBrowserTool } = await import('./browser.js');
      return await executeBrowserTool(name, args, ctx);
    }
    switch (name) {
      case 'list_files': return await listFiles(args, ctx);
      case 'read_file': return await readFile(args, ctx);
      case 'read_summary': return await readSummary(args, ctx);
      case 'search_files': return await searchFiles(args, ctx);
      case 'write_file': return await writeFile(args, ctx);
      case 'edit_file': return await editFile(args, ctx);
      case 'run_command': return await runCommand(args, ctx);
      case 'check_job': return await checkJobTool(args, ctx);
      case 'web_fetch': return await webFetch(args, ctx);
      case 'web_search': return await webSearch(args);
      case 'show_image': return showImage(args, ctx);
      case 'generate_image': return await generateImage(args, ctx);
      case 'edit_image': return await editImage(args, ctx);
      case 'analyze_link':
        if (!ctx.linkSandbox) {
          return 'analyze_link needs a sandbox container (Docker), which is unavailable here. Use web_fetch/web_search instead.';
        }
        return await analyzeLink(args, { runInSandbox: ctx.linkSandbox, networkEnabled: true, onNote: ctx.onNote });
      case 'social_search': {
        if (!ctx.linkSandbox) {
          return 'social_search needs a sandbox container (Docker), which is unavailable here. Use web_search instead.';
        }
        const { socialSearch } = await import('./social.js');
        return await socialSearch(args, { runInSandbox: ctx.linkSandbox, networkEnabled: true, onNote: ctx.onNote });
      }
      case 'recall_tool_output': {
        const id = String(args.id ?? '').trim();
        const hit = ctx.recallStore?.get(id);
        return hit ?? `No saved output for id "${id}" — it may never have existed or wasn't compacted. Re-run the original tool if you still need that data.`;
      }
      default: return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof SecurityError) return `Security error: ${err.message}`;
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function listFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const dir = validatePath(args.path as string, readFolders(ctx));
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // Explicit [dir]/[file] labels (+ trailing slash on dirs) so the model can
  // reliably tell directories from files and recurse without guessing.
  const lines = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `[dir]  ${e.name}/` : `[file] ${e.name}`));
  if (lines.length === 0) return '(empty directory)';
  // Cap big listings — the full list otherwise lands in history and is resent
  // every round.
  if (lines.length > MAX_LIST_ENTRIES) {
    const shown = lines.slice(0, MAX_LIST_ENTRIES);
    return `${shown.join('\n')}\n…[+${lines.length - MAX_LIST_ENTRIES} more entries — narrow with search_files]`;
  }
  return lines.join('\n');
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = validatePath(args.path as string, readFolders(ctx));
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return `File too large to read whole (${stat.size.toLocaleString()} bytes). Use search_files to find the part you need.`;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.length > MAX_FILE_READ_CHARS) {
    // We already read the whole file; handing the model only the head is a real,
    // free-to-measure saving (full = content.length, delivered = the cap).
    emitTruncationSaving(ctx, 'read_file', path.basename(filePath), content.length, MAX_FILE_READ_CHARS);
    return content.slice(0, MAX_FILE_READ_CHARS) +
      `\n\n…[truncated: showing first ${MAX_FILE_READ_CHARS.toLocaleString()} of ${content.length.toLocaleString()} chars. Use search_files for specific content, or read_summary for the gist.]`;
  }
  return content;
}

async function readSummary(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const filePath = validatePath(args.path as string, readFolders(ctx));
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return `File too large (${stat.size.toLocaleString()} bytes). Use search_files for specific content.`;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.trim()) return '(empty file)';
  const summary = await summarizeText(content, args.focus ? String(args.focus) : undefined);
  // Model ingests the short summary instead of the full file — both sizes in hand.
  emitTruncationSaving(ctx, 'read_summary', path.basename(filePath), content.length, summary.length);
  return `Summary of ${path.basename(filePath)} (${content.length.toLocaleString()} chars). ` +
    `Call read_file for the exact content if you need to edit it.\n\n${summary}`;
}

async function searchFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const query = (args.query as string | undefined) ?? '';
  const name = (args.name as string | undefined)?.trim();
  const pattern = (args.filePattern as string | undefined) ?? '';
  const rawPath = (args.path as string | undefined)?.trim();

  if (!name && !query) {
    return 'Provide "name" to locate a file by its name, or "query" to search file contents.';
  }

  // Resolve the search roots. With an explicit path, validate it lies inside the
  // allowed folders (unchanged). WITHOUT one, sweep EVERY allowed folder in a
  // single ripgrep call — a Work chat can grant many folders, and making the
  // model search them one-by-one burns rounds and bloats context. ripgrep takes
  // multiple path args, so all folders are covered in one process.
  // (Incognito reads anywhere and has no fixed root set, so it still needs an
  // explicit path — there's no sane "search the whole disk" default.)
  let roots: string[];
  if (rawPath) {
    try {
      roots = [validatePath(rawPath, readFolders(ctx))];
    } catch (e) {
      // Don't just bounce the model with a bare error — point it at the cheap
      // fix (omit path → all allowed folders) so it doesn't waste a round
      // guessing another path.
      if (e instanceof SecurityError) {
        const allowed = readFolders(ctx);
        return `Security error: ${e.message}. Tip: omit "path" to search every allowed folder at once` +
          `${allowed.length ? ` (${allowed.join(', ')})` : ''}.`;
      }
      throw e;
    }
  } else {
    const allowed = readFolders(ctx);
    if (allowed.length === 0) {
      return 'Provide a "path" to search — no folder is granted to search across.';
    }
    roots = allowed;
  }

  const excludeGlobs = SEARCH_EXCLUDE_DIRS.flatMap((d) => ['-g', `!**/${d}/**`]);

  // NAME mode: locate files by filename across all roots and return paths only —
  // no content, no per-line context. This is the right primitive for "where is
  // file X" (a content grep for a filename matches every log/trace that mentions
  // it, dumping huge irrelevant lines). `rg --files` lists files honouring our
  // excludes; --iglob filters by name (case-insensitive, friendlier for users).
  if (name) {
    const glob = /[*?]/.test(name) ? name : `*${name}*`;
    const fileArgs = ['--files', '--hidden', '--no-messages', ...excludeGlobs, '--iglob', glob, '--', ...roots];
    let out = '';
    try {
      ({ stdout: out } = await execFileAsync(rgPath, fileArgs, { timeout: COMMAND_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }));
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string; stdout?: string };
      if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
        return 'Search did not finish in time (the tree is large). This is NOT a confirmation that the file is missing — search a more specific subfolder.';
      }
      out = e.stdout ?? '';
    }
    const found = out.trim().split('\n').filter(Boolean).slice(0, 40);
    if (found.length === 0) return 'No files found with that name.';
    const more = out.trim().split('\n').filter(Boolean).length > 40 ? '\n…[more — narrow the name]' : '';
    return found.join('\n') + more;
  }

  // CONTENT mode: find the files that contain `query`. ripgrep skips binary
  // files (videos / photos / archives / office docs) and never follows symlinks
  // for free; we pass our own exclude list as ignore globs so generated/
  // dependency trees are pruned with or without git. This keeps the search fast
  // and — paired with the honest timeout below — truthful (an unscoped grep over
  // a 40GB+ tree used to time out, misreported as "No matches found", i.e. a
  // false "file doesn't exist").
  // --hidden searches dotfiles too (rg still always skips .git); -F = literal
  // (plain substring); --max-filesize guards against slurping a giant file.
  const rgArgs = ['--hidden', '--no-messages', '-l', '-F', '-m', '1',
    '--max-filesize', `${MAX_FILE_BYTES}`,
    ...(pattern ? ['-g', pattern] : []),
    ...excludeGlobs,
    '--', query, ...roots];

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(rgPath, rgArgs, { timeout: COMMAND_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; code?: number; stdout?: string };
    // CRITICAL: a timeout/kill is NOT "no matches". Say so explicitly so the
    // model narrows the search instead of telling the user the file is absent.
    if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
      return (
        `Search did not finish in time (the tree is large` +
        `${pattern ? '' : ' and no filePattern was given, so every file was scanned'}). ` +
        `This is NOT a confirmation that the file is missing. Narrow it: search a more ` +
        `specific subfolder, or pass filePattern (e.g. "*.sh").`
      );
    }
    // ripgrep exits 1 on no matches, 2 on partial read errors (matches on
    // readable files may still be in stdout). Keep whatever it printed.
    stdout = e.stdout ?? '';
  }

  const files = stdout.trim().split('\n').filter(Boolean).slice(0, 20);
  if (files.length === 0) return 'No matches found.';

  // Show matching lines for the first 5 files. Cap matches PER FILE (-m) so a
  // file with thousands of hits can't dump itself into history (resent every
  // round), and clamp the combined output as a backstop.
  const results: string[] = [];
  let trimmedLines = 0; // long match lines ripgrep clamped (markers it printed)
  for (const file of files.slice(0, 5)) {
    // --max-columns caps each match LINE's length: minified JS / JSON / log
    // (.jsonl trace) files can have single lines tens of thousands of chars
    // long, and dumping even a few of them blew the token budget. -preview keeps
    // a short head of the line instead of omitting it outright.
    const { stdout: ctx2 } = await execFileAsync(
      rgPath, ['-n', '--no-messages', '-F', '-m', String(MAX_MATCH_LINES_PER_FILE),
        '--max-columns', '200', '--max-columns-preview', '--', query, file], { timeout: 5000 },
    ).catch(() => ({ stdout: '' }));
    trimmedLines += (ctx2.match(/\[\.\.\. omitted end of long line\]/g) || []).length;
    const trimmed = ctx2.trim();
    const lineCount = trimmed ? trimmed.split('\n').length : 0;
    const more = lineCount >= MAX_MATCH_LINES_PER_FILE ? `\n…[more matches — refine the query]` : '';
    results.push(`${file}:\n${trimmed}${more}`);
  }
  if (files.length > 5) results.push(`...and ${files.length - 5} more files`);
  // Qualitative saving: ripgrep never tells us HOW MANY bytes it dropped from a
  // long line, only that it did. So when several oversized lines were trimmed we
  // post a quantity-free note (no fabricated %), gated so it's not noise.
  if (ctx.onNote && trimmedLines >= 2) {
    ctx.onNote({ kind: 'search', source: 'your files' });
  }
  return clampMiddle(results.join('\n\n'), MAX_CMD_OUTPUT_CHARS);
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (ctx.readOnly) {
    return 'write_file is disabled in Incognito mode. Incognito is read-only and never writes to disk — ' +
      'summarize or return the content in your reply instead.';
  }
  const filePath = validatePath(args.path as string, ctx.allowedFolders);
  const content = args.content as string;

  if (ctx.folderAccess && !isWriteAllowed(filePath, ctx.folderAccess)) {
    return `Write denied: "${filePath}" is in a read-only folder. Ask the user to grant read & write access to this folder.`;
  }

  const approved = await ctx.requestWriteApproval(filePath, content);
  if (!approved) return `Write rejected by user: ${filePath}`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return `Written: ${filePath}`;
}

const SHOW_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const SHOW_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * show_image: hand the host an image file (inside an allowed folder) to render
 * inline in the chat. Path is validated against allowedFolders exactly like
 * write_file — so the model must pass the HOST path it was given for the folder,
 * not a container `/work/N` path. We only signal (via ctx.onImage); the host
 * copies it into the chat's uploads and attaches it to the reply.
 */
function showImage(args: Record<string, unknown>, ctx: ToolContext): string {
  const raw = args.path;
  if (typeof raw !== 'string' || !raw.trim()) return 'show_image needs a "path" to an image file.';
  let filePath: string;
  try {
    filePath = validatePath(raw, ctx.allowedFolders);
  } catch (e) {
    if (e instanceof SecurityError) {
      return `Security error: ${e.message}. Pass the image's path inside an allowed folder` +
        `${ctx.allowedFolders.length ? ` (${ctx.allowedFolders.join(', ')})` : ''} — not a /work/N container path.`;
    }
    throw e;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = SHOW_IMAGE_MIME[ext];
  if (!mime) return `show_image supports image files only (png/jpg/gif/webp/svg); got "${ext || 'no extension'}".`;
  let st: fs.Stats;
  try { st = fs.statSync(filePath); } catch { return `No such file: ${filePath}`; }
  if (!st.isFile()) return `Not a file: ${filePath}`;
  if (st.size === 0) return `That image file is empty: ${filePath}`;
  if (st.size > SHOW_IMAGE_MAX_BYTES) {
    return `Image too large to display (${st.size.toLocaleString()} bytes; max ${SHOW_IMAGE_MAX_BYTES.toLocaleString()}).`;
  }
  if (!ctx.onImage) return 'Showing images inline is not available in this mode.';
  ctx.onImage({ path: filePath, mime, fileName: path.basename(filePath), bytes: st.size });
  return `Displayed ${path.basename(filePath)} to the user in the chat.`;
}

// ── Image generation / editing (OpenRouter, host-side) ───────────────────────
// Mirrors web_fetch/web_search: a host→OpenRouter call on the SAME key the chat
// uses. Nano Banana (google/gemini-2.5-flash-image) both generates from text and
// edits an input image — the cheapest quality option, so it's the hard default;
// override per-op only for a different STYLE via ICLAW_IMAGE_GEN_MODEL /
// ICLAW_IMAGE_EDIT_MODEL.
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const IMAGE_GEN_TIMEOUT_MS = Number(process.env.ICLAW_IMAGE_TIMEOUT_MS) || 120_000;
const IMAGE_GEN_MAX_BYTES = 20 * 1024 * 1024;
// generate_image can take a "prompts" array → all fired AT ONCE (Promise.allSettled).
// Generation is independent (each its own OpenRouter call, own temp file), so it's
// safe to parallelize; the rest of the tool loop stays sequential. Capped to keep
// concurrent OpenRouter requests (and the round's image count) sane.
const IMAGE_GEN_MAX_BATCH = Math.max(1, Number(process.env.ICLAW_IMAGE_MAX_BATCH) || 6);
// edit_image multi-image input. Nano Banana fuses several photos (e.g. put a
// person from one into a scene from another). Gemini's inline request cap is
// ~20MB INCLUDING base64 (which inflates raw bytes by ~4/3), so cap combined RAW
// input at ~14MB to stay safely under it. Count cap is a quality/abuse guard —
// fidelity drops past a handful of inputs.
const IMAGE_EDIT_TOTAL_RAW_BYTES = 14 * 1024 * 1024;
const IMAGE_EDIT_MAX_INPUTS = 8;
// Generated-image data: URL mime → temp-file extension. persistAgentImage on the
// host re-derives the mime from this extension, so it must be one it supports.
const IMAGE_DATA_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
};

type ImageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * POST a chat/completions request with modalities:["image","text"] and pull the
 * first image out of choices[0].message.images[].image_url.url. Returns the raw
 * data: URL, or throws with a user-facing reason.
 */
async function openRouterImage(model: string, content: string | ImageContentPart[]): Promise<string> {
  const key = process.env.ICLAW_OPENROUTER_API_KEY || '';
  if (!key) throw new Error('no OpenRouter API key (ICLAW_OPENROUTER_API_KEY set?) — image generation is unavailable here.');
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_GEN_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}${body ? ` — ${body.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
    }
    const data = await res.json() as {
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
    };
    const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!url || !url.startsWith('data:')) {
      throw new Error(`model "${model}" returned no image (it may not support image output — set ICLAW_IMAGE_GEN_MODEL to one that does).`);
    }
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/** Shared tail for every generate/edit result — kills the "where's my file?"
 *  hunt (chat-453/459): generated images live in chat uploads, OUTSIDE the work
 *  sandbox, so run_command can't see them. */
const GENERATED_IMAGE_NOTE =
  `It's delivered to the user and saved with the chat — you do NOT manage it as a file and CANNOT locate it on ` +
  `disk: generated images live outside the work sandbox, so run_command / find / ls will never see them — do not ` +
  `search. To change one, call edit_image (its path is listed under this chat's photos on your next message); put ` +
  `any framing/background/layout in the prompt. Never paste base64 or a data: URL.`;

/**
 * Decode ONE generated data: URL to a host temp file and signal the host to show
 * it inline (generated:true → not folder-gated; the host deletes the temp after
 * copying it into the chat). Returns the display fileName, or an error string.
 */
function stageGeneratedImage(
  dataUrl: string,
  ctx: ToolContext,
  kind: 'generate_image' | 'edit_image',
): { fileName: string } | { error: string } {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return { error: 'the model returned an unreadable image payload.' };
  const mime = (m[1] || 'image/png').toLowerCase();
  const ext = IMAGE_DATA_EXT[mime] ?? '.png';
  const buf = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'binary');
  if (buf.byteLength === 0) return { error: 'the generated image came back empty.' };
  if (buf.byteLength > IMAGE_GEN_MAX_BYTES) return { error: `the generated image is too large to show (${buf.byteLength.toLocaleString()} bytes).` };
  if (!ctx.onImage) return { error: 'showing images inline is not available in this mode.' };
  // Random suffix on top of the uuid temp path: parallel batch calls land in the
  // same millisecond, so Date.now() alone would collide the display names.
  const fileName = `${kind === 'edit_image' ? 'edited' : 'generated'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  const tmpPath = path.join(os.tmpdir(), `iclaw-img-${crypto.randomUUID()}${ext}`);
  try {
    fs.writeFileSync(tmpPath, buf);
  } catch (e) {
    return { error: `could not save the generated image (${e instanceof Error ? e.message : String(e)}).` };
  }
  ctx.onImage({ path: tmpPath, mime, fileName, bytes: buf.byteLength, generated: true });
  return { fileName };
}

/** Single-image convenience: stage one + the full directive result message. */
function emitGeneratedImage(dataUrl: string, ctx: ToolContext, kind: 'generate_image' | 'edit_image'): string {
  const r = stageGeneratedImage(dataUrl, ctx, kind);
  if ('error' in r) return `${kind}: ${r.error}`;
  return `Created "${r.fileName}" and showed it to the user inline. ${GENERATED_IMAGE_NOTE}`;
}

async function generateImage(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  // Accept "prompt" (one) and/or "prompts" (several → generated in parallel).
  const list: string[] = [];
  if (Array.isArray(args.prompts)) {
    for (const p of args.prompts) if (typeof p === 'string' && p.trim()) list.push(p.trim());
  }
  if (typeof args.prompt === 'string' && args.prompt.trim()) list.push(args.prompt.trim());
  const prompts = [...new Set(list)];
  if (prompts.length === 0) {
    return 'generate_image needs a "prompt" (one image) or "prompts" (an array, several images at once).';
  }
  if (prompts.length > IMAGE_GEN_MAX_BATCH) {
    return `generate_image makes at most ${IMAGE_GEN_MAX_BATCH} images per call (got ${prompts.length}); split the rest into another call.`;
  }
  const model = process.env.ICLAW_IMAGE_GEN_MODEL || DEFAULT_IMAGE_MODEL;

  // One image: simple path + the full directive message.
  if (prompts.length === 1) {
    let dataUrl: string;
    try {
      dataUrl = await openRouterImage(model, prompts[0]!);
    } catch (e) {
      return `generate_image failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    return emitGeneratedImage(dataUrl, ctx, 'generate_image');
  }

  // Several: fire all prompts AT ONCE — each is an independent OpenRouter call,
  // so N images come back in ~one image's time instead of N× sequential.
  // allSettled → one failure doesn't sink the batch; we show what succeeded.
  const settled = await Promise.allSettled(prompts.map((p) => openRouterImage(model, p)));
  let ok = 0;
  const failures: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      const r = stageGeneratedImage(s.value, ctx, 'generate_image');
      if ('error' in r) failures.push(`#${i + 1}: ${r.error}`);
      else ok++;
    } else {
      failures.push(`#${i + 1}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    }
  });
  if (ok === 0) return `generate_image failed for all ${prompts.length} prompts:\n${failures.join('\n')}`;
  const failNote = failures.length ? ` (${failures.length} failed — ${failures.join('; ')})` : '';
  return `Generated ${ok}/${prompts.length} images in parallel and showed them to the user inline${failNote}. ${GENERATED_IMAGE_NOTE}`;
}

async function editImage(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return 'edit_image needs a "prompt" describing the result.';

  // Accept `paths` (array — Nano Banana fuses several photos) and/or a legacy
  // single `path`. Dropped chat photos work too: staging already whitelisted
  // their folder and the "[The user attached…]" notice gives the model the path.
  const rawList: string[] = [];
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) if (typeof p === 'string' && p.trim()) rawList.push(p.trim());
  }
  if (typeof args.path === 'string' && args.path.trim()) rawList.push(args.path.trim());
  const uniqueRaw = [...new Set(rawList)]; // model sometimes repeats a path across both args
  if (uniqueRaw.length === 0) {
    return 'edit_image needs at least one image — pass "paths" (array of image file paths inside an allowed folder) plus a "prompt".';
  }
  if (uniqueRaw.length > IMAGE_EDIT_MAX_INPUTS) {
    return `edit_image takes at most ${IMAGE_EDIT_MAX_INPUTS} input images at once (got ${uniqueRaw.length}); pick the most relevant few.`;
  }

  // Validate + read each image exactly like show_image (real HOST path inside an
  // allowed folder, not a /work/N path), then send them all as image_url blocks.
  const parts: ImageContentPart[] = [{ type: 'text', text: prompt }];
  let totalRaw = 0;
  for (const raw of uniqueRaw) {
    let filePath: string;
    try {
      filePath = validatePath(raw, ctx.allowedFolders);
    } catch (e) {
      if (e instanceof SecurityError) {
        return `Security error on "${raw}": ${e.message}. Pass each image's host path inside an allowed folder` +
          `${ctx.allowedFolders.length ? ` (${ctx.allowedFolders.join(', ')})` : ''}.`;
      }
      throw e;
    }
    const ext = path.extname(filePath).toLowerCase();
    const inMime = SHOW_IMAGE_MIME[ext];
    if (!inMime || inMime === 'image/svg+xml') {
      return `edit_image needs raster images (png/jpg/webp/gif); "${path.basename(filePath)}" is "${ext || 'no extension'}".`;
    }
    let buf: Buffer;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size === 0) return `Not a readable image file: ${filePath}`;
      buf = fs.readFileSync(filePath);
    } catch { return `No such file: ${filePath}`; }
    totalRaw += buf.byteLength;
    if (totalRaw > IMAGE_EDIT_TOTAL_RAW_BYTES) {
      return `Those images are too large combined (over ${Math.round(IMAGE_EDIT_TOTAL_RAW_BYTES / 1024 / 1024)}MB) — use fewer or smaller images.`;
    }
    parts.push({ type: 'image_url', image_url: { url: `data:${inMime};base64,${buf.toString('base64')}` } });
  }

  const model = process.env.ICLAW_IMAGE_EDIT_MODEL || DEFAULT_IMAGE_MODEL;
  let dataUrl: string;
  try {
    dataUrl = await openRouterImage(model, parts);
  } catch (e) {
    return `edit_image failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return emitGeneratedImage(dataUrl, ctx, 'edit_image');
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (ctx.readOnly) {
    return 'edit_file is disabled in Incognito mode (read-only). Return the change in your reply instead.';
  }
  const filePath = validatePath(args.path as string, ctx.allowedFolders);
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  if (!oldStr) return 'edit_file requires old_string — the exact text to replace.';

  if (ctx.folderAccess && !isWriteAllowed(filePath, ctx.folderAccess)) {
    return `Edit denied: "${filePath}" is in a read-only folder. Ask the user to grant read & write access.`;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return `File not found (read it / create with write_file first): ${filePath}`;
  }

  const first = content.indexOf(oldStr);
  if (first === -1) {
    return 'old_string not found. Read the file and copy the exact text to replace (including whitespace/indentation).';
  }
  if (content.indexOf(oldStr, first + oldStr.length) !== -1) {
    return 'old_string is not unique — it appears more than once. Include more surrounding context so it matches exactly one place.';
  }

  const next = content.slice(0, first) + newStr + content.slice(first + oldStr.length);

  // Reuse the write-approval flow; show the resulting full content so the UI
  // diff/preview reflects what will land on disk.
  const approved = await ctx.requestWriteApproval(filePath, next);
  if (!approved) return `Edit rejected by user: ${filePath}`;

  fs.writeFileSync(filePath, next, 'utf-8');
  return `Edited: ${filePath}`;
}

async function runCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  // Validate cwd is inside an allowed folder up front (clear error before we
  // hand off to the sandbox, and the container only mounts allowed folders).
  const cwd = validatePath(args.cwd as string, ctx.allowedFolders);
  const command = args.command as string;

  // No sandbox available → run_command is disabled. We never fall back to host
  // bash, because that can't enforce per-folder read-only. File tools still
  // work (write_file is path-checked on the host).
  if (!ctx.runShell) {
    return 'run_command is unavailable. Shell commands run in a Docker sandbox, which needs both ' +
      '(1) Docker installed and running, and (2) at least one folder explicitly selected for this chat. ' +
      'Ask the user to start Docker and/or add a folder. Meanwhile read_file / search_files / write_file still work.';
  }

  // Background mode: launch detached and return a job id immediately, so work
  // that outlives the foreground timeout (image/video gen, long builds) isn't
  // killed mid-flight. The agent polls with check_job and waits with set_timer.
  if (args.background === true) {
    if (!ctx.startJob) {
      return 'Background commands need the Docker sandbox (same as run_command). It is unavailable here; run the command in the foreground instead.';
    }
    try {
      const jobId = await ctx.startJob(command, cwd);
      return `Started in the background — job_id "${jobId}". It is RUNNING now and will keep running between turns. ` +
        `Do NOT assume it finished: use set_timer to wait (e.g. 30s) and check_job with job_id "${jobId}" to poll its ` +
        `output and exit code. Re-check (shorter waits) until it is DONE.`;
    } catch (err) {
      return `Could not start background job: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // The sandbox mounts read-only folders as :ro, so the kernel — not us —
  // rejects any write outside the read & write folders. Commands may freely
  // read from read-only folders.
  const out = await ctx.runShell(command, cwd);
  // Compress noise (ANSI, progress bars, repeated lines) THEN cap verbose output
  // (test runs, build logs) so the cap keeps real signal, not flooding history.
  const delivered = clampMiddle(compressCommandOutput(out), MAX_CMD_OUTPUT_CHARS);
  // The command's full output is already in hand; if we capped it, that's a real
  // saving (the model would otherwise ingest all of it, every round).
  emitTruncationSaving(ctx, 'run_command', 'command output', out.length, delivered.length);
  return delivered;
}

/** check_job — poll a background command launched by run_command(background:true). */
async function checkJobTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
  if (!jobId) return 'check_job needs a "job_id" (the id run_command returned when you started it in the background).';
  if (!ctx.checkJob) return 'check_job needs the Docker sandbox, which is unavailable here.';
  const raw = await ctx.checkJob(jobId);
  return clampMiddle(compressCommandOutput(raw), MAX_CMD_OUTPUT_CHARS);
}

// ── web_fetch (read-only research) ────────────────────────────────────────────

/** Crude HTML → readable text. Good enough for research summaries, not parsing. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Search-query terms dropped before normalizing (boolean/scope operators + a few
// fillers) so two searches that differ only by operator/word-order collapse to
// the same repeat-signature. Kept tiny on purpose — over-collapsing distinct
// queries would wrongly trip the loop guard.
const SEARCH_STOPWORDS = new Set([
  'or', 'and', 'the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'vs', 'site', 'intitle', 'inurl',
]);

/**
 * Normalize a URL for within-turn fetch dedup AND the loop guard: lowercase the
 * host, drop the `#fragment` (it never changes what a fetch returns), and strip
 * a bare trailing slash. So `…/page`, `…/page/`, and `…/page#overview` collapse
 * to one key — the model can't dodge the repeat-guard by tweaking the anchor.
 */
export function normalizeFetchUrl(raw: string): string {
  try {
    const u = new URL(String(raw).trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith('/') && u.pathname === '/' && !u.search) s = s.slice(0, -1);
    return s;
  } catch {
    return String(raw).trim();
  }
}

// GitHub repo/file *pages* are mostly UI chrome (the awesome-ai-agents repo page
// is ~1.4 MB of nav/file-tree/JS vs a ~220 KB raw README), and htmlToText keeps
// that noise then truncates at 20k — so the actual content gets buried/cut.
// Redirect a repo URL to its raw README and a /blob/ file URL to the raw file, so
// web_fetch pulls clean markdown/source from the first byte. Non-content GitHub
// routes (issues, pull, tree, releases, wiki, user profiles, …) pass through.
// Reddit links get routed to old.reddit.com (server-rendered); other untouched.
const GITHUB_NON_REPO = new Set([
  'features', 'about', 'pricing', 'marketplace', 'sponsors', 'settings', 'notifications',
  'explore', 'topics', 'trending', 'collections', 'events', 'enterprise', 'team', 'login',
  'join', 'search', 'orgs', 'apps', 'security', 'readme', 'site', 'contact', 'customer-stories',
  'solutions', 'resources', 'git-guides', 'mobile',
]);

export function canonicalizeFetchUrl(raw: string): string {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return String(raw).trim(); }
  const host = u.hostname.toLowerCase();

  // GitHub repo/file pages → raw markdown/source.
  if (host === 'github.com' || host === 'www.github.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    // /owner/repo/blob/<ref>/<path...> → raw file (any "view file" link)
    if (seg.length >= 5 && seg[2] === 'blob') {
      const [owner, repo, , ref, ...rest] = seg;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`;
    }
    // /owner/repo (exactly) → raw README on the default branch (HEAD resolves it)
    if (seg.length === 2 && !GITHUB_NON_REPO.has(seg[0]!.toLowerCase())) {
      const [owner, repo] = seg;
      return `https://raw.githubusercontent.com/${owner}/${repo!.replace(/\.git$/, '')}/HEAD/README.md`;
    }
    return raw;
  }

  // Reddit: the JSON API and new-reddit are blocked / JS-only from many IPs
  // (the .json endpoint 403s even with a browser UA; www.reddit returns an empty
  // JS shell). old.reddit.com is server-rendered — the real post AND comments are
  // in the HTML. Route every reddit host there (idempotent), dropping a trailing
  // `.json` (it 403s) and the hash so the variants collapse to one fetch + cache.
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
    u.hostname = 'old.reddit.com';
    // drop a trailing `.json` (403s) and a trailing slash so the www / old /
    // .json / slash variants all collapse to one fetch + cache entry.
    u.pathname = u.pathname.replace(/\.json$/, '').replace(/(.)\/$/, '$1');
    u.hash = '';
    return u.toString();
  }

  return raw;
}

/**
 * Normalize a search query into a repeat-signature for the loop guard: lowercase,
 * strip punctuation/quotes/operators, drop stopwords, then sort the UNIQUE terms.
 * Two searches that differ only by word order, quoting, or a repeated word map to
 * the same key; genuinely different term sets stay distinct (so a real new search
 * isn't blocked).
 */
export function normalizeSearchQuery(raw: string): string {
  const terms = String(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !SEARCH_STOPWORDS.has(t));
  return Array.from(new Set(terms)).sort().join(' ');
}

async function webFetch(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const inputUrl = String(args.url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(inputUrl)) {
    return 'Only absolute http(s) URLs are allowed.';
  }
  // Redirect GitHub repo/file pages to their raw markdown/source before anything
  // else, so the cache + fetch both work on the clean URL.
  const url = canonicalizeFetchUrl(inputUrl);
  const key = normalizeFetchUrl(url);
  const cache = ctx?.fetchCache;

  // Within-turn cache: if we already pulled this page this turn, re-use the body
  // (the model loves to re-fetch the same URL with a tweaked `focus`). We cache
  // the extracted body, not the summary, so a new `focus` re-summarizes from
  // memory with NO network round-trip. Misses go to the network as before;
  // failures are NOT cached, so a transient error can still be retried.
  let text = cache?.get(key);
  const fromCache = text !== undefined;
  let status = 200;
  if (text === undefined) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'iClaw-Incognito/1.0', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      });
      status = res.status;
      const ct = res.headers.get('content-type') || '';
      const raw = await res.text();
      text = /html/i.test(ct) ? htmlToText(raw) : raw.trim();
      cache?.set(key, text);
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError'
        ? `timed out after ${WEB_FETCH_TIMEOUT / 1000}s`
        : err instanceof Error ? err.message : String(err);
      return `Fetch failed (${url}): ${msg}`;
    } finally {
      clearTimeout(timer);
    }
  }

  const note = fromCache ? '(already fetched this turn — served from cache; no new request)\n\n' : '';

  // Summarize by default (cheaper, smaller history); the model opts out with
  // summarize:false when it needs the exact text (lists, numbers, code, quotes).
  if (args.summarize !== false && text) {
    const summary = await summarizeText(text, args.focus ? String(args.focus) : undefined);
    return `${note}Summary of ${url}:\n\n${summary}`;
  }
  if (text.length > WEB_FETCH_MAX_CHARS) {
    text = text.slice(0, WEB_FETCH_MAX_CHARS) + `\n\n[truncated at ${WEB_FETCH_MAX_CHARS} chars]`;
  }
  return `${note}HTTP ${status} — ${url}\n\n${text || '(empty response body)'}`;
}

// ── web_fetch (Secure Mode: fetch runs INSIDE the sandbox) ────────────────────
//
// Same ergonomics as webFetch (canonicalize → clean text → optional cheap summary
// → caps + within-turn cache), but the network fetch itself runs as `curl` inside
// the container via runInSandbox, so it honours the same --network gate as
// run_command. A host-side fetch (the plain webFetch above) would bypass a
// network-OFF sandbox, which is exactly why that one is never exposed to Secure.
// The optional summary is a host→OpenRouter call — the same trusted channel as
// the chat stream — so it doesn't widen the sandbox boundary.

/**
 * Build the sandbox curl command. Body → temp file (-o), headers → temp (-D),
 * status+content-type → stdout via -w (captured into $meta). We echo the META
 * marker line FIRST, then `head -c` the body, so even a huge page that overruns
 * the `docker exec` stdout buffer still yields the status/type plus the head of
 * the body. The URL is single-quoted (shQuote) so a model-chosen URL can't break
 * out of the shell ($(), backticks, ;). Every step is guarded so we exit 0 with a
 * parseable result (curl's --max-time bounds it below CONTAINER_TIMEOUT).
 */
function buildCurlFetchCommand(url: string): string {
  const secs = Math.round(WEB_FETCH_TIMEOUT / 1000);
  return [
    'B=$(mktemp); H=$(mktemp)',
    `meta=$(curl -sSL --max-time ${secs} --compressed ` +
      `-A 'iClaw-Secure/1.0' ` +
      `-H 'Accept: text/html,application/json;q=0.9,*/*;q=0.8' ` +
      `-o "$B" -D "$H" -w '%{http_code} %{content_type}' ${shQuote(url)}) ` +
      `|| { echo "${CURL_ERR_MARKER}exit $?"; rm -f "$B" "$H"; exit 0; }`,
    `echo "${CURL_META_MARKER}$meta"`,
    `head -c ${WEB_FETCH_SANDBOX_BODY_CAP} "$B"`,
    'rm -f "$B" "$H"',
  ].join('\n');
}

/** Parse buildCurlFetchCommand output: a leading META marker line + body, or an ERR marker. */
function parseCurlFetch(raw: string): { body: string; status: number; contentType: string; error?: string } {
  const errIdx = raw.indexOf(CURL_ERR_MARKER);
  if (errIdx !== -1) {
    const after = raw.slice(errIdx + CURL_ERR_MARKER.length).trim().slice(0, 200);
    return { body: '', status: 0, contentType: '', error: `curl failed (${after || 'network error'})` };
  }
  const idx = raw.indexOf(CURL_META_MARKER);
  if (idx === -1) return { body: '', status: 0, contentType: '', error: raw.trim().slice(0, 200) || 'no response' };
  const after = raw.slice(idx + CURL_META_MARKER.length);
  const nl = after.indexOf('\n');
  const metaLine = (nl === -1 ? after : after.slice(0, nl)).trim();
  const body = nl === -1 ? '' : after.slice(nl + 1);
  const sp = metaLine.indexOf(' ');
  const status = Number(sp === -1 ? metaLine : metaLine.slice(0, sp)) || 0;
  const contentType = sp === -1 ? '' : metaLine.slice(sp + 1).trim();
  return { body, status, contentType };
}

export async function webFetchSandboxed(
  args: Record<string, unknown>,
  deps: {
    runInSandbox: (command: string) => Promise<string>;
    networkEnabled: boolean;
    fetchCache?: Map<string, string> | undefined;
  },
): Promise<string> {
  const inputUrl = String(args.url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(inputUrl)) return 'Only absolute http(s) URLs are allowed.';
  if (!deps.networkEnabled) {
    return 'web_fetch needs network, which is currently OFF for this chat. Ask the user to enable network, then retry.';
  }
  // GitHub repo/file → raw, reddit → old.reddit, before cache + fetch (as host webFetch).
  const url = canonicalizeFetchUrl(inputUrl);
  const key = normalizeFetchUrl(url);
  const cache = deps.fetchCache;

  let text = cache?.get(key);
  const fromCache = text !== undefined;
  let status = 200;
  if (text === undefined) {
    let raw: string;
    try {
      raw = await deps.runInSandbox(buildCurlFetchCommand(url));
    } catch (err) {
      return `Fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`;
    }
    const parsed = parseCurlFetch(raw);
    if (parsed.error) return `Fetch failed (${url}): ${parsed.error}`;
    status = parsed.status || 200;
    text = /html/i.test(parsed.contentType) ? htmlToText(parsed.body) : parsed.body.trim();
    cache?.set(key, text);
  }

  const note = fromCache ? '(already fetched this turn — served from cache; no new request)\n\n' : '';
  if (args.summarize !== false && text) {
    const summary = await summarizeText(text, args.focus ? String(args.focus) : undefined);
    return `${note}Summary of ${url}:\n\n${summary}`;
  }
  if (text.length > WEB_FETCH_MAX_CHARS) {
    text = text.slice(0, WEB_FETCH_MAX_CHARS) + `\n\n[truncated at ${WEB_FETCH_MAX_CHARS} chars]`;
  }
  return `${note}HTTP ${status} — ${url}\n\n${text || '(empty response body)'}`;
}

// ── cheap-model summarizer (read_summary, web_fetch summarize) ────────────────

/**
 * Summarize text with a cheap model via OpenRouter. Faithful + dense; preserves
 * exact names/numbers. Degrades gracefully to a truncation if there's no key or
 * the call fails, so callers always get usable output.
 */
async function summarizeText(text: string, focus?: string): Promise<string> {
  const key = process.env.ICLAW_OPENROUTER_API_KEY || '';
  if (!key || !text.trim()) return clampMiddle(text, MAX_CMD_OUTPUT_CHARS);
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const input = text.length > SUMMARY_MAX_INPUT_CHARS ? text.slice(0, SUMMARY_MAX_INPUT_CHARS) : text;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You compress a document for another AI agent. Produce a dense, faithful summary: ' +
              'what it is, its structure, and the key facts. Preserve exact names, numbers, paths and ' +
              'identifiers. No preamble, no fluff. If the input was truncated, say so at the end.',
          },
          { role: 'user', content: (focus ? `Focus on: ${focus}\n\n---\n` : '') + input },
        ],
      }),
    });
    if (!res.ok) throw new Error(`summary HTTP ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const out = data.choices?.[0]?.message?.content;
    return (typeof out === 'string' && out.trim())
      ? out.trim() + (text.length > SUMMARY_MAX_INPUT_CHARS ? '\n\n[note: input was truncated before summarizing]' : '')
      : clampMiddle(text, MAX_CMD_OUTPUT_CHARS);
  } catch {
    return clampMiddle(text, MAX_CMD_OUTPUT_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

// ── web_search (OpenRouter by default, DuckDuckGo as keyless fallback) ────────

interface SearchHit { title: string; url: string; snippet: string }

function formatHits(query: string, hits: SearchHit[], provider: string): string {
  if (hits.length === 0) return `No results for "${query}".`;
  const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`);
  return `Web search (${provider}) — "${query}":\n\n${lines.join('\n\n')}`;
}

/**
 * Zero-config default: use OpenRouter's built-in web search via the SAME key the
 * runtime already uses for chat — no separate search account/key to set up. The
 * `web` plugin runs a search and the response carries `url_citation` annotations
 * (title/url/snippet). Costs a small per-result fee on the user's existing
 * OpenRouter credits.
 */
async function openRouterSearch(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.ICLAW_OPENROUTER_API_KEY || '';
  if (!key) throw new Error('no OpenRouter key');
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = process.env.ICLAW_SEARCH_MODEL || process.env.ICLAW_MODEL || 'minimax/minimax-m2.7';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      plugins: [{ id: 'web', max_results: count }],
      messages: [{ role: 'user', content: `Find the most relevant, recent web results for: ${query}` }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = await res.json() as {
    choices?: { message?: { annotations?: { type?: string; url_citation?: { url?: string; title?: string; content?: string } }[] } }[];
  };
  const anns = data.choices?.[0]?.message?.annotations ?? [];
  return anns
    .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
    .map((a) => ({
      title: a.url_citation!.title || a.url_citation!.url!,
      url: a.url_citation!.url!,
      snippet: (a.url_citation!.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }))
    .slice(0, count);
}

async function duckDuckGoSearch(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]> {
  const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(u, { signal, headers: { 'User-Agent': 'Mozilla/5.0 iClaw-Incognito/1.0' } });
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < count) {
    let url = m[1]!;
    const uddg = /[?&]uddg=([^&]+)/.exec(url); // DDG wraps links in a redirect
    if (uddg) url = decodeURIComponent(uddg[1]!);
    const title = m[2]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (url.startsWith('http')) hits.push({ title, url, snippet: '' });
  }
  return hits;
}

async function webSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) return 'web_search requires a query.';
  const count = Math.min(10, Math.max(1, Number(args.count) || 6));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT);
  try {
    // 1) OpenRouter web search — the zero-config default (reuses the chat key).
    if (process.env.ICLAW_OPENROUTER_API_KEY) {
      try {
        const hits = await openRouterSearch(query, count, ctrl.signal);
        if (hits.length) return formatHits(query, hits, 'OpenRouter');
      } catch { /* fall through */ }
    }
    // 2) Keyless last resort.
    return formatHits(query, await duckDuckGoSearch(query, count, ctrl.signal), 'DuckDuckGo');
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? `timed out after ${WEB_FETCH_TIMEOUT / 1000}s`
      : err instanceof Error ? err.message : String(err);
    return `Search failed for "${query}": ${msg}.`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * web_search for Secure Mode. Uses ONLY the OpenRouter web plugin: the search
 * runs on OpenRouter's servers, so the host makes the same kind of API call it
 * already makes for the chat stream — no arbitrary host-side egress, and no
 * DuckDuckGo fallback (that one fetches from the host and would dodge the
 * sandbox's network gate). Gated on networkEnabled so a network-OFF chat does no
 * web research.
 */
export async function webSearchSecure(
  args: Record<string, unknown>,
  deps: { networkEnabled: boolean },
): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) return 'web_search requires a query.';
  if (!deps.networkEnabled) {
    return 'web_search needs network, which is currently OFF for this chat. Ask the user to enable network, then retry.';
  }
  if (!process.env.ICLAW_OPENROUTER_API_KEY) {
    return 'web_search is unavailable here (no OpenRouter key configured). Use run_command with curl for a specific API instead.';
  }
  const count = Math.min(10, Math.max(1, Number(args.count) || 6));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_FETCH_TIMEOUT);
  try {
    return formatHits(query, await openRouterSearch(query, count, ctrl.signal), 'OpenRouter');
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? `timed out after ${WEB_FETCH_TIMEOUT / 1000}s`
      : err instanceof Error ? err.message : String(err);
    return `Search failed for "${query}": ${msg}.`;
  } finally {
    clearTimeout(timer);
  }
}

// ── analyze_link (sandboxed link → content extraction) ───────────────────────
//
// Engine: yt-dlp (1000+ site extractors → easy to grow past YouTube). Shipped as
// a self-contained binary self-installed into /workspace/.tools/bin on first use
// — deliberately NOT baked into the image (keeps it lean; the binary persists in
// the workspace across container restarts, like uv). All network egress happens
// inside the sandbox via the injected runInSandbox callback, so it honours the
// same container network gate as run_command.

const ANALYZE_LINK_FULL_MAX_CHARS = Number(process.env.ICLAW_ANALYZE_LINK_MAX) || 16_000;
// Subtitle language priority (yt-dlp glob syntax). Tunable; first available wins.
const ANALYZE_LINK_SUB_LANGS = process.env.ICLAW_ANALYZE_LINK_LANGS || 'en.*,uk.*';
// Only surface a "saved N%" note when the win is real: the transcript is at
// least this long AND we trimmed at least this fraction. Avoids noise on clips.
const ANALYZE_LINK_SAVINGS_MIN_CHARS = 2_000;
const ANALYZE_LINK_SAVINGS_MIN_PCT = 25;

/** Single-quote a string for safe embedding in a bash command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Pull the 11-ish-char video id out of any YouTube URL shape, else null. */
function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      if (m) return m[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * WebVTT → dense plain text. Drops the header, cue timestamps/ids and inline
 * styling tags, and de-duplicates consecutive identical lines (YouTube
 * auto-captions emit each segment twice — once styled, once plain).
 */
function cleanVtt(vtt: string): string {
  const out: string[] = [];
  let last = '';
  for (const raw of vtt.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^WEBVTT/.test(raw)) continue;
    if (/^(Kind|Language):/i.test(raw)) continue;
    if (raw.includes('-->')) continue; // timestamp cue line
    if (/^\d+$/.test(raw.trim())) continue; // numeric cue id
    const line = raw
      .replace(/<[^>]+>/g, '') // inline <00:00.000> / <c> tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .trim();
    if (!line || line === last) continue;
    out.push(line);
    last = line;
  }
  return out.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Bash run inside the sandbox: ensure yt-dlp, fetch subtitles (+ info json) for
 * the video without downloading it, then print a marker-delimited payload the
 * host parses. `set -e`-safe: every fallible step is guarded so we always exit 0
 * with a parseable result (success, no-subs, or install error).
 */
function buildYouTubeSubsCommand(videoId: string, url: string): string {
  const out = `/workspace/.cache/links/${videoId}`; // videoId is [\w-]-validated
  return [
    'set -e',
    'BIN=/workspace/.tools/bin',
    'mkdir -p "$BIN" /workspace/.cache/links',
    'export PATH="$BIN:$PATH"',
    // Install yt-dlp if missing OR if a cached binary can\'t actually run (e.g. a
    // wrong-arch download from a previous version) — self-heals the stale binary.
    'if ! (command -v yt-dlp >/dev/null 2>&1 && yt-dlp --version >/dev/null 2>&1); then',
    // Pick the binary matching the container arch. yt-dlp_linux is x86_64-only;
    // arm64 containers (e.g. Docker on Apple Silicon) need the aarch64 build.
    '  case "$(uname -m)" in aarch64|arm64) YDL=yt-dlp_linux_aarch64 ;; armv7l|armhf) YDL=yt-dlp_linux_armv7l ;; *) YDL=yt-dlp_linux ;; esac',
    '  curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YDL" -o "$BIN/yt-dlp" 2>/dev/null && chmod +x "$BIN/yt-dlp" || { echo "__ERR__ could not download yt-dlp (network blocked?)"; exit 0; }',
    '  hash -r 2>/dev/null || true',
    '  yt-dlp --version >/dev/null 2>&1 || { echo "__ERR__ yt-dlp not runnable after install (arch=$(uname -m))"; exit 0; }',
    'fi',
    `OUT=${shQuote(out)}`,
    'rm -f "$OUT"*.vtt "$OUT".info.json 2>/dev/null || true',
    `ERR=$(yt-dlp --quiet --no-warnings --skip-download --write-subs --write-auto-subs --write-info-json --sub-langs ${shQuote(ANALYZE_LINK_SUB_LANGS)} --sub-format vtt -o "$OUT.%(ext)s" ${shQuote(url)} 2>&1) || true`,
    'f=$(ls "$OUT"*.vtt 2>/dev/null | head -1)',
    'if [ -n "$f" ]; then',
    '  echo "__META__"',
    '  jq -r \'[.title, .uploader, .duration_string] | map(select(. != null)) | join(" | ")\' "$OUT.info.json" 2>/dev/null || true',
    '  echo "__VTT__"',
    '  cat "$f"',
    'else',
    '  echo "__NOSUBS__"',
    '  echo "$ERR" | tail -n 5',
    'fi',
  ].join('\n');
}

/**
 * analyze_link implementation. `runInSandbox` runs a bash command inside the
 * session's container; `networkEnabled` mirrors the chat's network gate.
 */
export async function analyzeLink(
  args: Record<string, unknown>,
  deps: {
    runInSandbox: (command: string) => Promise<string>;
    networkEnabled: boolean;
    onNote?: ((note: SavingsNote) => void) | undefined;
  },
): Promise<string> {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return 'analyze_link needs an absolute http(s) URL.';
  const mode = args.mode === 'full' ? 'full' : 'summary';
  const purpose = args.purpose ? String(args.purpose) : undefined;

  if (!deps.networkEnabled) {
    return 'analyze_link needs network, which is currently OFF for this chat. Ask the user to enable network, then retry.';
  }

  const videoId = extractYouTubeId(url);
  if (!videoId || !/^[\w-]{6,}$/.test(videoId)) {
    return 'analyze_link currently supports only YouTube video links. For web pages or articles, use web_fetch instead.';
  }

  let raw: string;
  try {
    raw = await deps.runInSandbox(buildYouTubeSubsCommand(videoId, url));
  } catch (err) {
    return `analyze_link failed to run in the sandbox: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (raw.includes('__ERR__')) {
    return `analyze_link: ${(raw.split('__ERR__')[1] ?? '').trim().slice(0, 300) || 'sandbox error'}`;
  }
  if (raw.includes('__NOSUBS__') || (!raw.includes('__VTT__'))) {
    const detail = (raw.split('__NOSUBS__')[1] ?? raw).trim().slice(0, 250);
    const blocked = /sign in|confirm.*bot|429|HTTP Error 403|blocked|not a bot/i.test(detail);
    return blocked
      ? `analyze_link: YouTube blocked the request from the sandbox IP, or the video is restricted. ${detail}`
      : `analyze_link: no subtitles available in ${ANALYZE_LINK_SUB_LANGS} (video may have none, or only other languages). ${detail}`;
  }

  const meta = raw.includes('__META__') ? (raw.split('__META__')[1] ?? '').split('__VTT__')[0]!.trim() : '';
  const transcript = cleanVtt(raw.split('__VTT__')[1] ?? '');
  if (!transcript) return 'analyze_link: subtitles were fetched but empty after cleanup.';
  const header = meta ? `Video: ${meta}\n\n` : '';

  if (mode === 'full') {
    const body =
      transcript.length > ANALYZE_LINK_FULL_MAX_CHARS
        ? transcript.slice(0, ANALYZE_LINK_FULL_MAX_CHARS) +
          `\n\n…[truncated ${(transcript.length - ANALYZE_LINK_FULL_MAX_CHARS).toLocaleString()} chars — re-call with mode:"summary" and a purpose]`
        : transcript;
    return `${header}Transcript (${transcript.length.toLocaleString()} chars):\n\n${body}`;
  }

  const summary = await summarizeText(transcript, purpose);

  // Cost win: the main model ingests this short summary instead of the whole
  // transcript (which it would also re-read every subsequent round). Surface the
  // saving as a chat note. Char-count is a transparent token proxy; gate on a
  // real win so we don't post noise for tiny clips.
  if (deps.onNote && transcript.length >= ANALYZE_LINK_SAVINGS_MIN_CHARS && summary.length < transcript.length) {
    const savedPct = Math.round((1 - summary.length / transcript.length) * 100);
    if (savedPct >= ANALYZE_LINK_SAVINGS_MIN_PCT) {
      deps.onNote({
        kind: 'analyze_link',
        source: 'video transcript',
        savedPct,
        fullChars: transcript.length,
        deliveredChars: summary.length,
      });
    }
  }

  return `${header}Transcript summary${purpose ? ` (focus: ${purpose})` : ''}:\n\n${summary}`;
}
