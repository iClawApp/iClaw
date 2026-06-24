# Character Verification — Declared Done-Criteria for Specialist Workers

> Audience: an engineer/agent working on iClaw's characters or the runtime loop.
> Status: **MVP shipped** (rubric + judge model). The programmatic `checks` half
> is designed here but deliberately **not built** — no code-doing character needs
> it yet.

## 0. One-paragraph summary

Each specialist character (Emmie, Remi, Soshie, Ava, Leo) now carries a
**declared, typed definition-of-done** for its deliverable, instead of leaving
"is this good enough?" to the model's own self-judgement. On a character's
autonomous turn the runtime's **independent check (#1)** scores the deliverable
against THIS character's `rubric`, and — now by default — a **different-family
judge** (`google/gemini-2.5-flash`) does the scoring rather than the host model
grading its own homework. The whole block is optional: a character that declares
nothing still gets the (now cross-family) check, and behaves as before otherwise.

**Roster coverage:** the five business/knowledge workers that produce a discrete
deliverable carry rubrics (Emmie=replies, Remi=research, Soshie=posts/calendar,
Ava=plans/dates, Leo=leads). The generalist (no fixed job) and Ace (browser
operator, task varies per run) intentionally declare none.

## 1. Provenance — why this exists

Studied [`ksimback/looper`](https://github.com/ksimback/looper) (a Claude Code
skill that *designs* review-gated agent loops). Looper operates at a different
layer than us — it's a pre-flight design coach; our `loop.ts` is the runtime that
executes loops. Most of its machinery (CLI detection, argv invocation, file
handoff, cross-vendor egress consent) doesn't transfer, because we're already a
hosted orchestrator on OpenRouter.

