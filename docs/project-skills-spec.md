# Per-Project Skills (Inbox-Gated Self-Learning) — Implementation Spec

> Audience: an engineer/agent implementing this feature in the iClaw monorepo.
> Read this top-to-bottom before writing code. It tells you exactly which
> existing code to mirror, what to build, and in what order.

## 0. One-paragraph summary

Give iClaw a **closed learning loop scoped to projects**: after a chat turn (or
session), a **background reviewer** distills reusable *procedural skills* from
what just happened. Distilled skills do **not** activate automatically — they
land in a **per-project inbox** as *suggestions*. The user accepts/edits/rejects
them (exactly like the existing **project fact suggestions**). Accepted skills
become **active** project skills, stored as **`SKILL.md` markdown** (agentskills.io
format), and their one-line `description` is injected as a **summary index** into
the Work/Secure/Execute system prompt; the full body is loaded on demand. The
user sees a **Skills panel per project** showing each skill's name + description
(the "summary per skill" the product owner asked for). This mirrors Hermes's
self-improvement loop but adds a human-acceptance gate, which neutralizes the two
big risks (skill sprawl and prompt-injection-planted skills).

This is the **procedural** half of memory. iClaw already has the **declarative**
half (project *facts*). We are duplicating the facts pattern for skills, then
layering Hermes's distillation + the SKILL.md format on top.

---

## 1. Existing patterns to MIRROR (read these first)

The whole feature is "facts, but richer." Study these before designing:

| Concern | Facts implementation (mirror it) |
|---|---|
| DB tables | `src/db/database.ts` → `project_facts`, `project_fact_suggestions` (lines ~52–77) |
| Data layer | `src/services/store.ts` → `projectFacts` (~368) and `projectFactSuggestions` (~452) objects |
| Types | `src/types/index.ts` → `ProjectFact`, `ProjectFactSuggestion` |
| Distillation pipeline | `src/services/projectMemory.ts` → `scheduleProjectFactExtraction`, `runProjectFactExtraction`, `runThrowawayTurn`, `isDuplicateFact`, `parseExtractedFactLines` |
| Pipeline trigger | `src/services/chatRunner.ts:676` calls `scheduleProjectFactExtraction({...})` after a successful assistant reply |
| Prompt injection (Work/Secure) | `src/services/chatRunner.ts` `buildWorkSystemPrompt` (~849) prepends facts; the runtime composes the final system prompt in `packages/iclaw-runtime/src/agent/loop.ts` `buildSystemPrompt` |
| Prompt injection (Execute/gateway) | `src/services/projectMemory.ts` `buildGatewayUserMessage` prepends facts to the gateway turn |
| REST: inbox accept/reject | `src/routes/chats.ts` → `GET /:id/fact-suggestions`, `POST /:id/fact-suggestions/:sid/accept`, `.../reject` (~98–158) |
| REST: active-item CRUD | `src/routes/projects.ts` → `PATCH /:id/facts/:factId`, `POST /:id/facts/:factId/delete` (~210–237) |
| WS events | `src/types/protocol.ts` → `project-fact-suggestions`, `project-fact-suggestion-removed`, `project-fact-added/updated/deleted`, `project-facts-synced` (~159–179) |
| UI: inbox cards | `public/js/iclaw.js` → `fact-suggestions-card`, `fact-suggestion-row[data-suggestion-id]`, `removeFactSuggestionRow`, `existingFactSuggestionIds`, `cancelFactSuggestionRowExpiry` |
| UI: active-item panel | the project facts list (search `project-fact` in `public/js/iclaw.js` and the projects/settings view) |

**Rule of thumb:** for every `fact` symbol there should be a parallel `skill`
symbol. Keep names consistent (`projectSkills`, `projectSkillSuggestions`,
`scheduleProjectSkillReview`, `project-skill-suggestions`, etc.).

---

## 2. What to take from Hermes (the "best of")

Local clone: `~/.hermes/hermes-agent`. Key references:

