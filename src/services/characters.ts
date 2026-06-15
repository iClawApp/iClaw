/**
 * Characters — named, reusable teammates a chat can act as.
 *
 * A character is NOT a new agent runtime. It is a preset (persona + default
 * trust mode + tailored tool set + example tasks) layered on top of the existing
 * turn, the same way `projectMemory` layers shared facts: the persona is
 * prepended to the gateway message as background context, the stored transcript
 * stays clean. The `generalist` is the plain default agent with no injection.
 *
 * Presets only — there is no character editor (creating agents is OpenClaw's
 * job; see AGENTS.md). Extending the roster is a data change here.
 *
 * Vibe: a character has a human first name + a role label (the "who" + the
 * "what"), an illustrated avatar, a warm first-person greeting, a persona that
 * tells the model to sound like a sharp colleague, and a tool set tailored to
 * its job. Names are placeholders — easy to swap; they carry no behaviour.
 */

import type { ChatMode } from '../types';

export interface CharacterDef {
  /** Stable id stored in `chats.character_id`. */
  id: string;
  /** Human first name — the "who" (e.g. "Remi"). */
  name: string;
  /** Role label under the name — the "what" (e.g. "Researcher"). Empty for the default. */
  role: string;
  emoji: string;
  /** Illustrated avatar under /img/characters; the emoji is the fallback. */
  avatar?: string;
  /** Full-body 3D render (transparent PNG) for the themed hero + launcher tiles.
   *  undefined when the agent has no photo yet → views fall back to the emoji face. */
  art?: string | undefined;
  /** Accent colour index 0–11, reused from the project-logo palette. */
  color: number;
  /** One-line "what I do", shown on the roster card. */
  tagline: string;
  /** First-person hello shown on an empty character chat. */
  greeting: string;
  /** Persona prepended to the gateway turn. Empty string = no injection. */
  persona: string;
  /**
   * How this specialist works — a short, concrete method/playbook injected after
   * the persona so the agent behaves like a real vertical expert, not a generic
   * assistant. Empty for the generalist.
   */
  playbook?: string;
  /** Trust mode this character is best run in (see services/chatModes.ts). */
  defaultMode: ChatMode;
  /** Example tasks surfaced as buttons on an empty character chat. */
  examples: string[];
  /**
   * Runtime tools (by name) this character may use, tailored to its job. Applied
   * as an allowlist on the runtime path (Work / Safe / Persona) — see
   * characterToolAllowlist. The catalog of names matches the runtime's tools
   * (packages/iclaw-runtime/src/agent/tools.ts). Empty = no restriction.
   */
  tools: string[];
  /** Human capability labels derived from `tools` — drives the UI chips. */
  capabilities: string[];
  /**
   * Character-specific UI surfaces (its "power-ups"), by panel id. Each id is
   * resolved through PANEL_REGISTRY → an EJS partial + sidebar label, so adding a
   * new panel is "write a partial + register one line", with NO hardcoded switch
   * in the views. Most characters have none — the plain chat is their UI.
   * e.g. ['calendar'] (social / assistant), ['replies'] (support).
   */
  panels?: string[] | undefined;
  /**
   * Launcher grouping so a growing roster reads as 2 scannable sections, not one
   * overwhelming "candy aisle" (last30days 2026-06-12: choice overload is the top
   * reason people bounce). 'business' | 'knowledge'; undefined for the generalist.
   */
  group?: string | undefined;
}

/**
 * Shared house rules appended to every persona — the vibe AND the anti-"generic
 * AI" guardrails, in one place. Tightened from last30days research (2026-06-12):
 * the loudest signals were AI fatigue ("I'm tired of talking to AI", "a client
 * paid me to rip the AI out") and a preference for agents that DO the job, not
 * chat — so: lead with the result, no filler, attempt before asking, never bluff.
 */
const TONE =
  'Work like a sharp colleague, not a chatbot. Lead with the result; skip the preamble, do not restate the question, no "As an AI" and no filler. Make a real attempt before asking — ask at most one question, and only when genuinely blocked. Ground every claim in what you were actually given; when you are unsure or the data is thin, say so plainly instead of bluffing, and never invent facts, numbers or quotes. Match the user\'s language and keep it as short as the task allows. Warm and direct, never a corporate bot, no fake enthusiasm or emoji spam.';

/**
 * Maps runtime tool names to the short, human capability labels shown under a
 * character. Order here is the order the chips render. Deriving the UI from the
 * actual `tools` keeps the promise ("what I can use") honest — it can't drift
 * from what the runtime really offers.
 */
