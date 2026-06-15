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
import { mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { BrowserContext, Page } from 'playwright';
import type { ToolContext } from './tools.js';

const PROFILE_ROOT = process.env.ICLAW_BROWSER_PROFILE_DIR || join(homedir(), '.iclaw', 'browser');
const IDLE_MS = Number(process.env.ICLAW_BROWSER_IDLE_MS) || 10 * 60_000; // close idle browsers after 10m
const NAV_TIMEOUT = Number(process.env.ICLAW_BROWSER_NAV_TIMEOUT_MS) || 30_000;
const ACTION_TIMEOUT = Number(process.env.ICLAW_BROWSER_ACTION_TIMEOUT_MS) || 12_000;
const READ_MAX_CHARS = Number(process.env.ICLAW_BROWSER_READ_MAX) || 6_000;
const ELEMENTS_MAX = 40;

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
  if (existing && existing.visible === visible && !existing.context.pages()[0]?.isClosed()) {
    existing.lastUsed = Date.now();
    return existing;
  }
  // Mode changed (headful↔headless) → relaunch with the new mode.
  if (existing) {
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

/** Current page summary: title + url + a readable text excerpt. */
async function pageSummary(page: Page, label: string): Promise<string> {
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
  const clipped = text.length > READ_MAX_CHARS
    ? text.slice(0, READ_MAX_CHARS) + `\n…[truncated — call browser_read for more, or browser_elements for what's clickable]`
    : text;
  return `${label}\nURL: ${url}\nTitle: ${title || '(none)'}\n\n${clipped || '(no readable text on the page yet)'}`;
}

/** List the interactive elements so the model knows what it can click/type. */
async function listElements(page: Page): Promise<string> {
  let items: { kind: string; name: string }[] = [];
  try {
    // Runs in the BROWSER. `el` is a DOM element; typed `any` so the runtime's
    // Node tsconfig (no DOM lib) still compiles this serialized function.
    items = await page.evaluate((max: number) => {
      const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<unknown> } }).document;
      const out: { kind: string; name: string }[] = [];
      const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem]';
      const nodes: any[] = Array.from(doc.querySelectorAll(sel) as ArrayLike<any>);
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // hidden
        const tag = String(el.tagName).toLowerCase();
        const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'input') : tag);
        const name = (
          el.getAttribute('aria-label') ||
          el.innerText ||
          el.placeholder ||
          el.getAttribute('name') ||
          el.getAttribute('title') ||
          (el.value && el.type !== 'password' ? el.value : '') ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!name && role !== 'input' && tag !== 'input' && tag !== 'textarea') continue;
        out.push({ kind: role, name });
        if (out.length >= max) break;
      }
      return out;
    }, ELEMENTS_MAX);
  } catch {
    return 'Could not read the page elements (it may still be loading). Try browser_read or browser_screenshot.';
  }
  if (!items.length) return 'No interactive elements found on the page.';
  const lines = items.map((it, i) => `${i + 1}. [${it.kind}] ${it.name || '(no label)'}`);
  return `Interactive elements (use browser_click with the label text, or browser_type for inputs):\n${lines.join('\n')}`;
}

/** Click an element by its visible/accessible name — tries several locators. */
async function clickTarget(page: Page, target: string): Promise<string> {
  const t = target.trim();
  if (!t) return 'browser_click needs a "target" — the link text or button label to click (see browser_elements).';
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
      return `Clicked "${t}".\n\n` + (await pageSummary(page, 'After click:'));
    } catch { /* try next strategy */ }
  }
  return `Couldn't find a clickable element matching "${t}". Call browser_elements to see the exact labels, then retry.`;
}

/** Fill an input identified by label/placeholder/name; optionally submit (Enter). */
async function typeInto(page: Page, field: string, text: string, submit: boolean): Promise<string> {
  const f = field.trim();
  if (!f) return 'browser_type needs a "field" (the input\'s label/placeholder/name) and "text".';
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
      await loc.fill(text, { timeout: ACTION_TIMEOUT });
      if (submit) {
        await loc.press('Enter', { timeout: ACTION_TIMEOUT }).catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      }
      return `Typed into "${f}"${submit ? ' and pressed Enter' : ''}.\n\n` + (await pageSummary(page, 'Now:'));
    } catch { /* next */ }
  }
  return `Couldn't find an input matching "${f}". Call browser_elements to see the fields, then retry.`;
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
      return (await pageSummary(h.page, `Browser ready (${visible ? 'visible' : 'headless'}, profile: ${projectKey(projectId)}).`));
    }

    const h = handles.get(projectKey(projectId));
    if (!h) return 'No browser is open for this project. Call browser_open first (optionally with a url).';
    h.lastUsed = Date.now();
    const page = h.page;

    switch (name) {
      case 'browser_read':
        return await pageSummary(page, 'Current page:');
      case 'browser_elements':
        return await listElements(page);
      case 'browser_click':
        return await clickTarget(page, String(args.target ?? ''));
      case 'browser_type':
        return await typeInto(page, String(args.field ?? ''), String(args.text ?? ''), args.submit === true);
      case 'browser_screenshot':
        return await screenshot(page, ctx);
      case 'browser_navigate': {
        const url = String(args.url ?? '').trim();
        if (!url) return 'browser_navigate needs a "url".';
        const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        try {
          await page.goto(full, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        } catch (err) {
          return `Couldn't load ${full}: ${err instanceof Error ? err.message : String(err)}`;
        }
        return await pageSummary(page, 'Navigated:');
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
      description: 'List the interactive elements on the page (links, buttons, inputs) with their labels — so you know exactly what to click or type into.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_click',
      description: 'Click an element by its visible text or accessible label (see browser_elements). Returns the page after the click.',
      parameters: { type: 'object', properties: { target: { type: 'string', description: 'The link text / button label to click.' } }, required: ['target'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_type',
      description: 'Type text into an input identified by its label, placeholder or name. Set submit:true to press Enter (e.g. to search or log in).',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', description: "The input's label / placeholder / name." },
          text: { type: 'string', description: 'The text to type.' },
          submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
        },
        required: ['field', 'text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_screenshot',
      description: 'Capture a screenshot of the current page and attach it to the chat (so the user can see exactly what you see).',
      parameters: { type: 'object', properties: {}, required: [] },
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
