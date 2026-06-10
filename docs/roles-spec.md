# iClaw — Roles: build-ready specification

> Build doc for the agent implementing the "Roles" feature. Contains: (1) deep
> definition of a Role, (2) manifest schema, (3) full example, (4) first 20 roles,
> (5) implementation notes.
>
> **Sequencing principle:** first take ONE role (`content-strategist`) to a "wow"
> reaction on a real person. The other 19 are a curated queue, NOT a marketplace.
> Don't show all 20 at once (see progressive disclosure below).

---

## 1. What a "Role" is (deep definition)

**A Role = a hired digital specialist worker in its own box.** Not a prompt, not a
skill, not a GPT. A complete package that means the user is NOT staring at a blank
screen wondering "what can this thing even do."

### Anatomy of a role (6 parts)
1. **SOUL (persona + standards)** — system prompt: who it is, how it works, its
   quality bar, its voice, what it does NOT do. The worker's "character".
2. **Tools (wired-in integrations)** — concrete integrations connected in one tap
   (1 token, no OAuth hell where possible). Each tool has a **scope** (read /
   read_write) and goes into the container's **egress allowlist**.
3. **Workspace (the box)** — ephemeral isolated Docker container. Cut off from the
   computer; network only to allowed tools. Work persists NOT in the box but in the
   tool (e.g. Notion), so the container is disposable.
4. **Memory (role memory)** — what the role remembers between runs: brand voice,
   audience, past deliverables, preferences. Separate from the box.
5. **delegation_examples** — 3-5 concrete "do this for me" button-prompts. Cure the
   "blank screen = blank head".
6. **Deliverable contract** — what the role PRODUCES that you review (a doc, a
   filled database, a report). The role doesn't "quietly automate" — it brings a
   result for review. Human in the loop.

### The leash (cross-cutting principle)
- Every role has **permissions**: what's read, what's write, what needs human
  approval (publish / delete / sending outward).
- **Kill-switch**: "Delete" = tear down the container = "fired the worker". The
  work stays in the tool.
- Precise promise: "doesn't touch your COMPUTER — only the tools you gave it; you
  revoke both instantly."

### A Role is NOT:
- **not a skill** — a skill is too small (one action); a role is a worker with a
  set of skills + memory + tools.
- **not a GPT** — a GPT is flat: no wired tools, no cross-session memory, no
  delegation, no box/leash.
- **not an autonomous bot** — it doesn't act blind; it produces a deliverable for
  review (market lesson: over-promised autonomy = churn).
- **not a prompt** — a prompt is just part of SOUL.

### Lifecycle (what the user sees)
1. **"Roles"** tab → sees specialists → picks Content Strategist.
2. Sees 3 `delegation_examples` (buttons) + an input row. Immediately clear what it
   can do.
3. "Connect Notion" → one token.
4. Gives a task in one line → the role runs in a container → in 60-90s a finished
   **deliverable** (a filled Notion database) for review.
5. **"Delete"** button = fired. The work stays in Notion.

---

## 2. Role manifest schema (build every role exactly like this)

```yaml
role:
  id: content-strategist            # kebab-case, unique
  name: "Content Strategist"
  tagline: "Turns a topic into a ready content plan in your Notion"
  icon: "🧭"
  audience: "marketers, founders, content makers"
  connect_difficulty: easy          # easy = token/web/local; oauth = harder (Google/Gmail/Slack)

  soul: |                           # system prompt / persona
    You are a senior-level content strategist. You think in channels, audiences and
    funnels, not "posts". You write tersely, no AI fluff. You always show the plan
    for review; you publish nothing without confirmation.

  tools:
    - id: notion
      scope: read_write
      connect: token                # one token, no OAuth
  egress_allowlist:                 # container network — ONLY this
    - api.notion.com
    - api.anthropic.com

  workspace:
    type: ephemeral_container       # Docker, isolated from host
    persist_in_container: false     # work lives in the tool, not the box

  memory:
    type: per_role
    remembers: [brand_voice, audience, past_plans]

  deliverable:
    type: notion_database           # what the user reviews
    review: human_in_loop

  delegation_examples:              # buttons (cure the blank screen)
    - "Make a month content plan for [topic]"
    - "Turn my old blog into 10 short-video ideas"
    - "Find 5 topics nobody in my niche has covered"

  permissions:
    requires_approval: [publish_external, delete_external]
    kill_switch: delete_container   # = "fired"

  definition_of_done: >
    A filled Notion database with the plan, shown for review. Nothing published or
    deleted externally without confirmation.
```

**Agent:** implement all 20 roles below with this schema. Fields `soul`,
`delegation_examples`, `deliverable`, `tools.scope`, `egress_allowlist` are
mandatory for every role.