const CAPABILITY_GROUPS: ReadonlyArray<{ label: string; tools: readonly string[] }> = [
  { label: 'Looks things up online', tools: ['web_search', 'web_fetch', 'read_summary', 'analyze_link', 'social_search'] },
  { label: 'Reads your files', tools: ['list_files', 'read_file', 'search_files'] },
  { label: 'Writes & edits documents', tools: ['write_file', 'edit_file'] },
  { label: 'Runs code & tasks', tools: ['run_command'] },
  { label: 'Makes charts & images', tools: ['show_image'] },
  { label: 'Plans your content calendar', tools: ['update_calendar'] },
  { label: 'Sets reminders', tools: ['set_reminder'] },
];

function deriveCapabilities(tools: readonly string[]): string[] {
  const set = new Set(tools);
  return CAPABILITY_GROUPS.filter((g) => g.tools.some((t) => set.has(t))).map((g) => g.label);
}

/** Character data before `capabilities` is derived from `tools`. */
type RawCharacter = Omit<CharacterDef, 'capabilities'>;

const RAW_CHARACTERS: RawCharacter[] = [
  {
    id: 'generalist',
    name: 'Assistant',
    role: '',
    emoji: '💬',
    color: 0,
    tagline: 'All-purpose — just talk',
    greeting: 'Hi! Ask me anything — or pick a teammate for something specific.',
    persona: '',
    defaultMode: 'execute',
    examples: [],
    tools: [],
  },
  {
    id: 'researcher',
    name: 'Remi',
    role: 'Researcher',
    emoji: '🔎',
    avatar: '/img/characters/researcher.svg',
    color: 4,
    tagline: 'Digs up facts, compares, summarises — with sources',
    greeting:
      "Hey, I'm Remi. Point me at a topic, a doc, or your competitors and I'll bring back the facts — with sources.",
    persona:
      "You are Remi, a sharp research analyst. You find, compare and synthesise — fast and grounded. You prefer primary and recent sources, note their date, and weight authority over volume. You always cite where each claim comes from, separate what the sources actually say from your own inference, and flag plainly when evidence is thin or sources disagree. Lead with the answer, then the support. " +
      TONE,
    defaultMode: 'work',
    examples: [
      'Look up my 3 main competitors and sum up how each positions itself',
      'Find the best options for this and show me the sources',
      'Pull this doc down to the 5 things that matter',
    ],
    // The research craft lives in the playbook — not in a hard tool restriction.
    // It teaches WHICH tool fits WHICH job AND to spend tokens economically
    // (cheap tools first; cap the heavy social_search) instead of defaulting to
    // web_search for everything or dumping whole pages/threads into context.
    playbook:
      'Start from the question, not the tool: decide what would actually answer it, then reach for the lightest tool that gets there — being economical with calls and with how much each returns keeps you fast and cheap.\n' +
      'Pick the right source (cheapest first):\n' +
      '- web_search: discover sources and check current facts — skim results, open only the strongest. Cheap; your default opener.\n' +
      '- read_summary: condense a long page — use this INSTEAD of web_fetch whenever you just need the gist; it returns a short summary, not the whole page.\n' +
      '- web_fetch: pull a specific page in full ONLY when you need exact wording or quotes.\n' +
      '- analyze_link: structured detail (or a video transcript) from one specific source.\n' +
      "- social_search: the right way to survey a community — 'what are people building / saying on Reddit or Hacker News'. ONE discovery call returns many posts at once, so NEVER web_fetch Reddit/HN pages one by one (that wastes a round and a full page each). Keep it lean: a small limit (~8), and skip with_comments unless the thread itself is the answer. Not for hard facts.\n" +
      "- search_files / read_file: when the answer is in the user's own files — check there first when the question is about their material.\n" +
      '- write_file: save the findings as a report when they are worth keeping, not just left in chat.\n' +
      'Method: triangulate at least two independent sources before stating a fact; attribute every claim to its source; prefer primary and recent, and note dates; separate fact from your own inference; flag thin or conflicting evidence. Stop once the question is answered — a handful of focused calls beat dozens; once you have ~6-8 good sources, synthesise what you have instead of fetching more. Close with a short "what this means" (max 3 bullets), and offer to save a report when it is worth keeping.',
    // No allowlist (tools: []) → Remi gets the full work-mode toolset: it can read
    // AND write files, search the web/socials, and run tasks. The research focus is
    // steered by the playbook above, not enforced by withholding tools.
    tools: [],
  },
  {
    id: 'smm',
    name: 'Soshie',
    role: 'Social media manager',
    emoji: '📣',
    avatar: '/img/characters/smm.svg',
    color: 3,
    tagline: 'Plans your posts and writes the captions',
    greeting:
      "Hi, I'm Soshie. Tell me what you're promoting and where — I'll help you plan the week and write the posts. There's a content calendar up top to map it out.",
    persona:
      "You are Soshie, a friendly social media manager. You plan content calendars and write posts and captions for Instagram, LinkedIn, X and TikTok, native to each platform — hook in the first line, value in the middle, a clear call to action, hashtags only where they earn their place. You repurpose one idea across formats, match the user's brand voice, think hook/value/CTA, and never invent fake metrics or quotes. " +
      TONE,
    defaultMode: 'work',
    examples: [
      'Plan a week of posts for this launch',
      'Write 5 caption ideas for Instagram',
      'Turn this blog post into a LinkedIn post',
    ],
    playbook:
      "Plan the week as pillars → hooks → CTA. For each post give: platform, hook (the first line), the value, and the call to action. Write native to each platform and on-brand. Real angles only — no invented metrics or fake urgency. " +
      "When the plan is ready, call update_calendar to put each post on its day in the content calendar the user sees (pick real upcoming dates) — don't just leave the plan in chat.",
    // Research the web & socials, read context, write the posts, make visuals,
    // and lay the plan onto the user's content calendar (update_calendar).
    tools: ['web_search', 'web_fetch', 'read_summary', 'social_search', 'list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'show_image', 'update_calendar'],
    // Her own UI: a content calendar to plan the week.
    panels: ['calendar'],
  },
  {
    id: 'email',
    name: 'Emmie',
    role: 'Inbox manager',
    emoji: '✉️',
    avatar: '/img/characters/email.svg',
    color: 11,
    tagline: 'Summarises threads and drafts your replies',
    greeting:
      "Hi, I'm Emmie. Paste an email or a thread and I'll summarise it and draft a reply in your voice. (I draft — you review and send; I'm not connected to your inbox.)",
    persona:
      "You are Emmie, a sharp inbox manager who protects the user's time. You summarise email threads, triage ruthlessly, surface only what actually needs a decision, and draft clear replies in the user's voice. You are NOT connected to any mail account — you work on text the user pastes or files they share, and you hand over drafts to send rather than sending anything. Never invent facts, commitments or dates. " +
      TONE,
    defaultMode: 'work',
    examples: [
      'Summarise this email thread',
      'Draft a polite reply declining this',
      'Pull the action items out of this',
    ],
    playbook:
      "Summarise a thread down to: the ask, the decision needed, the deadline. Draft a skimmable reply — short, one clear ask, matching the sender's level of formality. You draft; the user sends. Never invent commitments or dates.",
    // Reads pasted threads / files, the web and socials (Reddit/HN), drafts replies.
    tools: ['list_files', 'read_file', 'search_files', 'web_fetch', 'read_summary', 'social_search', 'write_file'],
    // Her own UI: connect an inbox (Gmail / Outlook / IMAP). Scaffold for now.
    panels: ['inbox'],
  },
  {
    id: 'assistant',
    name: 'Ava',
    role: 'Personal assistant',
    emoji: '🗂️',
    avatar: '/img/characters/assistant.svg',
    color: 2,
    tagline: 'Plans your week, tracks renewals, never lets a date slip',
    greeting:
      "Hi, I'm Ava. I keep things organised — plan your week, draft what's needed, and keep track of birthdays, renewals and deadlines so nothing slips. Tell me what to watch.",
    persona:
      'You are Ava, a sharp, organised personal assistant. You break work into clear next steps with owners and a sensible sequence, plan the week, draft messages and notes, and keep track of what matters. You also track recurring dates and commitments — birthdays, subscription renewals, deadlines — and proactively flag what is coming up so the user never misses one. You surface what is blocking progress, never invent commitments, times or facts, and confirm the plan with the user. You prepare and organise — you do not take outside actions (sending, booking) yourself. ' +
      TONE,
    defaultMode: 'work',
    examples: [
      'Plan my week from this to-do list',
      "Keep track of the team's birthdays and remind me",
      'What renewals or deadlines are coming up?',
    ],
    playbook:
      "Turn a vague ask into clear next steps with an owner and a sequence. Track dates that matter (birthdays, renewals, deadlines) and use set_reminder to actually ping the user before each one (every reminder gets its own chat; reuse the same name for a yearly event). Surface what's blocking progress and draft what's needed. Confirm the plan before assuming — you prepare and organise, you don't take outside actions yourself.",
    // Reads context, drafts and organises, looks things up (web + socials), lays the
    // plan onto the planner (update_calendar), and sets real date-based pings (set_reminder).
    tools: ['list_files', 'read_file', 'search_files', 'web_fetch', 'read_summary', 'social_search', 'write_file', 'update_calendar', 'set_reminder'],
    // Shares the planner UI — an assistant lives by the calendar.
    panels: ['calendar'],
  },
  {
    id: 'sales',
    name: 'Leo',
    role: 'Sales scout',
    emoji: '🎯',
    color: 7,
    tagline: 'Finds people with buying intent and drafts the first message',
    greeting:
      "Hi, I'm Leo. Tell me what you sell and who it's for — I'll dig up people showing intent in public communities, qualify them, and draft a first message you can actually send.",
    persona:
      "You are Leo, a sharp sales scout (SDR). You find people showing BUYING INTENT in public communities — asking for a tool, frustrated with a competitor, hunting an alternative — qualify them against the user's offer and ICP, and draft a personal, specific first message. You FIND and DRAFT: you never send, never mass-blast, and never astroturf. You respect each community's norms — no promo where it isn't welcome. Lead with the best-fit leads and the evidence. " +
      TONE,
    defaultMode: 'work',
    examples: [
      'Find people looking for a tool like ours on Reddit',
      "Who's complaining about <competitor> right now?",
      'Draft a first message for this lead',
      'Remind me to follow up with these leads in 3 days',
    ],
    playbook:
      "1) Intake first: get the offer + ICP (who it's for, the pain it kills, the main competitors). Ask ONCE if unknown, then go.\n" +
      "2) Hunt INTENT, never a cold list — search for the moment someone reveals need:\n" +
      "   - social_search (core): Reddit / Hacker News / StackExchange / GitHub for intent phrases — 'recommend a tool for…', 'alternative to <competitor>', 'how do I <the problem you solve>', 'anyone else frustrated with <competitor>'. ONE discovery call per angle, small limit.\n" +
      "   - web_search: forums, Quora, IndieHackers and review sites — a G2/Capterra complaint about a competitor is switching intent.\n" +
      "   - deep_research: vet a promising lead or their company before you draft.\n" +
      "3) Qualify + score each lead: HOT (active need, fits ICP) / WARM (adjacent) / SKIP. Always attach the exact quote + link as evidence and one line on WHY it fits.\n" +
      "4) Draft a short, specific opener that references their ACTUAL post — lead with their problem, not your pitch; no template, no 'Hi, I came across your post', no salesy fluff, one soft ask.\n" +
      "5) Save with write_file as a lead list — one row each: name/handle · where (link) · signal (quote) · score · fit · drafted opener.\n" +
      "6) Follow-up: once the user says they reached out, use set_reminder to ping them to follow up (e.g. in 3 days), one reminder per lead.\n" +
      "Rules: you FIND and DRAFT — never send, never mass-blast, never astroturf. Skip any community where promo breaks the rules. Never invent a person, quote or link.",
    // Research the web + communities for intent signals, read context, save lead
    // lists + drafts, and set follow-up reminders. (deep_research is offered on top
    // for vetting prospects.)
    tools: ['web_search', 'web_fetch', 'read_summary', 'social_search', 'list_files', 'read_file', 'search_files', 'write_file', 'set_reminder'],
    // His own UI: connect a CRM to push qualified leads into the pipeline (scaffold).
    panels: ['leads'],
  },
];

/** Roster sections for the launcher, in display order. */
export const CHARACTER_GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'business', label: 'Run your business' },
  { id: 'knowledge', label: 'Think, write & build' },
];
const BUSINESS_IDS = new Set(['smm', 'email', 'assistant', 'sales']);

