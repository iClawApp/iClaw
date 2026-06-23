// ── Browser agent (per-project, host-side, headful co-pilot) ──────────────────
//
// A real Chromium the agent drives via Playwright — and the user can grab the
// SAME window any time to log in, solve a captcha, or take over. Key design:
//
//   • Per PROJECT, not per chat: one persistent browser profile per project
//     (userDataDir = ~/.iclaw/browser/<projectId>), so cookies/logins persist and
//     are ISOLATED between projects — and it is NEVER the user's main browser.
//   • Host-side (this runtime is a host process), so headful shows a real window
//     the user can interact with — which Docker can't do without a VNC stack.
//   • Agent chooses headless vs headful (browser_open `visible`); default visible
//     so the user can step in.
//   • Self-installs Chromium on first use (no manual `playwright install`).
//   • Every tool fails SOFT: it returns a guidance string, never throws into the
//     turn. Screenshots ride the existing onImage pipeline into the chat.
//
// Kept out of the heavy import path: tools.ts imports this lazily (like social.ts),
// so Playwright only loads when a browser tool is actually called.

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { BrowserContext, Page, Locator } from 'playwright';
import type { ToolContext } from './tools.js';
import { DEFAULT_VISION_MODEL } from './model-capabilities.js';

const PROFILE_ROOT = process.env.ICLAW_BROWSER_PROFILE_DIR || join(homedir(), '.iclaw', 'browser');
const IDLE_MS = Number(process.env.ICLAW_BROWSER_IDLE_MS) || 10 * 60_000; // close idle browsers after 10m
const NAV_TIMEOUT = Number(process.env.ICLAW_BROWSER_NAV_TIMEOUT_MS) || 30_000;
const ACTION_TIMEOUT = Number(process.env.ICLAW_BROWSER_ACTION_TIMEOUT_MS) || 12_000;
const READ_MAX_CHARS = Number(process.env.ICLAW_BROWSER_READ_MAX) || 6_000;
const ELEMENTS_MAX = Number(process.env.ICLAW_BROWSER_ELEMENTS_MAX) || 100;
const SCROLL_STEP = 800; // px per browser_scroll up/down
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Coerce a tool arg into a finite element index, or undefined. */
function numArg(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  visible: boolean;
  lastUsed: number;
}

// One handle per project key. `null`/no project → a single "shared" profile.
const handles = new Map<string, BrowserHandle>();
let reaper: ReturnType<typeof setInterval> | null = null;
let shutdownHooked = false;

function projectKey(projectId: number | null | undefined): string {
  return projectId == null ? 'shared' : `p${projectId}`;
}

/** Reap idle browsers + close everything cleanly on runtime shutdown. */
function ensureLifecycle(): void {
  if (!reaper) {
    reaper = setInterval(() => {
      const now = Date.now();
      for (const [key, h] of handles) {
        if (now - h.lastUsed > IDLE_MS) {
          handles.delete(key);
          h.context.close().catch(() => {});
        }
      }
    }, 60_000);
    if (typeof reaper.unref === 'function') reaper.unref();
  }
  if (!shutdownHooked) {
    shutdownHooked = true;
    const bye = () => { void closeAllBrowsers(); };
    process.once('SIGTERM', bye);
    process.once('SIGINT', bye);
    process.once('exit', bye);
  }
}

/** Self-install the Chromium binary if Playwright can't find it. Runs once. */
function installChromium(): { ok: boolean; detail: string } {
  const r = spawnSync('npx', ['--yes', 'playwright', 'install', 'chromium'], {
    encoding: 'utf8',
    timeout: 5 * 60_000,
    env: { ...process.env },
  });
  if (r.status === 0) return { ok: true, detail: 'installed' };
  return { ok: false, detail: (r.stderr || r.stdout || r.error?.message || 'unknown error').slice(0, 300) };
}