But three of its design *ideas* were relevant, and all three pointed at the same
known gap (see memory `loop_engineering_study` → "biggest gap = independent
verification"):

1. **Cross-model council** — "don't let the worker grade its own homework." Our
   verifier defaulted to the *same* model as the host (`VERIFY_MODEL || effectiveModel`).
2. **Typed verification** — prefer a declared, checkable bar over vibes.
3. **Plan gate** — verify the plan before executing (judged speculative; deferred).

The insight: the natural home for a *declared* verification in iClaw is **the
character registry** (pre-designed workers), not the generic loop. This feature
is #1 + #2, landed there.

## 2. The wire path (host → runtime)

`verification` rides the exact channel `characterTools` already uses:

```
src/services/characters.ts        CharacterDef.verification + characterVerification(id)
  → src/services/chatRunner.ts    fetch + pass into createWorkSession
  → src/services/workRuntime.ts   CreateSessionOptions.verification → HTTP body
  → packages/iclaw-runtime/src/index.ts      parse body.verification → createSession
  → packages/iclaw-runtime/src/sessions.ts   SessionOptions.verification → runAgentTurn opts
  → packages/iclaw-runtime/src/agent/loop.ts AgentOptions.verification → the verifier
```

The host `CharacterVerification` and the runtime `TurnVerification` are two
independent declarations of the same JSON shape (separate packages, crosses an
HTTP boundary) — keep them in sync.

## 3. The type (MVP)

```ts
interface CharacterVerification {
  judgeModel?: string;   // DIFFERENT family than host for a real second opinion
  rubric?: string;       // plain-language definition-of-done the judge scores against
}
```

On `CharacterDef`: `verification?: CharacterVerification`.

## 4. Runtime behaviour (`loop.ts`)

This is a generalisation of the existing independent check, not a new loop:

- **Gating is unchanged.** Verification still only runs when `shouldVerify`
  (`opts.autonomous === true && ICLAW_VERIFY !== 'off'`). Specialist character
  chats are already autonomous (`autonomous = !!character_id && chat_kind !==
  'task_execution'`), so the check already fires for them.
- **Firing condition widened:** the check now runs when there's tool evidence
  **OR** a rubric is declared. (A rubric judges the deliverable itself, so it
  applies even to a no-tool answer — e.g. Emmie drafting from a pasted thread.)
- **Judge model precedence:** `verification.judgeModel` → global
  `ICLAW_VERIFY_MODEL` → `DEFAULT_VERIFY_MODEL`. **Cross-model is now ON by
  default:** `VERIFY_MODEL` defaults to `google/gemini-2.5-flash` (mirrors the
  vision default — cheap, fast, and a different family from the minimax/deepseek
  hosts), so the independent check no longer grades its own homework out of the
  box. To pin same-model self-check, set `ICLAW_VERIFY_MODEL` to the host model
  id; `ICLAW_VERIFY=off` disables the check entirely.
- **Prompt:** with a rubric, `verifierSystem()` builds a rubric-scored reviewer
  ("score the DELIVERABLE strictly against this RUBRIC"); without one, the
  original evidence fact-checker is used verbatim. Both return the same
  `{verdict, issues}` JSON, so `parseVerifierVerdict` is unchanged.
- **Judge inputs (rubric path):** REQUEST (the turn's user message, capped at
  `VERIFY_REQUEST_CHARS`) + DELIVERABLE (the answer) + EVIDENCE (tool outputs).
  The REQUEST matters because the user's input is **never** in the evidence pool
  — without it, input-relative rubrics ("answers every question *in the source
  thread*", "invents no fact *absent from the thread*") would be unjudgeable.
  Note the evidence pool excludes ack-only tools (`NON_EVIDENCE_TOOLS`:
  update_calendar, set_reminder, create_task, …), and `write_file` returns an ack
  (not the file body) — so for file/calendar deliverables the judge scores the
  chat text + source evidence, not the written artifact's full contents. The
  system prompt tells the judge to skip, not fail, any rubric point it can't check
  from what it was given.
- **Still fail-OPEN, still capped.** A broken/unavailable judge → `pass` (never
  blocks the turn); `VERIFY_MAX_REVISIONS = 1`; the token budget is the backstop.
  This is deliberately the opposite of Looper (which fails to `revise`) — our UX
  rule is "never block the user's turn on a flaky verifier."

## 5. Worked example — Emmie

```ts
verification: {
  rubric:
    'The reply answers every question and request raised in the source thread; ' +
    "matches the tone and formality the user asked for (or the thread's own register); " +
    'makes no commitment, promise or date the source thread did not contain; ' +
    'invents no facts, names or numbers absent from the thread; ' +
    'ends ready to send with nothing left as a placeholder or "[TBD]".',
}
```

Rubric-only on purpose. No character hard-codes a `judgeModel` — the global
`VERIFY_MODEL` default already makes the review cross-family
(`google/gemini-2.5-flash`), so a per-character override is only needed when one
worker should be judged by a *specific* different model. Pinning a model id into a
shipped character is a per-deployment decision, and a wrong/unavailable id would
silently fail-open — so we leave it to the env default.

## 6. How to add verification to a character

1. In `src/services/characters.ts`, add a `verification` block to the character's
   `RAW_CHARACTERS` entry. Write a **concrete, checkable** rubric — name the
   dimensions that matter for that job (see goal/verification anti-patterns:
   avoid "high quality"/"comprehensive" with no dimensions).
2. Optionally set `judgeModel` to a different-family model id for cross-model review.
3. That's it — the wire path and runtime handle the rest. Run
   `npm run typecheck` and `npx vitest run test/unit/characters.test.ts`.

## 7. Deferred: programmatic `checks` (the future half)

Looper's verification taxonomy is `programmatic | judge | human`. We shipped the
`judge` half. The `programmatic` half — run a deterministic check and require a
result before the judge — is designed but **not built**:

```ts
// FUTURE — not implemented.
checks?: Array<{
  id: string;
  run: string[];                                    // argv array, never a shell string
  expect: 'exit_zero' | 'exit_nonzero' | 'stdout_contains';
  contains?: string;
}>;
```

Intended semantics when added:
- Run `checks` in the session sandbox (reuse the `run_command` path) **before**
  the judge call — cheap, free, objective.
- A check that **ran and missed** `expect` → `revise` with its stderr (a real,
  actionable signal — distinct from fail-open).
- A check that **couldn't run at all** (missing binary, timeout) → skip + warn,
  staying fail-open.

**Why deferred:** `checks` only help code-doing workers (build/test/lint exit
codes), and no current character does code work. Adding the sandbox-check runner
to `loop.ts` now would be wiring for a consumer that doesn't exist (YAGNI). Add it
alongside the first code-producing character.

## 8. Tests

`test/unit/characters.test.ts` covers the getter contract: generalist/unknown →
`null`; the 5 deliverable workers → a concrete rubric, none hard-coding a
`judgeModel`; generalist + browser declare none. `test/unit/loopCompaction.test.ts`
covers the verifier helpers (`parseVerifierVerdict`, `buildVerifierEvidence`) plus
a **judge round-trip against a mock client** (`runVerification` / `verifierSystem`,
exported for tests): the cross-family default model is selected, the rubric path
assembles REQUEST + DELIVERABLE + EVIDENCE with the rubric system prompt, a
gemini-style fenced-JSON verdict parses correctly, the fact-checker path omits
REQUEST, and an erroring/garbage judge fails-open to `pass`.

**Live smoke (needs a real key — this is the only check the unit tests can't do).**
Confirms `google/gemini-2.5-flash` is reachable on the deployment's OpenRouter key
and the judge behaves. After `npm run build` in `packages/iclaw-runtime`:

```bash
ICLAW_OPENROUTER_API_KEY=<key> node --input-type=module -e '
import OpenAI from "openai";
import { runVerification, DEFAULT_VERIFY_MODEL } from "./packages/iclaw-runtime/dist/agent/loop.js";
const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.ICLAW_OPENROUTER_API_KEY });
const v = await runVerification(
  client, DEFAULT_VERIFY_MODEL,
  "Hi Sam — yes, Tuesday 3pm works and the price is $400.",          // deliverable
  "", undefined,
  "The reply answers every question in the source thread; invents no fact absent from it.",  // rubric
  "Thread from Sam: Are you free Tuesday? And what does it cost?"    // request
);
console.log(DEFAULT_VERIFY_MODEL, "→", JSON.stringify(v));
'
```

With a real key the judge should return `revise` — the draft invents "3pm" and
"$400", facts the thread never contained. (With no key it fails-open to `pass`,
which is itself the fail-open path working.)

## 9. Note for the runtime dev loop

The runtime runs from `dist/` (the sidecar), not `src/` — changes to `loop.ts` /
`sessions.ts` / `index.ts` need `npm run build` in `packages/iclaw-runtime` and a
sidecar restart to take effect. The host app is tsx-watch (live).