1. **Background-review fork with a restricted toolset.**
   `agent/background_review.py` → `spawn_background_review` forks a daemon that
   replays the conversation snapshot in a copy of the agent whose tools are
   **whitelisted to memory + skill writes only** (everything else denied at
   runtime). Main conversation + prompt cache are untouched.
   - **Take:** the *pattern* of a separate, least-privilege reviewer that only
     emits memory/skill writes. In iClaw this maps to `runThrowawayTurn`
     (`projectMemory.ts`) — a throwaway gateway session — except the reviewer
     output is parsed into **inbox suggestions**, never written live.

2. **Be ACTIVE but CLASS-LEVEL (anti-sprawl).**
   `_SKILL_REVIEW_PROMPT` in `background_review.py`: "most sessions produce at
   least one skill update… Target shape: CLASS-LEVEL skills, each with a rich
   `SKILL.md` and a `references/` directory… Not a long flat list of narrow
   one-session-one-skill entries. Patch the existing skill if it covers the
   learning."
   - **Take:** the reviewer must prefer **patching an existing skill** over
     creating a new one, and skills should be broad/reusable, not one-offs.
     This is what keeps the library from rotting.

3. **`SKILL.md` format (agentskills.io standard).**
   Example: `~/.hermes/hermes-agent/skills/yuanbao/SKILL.md`. Frontmatter:
   ```yaml
   ---
   name: <kebab-case>
   description: "<one line — THIS is the user-facing summary>"
   version: 1.0.0
   metadata:
     iclaw:
       tags: [..]
       related_skills: [..]
   ---
   # <Title>
   ## <procedure sections...>
   ```
   - **Take:** store skills in exactly this format. `description` is the summary
     shown in the UI and injected into the prompt index. Body is the procedure.

4. **Nudge intervals (optional, phase 2).**
   `agent/agent_init.py` → `_skill_nudge_interval = 10`. A lighter in-band
   reminder every N turns, complementary to background review.
   - **Take later:** start with background review only; add nudges if needed.

5. **Skill manager tool.** `tools/skill_manager_tool.py` → `_create_skill(name,
   content, category)`. We don't need the agent to write skills live (the
   reviewer does), but we DO need a **read** tool (`get_skill`) so the acting
   agent can load a full skill body on demand. See §7.

What we deliberately **diverge** from Hermes on:
- Hermes skills are **global + category-foldered**; ours are **per-project**
  (keyed by `project_id`), matching iClaw facts. (Add an optional `global` scope
  at acceptance time — see §5.)
- Hermes writes skills **live**; we route through an **inbox** (human gate).

---

## 3. Core design decisions (locked)

1. **Inbox-gated.** Distilled skills are `project_skill_suggestions` rows, never
   active until accepted. This is the safety spine — do not skip it.
2. **Per-project scope**, with an optional `global` scope chosen at acceptance.
3. **`SKILL.md` markdown** is the storage format for both active skills and
   suggestions (the suggestion already holds the full proposed body).
4. **Two suggestion kinds:** `new` (a new skill) and `patch` (an update to an
   existing skill `target_skill_id`, carrying the full proposed new body; show a
   diff in the UI).
5. **Provenance + trust.** Every suggestion records `source_chat_id` and an
   `untrusted` flag (true when the source turn ingested untrusted content — for
   now set heuristically: secure-mode turns, or turns that fetched web/email/
   Telegram content). Untrusted suggestions are **always** inbox-gated and
   visually flagged. (Auto-accept of trusted suggestions is a future toggle —
   see §14; default = everything is gated.)
6. **Summaries-only in the prompt.** Inject `name: description` lines for active
   skills (token-bounded, like facts). Full body via `get_skill` tool on demand.
