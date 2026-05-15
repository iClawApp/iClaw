/** Human-readable status for an OpenClaw / OpenAI tool name. */
export function toolActivityLabel(name: string): string {
  const n = name.toLowerCase();

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