/** Launch (or reuse) the project's persistent browser. Self-installs on first use. */
async function ensureBrowser(projectId: number | null | undefined, visible: boolean): Promise<BrowserHandle | string> {
  ensureLifecycle();
  const key = projectKey(projectId);
  const existing = handles.get(key);
  if (existing) {
    // Same mode + a usable context → reuse it, refreshing the active page if the
    // user closed the tab. A dead context falls through to a relaunch.
    if (existing.visible === visible) {
      try {
        if (existing.page.isClosed()) {
          const alive = existing.context.pages().find((p) => !p.isClosed());
          existing.page = alive ?? (await existing.context.newPage());
        }
        existing.lastUsed = Date.now();
        return existing;
      } catch { /* context is gone → relaunch below */ }
    }
    // Mode changed (headful↔headless) or the context died → close + relaunch.
    handles.delete(key);
    await existing.context.close().catch(() => {});
  }

  const userDataDir = join(PROFILE_ROOT, key.replace(/[^a-zA-Z0-9_-]/g, '_'));
  try {
    mkdirSync(userDataDir, { recursive: true });
  } catch { /* best-effort */ }

  const { chromium } = await import('playwright');
  const launch = async (): Promise<BrowserContext> =>
    chromium.launchPersistentContext(userDataDir, {
      headless: !visible,
      viewport: { width: 1280, height: 860 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });

  let context: BrowserContext;
  try {
    context = await launch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Browser binary missing → install once and retry.
    if (/Executable doesn't exist|playwright install|please run the following/i.test(msg)) {
      const inst = installChromium();
      if (!inst.ok) {
        return `Couldn't open the browser: Chromium isn't installed and auto-install failed (${inst.detail}). On the machine running iClaw, run: npx playwright install chromium`;
      }
      try {
        context = await launch();
      } catch (err2) {
        return `Couldn't open the browser after installing Chromium: ${err2 instanceof Error ? err2.message : String(err2)}`;
      }
    } else if (visible && /Missing X server|no display|cannot open display/i.test(msg)) {
      return `Couldn't open a VISIBLE browser — this machine has no display. Retry with visible:false (headless), or run iClaw on a desktop.`;
    } else {
      return `Couldn't open the browser: ${msg}`;
    }
  }

  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  context.setDefaultTimeout(ACTION_TIMEOUT);
  const page = context.pages()[0] ?? (await context.newPage());
  const handle: BrowserHandle = { context, page, visible, lastUsed: Date.now() };
  handles.set(key, handle);
  return handle;
}

/**
 * Current page summary: title + url + readable text. A big page (> READ_MAX_CHARS)
 * is LLM-summarized TASK-AWARE (facts preserved, keyed to the user's goal) via a
 * cheap aux model instead of being hard-truncated — so navigate/read/back never
 * blow context on a long page. Mirrors Hermes' snapshot summarization. Falls back
 * to plain truncation when no key / no ctx / the aux call fails.
 */
async function pageSummary(page: Page, label: string, ctx?: ToolContext): Promise<string> {
  const url = page.url();
  let title = '';
  try { title = await page.title(); } catch { /* about:blank etc. */ }
  let text = '';
  try {
    // Runs in the BROWSER (globalThis = window). Cast through globalThis so this
    // typechecks in the runtime's Node context, which has no DOM lib.
    text = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
      return (doc?.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    });
  } catch { /* page navigating */ }
  let body: string;
  if (text.length <= READ_MAX_CHARS) {
    body = text;
  } else {
    const summary = ctx ? await summarizePageText(text, url, ctx) : null;
    body = summary
      ? `${summary}\n…[summarized from ${text.length.toLocaleString()} chars — call browser_elements for the exact controls]`
      : text.slice(0, READ_MAX_CHARS) + `\n…[truncated — call browser_read for more, or browser_elements for what's clickable]`;
  }
  return `${label}\nURL: ${url}\nTitle: ${title || '(none)'}\n\n${body || '(no readable text on the page yet)'}`;
}

/** Resolve the OpenRouter key from the tool context, falling back to env. */
function resolveApiKey(ctx: ToolContext): string {
  return ctx.apiKey || process.env.ICLAW_API_KEY || process.env.OPENROUTER_API_KEY || '';
}

/** POST to OpenRouter chat/completions; never throws. Shared by vision + summarize. */
async function openRouterChat(
  apiKey: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${b.slice(0, 160)}` };
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    return { ok: true, text: json.choices?.[0]?.message?.content?.trim() ?? '' };
  } catch (err) {
    return { ok: false, error: briefErr(err) };
  }
}

/** Task-aware summary of a long page's text via a cheap aux model. null = unavailable. */
async function summarizePageText(text: string, url: string, ctx: ToolContext): Promise<string | null> {
  const apiKey = resolveApiKey(ctx);
  if (!apiKey) return null;
  const model = (process.env.ICLAW_BROWSER_EXTRACT_MODEL ?? '').trim()
    || (process.env.ICLAW_VISION_MODEL ?? '').trim() || DEFAULT_VISION_MODEL;
  const hint = (ctx.taskHint ?? '').trim().slice(0, 200);
  const prompt =
    `Summarize the readable content of this web page (${url}) for a browser-automation agent. ` +
    (hint ? `Focus on anything relevant to this goal: "${hint}". ` : '') +
    `Preserve concrete facts — names, numbers, prices, statuses, headings — and the page's structure. Be concise.\n\nPAGE TEXT:\n${text}`;
  const r = await openRouterChat(
    apiKey,
    { model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] },
    Number(process.env.ICLAW_MODEL_TIMEOUT_MS) || 60_000,
  );
  return r.ok && r.text ? r.text : null;
}