7. **Cost-aware trigger.** Do NOT run the reviewer every turn. Trigger on:
   session end / chat idle, OR every N (config, default 8) *substantive* turns
   (turns that used tools), whichever comes first. (Facts extraction runs per
   turn because it's cheap and append-only; skill review is heavier, so throttle.)

---

## 4. Data model

Add to `src/db/database.ts` (mirror the facts tables; the schema is applied with
`CREATE TABLE IF NOT EXISTS`, so just append — no migration framework needed,
same as facts):

```sql
-- Active, accepted project skills (procedural memory). Stored as SKILL.md.
CREATE TABLE IF NOT EXISTS project_skills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global skill
  name         TEXT NOT NULL,            -- kebab-case, unique within scope
  description  TEXT NOT NULL,            -- one-line summary (shown to user + prompt index)
  body         TEXT NOT NULL,            -- full SKILL.md (frontmatter + procedure)
  tags         TEXT,                     -- JSON array of strings (optional)
  source_chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_project ON project_skills(project_id, id);
-- Uniqueness within a scope (project_id may be NULL for global). SQLite treats
-- NULLs as distinct, which is fine — enforce global uniqueness in the store layer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_scope_name
  ON project_skills(project_id, name);

-- Inbox: proposed skills awaiting user acceptance.
CREATE TABLE IF NOT EXISTS project_skill_suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_id         INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'new',     -- 'new' | 'patch'
  target_skill_id INTEGER REFERENCES project_skills(id) ON DELETE CASCADE,  -- for 'patch'
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  body            TEXT NOT NULL,          -- full proposed SKILL.md
  tags            TEXT,                   -- JSON array (optional)
  untrusted       INTEGER NOT NULL DEFAULT 0,      -- 1 if source turn ingested untrusted content
  assistant_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_suggestions_chat ON project_skill_suggestions(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_skill_suggestions_project ON project_skill_suggestions(project_id, id);
```

---

## 5. Store layer (`src/services/store.ts`)

Add two objects next to `projectFacts` / `projectFactSuggestions`. Mirror their
method shapes exactly.

```ts
export const projectSkills = {
  listByProject(projectId: number): ProjectSkill[]            // active skills for a project (+ global merged in by caller if desired)
  listGlobal(): ProjectSkill[]
  get(id: number): ProjectSkill | undefined
  getByName(projectId: number | null, name: string): ProjectSkill | undefined
  // index = name + description only (for prompt injection / panel list)
  listIndex(projectId: number): { id: number; name: string; description: string }[]
  create(opts: { projectId: number | null; name; description; body; tags?; sourceChatId?: number|null }): ProjectSkill
  update(id: number, patch: { description?; body?; tags?; name? }): void  // bumps version + updated_at
  incrementUsage(id: number): void
  remove(id: number): void
};

export const projectSkillSuggestions = {
  listByChat(chatId: number): ProjectSkillSuggestion[]
  listByProject(projectId: number): ProjectSkillSuggestion[]
  get(id: number): ProjectSkillSuggestion | undefined
  insert(opts: { projectId; chatId; kind:'new'|'patch'; targetSkillId?: number|null; name; description; body; tags?; untrusted?: boolean; assistantMessageId: number|null }): ProjectSkillSuggestion
  remove(id: number): void
};
```

Notes:
- `update` increments `version` and sets `updated_at`; on accepting a `patch`,
  call `projectSkills.update(target, {...})`.
- Enforce scope+name uniqueness in `create` (look up `getByName` first; if it
  exists, treat as an update rather than insert — the route layer decides).
- `tags` round-trips as `JSON.stringify` / `JSON.parse`.

---

## 6. Types (`src/types/index.ts`)

```ts
export interface ProjectSkill {
  id: number;
  project_id: number | null;     // null = global
  name: string;
  description: string;
  body: string;
  tags: string | null;           // JSON
  source_chat_id: number | null;
  usage_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectSkillSuggestion {
  id: number;
  project_id: number;
  chat_id: number;
  kind: 'new' | 'patch';
  target_skill_id: number | null;
  name: string;
  description: string;
  body: string;
  tags: string | null;
  untrusted: number;             // 0 | 1
  assistant_message_id: number | null;
  created_at: string;
}
```

---

## 7. Skill exposure to the agent (read path)

Active skills must reach the agent in two layers, matching how facts do it:

### 7a. Summary index in the system prompt
- **Work/Secure (iclaw-runtime):** the host builds the project block in
  `chatRunner.ts buildWorkSystemPrompt`. Add a **"Skills available"** section:
  one `- <name>: <description>` line per active skill (project + global),
  token-bounded the same way facts are (see `buildGatewayUserMessage`'s budget
  logic). Tell the model: *"To use a skill, call `get_skill` with its name to
  load the full procedure."*
  - The runtime's `packages/iclaw-runtime/src/agent/loop.ts buildSystemPrompt`
    already appends the host-supplied `systemPrompt`. No runtime change needed
    for the index itself — it rides in via `buildWorkSystemPrompt`.
- **Execute (gateway):** add the same index block in `buildGatewayUserMessage`
  (`projectMemory.ts`) alongside the facts block.

### 7b. `get_skill` tool (load full body on demand)
- **Work/Secure runtime:** add a `get_skill` tool to
  `packages/iclaw-runtime/src/agent/tools.ts` (`TOOL_DEFINITIONS` + a handler in
  `executeTool`). Problem: the runtime is a separate process and does not have
  the iClaw DB. Two options — pick (A) for the MVP:
  - **(A) Inject bodies at session create.** When the host creates the work
    session (`createWorkSession` in `workRuntime.ts` / `runWorkModeTurn` in
    `chatRunner.ts`), pass the active skills (name + body) for the chat's
    project as a new `skills` field; the runtime stores them on the session and
    `get_skill(name)` reads from that in-memory map. Re-inject when skills
    change (the session is already recreated on folder/mode changes — see
    `workSessions` signature logic; add skills to that signature so accepting a
    skill recreates the session with the new set). Simple, no cross-process DB.
  - (B) Add an HTTP endpoint on the host that the runtime calls to fetch a skill
    body by `(projectId, name)`. More moving parts; defer.
- **Execute (gateway):** the gateway agent already has tools; expose `get_skill`
  via the same mechanism facts use, or simply inline the full bodies of the
  top-N most relevant skills if token budget allows. MVP: index-only + instruct
  the agent that bodies can be requested; wire the actual fetch in phase 2 if
  the gateway can't call back. (Coordinate with how Execute mode tools are
  registered — see `openclawWs`.)

