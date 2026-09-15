/**
 * Chat API.
 *
 * Two ways to ask a question: a streaming endpoint for the UI, and a plain JSON
 * endpoint for anything that just wants the answer.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, hasApiKey } from './config.ts';
import { reply, streamReplyWithMetadata, type ChatMessage } from './chat.ts';

const app = Fastify({ logger: { level: 'info' } });
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({
  ok: true,
  model: config.model,
  ready: hasApiKey(),
  uptime: process.uptime(),
}));

/** Validate a client-supplied conversation without trusting its shape. */
function parseMessages(body: unknown): ChatMessage[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string' || !content.trim()) return null;
    out.push({ role, content });
  }
  return out;
}

/** Streaming reply, one chunk per server-sent event. */
app.post('/api/chat/stream', async (req, reply_) => {
  if (!hasApiKey()) {
    return reply_.code(503).send({ error: 'ANTHROPIC_API_KEY is not configured.' });
  }
  const messages = parseMessages(req.body);
  if (!messages) {
    return reply_.code(400).send({ error: 'Body must be { messages: [{ role, content }] }' });
  }

  reply_.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Without this, a proxy buffers the stream and the UI looks frozen.
    'X-Accel-Buffering': 'no',
  });

  try {
    const { chunks, metadata } = await streamReplyWithMetadata(messages);
    // Wrap metadata promise to handle rejections immediately and avoid unhandled rejection
    // if chunk processing fails before we await it.
    const safeMetadata = metadata.catch((err) => {
      app.log.error({ err }, 'metadata tracking failed');
      return null;
    });

    for await (const chunk of chunks) {
      reply_.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }
    const meta = await safeMetadata;
    if (meta) {
      reply_.raw.write(`data: ${JSON.stringify({ metadata: meta })}\n\n`);
    }
    reply_.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.error({ err }, 'chat stream failed');
    reply_.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    reply_.raw.end();
  }
});

/** Whole answer in one response. */
app.post('/api/chat', async (req, reply_) => {
  if (!hasApiKey()) {
    return reply_.code(503).send({ error: 'ANTHROPIC_API_KEY is not configured.' });
  }
  const messages = parseMessages(req.body);
  if (!messages) {
    return reply_.code(400).send({ error: 'Body must be { messages: [{ role, content }] }' });
  }
  try {
    return { reply: await reply(messages) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.error({ err }, 'chat failed');
    return reply_.code(502).send({ error: message });
  }
});

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(
  `\n  Chat API on http://localhost:${config.port}` +
    `\n  Model: ${config.model}` +
    `\n  Key: ${hasApiKey() ? 'configured' : 'MISSING - /api/chat will return 503'}\n`,
);