/**
 * List interactive elements with a stable `[n]` ref each, so the model can act by
 * index (browser_click index:N) — far more reliable than label-matching, and the
 * ONLY way to hit an icon-only control (a ⋮ kebab, a bare-icon button) that has no
 * visible text. Each element is tagged with `data-iclaw-ref="n"` in the live DOM;
 * browser_click/browser_type re-find it by that attribute. Indices reset on every
 * call (and when the page changes), mirroring agent-browser / OpenClaw aria refs.
 */
async function listElements(page: Page): Promise<string> {
  let items: { idx: number; kind: string; name: string }[] = [];
  try {
    // Runs in the BROWSER. `el` is a DOM element; typed `any` so the runtime's
    // Node tsconfig (no DOM lib) still compiles this serialized function.
    items = await page.evaluate((max: number) => {
      const doc = (globalThis as unknown as { document: any }).document;
      // Clear refs from a previous snapshot so indices never collide across calls.
      for (const prev of Array.from(doc.querySelectorAll('[data-iclaw-ref]') as ArrayLike<any>)) {
        prev.removeAttribute('data-iclaw-ref');
      }
      const win = globalThis as any;
      const cand = new Set<any>();
      // 1) Semantic + ARIA + focusable controls.
      const sel = 'a[href], button, input:not([type=hidden]), textarea, select, label, '
        + '[role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [role=menu], '
        + '[onclick], [aria-haspopup], [aria-expanded], [tabindex]:not([tabindex="-1"])';
      for (const e of Array.from(doc.querySelectorAll(sel) as ArrayLike<any>)) cand.add(e);
      // 2) Icon triggers — a ⋮ kebab in a React app is usually a clickable <div>/<span>
      //    wrapping an <svg>, with NO role/onclick (the handler is delegated, so it
      //    matches nothing above). Climb from each icon to the nearest clickable-looking
      //    ancestor (button/link/role/tabindex/cursor:pointer) and include THAT.
      const icons = Array.from(doc.querySelectorAll('svg, img, i, [class*=icon], [class*=Icon]') as ArrayLike<any>).slice(0, 500);
      for (const icon of icons) {
        let n: any = icon;
        for (let d = 0; n && d < 4; d++, n = n.parentElement) {
          const t = String(n.tagName || '').toLowerCase();
          if (t === 'svg' || t === 'path' || t === 'g' || t === 'img' || t === 'i' || t === 'use') continue; // skip the icon, keep climbing
          if (t === 'html' || t === 'body') break;
          let cur = '';
          try { cur = win.getComputedStyle(n).cursor; } catch { cur = ''; }
          if (t === 'button' || t === 'a' || n.getAttribute('role') || n.hasAttribute('tabindex') || n.hasAttribute('onclick') || cur === 'pointer') { cand.add(n); break; }
        }
      }
      // DOM order → intuitive top-to-bottom indices.
      const all = Array.from(cand).sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
      const out: { idx: number; kind: string; name: string }[] = [];
      let idx = 0;
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // not rendered (e.g. hover-only until revealed)
        const tag = String(el.tagName).toLowerCase();
        const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'input') : tag);
        let name = (
          el.getAttribute('aria-label') ||
          el.innerText ||
          el.placeholder ||
          el.getAttribute('name') ||
          el.getAttribute('title') ||
          (el.value && el.type !== 'password' ? el.value : '') ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 80);
        // Icon-only / unlabeled control (e.g. a ⋮ kebab): DON'T drop it — synthesize a
        // hint so the model can still target it by index. Prefer a child icon's label,
        // then the control's class (more/menu/dots…), else a snippet of its row.
        if (!name) {
          const child = el.querySelector('[aria-label],[title]');
          const childName = child && (child.getAttribute('aria-label') || child.getAttribute('title'));
          const cls = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
          const kind2 = /more|menu|dots|kebab|option|action|ellipsis|overflow|expand/i.test(cls) ? 'menu/more' : 'icon';
          const row = el.closest('[role=row],li,tr,[class*=row],[class*=item],[class*=card]');
          const near = row && row.innerText ? String(row.innerText).replace(/\s+/g, ' ').trim().slice(0, 40) : '';
          name = (childName && String(childName).trim().slice(0, 40)) || (near ? `(${kind2} — near "${near}")` : `(${kind2}, no label)`);
        }
        idx += 1;
        el.setAttribute('data-iclaw-ref', String(idx));
        out.push({ idx, kind: role, name });
        if (out.length >= max) break;
      }
      return out;
    }, ELEMENTS_MAX);
  } catch {
    return 'Could not read the page elements (it may still be loading). Try browser_read or browser_screenshot.';
  }
  if (!items.length) return 'No interactive elements found on the page.';
  const lines = items.map((it) => `[${it.idx}] ${it.kind} — ${it.name}`);
  const more = items.length >= ELEMENTS_MAX ? `\n…(${ELEMENTS_MAX}+ elements — browser_scroll then call again for the rest)` : '';
  return `Interactive elements — click/type by index (e.g. browser_click index:5) or by label:\n${lines.join('\n')}${more}`;
}