> MVP shortcut acceptable: if `get_skill` plumbing is heavy, start by injecting
> the **full bodies** of up to ~3 small active skills (most-recently-used) and
> just the index for the rest. Make the body-vs-index cutoff a constant.

On a skill being used (agent calls `get_skill`), bump `usage_count` (host side).

---

## 8. The distillation pipeline (`src/services/projectSkills.ts` — NEW)

Model it on `projectMemory.ts`. New module, parallel functions.

### 8a. Trigger
- Add `scheduleProjectSkillReview(opts)` and call it from the **same place**
  facts are scheduled (`chatRunner.ts:676` area) **but throttled**:
  - Maintain a per-chat counter of substantive (tool-using) turns.
  - Fire the reviewer when counter ≥ `SKILL_REVIEW_TURN_INTERVAL` (default 8) OR
    on session end (hook where a Work/Secure/Execute session is torn down).
  - Also expose a manual "review now" affordance later (phase 2).
- Guard like facts: only when `chat.shares_to_project`, project exists, etc.

### 8b. Reviewer call (least-privilege, throwaway)
- Reuse `runThrowawayTurn` (gateway 'main' agent) OR a direct OpenRouter call
  (see `loadOpenRouterConfig`) — pick whichever the surrounding mode already
  uses; gateway throwaway is the established pattern.
- Feed it: the recent turn(s) transcript (user + assistant + which tools ran),
  PLUS the **existing skill index** (names + descriptions) for the project so it
  can decide patch-vs-new and avoid duplicates.
