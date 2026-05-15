import 'dotenv/config';
import { createApp } from './app';
import { openclaw } from './services/openclaw';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`iClaude listening on http://localhost:${port}`);
  console.log(
    `OpenClaw Gateway: ${openclaw.baseUrl}` +
      ` (token: ${openclaw.hasToken ? `loaded from ${openclaw.tokenSource}` : 'NOT SET'})`,
  );
});