---

## 3. The first 20 roles

> Format: **id · Name** — for whom · tool(scope, connect) · deliverable ·
> 3× delegation_examples · leash.
> `connect: easy` = Notion/web/local files/token (no OAuth). `connect: oauth` =
> Google/Gmail/Slack (harder — second wave).

### Wave 1 — marketing/content (your beachhead; start with #1)

**1. content-strategist · Content Strategist** — marketers, founders
- Tool: Notion (read_write, easy) · Deliverable: Notion DB (content plan)
- Examples: "Month content plan for [topic]" / "10 short-video ideas from my blog" /
  "5 uncovered topics in my niche"
- Leash: publish — only with confirmation.

**2. copywriter · Copywriter** — anyone who writes
- Tool: Notion or Google Docs (read_write; Notion easy) · Deliverable: text drafts
- Examples: "Write a landing page for [product]" / "5 subject-line variants for this
  email" / "Rewrite this simpler, no jargon"
- Leash: drafts only; sends nothing.

**3. social-media-manager · Social Media Manager** — content teams
- Tool: Notion (read_write, easy) · Deliverable: post calendar + captions
- Examples: "Schedule a week of posts from these 3 news items" / "Adapt this post for
  X, LinkedIn, IG" / "20 story ideas this month"
- Leash: doesn't post itself; prepares drafts.

**4. seo-specialist · SEO Analyst** — marketers, site owners
- Tool: web + Google Sheets (read_write; web easy, Sheets oauth) · Deliverable:
  keyword cluster table + on-page checklist
- Examples: "Keyword clusters for [topic]" / "On-page checklist for this page" /
  "10 featured-snippet topics"
- Leash: read-only on the site; changes nothing live.

**5. email-marketer · Email Marketer** — marketing, founders
- Tool: Notion (read_write, easy) · Deliverable: email sequence (drafts)
- Examples: "5-email welcome series for [product]" / "Reactivate dormant subs" /
  "A/B subject-line variants"
- Leash: drafts in Notion only; doesn't send.

### Wave 2 — operations/founder/admin

**6. market-researcher · Market Researcher** — founders, PMs
- Tool: web + Notion (read_write; easy) · Deliverable: market/competitor brief with
  citations
- Examples: "Brief on 5 competitors in [category]" / "What people hate about
  [product] (with sources)" / "[niche] market size + trends"
- Leash: read-only web; sources mandatory.

**7. personal-assistant · Personal Assistant** — everyone
- Tool: Calendar + Gmail-read (oauth) · Deliverable: daily brief + triage (proposes,
  you confirm)
- Examples: "Make my daily brief" / "Which emails need a reply today" / "Propose 3
  slots for a meeting with [who]"
- Leash: reads mail only; sends/deletes nothing without confirmation.

**8. meeting-notetaker · Meeting Notetaker** — teams, founders
- Tool: local file/transcript → Notion (read_write, easy) · Deliverable: notes →
  action items
- Examples: "Turn this transcript into notes + tasks" / "Extract decisions and who's
  responsible" / "5-line summary"
- Leash: reads local file; writes only to Notion.

**9. crm-organizer · CRM Curator** — sales, freelancers
- Tool: Google Sheets/Notion (read_write; Notion easy) · Deliverable: cleaned lead
  list + follow-up drafts
- Examples: "Clean and dedupe this lead list" / "Enrich companies with industry +
  size" / "Write follow-ups for those silent 7 days"
- Leash: follow-ups — drafts only.

**10. finance-organizer · Finance Organizer** — freelancers, small biz
- Tool: Google Sheets / CSV (read_write; oauth/local) · Deliverable: categorized
  expenses + simple report
- Examples: "Categorize these transactions" / "Sum the month's expenses into a
  report" / "How much did I spend on subscriptions"
- Leash: does NOT make payments/transfers; only organizes data.

### Wave 3 — knowledge/research/learning

**11. tutor-explainer · Tutor-Explainer** — students, self-learners
- Tool: chat + local files (read, easy) · Deliverable: explanations, study plan,
  quizzes
- Examples: "Explain [topic] like I'm a beginner" / "2-week plan to learn [skill]" /
  "Generate a quiz from this PDF"
- Leash: read-only on files.

**12. research-summarizer · Research Summarizer** — researchers, analysts
- Tool: web + Notion (read_write; easy) · Deliverable: source digest with citations
- Examples: "Summarize 5 articles on [topic] with links" / "What's new in [field]
  this month" / "Compare these 3 approaches"
- Leash: read-only web; every claim — with a source.

