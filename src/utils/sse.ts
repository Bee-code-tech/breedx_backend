import { Request, Response } from 'express';

// Comments sent this often keep proxies from closing a quiet stream
const HEARTBEAT_MS = 15_000;

export interface Stream {
  /** A thought line for the student, e.g. "Searching your notes…". Same id = update that line. */
  step: (id: string, text: string, extra?: Record<string, unknown>) => void;
  send: (event: string, data: unknown) => void;
  /** Sends an `error` event and closes the stream. */
  fail: (message: string, extra?: Record<string, unknown>) => void;
  end: () => void;
  /** Aborted when the student closes the page, so AI calls can stop. */
  signal: AbortSignal;
  readonly closed: boolean;
}

/**
 * Opens a Server-Sent Events stream: one long response the server writes
 * events into as work happens. The frontend reads it with fetch.
 */
export const openStream = (_req: Request, res: Response): Stream => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tells nginx to pass each event on at once instead of holding them back
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  let closed = false;
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  res.on('close', () => {
    clearInterval(heartbeat);
    if (!closed) {
      closed = true;
      controller.abort();
    }
  });

  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.end();
  };

  return {
    step: (id, text, extra = {}) => send('step', { id, text, ...extra }),
    send,
    fail: (message, extra = {}) => {
      send('error', { message, ...extra });
      end();
    },
    end,
    signal: controller.signal,
    get closed() {
      return closed;
    },
  };
};