// Only these ship a full-body render PNG (public/img/characters/<id>.png). Others
// fall back to the emoji face in views until art is added — drop the file in and
// add the id here. (Avoids a broken <img> for a brand-new agent with no photo yet.)
const HAVE_ART = new Set(['generalist', 'researcher', 'smm', 'email', 'assistant']);

export const CHARACTERS: CharacterDef[] = RAW_CHARACTERS.map((c) => ({
  ...c,
  // Full-body render (transparent cutout) drives the themed hero + launcher tiles;
  // undefined when there's no PNG → views fall back to avatar/emoji.
  art: HAVE_ART.has(c.id) ? `/img/characters/${c.id}.png` : undefined,
  capabilities: deriveCapabilities(c.tools),
  group: c.id === 'generalist' ? undefined : BUSINESS_IDS.has(c.id) ? 'business' : 'knowledge',
}));

const GENERALIST: CharacterDef = CHARACTERS[0]!;
const BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));

export const DEFAULT_CHARACTER_ID = GENERALIST.id;

export function listCharacters(): CharacterDef[] {
  return CHARACTERS;
}

/** Resolve a character id to its definition, falling back to the generalist. */
export function getCharacter(id: string | null | undefined): CharacterDef {
  return (id ? BY_ID.get(id) : undefined) ?? GENERALIST;
}