/**
 * Compact result after a click/type/scroll/press: confirmation + the new URL/title
 * only — NOT the page body. Re-observation is deliberate (browser_elements /
 * browser_read), which is the single biggest token saver: the old code re-dumped up
 * to READ_MAX_CHARS of page text after EVERY action, resent every round.
 */
async function actionResult(page: Page, label: string): Promise<string> {
  let title = '';
  try { title = await page.title(); } catch { /* ignore */ }
  return `${label}\nURL: ${page.url()}\nTitle: ${title || '(none)'}\n` +
    `(Page may have changed — call browser_elements for what's clickable now, or browser_read for the text.)`;
}

/** First line of a Playwright error (the rest is a noisy call-log). */
function briefErr(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}

/**
 * Click an element by `[n]` index (from the last browser_elements — preferred and
 * the only way to hit unlabeled/icon controls) or by visible/accessible name.
 */
async function clickTarget(page: Page, target: string, index?: number): Promise<string> {
  if (index !== undefined) {
    const loc = page.locator(`[data-iclaw-ref="${index}"]`).first();
    try {
      if (await loc.count() === 0) {
        return `No element [${index}] on the page — indices come from the last browser_elements call and reset when the page changes. Call browser_elements again for fresh ones.`;
      }
      await loc.click({ timeout: ACTION_TIMEOUT });
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      return await actionResult(page, `Clicked [${index}].`);
    } catch (err) {
      return `Couldn't click [${index}]: ${briefErr(err)}. It may have moved — call browser_elements again, then retry.`;
    }
  }
  const t = target.trim();
  if (!t) return 'browser_click needs an "index" (from browser_elements) or a "target" label.';
  const tries = [
    () => page.getByRole('button', { name: t, exact: false }).first(),
    () => page.getByRole('link', { name: t, exact: false }).first(),
    () => page.getByRole('tab', { name: t, exact: false }).first(),
    () => page.getByText(t, { exact: false }).first(),
    () => page.locator(`text=${JSON.stringify(t)}`).first(),
  ];
  for (const make of tries) {
    try {
      const loc = make();
      if (await loc.count() === 0) continue;
      await loc.click({ timeout: ACTION_TIMEOUT });
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      return await actionResult(page, `Clicked "${t}".`);
    } catch { /* try next strategy */ }
  }
  return `Couldn't find a clickable element matching "${t}". Call browser_elements and click by index — most reliable, and the only way to hit icon-only controls.`;
}