- The reviewer must output **structured** results so we can build suggestions.
  Use a strict, parseable format (JSON preferred; fall back to a line protocol
  if the model is unreliable). Target schema:
  ```json
  {
    "skills": [
      {
        "action": "new" | "patch",
        "target": "<existing-skill-name, only for patch>",
        "name": "<kebab-case>",
        "description": "<one line>",
        "tags": ["..."],
        "body": "<full SKILL.md markdown>"
      }
    ]
  }
  ```
  If nothing qualifies, the model returns `{"skills": []}` (or literal `NONE`).

### 8c. Reviewer prompt (adapt Hermes `_SKILL_REVIEW_PROMPT`)
Encode these rules (paraphrase from `~/.hermes/hermes-agent/agent/background_review.py`):
- Prefer **patching** an existing skill over creating a near-duplicate.
- Skills should be **class-level / reusable**, not one-shot task logs.
- A skill captures a *procedure/convention/workflow* discovered this session
  that will help next time (commands that worked, gotchas, project conventions,
  tool quirks) — NOT transient task state, NOT secrets/paths/credentials (same
  exclusions as the facts prompt; reuse that exclusion list).
- Output strictly the JSON above. Same language as the technical content.

### 8d. Build suggestions
- Parse the JSON. For each entry:
  - Dedup against existing **active skills** and **pending suggestions** for the
    project (reuse `isDuplicateFact`-style normalization on `name`+`description`).
  - For `patch`: resolve `target` name → `target_skill_id`; if not found,
    downgrade to `new`.
  - Determine `untrusted` (see §10).
  - Insert into `project_skill_suggestions`.
- Broadcast a WS event (`project-skill-suggestions`) like
  `project-fact-suggestions`, so the chat UI shows inbox cards immediately.

### 8e. Compaction (phase 2)
Facts compact when the table grows (`compactProjectFacts`). Skills mostly
self-limit via class-level discipline + user pruning, so defer compaction.

---

## 9. REST routes

### Inbox (per chat) — mirror `src/routes/chats.ts` fact-suggestion routes
- `GET  /chats/:id/skill-suggestions` → list for chat.
- `POST /chats/:id/skill-suggestions/:sid/accept`
  - body: `{ scope?: 'project' | 'global', body?, description?, name?, tags? }`
    (the optional fields let the UI submit user **edits** before accepting).
  - if `kind === 'patch'`: `projectSkills.update(target_skill_id, {...})`.
  - if `kind === 'new'`: `projectSkills.create({...scope...})`.
  - remove the suggestion; broadcast `project-skill-suggestion-removed` +
    `project-skill-added`/`project-skill-updated`.
  - If accepting changes the active skill set for any open Work/Secure chat in
    that project, invalidate those sessions so the new skill is injected (tie
    into the `workSessions` signature — see §7b option A).
- `POST /chats/:id/skill-suggestions/:sid/reject` → remove + broadcast removed.

### Active skills (per project) — mirror `src/routes/projects.ts` facts CRUD
- `GET   /projects/:id/skills` → list active (project + global) with index info.
- `GET   /projects/:id/skills/:skillId` → full body (for the view/edit modal).
- `PATCH /projects/:id/skills/:skillId` → edit description/body/tags/name.
- `POST  /projects/:id/skills/:skillId/delete`.

---

## 10. Security (do not cut corners here)

This feature is a **prompt-injection amplifier** if done naively: untrusted
content (a web page, an email, a Telegram message) could contain text that the
reviewer distills into a *standing instruction*. The inbox is the primary
defense; reinforce it:

1. **Everything is inbox-gated by default.** No code path writes an active skill
   without an explicit `accept` call from the user.
