import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app';
import { attachWsServer } from './routes/ws';
import { openclaw } from './services/openclaw';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
const server = createServer(app);
attachWsServer(server);

server.listen(port, () => {
  console.log(`iClaw listening on http://localhost:${port}`);
  console.log(`  WebSocket on ws://localhost:${port}/ws`);
  console.log(
    `OpenClaw Gateway: ${openclaw.baseUrl}` +
      ` (token: ${openclaw.hasToken ? `loaded from ${openclaw.tokenSource}` : 'NOT SET'})`,
  );
});