/** Fill an input by `[n]` index or by label/placeholder/name; optionally submit (Enter). */
async function typeInto(page: Page, field: string, text: string, submit: boolean, index?: number): Promise<string> {
  const fill = async (loc: Locator, where: string): Promise<string> => {
    await loc.fill(text, { timeout: ACTION_TIMEOUT });
    if (submit) {
      await loc.press('Enter', { timeout: ACTION_TIMEOUT }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    }
    return await actionResult(page, `Typed into ${where}${submit ? ' and pressed Enter' : ''}.`);
  };
  if (index !== undefined) {
    const loc = page.locator(`[data-iclaw-ref="${index}"]`).first();
    try {
      if (await loc.count() === 0) return `No element [${index}] — call browser_elements again for fresh indices.`;
      return await fill(loc, `[${index}]`);
    } catch (err) {
      return `Couldn't type into [${index}]: ${briefErr(err)}.`;
    }
  }
  const f = field.trim();
  if (!f) return 'browser_type needs an "index" (from browser_elements) or a "field" label, plus "text".';
  const tries = [
    () => page.getByLabel(f, { exact: false }).first(),
    () => page.getByPlaceholder(f, { exact: false }).first(),
    () => page.getByRole('textbox', { name: f, exact: false }).first(),
    () => page.locator(`input[name=${JSON.stringify(f)}], textarea[name=${JSON.stringify(f)}]`).first(),
  ];
  for (const make of tries) {
    try {
      const loc = make();
      if (await loc.count() === 0) continue;
      return await fill(loc, `"${f}"`);
    } catch { /* next */ }
  }
  return `Couldn't find an input matching "${f}". Call browser_elements to see the fields/indices, then retry.`;
}

/** Scroll the viewport (down/up by SCROLL_STEP, or jump to top/bottom). */
async function scrollPage(page: Page, direction: string): Promise<string> {
  const dir = direction.trim().toLowerCase() || 'down';
  try {
    await page.evaluate(({ dir, step }: { dir: string; step: number }) => {
      const w = globalThis as unknown as { scrollBy(x: number, y: number): void; scrollTo(x: number, y: number): void; document: any };
      if (dir === 'top') w.scrollTo(0, 0);
      else if (dir === 'bottom') w.scrollTo(0, w.document.body.scrollHeight);
      else if (dir === 'up') w.scrollBy(0, -step);
      else w.scrollBy(0, step);
    }, { dir, step: SCROLL_STEP });
    await page.waitForTimeout(300); // let lazy/virtualised rows render
    return await actionResult(page, `Scrolled ${dir}.`);
  } catch (err) {
    return `Couldn't scroll: ${briefErr(err)}`;
  }
}

/** Go back one entry in this tab's history. */
async function goBack(page: Page, ctx?: ToolContext): Promise<string> {
  try {
    const resp = await page.goBack({ timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
    if (!resp) return 'Nothing to go back to (no previous page in this tab).';
    return await pageSummary(page, 'Went back:', ctx);
  } catch (err) {
    return `Couldn't go back: ${briefErr(err)}`;
  }
}

/** Press a key — Escape to dismiss a menu/overlay, Enter to submit, Tab/arrows to navigate. */
async function pressKey(page: Page, key: string): Promise<string> {
  const k = key.trim();
  if (!k) return 'browser_press needs a "key" (e.g. Escape, Enter, Tab, ArrowDown, PageDown).';
  const alias: Record<string, string> = {
    esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    pagedown: 'PageDown', pageup: 'PageUp', backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End',
  };
  const resolved = alias[k.toLowerCase()] || k;
  try {
    await page.keyboard.press(resolved);
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    return await actionResult(page, `Pressed ${resolved}.`);
  } catch (err) {
    return `Couldn't press "${resolved}": ${briefErr(err)}`;
  }
}

/**
 * Screenshot the page and ASK a vision model about it — returns a TEXT answer the
 * (often text-only) main model can act on, and also shows the shot to the user.
 * This is how Ace "sees": icon-only menus, canvas, captchas, complex layouts that
 * the accessibility-tree snapshot can't express. Routes to ICLAW_VISION_MODEL (a
 * cheap fast vision model) so the main loop stays text-only — mirrors Hermes'
 * browser_vision / aux-vision routing.
 */
async function askVision(page: Page, question: string, ctx: ToolContext): Promise<string> {
  const q = question.trim() || 'Describe what is on this page and the main interactive options.';
  let buf: Buffer;
  try {
    buf = await page.screenshot({ fullPage: false });
  } catch (err) {
    return `Couldn't capture the page: ${briefErr(err)}`;
  }
  // Show the user too (same pipeline as browser_screenshot).
  if (ctx.onImage) {
    try {
      const path = join(tmpdir(), `iclaw-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
      writeFileSync(path, buf);
      ctx.onImage({ path, mime: 'image/png', fileName: 'browser.png', bytes: buf.byteLength, generated: true });
    } catch { /* non-fatal: the text analysis below is the point */ }
  }
  const apiKey = resolveApiKey(ctx);
  if (!apiKey) {
    return `Screenshot shown to the user, but I can't analyse it (no API key for the vision model). Rely on browser_read / browser_elements, or ask the user what's on screen.`;
  }
  const model = (process.env.ICLAW_VISION_MODEL ?? '').trim() || DEFAULT_VISION_MODEL;
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  const r = await openRouterChat(apiKey, {
    model,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text:
          `This is a screenshot of a web page (${page.url()}). Answer concisely and concretely for a browser-automation agent. ${q}\n` +
          `If the answer is a control to click, name its exact visible label and where it is (e.g. "the ⋮ menu at the right end of each row, then 'Enable Channel'").` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  }, Number(process.env.ICLAW_MODEL_TIMEOUT_MS) || 60_000);
  if (!r.ok) {
    return `Couldn't analyse the screenshot (vision model ${model} → ${r.error}).\nThe shot is shown to the user; try browser_elements instead.`;
  }
  return r.text
    ? `Vision (${model}) on ${page.url()}:\n${r.text}`
    : `The vision model returned no answer. The screenshot is shown to the user.`;
}

/** Screenshot the page → the chat (via the runtime's onImage pipeline). */
async function screenshot(page: Page, ctx: ToolContext): Promise<string> {
  if (!ctx.onImage) return 'Screenshots are not available in this turn.';
  const path = join(tmpdir(), `iclaw-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await page.screenshot({ path, fullPage: false });
    let bytes = 0;
    try { bytes = statSync(path).size; } catch { /* ignore */ }
    ctx.onImage({ path, mime: 'image/png', fileName: 'browser.png', bytes, generated: true });
    return `Screenshot of ${page.url()} attached.`;
  } catch (err) {
    return `Couldn't take a screenshot: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Hover an element by [n] index (or name) — many menus open only on hover. */
async function hoverTarget(page: Page, target: string, index?: number): Promise<string> {
  const doHover = async (loc: Locator, where: string): Promise<string> => {
    await loc.hover({ timeout: ACTION_TIMEOUT });
    await page.waitForTimeout(250); // let a hover-menu render
    return await actionResult(page, `Hovered ${where} — call browser_elements to index anything it revealed.`);
  };
  if (index !== undefined) {
    const loc = page.locator(`[data-iclaw-ref="${index}"]`).first();
    try {
      if (await loc.count() === 0) return `No element [${index}] — call browser_elements again for fresh indices.`;
      return await doHover(loc, `[${index}]`);
    } catch (err) { return `Couldn't hover [${index}]: ${briefErr(err)}.`; }
  }
  const t = target.trim();
  if (!t) return 'browser_hover needs an "index" (from browser_elements) or a "target" label.';
  for (const make of [
    () => page.getByRole('button', { name: t, exact: false }).first(),
    () => page.getByText(t, { exact: false }).first(),
  ]) {
    try {
      const loc = make();
      if (await loc.count() === 0) continue;
      return await doHover(loc, `"${t}"`);
    } catch { /* next */ }
  }
  return `Couldn't find anything matching "${t}" to hover. Call browser_elements and hover by index.`;
}

/** Drag from one [n] index to another — reorder lists, sliders, drag-and-drop. */
async function dragBetween(page: Page, fromIndex: number, toIndex: number): Promise<string> {
  const from = page.locator(`[data-iclaw-ref="${fromIndex}"]`).first();
  const to = page.locator(`[data-iclaw-ref="${toIndex}"]`).first();
  try {
    if (await from.count() === 0 || await to.count() === 0) {
      return `Can't drag — [${fromIndex}] or [${toIndex}] isn't on the page. Call browser_elements for fresh indices.`;
    }
    await from.dragTo(to, { timeout: ACTION_TIMEOUT });
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    return await actionResult(page, `Dragged [${fromIndex}] → [${toIndex}].`);
  } catch (err) {
    return `Couldn't drag [${fromIndex}] → [${toIndex}]: ${briefErr(err)}.`;
  }
}

/**
 * Manage tabs in this project's browser: list / open / select / close. The active
 * tab is `handle.page` — every other tool acts on it, so select/open switch what
 * the agent is driving. A consolidated action-discriminator tool (one compact
 * schema) rather than four separate tools.
 */
async function manageTabs(handle: BrowserHandle, action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const a = (action || 'list').toLowerCase();
  const live = () => handle.context.pages().filter((p) => !p.isClosed());
  const listText = async (): Promise<string> => {
    const pages = live();
    const lines: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!;
      let title = '';
      try { title = await p.title(); } catch { /* ignore */ }
      lines.push(`[${i + 1}] ${title || '(untitled)'} — ${p.url()}${p === handle.page ? ' (active)' : ''}`);
    }
    return lines.length ? `Open tabs:\n${lines.join('\n')}` : 'No open tabs.';
  };
  try {
    if (a === 'open') {
      const url = String(args.url ?? '').trim();
      const p = await handle.context.newPage();
      handle.page = p;
      if (url) {
        const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        try { await p.goto(full, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); }
        catch (err) { return `Opened a new tab but couldn't load ${full}: ${briefErr(err)}`; }
      }
      if (handle.visible) { try { await p.bringToFront(); } catch { /* ignore */ } }
      return await pageSummary(p, 'Opened new tab:', ctx);
    }
    if (a === 'select' || a === 'close') {
      const pages = live();
      const idx = numArg(args.index);
      if (idx === undefined || idx < 1 || idx > pages.length) {
        return `Pick a tab index 1–${pages.length} (see browser_tabs action:list).`;
      }
      const target = pages[idx - 1]!;
      if (a === 'select') {
        handle.page = target;
        if (handle.visible) { try { await target.bringToFront(); } catch { /* ignore */ } }
        return await pageSummary(handle.page, `Switched to tab [${idx}]:`, ctx);
      }
      const wasActive = target === handle.page;
      await target.close().catch(() => {});
      if (wasActive) handle.page = live()[0] ?? (await handle.context.newPage());
      return await listText();
    }
    return await listText();
  } catch (err) {
    return `Tab action failed: ${briefErr(err)}`;
  }
}

/** Close every open browser (idle reap / shutdown). */
export async function closeAllBrowsers(): Promise<void> {
  const all = [...handles.values()];
  handles.clear();
  await Promise.all(all.map((h) => h.context.close().catch(() => {})));
}

/**
 * Dispatch a browser_* tool. Returns a guidance string for the model; never
 * throws. `ctx.projectId` picks the per-project profile; `ctx.onImage` carries
 * screenshots to the chat.
 */
export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  try {
    const projectId = ctx.projectId;
    // browser_open is the only tool that may launch; the rest need an open browser.
    if (name === 'browser_open') {
      const visible = args.visible === undefined ? true : args.visible !== false;
      const h = await ensureBrowser(projectId, visible);
      if (typeof h === 'string') return h; // launch error message
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (url) {
        const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        try {
          await h.page.goto(full, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        } catch (err) {
          return `Opened the browser but couldn't load ${full}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      h.lastUsed = Date.now();
      return (await pageSummary(h.page, `Browser ready (${visible ? 'visible' : 'headless'}, profile: ${projectKey(projectId)}).`, ctx));
    }

    const h = handles.get(projectKey(projectId));
    if (!h) return 'No browser is open for this project. Call browser_open first (optionally with a url).';
    h.lastUsed = Date.now();
    const page = h.page;

    switch (name) {
      case 'browser_read':
        return await pageSummary(page, 'Current page:', ctx);
      case 'browser_elements':
        return await listElements(page);
      case 'browser_click':
        return await clickTarget(page, String(args.target ?? ''), numArg(args.index));
      case 'browser_type':
        return await typeInto(page, String(args.field ?? ''), String(args.text ?? ''), args.submit === true, numArg(args.index));
      case 'browser_hover':
        return await hoverTarget(page, String(args.target ?? ''), numArg(args.index));
      case 'browser_drag': {
        const from = numArg(args.from), to = numArg(args.to);
        if (from === undefined || to === undefined) return 'browser_drag needs "from" and "to" element indices (from browser_elements).';
        return await dragBetween(page, from, to);
      }
      case 'browser_scroll':
        return await scrollPage(page, String(args.direction ?? 'down'));
      case 'browser_back':
        return await goBack(page, ctx);
      case 'browser_press':
        return await pressKey(page, String(args.key ?? ''));
      case 'browser_tabs':
        return await manageTabs(h, String(args.action ?? 'list'), args, ctx);
      case 'browser_screenshot':
        return await screenshot(page, ctx);
      case 'browser_vision':
        return await askVision(page, String(args.question ?? ''), ctx);
      case 'browser_navigate': {
        const url = String(args.url ?? '').trim();
        if (!url) return 'browser_navigate needs a "url".';
        const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        try {
          await page.goto(full, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        } catch (err) {
          return `Couldn't load ${full}: ${err instanceof Error ? err.message : String(err)}`;
        }
        return await pageSummary(page, 'Navigated:', ctx);
      }
      case 'browser_takeover': {
        const reason = String(args.reason ?? 'do this step').trim();
        if (h.visible) { try { await page.bringToFront(); } catch { /* ignore */ } }
        const where = h.visible
          ? 'The browser window is now in front.'
          : 'The browser is running headless — reopen it with browser_open visible:true so the user can see it.';
        return `Handing the browser to the user: please ${reason} in the browser window, then tell me to continue. ${where} ` +
          `Your login/cookies are saved in this project's profile, so I'll stay signed in afterwards. (I'll wait — when the user says go, I'll re-read the page.)`;
      }
      case 'browser_close':
        await h.context.close().catch(() => {});
        handles.delete(projectKey(projectId));
        return 'Closed the browser for this project.';
      default:
        return `Unknown browser tool: ${name}`;
    }
  } catch (err) {
    return `Browser error (${name}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Tool schemas (offered to the model when a browser-capable character runs) ──
export const BROWSER_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'browser_open',
      description:
        "Open this project's dedicated browser (a real Chromium, separate from the user's main browser, with its own saved logins per project) and optionally go to a URL. " +
        'Use `visible:true` (default) for a window the USER can see and take over (logins, captchas); `visible:false` for quiet headless work. Returns the page title, URL and readable text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional URL to open (https:// assumed if omitted).' },
          visible: { type: 'boolean', description: 'Show a real window the user can interact with (default true). false = headless.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_navigate',
      description: 'Go to a URL in the already-open project browser. Returns the new page summary.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to load.' } }, required: ['url'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_read',
      description: 'Read the current page: title, URL and the readable text. Use to understand what is on screen before acting.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_elements',
      description: 'List the interactive elements on the page, each with a stable [n] index — links, buttons, inputs, and ICON-ONLY controls (a ⋮ kebab menu, bare-icon buttons) that have no visible text. Click or type by that index. Indices reset on every call and when the page changes, so list fresh, then act.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_click',
      description: 'Click an element. Prefer `index` (the [n] from browser_elements) — most reliable, and the ONLY way to hit an icon-only control with no text. Falls back to `target` (visible text/label) when you have no index. Returns a compact confirmation (new URL/title), not the full page — call browser_elements/browser_read to re-observe.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The [n] index from the latest browser_elements call. Preferred.' },
          target: { type: 'string', description: 'Visible text / button label to click — fallback when no index is available.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_type',
      description: 'Type text into an input. Prefer `index` (the [n] from browser_elements); or identify the field by its label/placeholder/name. Set submit:true to press Enter (e.g. to search or log in).',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The [n] index of the input from browser_elements. Preferred.' },
          field: { type: 'string', description: "The input's label / placeholder / name — fallback when no index." },
          text: { type: 'string', description: 'The text to type.' },
          submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_screenshot',
      description: 'Capture a screenshot of the current page and attach it to the chat so the USER can see it. (To have YOURSELF understand a visual page — an icon menu, a layout the element list misses — use browser_vision, which also answers a question about the shot.)',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_scroll',
      description: 'Scroll the page to reveal more (lazy-loaded / off-screen rows, long lists). Call browser_elements again afterwards to index the newly visible controls.',
      parameters: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'down/up by a viewport step, or jump to top/bottom. Default down.' } },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_back',
      description: "Go back one page in this tab's history — e.g. after a misclick bounced you to a login or detail page. Returns the previous page's summary.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_press',
      description: 'Press a keyboard key on the page: Escape to dismiss a menu/overlay, Enter to submit, Tab to move fields, ArrowUp/ArrowDown to move within a dropdown, PageDown to scroll.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key name: Escape, Enter, Tab, Space, ArrowUp/Down/Left/Right, PageDown/Up, Backspace, Delete, Home, End.' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_hover',
      description: 'Hover the mouse over an element (by [n] index from browser_elements, or by label) — opens hover-only menus and dropdowns. Then call browser_elements to index what appeared.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The [n] index of the element to hover. Preferred.' },
          target: { type: 'string', description: 'Visible text/label to hover — fallback when no index.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_drag',
      description: 'Drag one element onto another, both by [n] index from browser_elements — for reordering lists, sliders, or drag-and-drop.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'integer', description: 'The [n] index of the element to drag.' },
          to: { type: 'integer', description: 'The [n] index of the drop target.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_tabs',
      description: 'Manage tabs in this project browser. action:list shows open tabs with [n] indices (the active one marked); action:open opens a new tab (optional url) and makes it active; action:select switches the active tab by index; action:close closes a tab by index. Every other browser tool acts on the active tab.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'select', 'close'], description: 'What to do. Default list.' },
          index: { type: 'integer', description: 'Tab index (1-based, from action:list) — for select/close.' },
          url: { type: 'string', description: 'URL for action:open (optional).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_vision',
      description: "Look at the current page with a vision model and get a text answer — for what the accessibility-tree element list can't express: icon-only menus, image/canvas content, captchas, complex layouts. Ask a specific question ('how do I enable a disconnected channel?'). Also shows the screenshot to the user.",
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: 'What you want to know about what is visually on the page.' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_takeover',
      description:
        'Hand the browser to the USER for a step you should not do yourself — logging in, solving a captcha/2FA, or anything sensitive. Brings the window to front and pauses for them. Their login is saved in the project profile, so you stay signed in afterwards.',
      parameters: { type: 'object', properties: { reason: { type: 'string', description: 'What the user should do (e.g. "log into LinkedIn", "solve the captcha").' } }, required: ['reason'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_close',
      description: "Close this project's browser window when you're done.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
] as const;

/** Names handled by executeBrowserTool — used by the loop to route + offer them. */
export const BROWSER_TOOL_NAMES = BROWSER_TOOLS.map((t) => t.function.name);
