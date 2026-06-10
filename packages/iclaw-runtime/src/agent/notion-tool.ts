/**
 * Notion tools for Roles — host-side.
 *
 * These run in the runtime process, NOT inside the role's container, so the box
 * never needs network egress to Notion: the only thing that ever talks to
 * api.notion.com is this file, with the one verified token the user connected.
 * That makes the egress story airtight (exactly one destination, one tool) and
 * keeps the container offline.
 *
 * The agent thinks in plain tables — columns and rows — and we translate to
 * Notion's verbose typed-property API here. Exposed to a turn only when a
 * verified token is present (read from ToolContext, never from history/args).
 */

const NOTION_VERSION = '2022-06-28';
const BASE = 'https://api.notion.com/v1';
const MAX_CELL = 2000; // Notion rich_text hard cap per text object.

type Json = Record<string, unknown>;

async function notionFetch(token: string, method: string, path: string, body?: Json): Promise<Json> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data: Json = {};
  try {
    data = text ? (JSON.parse(text) as Json) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = typeof data.message === 'string' ? data.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Plain-table → Notion typed-property translation ──────────────────────────

type ColType = 'title' | 'text' | 'select' | 'multi_select' | 'date' | 'number' | 'checkbox' | 'url';

/** The empty schema object Notion wants when CREATING a property of each type. */
function propertySchema(type: string): Json {
  switch (type) {
    case 'title': return { title: {} };
    case 'select': return { select: {} };
    case 'multi_select': return { multi_select: {} };
    case 'date': return { date: {} };
    case 'number': return { number: {} };
    case 'checkbox': return { checkbox: {} };
    case 'url': return { url: {} };
    case 'text':
    default: return { rich_text: {} };
  }
}

/** A single cell value → the property payload Notion wants when WRITING a row. */
function valuePayload(type: string, value: unknown): Json {
  const s = value == null ? '' : String(value);
  switch (type) {
    case 'title': return { title: [{ type: 'text', text: { content: s.slice(0, MAX_CELL) } }] };
    case 'select': return s ? { select: { name: s.slice(0, 100) } } : { select: null };
    case 'multi_select': {
      const arr = Array.isArray(value) ? value.map(String) : s.split(',').map((x) => x.trim());
      return { multi_select: arr.filter(Boolean).slice(0, 100).map((name) => ({ name: name.slice(0, 100) })) };
    }
    case 'date': return s ? { date: { start: s } } : { date: null };
    case 'number': { const n = Number(value); return { number: Number.isFinite(n) ? n : null }; }
    case 'checkbox': return { checkbox: value === true || s.toLowerCase() === 'true' };
    case 'url': return { url: s || null };
    case 'rich_text':
    case 'text':
    default: return { rich_text: [{ type: 'text', text: { content: s.slice(0, MAX_CELL) } }] };
  }
}

/** Best-effort human title for a page/database object from a Notion search hit. */
function extractTitle(obj: Json): string {
  // Top-level pages: title lives under properties.<name>.title[].plain_text.
  const props = obj.properties as Record<string, Json> | undefined;
  if (props) {
    for (const p of Object.values(props)) {
      if (p && (p as Json).type === 'title') {
        const arr = (p as Json).title as { plain_text?: string }[] | undefined;
        const t = arr?.map((x) => x.plain_text ?? '').join('').trim();
        if (t) return t;
      }
    }
  }
  // Databases: title is a top-level rich-text array.
  const dbTitle = obj.title as { plain_text?: string }[] | undefined;
  if (Array.isArray(dbTitle)) {
    const t = dbTitle.map((x) => x.plain_text ?? '').join('').trim();
    if (t) return t;
  }
  return '(untitled)';
}

// ── Tool schemas (sent to the model when a Notion token is present) ───────────

export const NOTION_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'notion_search',
      description:
        'Find Notion pages and databases shared with this integration. CALL THIS FIRST: you need a page_id to create your deliverable under (the integration can only write inside pages the user has shared with it). Returns id, title, and type for each hit.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional text to filter by title. Omit to list everything shared.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'notion_create_database',
      description:
        'Create a new Notion database (a table) under a parent page. Define columns as {name, type}. Exactly one column must be type "title" (the row name) — if you omit it, the first column becomes the title. Returns the new database_id and its URL.',
      parameters: {
        type: 'object',
        properties: {
          parent_page_id: { type: 'string', description: 'A page_id from notion_search to create the database under.' },
          title: { type: 'string', description: 'The database title, e.g. "October Content Plan".' },
          columns: {
            type: 'array',
            description: 'Column definitions in order.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: {
                  type: 'string',
                  enum: ['title', 'text', 'select', 'multi_select', 'date', 'number', 'checkbox', 'url'],
                },
              },
              required: ['name', 'type'],
            },
          },
        },
        required: ['parent_page_id', 'title', 'columns'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'notion_add_row',
      description:
        'Add one row to a database created with notion_create_database. Pass cells as a flat object keyed by column name, e.g. {"Title":"…","Channel":"LinkedIn","Week":"2026-06-15"}. Values are coerced to each column\'s type automatically; unknown columns are ignored. Returns the new row\'s URL.',
      parameters: {
        type: 'object',
        properties: {
          database_id: { type: 'string', description: 'The database_id returned by notion_create_database.' },
          cells: { type: 'object', description: 'Column name → value. Multi-select takes a comma string or an array.' },
        },
        required: ['database_id', 'cells'],
      },
    },
  },
];