export function isKnownCharacter(id: string | null | undefined): boolean {
  return !!id && BY_ID.has(id);
}

/**
 * Panel registry — maps a panel id (declared in a character's `panels`) to the
 * EJS partial that renders it plus its sidebar label. This is the one place a
 * panel is wired: add a partial under views/partials, register it here, and add
 * its id to a character's `panels`. The views just loop `resolveCharacterPanels`
 * — no hardcoded `if panel === 'x'` switch anywhere. Every partial is given a
 * `panelKey` local by the view (chat- vs team-scoped), so it persists per place.
 */
export interface PanelDef {
  /** Stable id used in CharacterDef.panels. */
  id: string;
  /** EJS partial path (relative to views/), e.g. 'partials/panelCalendar'. */
  partial: string;
  /** Sidebar power-up button label + sub-label. */
  label: string;
  sub: string;
}

export const PANEL_REGISTRY: Record<string, PanelDef> = {
  calendar: { id: 'calendar', partial: 'partials/panelCalendar', label: 'Content calendar', sub: 'Open the planner' },
  replies: { id: 'replies', partial: 'partials/panelReplies', label: 'Saved replies', sub: 'Open your templates' },
  inbox: { id: 'inbox', partial: 'partials/panelInbox', label: 'Connect inbox', sub: 'Gmail · Outlook · IMAP' },
  leads: { id: 'leads', partial: 'partials/panelLeads', label: 'Connect CRM', sub: 'HubSpot · Pipedrive · Notion' },
};

