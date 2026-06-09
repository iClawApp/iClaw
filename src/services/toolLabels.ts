/** Human-readable status for an iClaw-runtime / OpenClaw / OpenAI tool name. */
export function toolActivityLabel(name: string): string {
  const n = name.toLowerCase();

  // Exact matches for iClaw's own runtime tools — checked first so a specific
  // tool (e.g. social_search) doesn't fall into the generic "search" bucket.
  switch (n) {
    case 'social_search': return 'Searching social media…';
    case 'web_search': return 'Searching the web…';
    case 'web_fetch': return 'Reading the web…';
    case 'read_summary': return 'Skimming a file…';
    case 'analyze_link': return 'Analyzing the link…';
    case 'show_image': return 'Sharing an image…';
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
export function toolActivityDetail(_name: string, input: unknown): string | undefined {
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
  } else if (str(a.name)) {
    raw = str(a.name);
  }
  if (!raw) return undefined;

  raw = raw.replace(/\s+/g, ' ');
  return raw.length > 70 ? raw.slice(0, 69) + '…' : raw;
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