**13. doc-drafter · Document Drafter** — freelancers, small biz
- Tool: Google Docs/Notion (read_write; Notion easy) · Deliverable: drafts of common
  documents
- Examples: "Draft a service agreement" / "Client brief from these notes" / "Invoice
  template"
- Leash: drafts only; explicit "check with a lawyer" disclaimer.

**14. knowledge-base-builder · Knowledge Base Builder** — teams, founders
- Tool: Notion (read_write, easy) · Deliverable: structured wiki/KB from note chaos
- Examples: "Turn these notes into a structured wiki" / "Make an onboarding doc for a
  new hire" / "Tidy up this Notion page"
- Leash: works in a separate base; doesn't touch others' pages without permission.

### Wave 4 — product/dev-adjacent (non-technical-friendly)

**15. product-manager · Product Manager** — founders, PMs
- Tool: Notion/Linear (read_write; Notion easy) · Deliverable: PRD, user stories,
  roadmap
- Examples: "Write a PRD for [feature]" / "Break this idea into user stories" /
  "Draft a quarter roadmap"
- Leash: writes only to the working base.

**16. bug-triager · Bug Triager** — PMs, indie devs
- Tool: GitHub issues (read) + Notion (read_write; oauth/easy) · Deliverable:
  organized/reproduced bug reports
- Examples: "Group these bugs by theme + priority" / "Try reproducing this bug step
  by step" / "Top-5 complaints this week"
- Leash: read-only GitHub; closes/writes nothing in issues.

**17. data-analyst · Data Analyst** — operators, marketers
- Tool: Google Sheets/CSV (read_write; oauth/local) · Deliverable: analysis +
  summary + chart spec
- Examples: "Analyze this sales table" / "Find the top-3 insights" / "Which channel
  has the best ROI"
- Leash: doesn't change raw data; writes to a separate tab.

### Wave 5 — everyday (for everyone, shows "not just for devs")

**18. travel-planner · Travel Planner** — everyone
- Tool: web + Notion/Docs (read_write; easy) · Deliverable: itinerary + budget
- Examples: "5-day [city] itinerary under $1000" / "Find flights and stays for these
  dates" / "What to pack for [trip]"
- Leash: does NOT book or pay; prepares a plan.

**19. meal-planner · Meal Planner** — everyone
- Tool: Notion/Sheets (read_write; Notion easy) · Deliverable: menu plan + shopping
  list
- Examples: "Week menu plan, budget + vegan" / "Shopping list from these recipes" /
  "What can I cook with what's at home"
- Leash: only plans.

**20. career-coach · Career Coach** — job seekers, students
- Tool: Google Docs/local files (read_write; oauth/local) · Deliverable: resume +
  cover letter tailored to a job
- Examples: "Tailor my resume to this job" / "Write a cover letter" / "What skills
  am I missing for [role]"
- Leash: reads resume; writes drafts only.

---

## 4. Implementation notes (agent)

- **Each role = one ephemeral container.** Launching a role starts a container with
  its `egress_allowlist`; "Delete" = `docker rm -f` = fired. The work is already in
  the tool.
- **Default leash is restricted:** read where possible; write only to the tool's
  assigned space; everything external (publish/send/delete) — on human confirmation.
  Log every tool action (visible to the user).
- **One-tap connect:** prioritize `connect: easy` (Notion/web/local/token). Roles
  with `oauth` (Google/Gmail/Slack) — second wave, because OAuth onboarding is
  harder (that's the real "engineering boss", not the container).
- **delegation_examples — mandatory and clickable.** It's the first thing the user
  sees after picking a role. Without them the screen is "blank".
- **Deliverable always for review.** No role acts blind; the result is shown, the
  human confirms external actions.
- **Memory per-role**, separate from the container (brand voice, audience, past
  deliverables).
- **Progressive disclosure:** don't dump all 20. At the start — a few most relevant
  (start with `content-strategist`). Reveal others as the user matures (per the
  "feature appears after N interactions" pattern). A marketplace of hundreds is
  forbidden.
- **MVP slice for validation:** implement ONLY `content-strategist` end-to-end first
  (Roles → pick → 3 examples → connect Notion → one line → filled DB in 60-90s →
  Delete). Prove the "wow", then unlock the queue.

---

## 5. Build queue (recommended order)
1. `content-strategist` (take to "wow" — the gate)
2. `copywriter`, `social-media-manager` (same Notion integration, zero new infra)
3. `market-researcher`, `research-summarizer` (web read — no new auth)
4. `meeting-notetaker`, `knowledge-base-builder` (Notion + local files)
5. then the rest, by demand (metric: % who ran a 2nd role within 7 days)