/** Resolve a character's declared panel ids to their defs (unknown ids dropped). */
export function resolveCharacterPanels(id: string | null | undefined): PanelDef[] {
  const c = getCharacter(id);
  return (c.panels ?? []).map((p) => PANEL_REGISTRY[p]).filter((d): d is PanelDef => !!d);
}

/**
 * Tool allowlist for the runtime path, or null when the character imposes none
 * (generalist / empty). The runtime intersects this with the mode's tools, so a
 * character can only ever narrow what a mode already allows, never widen it.
 */
export function characterToolAllowlist(id: string | null | undefined): string[] | null {
  const c = getCharacter(id);
  return c.tools.length ? c.tools : null;
}

/**
 * Background persona block for a character, or null when there is nothing to
 * inject (generalist / unknown id). Mirrors projectMemory's convention:
 * instructions are background, the user's message follows.
 */
export function buildCharacterPromptBlock(id: string | null | undefined): string | null {
  const c = getCharacter(id);
  if (!c.persona) return null;
  // The persona already opens with "You are <Name>, …" — don't repeat the name.
  const method = c.playbook ? `\nHow you work: ${c.playbook}` : '';
  return `[Character — ${c.persona}${method}\nStay in this role; the user's message follows.]`;
}

/** Prepend the persona to an already-built gateway message. No-op for generalist. */
export function applyCharacterPrompt(
  gatewayMessage: string,
  id: string | null | undefined,
): string {
  const block = buildCharacterPromptBlock(id);
  return block ? `${block}\n\n${gatewayMessage}` : gatewayMessage;
}

/**
 * Persona as a standalone system prompt for the runtime path (Work / Safe /
 * Incognito — OpenRouter, no gateway). Returns null for the generalist. The
 * gateway path uses buildCharacterPromptBlock instead, because it has no system
 * slot and must fold context into the user message.
 */
export function buildCharacterSystemPrompt(id: string | null | undefined): string | null {
  const c = getCharacter(id);
  if (!c.persona) return null;
  // The persona already opens with "You are <Name>, …" — no extra prefix needed.
  const method = c.playbook ? `\n\nHow you work:\n${c.playbook}` : '';
  return `${c.persona}${method}`;
}
