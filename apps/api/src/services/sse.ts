import type { FastifyReply } from 'fastify';

/**
 * Server-sent events, written directly to the raw socket. Fastify's reply
 * serialisation would buffer, and buffering is the one thing a live trace
 * cannot tolerate.
 */
export class SseStream {
  private closed = false;

  constructor(private readonly reply: FastifyReply) {
    // Writing to the raw socket bypasses Fastify's reply, and with it every
    // header a plugin attached. CORS in particular is set by a hook on the
    // reply, so without this the browser rejects the stream outright while
    // curl, which does not enforce CORS, sees nothing wrong.
    const inherited: Record<string, string> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value === undefined) continue;
      if (name.startsWith('access-control-') || name === 'vary') {
        inherited[name] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }

    reply.raw.writeHead(200, {
      ...inherited,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer event streams by default, which turns a live
      // timeline into a single burst at the end.
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders?.();
  }

  send(event: string, data: unknown): void {
    if (this.closed || this.reply.raw.writableEnded) return;
    this.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Comment frame. Keeps intermediaries from reaping an idle connection
   *  while a slow grading pass produces nothing to say. */
  comment(text: string): void {
    if (this.closed || this.reply.raw.writableEnded) return;
    this.reply.raw.write(`: ${text}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.reply.raw.writableEnded) this.reply.raw.end();
  }

  get isClosed(): boolean {
    return this.closed || this.reply.raw.writableEnded;
  }

  onClientDisconnect(handler: () => void): void {
    this.reply.raw.on('close', () => {
      this.closed = true;
      handler();
    });
  }
}
