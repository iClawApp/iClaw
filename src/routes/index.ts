import express, { Router } from 'express';
import { chats, projectSecrets, projects, tasks } from '../services/store';
import { openclaw } from '../services/openclaw';
import { probeGateway } from '../services/gatewayProbe';
import { chatStatus } from '../services/chatStatus';
import { shouldShowSendHint } from '../services/sendHint';
import { DEFAULT_MODE, listSelectableModes } from '../services/chatModes';
import { openRouterEnabled, transcribeAudio, isOpenRouterFailure } from '../services/openRouter';

export const indexRouter: Router = Router();

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
    defaultChatMode: DEFAULT_MODE,
    sttEnabled: openRouterEnabled(),
  });
});
