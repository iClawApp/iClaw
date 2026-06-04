import express, { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chats, projectSecrets, projects, tasks } from '../services/store';
import { openclaw } from '../services/openclaw';
import { probeGateway } from '../services/gatewayProbe';
import { chatStatus } from '../services/chatStatus';
import { shouldShowSendHint } from '../services/sendHint';
import { defaultComposerMode, listSelectableModes } from '../services/chatModes';
import { openRouterEnabled, transcribeAudio, isOpenRouterFailure } from '../services/openRouter';
import { isOnboardingDone, setOnboardingDone } from '../services/config';
import { startOnboardingPrep, getOnboardingEnv } from '../services/onboardingEnv';

const execFileAsync = promisify(execFile);

export const indexRouter: Router = Router();

/**
 * First-run welcome screen. Shown until the user picks a power source (or skips)
 * — gated solely on the `onboarding.done` flag so it never reappears after.
 * Starts the background environment prep (Docker probe + image pre-pull) so the
 * slow download happens while the user reads the copy / pastes their key.
 */
indexRouter.get('/welcome', (_req, res) => {
  startOnboardingPrep();
  res.render('welcome', {
    title: 'Welcome to iClaw',
    hasKey: openRouterEnabled(),
  });
});

/** Honest background-prep status for the welcome progress line. */
indexRouter.get('/api/onboarding/status', (_req, res) => {
  res.json(getOnboardingEnv());
});

/** Finish (or skip) onboarding — flips the flag so /welcome never shows again. */
indexRouter.post('/api/onboarding/complete', (_req, res) => {
  setOnboardingDone();
  res.json({ ok: true });
});

/** Native OS folder picker — opens system dialog, returns selected path. */
indexRouter.post('/api/pick-folder', async (_req, res) => {
  try {
    let folderPath: string;
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('osascript', [
        '-e', 'POSIX path of (choose folder with prompt "Select a folder for Work Mode")',
      ]);
      folderPath = stdout.trim().replace(/\/$/, '');
    } else if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Select folder for Work Mode']).catch(() =>
        execFileAsync('kdialog', ['--getexistingdirectory', process.env.HOME ?? '/']),
      );
      folderPath = stdout.trim();
    } else {
      return res.status(400).json({ error: 'Folder picker not supported on this platform' });
    }
    if (!folderPath) return res.status(400).json({ error: 'No folder selected' });
    res.json({ path: folderPath });
  } catch (err: unknown) {
    // User cancelled dialog — not an error
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('User canceled') || msg.includes('cancelled') || msg.includes('-128')) {
      return res.status(204).end();
    }
    res.status(500).json({ error: msg });
  }
});

/** Draft composer — secret name check before the chat row exists. */
indexRouter.get('/api/secrets/check-label', (req, res) => {
  res.json({ available: projectSecrets.isLabelAvailable(String(req.query.label ?? '')) });
});

/** Map an upload mime to the container hint OpenRouter expects for input_audio. */
function audioFormatFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('flac')) return 'flac';
  return 'webm';
}

/**
 * Speech-to-text. The composer mic POSTs the recorded clip as a raw audio body
 * (Content-Type carries the container). We transcribe it via OpenRouter and
 * return `{ text }`. Gated on OPENROUTER_API_KEY — the mic button is only
 * rendered when that's set; this 503 covers a stale client.
 */
indexRouter.post(
  '/api/stt',
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res) => {
    if (!openRouterEnabled()) {
      res.status(503).json({ error: 'Speech-to-text is unavailable: set OPENROUTER_API_KEY.' });
      return;
    }
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: 'No audio received.' });
      return;
    }
    const mime = String(req.headers['content-type'] || 'audio/webm');
    try {
      const text = await transcribeAudio({
        audioBase64: buf.toString('base64'),
        format: audioFormatFromMime(mime),
      });
      res.json({ text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[stt] transcription failed:', msg);
      res
        .status(502)
        .json({ error: isOpenRouterFailure(err) ? 'Transcription failed (OpenRouter).' : msg });
    }
  },
);

indexRouter.get('/', async (req, res) => {
  // First run: render the welcome flow in place of the empty chat. Rendered
  // (not redirected) so `/` stays 200 — the CLI/instance readiness probe in
  // startup.ts checks for a 200 that contains "iClaw".
  if (!isOnboardingDone()) {
    // Power users who already configured a key (env/prior run) shouldn't see
    // the welcome at all — mark it done and fall through to the app.
    if (openRouterEnabled()) {
      setOnboardingDone();
    } else {
      startOnboardingPrep();
      return res.render('welcome', { title: 'Welcome to iClaw', hasKey: openRouterEnabled() });
    }
  }

  const list = chats.list();
  const allProjects = projects.list();

  // ?project=<id> — preselect a project for the new draft chat
  const projectQuery = typeof req.query.project === 'string' ? Number(req.query.project) : NaN;
  const preselectedProject =
    Number.isFinite(projectQuery) && projectQuery > 0
      ? projects.get(projectQuery) ?? null
      : null;

  const { gatewayUp, agents, agentsError, gatewayStatus } = await probeGateway('index');

  res.render('index', {
    chats: list,
    // First-ever empty state → show the conversational welcome (and skip the
    // project picker) instead of dropping a non-technical user into a blank chat.
    isFirstChat: list.length === 0,
    allProjects,
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    preselectedProject,
    activeChat: null,
    activeProject: preselectedProject,
    gatewayUp,
    gatewayStatus,
    agents,
    agentsError,
    defaultAgent: 'openclaw/default',
    openclawBaseUrl: openclaw.baseUrl,
    workingIds: chatStatus.workingIds(),
    sendHintShow: shouldShowSendHint(),
    chatModes: listSelectableModes(),
    defaultChatMode: defaultComposerMode(),
    sttEnabled: openRouterEnabled(),
    // With an OpenRouter key the runtime modes (Work / Safe work / Incognito)
    // work without OpenClaw — so a missing gateway must NOT block starting a chat.
    openRouterReady: openRouterEnabled(),
    // Full Power (Execute) needs a reachable gateway; seeds the composer gating.
    gatewayOk: gatewayStatus === 'ok',
  });
});
