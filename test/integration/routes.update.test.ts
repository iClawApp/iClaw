import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

describe('POST /api/update/run', () => {
  const app = createApp();

  it('starts update for localhost', async () => {
    const res = await request(app).post('/api/update/run');
    expect(res.status).toBe(200);
    expect(res.body.started).toBe(true);
    expect(res.body.command).toContain('@iclawapp/iclaw@latest');
  });
});
