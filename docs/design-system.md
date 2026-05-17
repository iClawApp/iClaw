# iClaw design system

Single source of truth: `public/css/style.css`. This doc explains the moving parts and shows copy-pasteable markup for the four reusable component primitives (`.btn`, `.chip`, `.card`, `.menu`).

## Why

Before the design system the stylesheet had ~10 separate button selectors (`.stop-btn`, `.interrupt-btn`, `.compact-btn`, `.exec-approval-btn`, `.fact-suggestion-btn`, `.scheduled-item-cancel`, `.schedule-menu-item`, `.slash-item`, `.composer-send`…) each duplicating the same padding / border / radius / hover dance. Adding a new button meant copying ~15 lines of CSS and hoping you matched the rest. Now there's one definition, four tone variants, two sizes, and every button is one HTML class away.

## Tokens

Defined in `:root` at the top of `style.css`, light-mode by default and overridden by `@media (prefers-color-scheme: dark)`.

### Spacing (4 px grid)

| Token        | Value | Typical use                       |
|--------------|-------|-----------------------------------|
| `--space-0`  | 0     | reset                             |
| `--space-1`  | 2 px  | hairline gap                      |
| `--space-2`  | 4 px  | tight gap (button icon ↔ label)   |
| `--space-3`  | 6 px  | menu padding, popover gap         |
| `--space-4`  | 8 px  | small-button padding-y, card gap  |
| `--space-5`  | 10 px | small-button padding-x            |
| `--space-6`  | 12 px | comfortable padding               |
| `--space-7`  | 16 px | card padding-x                    |
| `--space-8`  | 20 px | section padding-x                 |
| `--space-9`  | 24 px | section padding-y                 |
| `--space-10` | 32 px | full-width section padding        |

### Radius

| Token            | Value  | Use                          |
|------------------|--------|------------------------------|
| `--radius-xs`    | 4 px   | inline code, tiny chips      |
| `--radius-sm`    | 6 px   | menu items, small buttons    |
| `--radius-md`    | 8 px   | primary buttons, inputs      |
| `--radius-lg`    | 12 px  | popovers, cards              |
| `--radius-xl`    | 16 px  | composer field, large cards  |
| `--radius-pill`  | 999 px | chips, status badges         |
| `--radius-circle`| 50 %   | round icon buttons, avatars  |

### Stacking (`--z-*`)

`base: 1 → sticky: 10 → popover: 30 → modal: 100 → toast: 200`. Popovers (schedule menu, slash autocomplete) sit above the chat surface but always below any future modal layer.

### Shadows

| Token | Use |
|-------|-----|
| `--shadow-sm` | Composer + chip hover halo |
| `--shadow-md` | Cards lifted off the surface |
| `--shadow-lg` | Popovers anchored to triggers (slash, schedule) |
| `--shadow-xl` | Menu popovers + future modal panels |

All four have dark-mode-tuned overrides in the `@media` block.

### Typography

`--text-xs (0.75rem) · --text-sm (0.85rem) · --text-base (0.95rem) · --text-md (1rem) · --text-lg (1.1rem)`. Use semantic names; never hardcode `font-size: 14px`.

### Semantic colors

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--warn`            | `#c47a00` | `#fbbf24` | exec approval cards, "in flight" |
| `--info`            | `#2962ff` | `#7ab7ff` | informational badges, links |
| `--approve`         | `#2da44e` | `#4ade80` | approve buttons |
| `--approve-soft-*`  | bg / fg / border | … | approve hover + soft surface |
| `--warn-soft-*`     | bg / border | … | approval card surface |
| `--danger` / `--ok` / `--down` | existing | existing | error / success / offline states |

A `--focus-ring` is exposed for any focusable element (`.btn` / `.chip` / inputs all use it via `:focus-visible`).

## Primitives

### `.btn`

```html
<button class="btn">Default</button>
<button class="btn btn--primary">Send</button>
<button class="btn btn--danger btn--sm">Stop</button>
<button class="btn btn--approve btn--sm">Approve</button>
<button class="btn btn--ghost btn--sm">Compact</button>
<button class="btn btn--icon btn--ghost">×</button>
```

