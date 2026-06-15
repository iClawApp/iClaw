/** Human-readable status for an iClaw-runtime / OpenClaw / OpenAI tool name. */
export function toolActivityLabel(name: string): string {
  const n = name.toLowerCase();

  // Exact matches for iClaw's own runtime tools — checked first so a specific
  // tool (e.g. social_search) doesn't fall into the generic "search" bucket.
  switch (n) {
    case 'deep_research': return 'Researching in depth…';
    case 'recall_tool_output': return 'Recalling an earlier result…';
    case 'social_search': return 'Searching social media…';
    case 'web_search': return 'Searching the web…';
    case 'web_fetch': return 'Reading the web…';
    case 'read_summary': return 'Skimming a file…';
    case 'analyze_link': return 'Analyzing the link…';
    case 'show_image': return 'Sharing an image…';
    case 'generate_image': return 'Generating an image…';
    case 'edit_image': return 'Editing the image…';
    case 'search_files': return 'Searching files…';
    case 'list_files': return 'Listing files…';
    case 'read_file': return 'Reading a file…';
    case 'write_file': return 'Writing a file…';
    case 'edit_file': return 'Editing a file…';
    case 'run_command': return 'Running a command…';
  }

  if (/web.?search|internet.?search|search|grep|find|lookup|browse/.test(n)) {
    return 'Searching…';
  }
  if (/edit|write|patch|apply|create.?file|save/.test(n)) {
    return 'Editing file…';
  }
  if (/read|cat|head|tail|view.?file|open.?file/.test(n)) {
    return 'Reading file…';
  }
  if (/bash|shell|exec|command|run|terminal|process/.test(n)) {
    return 'Running command…';
  }
  if (/think|reason|plan/.test(n)) {
    return 'Thinking…';
  }
  if (/list|ls|glob|dir/.test(n)) {
    return 'Listing files…';
  }

  const pretty = name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return (pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : name) + '…';
}

/**
 * Short, safe "detail" for the expandable activity status — the actual query /
 * URL / command / path the tool is working on (e.g. "Searching social media…"
 * → "r/LocalLLaMA"). Pulled only from well-known arg fields and capped, so we
 * never dump a large or unexpected input into the UI. Returns undefined when
 * there's nothing useful to show.
 */
export function toolActivityDetail(
  _name: string,
  input: unknown,
  /** Applied to the extracted text BEFORE the 70-char clip — clipping after
   *  redaction can't split a secret into an unmatchable prefix. */
  redact?: (s: string) => string,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const a = input as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  let raw: string | undefined;
  if (str(a.query)) {
    raw = str(a.query);
  } else if (str(a.command)) {
    raw = str(a.command);
  } else if (str(a.url)) {
    const u = str(a.url)!;
    try {
      const parsed = new URL(u);
      raw = parsed.host + parsed.pathname.replace(/\/$/, '');
    } catch {
      raw = u;
    }
  } else if (str(a.path)) {
    raw = str(a.path);
  } else if (str(a.prompt)) {
    // generate_image: surface a snippet of the image description as the detail.
    raw = str(a.prompt);
  } else if (Array.isArray(a.prompts) && typeof a.prompts[0] === 'string') {
    // generate_image batch: first prompt + how many in the parallel batch.
    raw = a.prompts.length > 1 ? `${a.prompts[0]} (+${a.prompts.length - 1} more)` : a.prompts[0];
  } else if (str(a.name)) {
    raw = str(a.name);
  }
  if (!raw) return undefined;

  if (redact) raw = redact(raw);
  raw = raw.replace(/\s+/g, ' ');
  return raw.length > 70 ? raw.slice(0, 69) + '…' : raw;
}

/**
 * Failure shapes of iClaw-runtime tool results. Mirrors the runtime's own
 * "nothing useful" prefixes (loop.ts isLowValueResult) plus file-tool errors and
 * the shell exit/timeout markers — keep in sync when runtime tools change how
 * they report failure.
 */
const TOOL_RESULT_ERROR_RE =
  /^(Error\b|error:|Fetch failed|Search failed|Guardrail:|No results for|No files found|\(empty|Only absolute http|Security error:|File not found|old_string |edit_file requires|run_command is unavailable|Refused:|HTTP [45]\d\d\b)/;
const TOOL_RESULT_VERDICT_RE = /^\[(exit code |command killed )/;

/**
 * Classify a finished tool call from its result text: did it succeed, and what
 * one-line verdict should the persisted trace carry? The verdict prefers an
 * explicit shell marker line ("[exit code 128 — command FAILED]", "[command
 * killed after 60s …]") anywhere in the output, then the first line carrying a
 * word character (a leading "{" of a JSON body says nothing — the next line,
 * e.g. `"message": "Bad credentials"`, is the actual signal).
 * Heuristic by design — when nothing matches, the call counts as ok.
 */
export function toolOutcome(result: string): { ok: boolean; outcome: string } {
  const text = String(result ?? '');
  const lines = text.split('\n');
  const marker = lines.find((l) => TOOL_RESULT_VERDICT_RE.test(l.trim()));
  const firstWordy = lines.find((l) => /[A-Za-z0-9]/.test(l));
  const firstLine = lines.find((l) => l.trim()) ?? '';
  const pick = (marker ?? firstWordy ?? firstLine).trim().replace(/\s+/g, ' ');
  const ok =
    !marker &&
    !TOOL_RESULT_ERROR_RE.test(text.trimStart()) &&
    !/\btimed out after\b/.test(text) &&
    !/did NOT finish/.test(text);
  return { ok, outcome: pick.length > 140 ? pick.slice(0, 139) + '…' : pick };
}

/** Human-readable label for gateway lifecycle phases. */
export function lifecycleActivityLabel(phase: string): string {
  switch (phase) {
    case 'thinking':
      return 'Thinking…';
    case 'start':
      return 'Starting…';
    case 'end':
      return 'Finishing…';
    default:
      return phase.charAt(0).toUpperCase() + phase.slice(1) + '…';
  }
}