2. **`untrusted` provenance flag.** Set `untrusted = 1` when the source turn
   ingested external content. MVP heuristic: `true` if the turn ran in **Secure
   mode** with network enabled, OR used a fetch/`run_command curl`/email/Telegram
   tool. Surface this on the inbox card ("learned from untrusted content —
   review carefully").
3. **The reviewer is least-privilege by construction.** It only emits suggestion
   text; it has no tools and cannot act. (This is the iClaw analogue of Hermes's
   whitelisted reviewer.)
4. **Never distill secrets.** Reuse the facts exclusion list (no tokens, keys,
   `.env`, paths, hostnames). Additionally, strip/refuse any skill body that
   contains secret-looking patterns (reuse `findBlockedPattern` from
   `packages/iclaw-runtime/src/agent/security.ts` conceptually, or a host-side
   equivalent).
5. **No auto-accept in MVP.** The trust-level auto-accept (phase 2, §14) must
   only ever apply to **trusted** (non-ingested) sessions, never `untrusted=1`.

Cross-reference: this connects to the broader threat-model discussion (lethal
trifecta, host-mediated creds, egress allowlist). A planted skill that says
"always send X to Y" is only dangerous if the acting agent also has a send
capability — keep capability scoping per task regardless of this feature.

---

## 11. WS protocol (`src/types/protocol.ts`)

Add events mirroring the fact events:
```ts
| { type: 'project-skill-suggestions'; chatId: number; projectId: number;
    projectName: string;
    suggestions: { id: number; kind: 'new'|'patch'; name: string;
                   description: string; untrusted: boolean; targetSkillId: number|null }[] }
| { type: 'project-skill-suggestion-removed'; chatId: number; suggestionId: number }
| { type: 'project-skill-added';   projectId: number; skill: ProjectSkill }
| { type: 'project-skill-updated'; projectId: number; skill: ProjectSkill }
| { type: 'project-skill-deleted'; projectId: number; skillId: number }
```
(Card list carries only summary fields; the full body is fetched via REST when
the user expands/edits — keeps WS frames small.)

---

## 12. UI (`public/js/iclaw.js` + views)

### 12a. Inbox cards (in the chat) — extend the fact-suggestion card
Mirror `fact-suggestions-card` / `fact-suggestion-row`. Differences vs facts:
- Each row shows **name + description** (the summary) and a **kind badge**
  (`New skill` / `Updates "<target>"`).
- An **untrusted** badge when `untrusted` (amber, "from untrusted content").
- A **Preview/Edit** affordance: clicking fetches the full body
  (`GET /chats/:id/skill-suggestions` returns bodies, or fetch per-suggestion)
  and shows it in an expandable area / modal with an editable textarea.
- Accept button → `POST .../accept` with any edits + a scope toggle
  (Project / Global). Reject button → `.../reject`.
- Reuse `existingSuggestionIds` / expiry helpers (`cancelFactSuggestionRowExpiry`
  analogue) so the inbox self-cleans.

### 12b. Project Skills panel — mirror the project facts list
- A "Skills" section on the project view (next to Facts): list each active skill
  as **name — description**, with view (open body modal), edit, delete.
- This list IS the "short summary per skill" deliverable.
- Live-update via the new `project-skill-*` WS events.

### 12c. Composer indicator (optional, phase 2)
A small "N skills" chip in the composer for Work/Execute, like the work-folders
count, so the user knows skills are active for this project.

---

## 13. Wiring checklist (file-by-file)

1. `src/db/database.ts` — add the two tables + indexes (§4).
2. `src/types/index.ts` — add `ProjectSkill`, `ProjectSkillSuggestion` (§6).
3. `src/services/store.ts` — add `projectSkills`, `projectSkillSuggestions` (§5).
4. `src/services/projectSkills.ts` (NEW) — reviewer pipeline (§8).
5. `src/services/chatRunner.ts` — call `scheduleProjectSkillReview` (throttled),
   add the skills index to `buildWorkSystemPrompt`, and (option A §7b) pass
   active skills into `createWorkSession` + include them in the `workSessions`
   recreation signature.
6. `src/services/workRuntime.ts` — add `skills` to `CreateSessionOptions` and
   send it.
7. `packages/iclaw-runtime/src/index.ts` + `sessions.ts` — accept `skills` on
   session create, store on the session.
8. `packages/iclaw-runtime/src/agent/tools.ts` + `loop.ts` — add `get_skill`
   tool reading the session's skill map; bump usage via an event/log the host
   can observe (or skip usage tracking in MVP).
9. `src/services/projectMemory.ts` — add skills index to `buildGatewayUserMessage`
   (Execute path).
10. `src/routes/chats.ts` — skill-suggestion inbox routes (§9).
11. `src/routes/projects.ts` — active-skill CRUD routes (§9).
12. `src/types/protocol.ts` — WS events (§11).
13. `public/js/iclaw.js` (+ relevant `views/*.ejs`, `public/css/style.css`) —
    inbox cards + project Skills panel (§12).

---

## 14. Phasing

**MVP (ship first):**
- Tables, store, types.
- Reviewer pipeline (throttled, JSON output, dedup, patch-vs-new).
- Inbox suggestions + WS + chat cards (accept/edit/reject, scope, untrusted badge).
- Project Skills panel (list/view/edit/delete) — the summary view.
- Prompt **index** injection (Work/Secure via `buildWorkSystemPrompt`, Execute
  via `buildGatewayUserMessage`). For bodies, use the "inline top-N small skills"
  shortcut (§7b) — defer real `get_skill`.

**Phase 2:**
- `get_skill` tool (runtime in-memory map, option A) + usage tracking.
- Trust-level auto-accept of **trusted** suggestions (config per project;
  untrusted always gated).
- Nudge intervals (Hermes-style in-band reminder).
- Skill compaction / merge when a project accumulates many.
- Composer "N skills" chip.

---

## 15. Acceptance criteria (definition of done for MVP)

- [ ] After ~8 tool-using turns in a project chat (or on session end), a skill
      suggestion can appear in the chat as an inbox card with name + description.
- [ ] No skill ever becomes active without the user clicking Accept.
- [ ] Accepting a `new` suggestion creates a `project_skills` row (SKILL.md
      body); accepting a `patch` updates the target and bumps `version`.
- [ ] The user can edit the body before accepting.
- [ ] Suggestions from untrusted sessions show the untrusted badge.
- [ ] The project Skills panel lists each active skill as name — description,
      with view/edit/delete, live-updating over WS.
- [ ] Active skills' `name: description` index appears in the Work/Secure and
      Execute system prompts, token-bounded.
- [ ] Rejecting / deleting works and broadcasts the removal.
- [ ] Type-checks clean: `npm run typecheck` (host) and runtime `tsc --noEmit`
      (ignore the pre-existing `agent-to-agent` / `db-v2.test` errors).

---

## 16. Open decisions (resolve with product owner if blocked)

1. **Reviewer model:** gateway 'main' agent (consistent with facts) vs a cheap
   OpenRouter model (`SUMMARY_MODEL` style). Default: reuse the facts pattern
   (gateway throwaway) for MVP.
2. **Trigger cadence:** every-N-turns vs session-end vs both. Default: both,
   N=8.
3. **Global scope at acceptance:** include the Project/Global toggle in MVP, or
   project-only first? Default: include the toggle (cheap, and useful).
4. **`get_skill` vs inline bodies:** MVP uses inline-top-N; confirm that's
   acceptable or prioritize the tool.

---

## 17. Don't break

- Facts must keep working untouched — skills are additive and parallel.
- The Work/Secure session recreation logic (`workSessions` signature in
  `chatRunner.ts`) already recreates on folder/mode change; if you add skills to
  the injected session state, **add skills to that signature** so accepting a
  skill takes effect without a manual restart (this is the same class of bug we
  already fixed for folder-access and mode changes — see git history
  `fix(work): recreate session on Work<->Secure mode switch`).
- Keep the reviewer **off the hot path** (fire-and-forget, like
  `scheduleProjectFactExtraction`); never block the user's turn on it.
