/**
 * First-run "use iClaw from another device" onboarding for headless servers.
 *
 * On a machine with no local browser (a server) offer — in the same polished
 * style as the startup banner — to bring up a private remote-access link so the
 * operator can reach
 * iClaw from a phone or laptop without ever opening a browser on the box.
 *
 * After the question we keep the terminal interactive: pressing `S` shows the
 * link(s), Ctrl+C stops. The onboarding creates one 30-day link; more can be
 * made in the browser UI, so we show / count whatever `remoteAccess.list()`
 * currently holds. The link + passphrase auto-hide after a minute (back to a
 * plain "remote access is on" screen) so they aren't left sitting on screen;
 * `S` brings them back. The tunnel persists / re-registers across restarts.
 *
 * Rendering + key handling live in startup.ts (next to the banner helpers);
 * this module is just the flow / decision logic.
 */
import { remoteAccess, type TunnelStatus } from './services/remoteAccess';
import {
  attachHeadlessControls,
  printHeadlessControlsFooter,
  printRemoteAlreadyOn,
  printRemoteError,
  printRemoteHeadlessHint,
  printRemoteLinks,
  printRemoteNoFallback,
  printRemoteOnboardingIntro,
  printRemoteSettingUp,
  promptYesNo,
  shouldOfferRemoteSetup,
} from './startup';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
/** How long to wait for the relay to assign the public subdomain before
 *  printing the link (the password is known immediately either way). */
const URL_WAIT_MS = 15_000;
/** Auto-hide the link + passphrase after a minute so they aren't left on screen. */
const HIDE_AFTER_MS = 60_000;

let hideTimer: NodeJS.Timeout | null = null;
/** Set once per run; the footer shows it on every resting headless screen. */
let localAddress = '';

export async function offerRemoteAccessOnboarding(opts: {
  localUrl: string;
  onStop: () => void;
}): Promise<void> {
  // UC1 — a local browser is available (laptop/desktop): nothing to offer.
  if (!shouldOfferRemoteSetup()) return;
  localAddress = opts.localUrl;

  // UC3 — headless but no interactive terminal (systemd/docker): can't draw a
  // splash or take keys. If a tunnel is already up the relay logs say so;
  // otherwise leave a one-line hint. Never open a public link silently.
  if (!process.stdin.isTTY) {
    if (remoteAccess.list().length === 0) printRemoteHeadlessHint(opts.localUrl);
    return;
  }

  // Interactive headless — a polished, full-screen flow.
  if (remoteAccess.list().length > 0) {
    // UC4 — already configured: link(s) hidden; S reveals them.
    showResting();
  } else {
    // UC2 — ask.
    printRemoteOnboardingIntro();
    const yes = await promptYesNo('  > ');
    if (yes) {
      await createAndShowLink();
    } else {
      printRemoteNoFallback();
      printHeadlessControlsFooter('none', localAddress);
    }
  }

  // Stay interactive in THIS terminal — `S` shows the link(s), Ctrl+C stops.
  attachHeadlessControls({ onShare: shareFromKey, onStop: opts.onStop });
}

/** S key: create a 30-day link if there's none, otherwise (re-)show them. */
async function shareFromKey(): Promise<void> {
  if (remoteAccess.list().length === 0) {
    await createAndShowLink();
  } else {
    showLink();
  }
}

async function createAndShowLink(): Promise<void> {
  printRemoteSettingUp();
  let status: TunnelStatus;
  try {
    status = await remoteAccess.createTunnel(THIRTY_DAYS_MS, 'remote access');
  } catch (err) {
    printRemoteError(
      `Could not set up remote access: ${err instanceof Error ? err.message : String(err)}`,
    );
    printHeadlessControlsFooter('none', localAddress);
    return;
  }
  await waitForUrl(status.id, URL_WAIT_MS);
  showLink();
}

/** Show every active link + passphrase, then quietly auto-hide after a minute. */
function showLink(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const links = remoteAccess.list().map((s) => ({
    url: s.url,
    passphrase: s.passphrase,
    days: Math.max(1, Math.round((s.expiresAt - Date.now()) / (24 * 60 * 60_000))),
  }));
  if (links.length === 0) {
    showResting();
    return;
  }
  printRemoteLinks(links);
  printHeadlessControlsFooter('shown', localAddress);
  hideTimer = setTimeout(hideLink, HIDE_AFTER_MS);
  hideTimer.unref();
}

/** The "remote access is on" resting screen — secrets hidden; S reveals them. */
function showResting(): void {
  printRemoteAlreadyOn();
  printHeadlessControlsFooter('hidden', localAddress, remoteAccess.list().length);
}

/** Auto-hide handler: drop the secrets back to the resting screen. */
function hideLink(): void {
  hideTimer = null;
  if (remoteAccess.list().length === 0) return;
  showResting();
}

/** Poll remoteAccess until the relay assigns the public URL (or time out). */
async function waitForUrl(id: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    const s = remoteAccess.list().find((t) => t.id === id) ?? null;
    if (s?.url) return;
    if (Date.now() - start >= timeoutMs) return;
    await delay(300);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
