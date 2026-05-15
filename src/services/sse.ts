import type { Response } from 'express';

export type ClientStreamEvent =
  | { type: 'status'; status: 'thinking' }
  | { type: 'tool'; phase: 'start' | 'end'; name: string; label: string }
  | { type: 'lifecycle'; phase: string; label: string }
  | { type: 'delta'; text: string }
  | { type: 'title'; id: number; title: string }
  | { type: 'done'; id?: number; title?: string; message: unknown }
  | { type: 'error'; error: string };

export function beginSse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

export function writeSse(res: Response, event: ClientStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function endSse(res: Response): void {
  res.write('data: [DONE]\n\n');
  res.end();
}