| Modifier      | Effect                                                 |
|---------------|--------------------------------------------------------|
| `.btn--sm`    | smaller padding + `--text-xs` font                     |
| `.btn--lg`    | bigger padding + `--text-base` font                    |
| `.btn--primary` | filled with `--btn-bg`/`--btn-fg`, dark in light mode |
| `.btn--danger`  | red-tinted soft surface, used for Stop / Deny        |
| `.btn--approve` | green-tinted soft surface, used for Approve          |
| `.btn--ghost`   | transparent border + transparent bg, hover halo only |
| `.btn--icon`    | square 36 × 36 with `--radius-circle`                |

Focus ring + disabled state + active-scale transform are inherited from `.btn` — variants only swap colors.

### `.chip`

```html
<span class="chip">Neutral</span>
<span class="chip chip--ok">Connected</span>
<span class="chip chip--down">Unreachable</span>
<span class="chip chip--warn">Shutting down</span>
<span class="chip chip--accent">Today $0.42</span>
```

Use chips for compact static labels (status, counters, badges). They honor `[hidden]`.

### `.card`

```html
<div class="card">…</div>
<div class="card card--warn">Approval needed</div>
<div class="card card--danger">Run failed</div>
<div class="card card--accent">Highlighted note</div>
```

Cards have a 3 px left-border accent + matching tinted background. Use them for inline callouts (exec approval prompts, fact suggestions, future notifications).

### `.menu` + `.menu-item`

```html
<div class="menu" hidden role="menu">
  <button class="menu-item" type="button">
    <span class="menu-item__title">Compact session</span>
    <span class="menu-item__hint">Sends /compact</span>
  </button>
  <button class="menu-item is-active" type="button">
    <span class="menu-item__title">New chat</span>
  </button>
</div>
```

Position the `.menu` absolutely relative to its trigger and toggle the `hidden` attribute from JS. `.menu-item.is-active` is the keyboard-navigation highlight.

## Migration recipe

Adding a new affordance:

1. **Identify the closest primitive.** A button is `.btn`; a small label is `.chip`; an inline callout is `.card`; an anchored list is `.menu`.
2. **Reach for tone + size variants** instead of inventing new selectors. `Stop` is `btn--danger btn--sm`; `Compact` is `btn--ghost btn--sm`.
3. **Need something the primitive can't express?** Add an *override* class on top, NOT a sibling primitive. Example: `.scheduled-item-cancel` is `.btn .btn--icon .btn--ghost` + 4 lines of CSS to shrink to 22 × 22 px.
4. **Adding a new color?** Define a `--color-*` token in `:root` (with a dark-mode override) and reference it everywhere. Hardcoded hex outside the token block is a code smell.

## What still exists as legacy snowflakes

Everything below the design system block in `style.css` predates it. Live snowflakes that still own most of their visuals:

- `.composer-field`, `.composer textarea`, `.composer-send` — composer; tied to the round send-button visual.
- `.msg.user`, `.msg.assistant`, `.msg-body` — message bubbles; very specific Markdown + code-block tuning.
- Sidebar items (`.chat-item`, `.project-row`, status dots).
- Project page tabs (`.project-tabs`, `.tab-link`).
- Reasoning + tool-status streaming pills (`.stream-tool`, `.stream-generating`).

Touching these is fine when adding a feature in that area — fold the values onto tokens (`--space-*`, `--radius-*`, `--shadow-*`, semantic colors) as you go.

## Tested

The primitives have no behaviour to unit-test directly. Components that *use* them (composer, header buttons, scheduled list, exec approval cards, slash menu) are exercised in:

- `test/integration/chatRunner.test.ts` — attachment rendering, reasoning gate, project context injection
- `test/integration/routes.chats.test.ts` — model swap, reasoning toggle, scheduled CRUD, delete + sessions.delete
- `test/integration/scheduler.test.ts` — fire / cancel / future-row safety
- `test/unit/wsHub.test.ts` — broadcast scoping
- `test/unit/chatStatus.test.ts` — per-chat lock serialisation
