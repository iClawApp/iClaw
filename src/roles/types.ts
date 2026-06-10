/**
 * Roles — a hired digital specialist worker in its own box.
 *
 * A Role is NOT a prompt, skill, or GPT. It's a complete package (see
 * docs/roles-spec.md): a persona (SOUL), wired-in tools, an ephemeral isolated
 * container, per-role memory, clickable delegation examples, and a deliverable
 * the human reviews. The registry of roles is CURATED and lives in code (these
 * manifests are the source of truth); per-role *state* (a connected tool token,
 * the role's memory) lives in the DB.
 *
 * The host renders the UI from a manifest's metadata (name/tagline/icon/
 * delegation examples) and, when the user runs a role, hands the runtime the
 * manifest's `soul` (as the turn's systemPrompt), its `tools`, and its
 * `egressAllowlist` (the container's network leash).
 */

/** What a tool may do inside the role's box. */
export type ToolScope = 'read' | 'read_write';

/**
 * How a tool is connected. `token`/`web`/`local` are "easy" (one tap, no OAuth
 * dance); `oauth` (Google/Gmail/Slack) is the harder second wave — the real
 * "engineering boss", not the container.
 */
export type ConnectMethod = 'token' | 'oauth' | 'web' | 'local';

/** A single wired-in integration the role can use. */
export interface RoleTool {
  /** Stable tool id, e.g. "notion". Maps to a runtime tool implementation. */
  id: string;
  scope: ToolScope;
  connect: ConnectMethod;
  /** Human label for the connect button, e.g. "Connect Notion". */
  connectLabel?: string;
}

/** The deliverable the role produces for the human to review. */
export interface RoleDeliverable {
  /** e.g. "notion_database", "drafts", "brief". Drives the review surface. */
  type: string;
  /** Roles never act blind — the result is always shown for review. */
  review: 'human_in_loop';
}

/** What the role remembers between runs (separate from the disposable box). */
export interface RoleMemory {
  type: 'per_role';
  /** Memory slots this role keeps, e.g. ["brand_voice", "audience", "past_plans"]. */
  remembers: string[];
}

/** The leash: what's read, what's write, what needs explicit human approval. */
export interface RolePermissions {
  /**
   * Actions that ALWAYS require a human tap before they happen — anything that
   * leaves the box for the outside world (publish, send, delete externally).
   */
  requiresApproval: string[];
  /** Tearing down the container = "firing" the worker. The work stays in the tool. */
  killSwitch: 'delete_container';
}

/** A complete, curated Role definition. Build every role exactly like this. */
export interface RoleManifest {
  /** kebab-case, unique. e.g. "content-strategist". */
  id: string;
  name: string;
  /** One line: what it turns INTO what, where. */
  tagline: string;
  /** A single emoji. */
  icon: string;
  audience: string;
  /** `easy` = token/web/local; `oauth` = harder (gated to a later wave). */
  connectDifficulty: 'easy' | 'oauth';

  /** The system prompt / persona — character, standards, voice, what it won't do. */
  soul: string;

  /** Wired-in integrations (each with a scope + connect method). */
  tools: RoleTool[];
  /** The ONLY domains the role's container may reach. Network leash. */
  egressAllowlist: string[];

  workspace: {
    type: 'ephemeral_container';
    /** Work lives in the tool (e.g. Notion), not the box → the box is disposable. */
    persistInContainer: false;
  };

  memory: RoleMemory;
  deliverable: RoleDeliverable;

  /**
   * 3-5 concrete "do this for me" buttons. MANDATORY — they're the first thing the
   * user sees after picking a role and they cure the "blank screen = blank head".
   * Use a `[bracket]` placeholder where the user fills in a topic/product.
   */
  delegationExamples: string[];

  permissions: RolePermissions;
  /** Crisp acceptance line: what "done" looks like for this role. */
  definitionOfDone: string;

  /**
   * Build/disclosure wave (1 = beachhead). Drives progressive disclosure ordering
   * — we never dump all roles at once; lower waves surface first.
   */
  wave: number;
}