export type NotionToolName = 'notion_search' | 'notion_create_database' | 'notion_add_row';

/** A database we created this turn — surfaced as the run's deliverable. */
export interface NotionDeliverable {
  databaseId: string;
  url: string;
  title: string;
  rows: number;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Execute a Notion tool call. `onDeliverable` (optional) is invoked when a
 * database is created or a row is added, so the run flow can track the final
 * deliverable URL + row count to show the user for review.
 */
export async function executeNotionTool(
  name: NotionToolName,
  args: Record<string, unknown>,
  token: string | undefined,
  onDeliverable?: (d: NotionDeliverable) => void,
): Promise<string> {
  if (!token) {
    return 'Notion is not connected for this role. Ask the user to connect it, then retry.';
  }
  try {
    switch (name) {
      case 'notion_search': {
        const query = typeof args.query === 'string' ? args.query : undefined;
        const data = await notionFetch(token, 'POST', '/search', {
          query: query || undefined,
          page_size: 12,
        });
        const results = (Array.isArray(data.results) ? data.results : []) as Json[];
        if (results.length === 0) {
          return 'No pages shared with this integration yet. Ask the user to open a Notion page, click ••• → Connections, and add this integration — then retry.';
        }
        const lines = results.map((r) => {
          const kind = r.object === 'database' ? 'database' : 'page';
          return `- ${extractTitle(r)} — ${kind} — id: ${String(r.id)}`;
        });
        return `Shared with this integration:\n${lines.join('\n')}\n\nUse a page id as parent_page_id for notion_create_database.`;
      }

      case 'notion_create_database': {
        const parentPageId = String(args.parent_page_id ?? '').trim();
        const title = String(args.title ?? '').trim() || 'Untitled';
        const rawCols = Array.isArray(args.columns) ? (args.columns as Json[]) : [];
        if (!parentPageId) return 'parent_page_id is required — call notion_search first to get one.';
        if (rawCols.length === 0) return 'Provide at least one column ({name, type}).';

        const cols: { name: string; type: ColType }[] = rawCols.map((c) => ({
          name: String((c as Json).name ?? '').trim() || 'Field',
          type: (String((c as Json).type ?? 'text') as ColType),
        }));
        if (!cols.some((c) => c.type === 'title')) cols[0]!.type = 'title';

        const properties: Json = {};
        const seen = new Set<string>();
        for (const c of cols) {
          let nm = c.name;
          while (seen.has(nm)) nm = `${nm} `;
          seen.add(nm);
          properties[nm] = propertySchema(c.type);
        }

        const data = await notionFetch(token, 'POST', '/databases', {
          parent: { type: 'page_id', page_id: parentPageId },
          title: [{ type: 'text', text: { content: title.slice(0, MAX_CELL) } }],
          properties,
        });
        const id = String(data.id ?? '');
        const url = typeof data.url === 'string' ? data.url : '';
        onDeliverable?.({ databaseId: id, url, title, rows: 0 });
        return `Created database "${title}" (database_id: ${id}). URL: ${url}\nNow add rows with notion_add_row.`;
      }

      case 'notion_add_row': {
        const databaseId = String(args.database_id ?? '').trim();
        const cells = (args.cells && typeof args.cells === 'object' ? args.cells : {}) as Record<string, unknown>;
        if (!databaseId) return 'database_id is required (from notion_create_database).';
        if (Object.keys(cells).length === 0) return 'cells is empty — pass a {column: value} object.';

        const db = await notionFetch(token, 'GET', `/databases/${databaseId}`);
        const schema = (db.properties ?? {}) as Record<string, { type?: string }>;
        const properties: Json = {};
        let mapped = 0;
        for (const [colName, value] of Object.entries(cells)) {
          const type = schema[colName]?.type;
          if (!type) continue; // ignore columns that aren't in the schema
          properties[colName] = valuePayload(type, value);
          mapped++;
        }
        if (mapped === 0) {
          return `None of those column names match the database. Columns are: ${Object.keys(schema).join(', ')}.`;
        }
        const page = await notionFetch(token, 'POST', '/pages', {
          parent: { type: 'database_id', database_id: databaseId },
          properties,
        });
        const url = typeof page.url === 'string' ? page.url : '';
        const dbUrl = typeof db.url === 'string' ? db.url : '';
        onDeliverable?.({ databaseId, url: dbUrl, title: extractTitle(db), rows: 1 });
        return `Added row. ${url}`;
      }

      default:
        return `Unknown Notion tool: ${name as string}`;
    }
  } catch (err) {
    return `Notion error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
