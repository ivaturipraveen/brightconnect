/**
 * The chat engine.
 *
 * Talks to Claude through the Anthropic SDK and streams the reply back a token
 * at a time, because a chat UI that sits silent for ten seconds feels broken
 * even when it is working.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Metadata about a streamed chat response.
 *
 * All fields are required and always present on success. The streaming protocol
 * guarantees these will be sent once the message is complete.
 */
export interface StreamMetadata {
  inputTokens: number;
  outputTokens: number;
  elapsedTimeMs: number;
}

export interface StreamReplyResult {
  chunks: AsyncGenerator<string>;
  metadata: Promise<StreamMetadata>;
}

const SYSTEM_PROMPT = `You are a helpful assistant answering questions for users
of this application.

Be direct and useful:
- Answer the question that was asked, at the length it deserves. A one-line
  question gets a one-line answer.
- If you do not know something, say so rather than guessing. A confident wrong
  answer costs the user more than an honest "I'm not sure".
- Use plain language. Explain jargon the first time you use it.
- When a question is ambiguous, answer the most likely reading and note the
  assumption, rather than refusing to answer until it is clarified.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

/** Keep the most recent turns; older ones fall off the front. */
export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= config.historyLimit) return messages;
  return messages.slice(-config.historyLimit);
}

/**
 * Stream a reply. Yields text chunks as they arrive.
 */
export async function* streamReply(messages: ChatMessage[]): AsyncGenerator<string> {
  const stream = anthropic().messages.stream({
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages: trimHistory(messages).map((m) => ({ role: m.role, content: m.content })),
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

/**
 * Stream a reply with metadata tracking. Returns both the text chunks and metadata
 * (token counts and elapsed time).
 */
export async function streamReplyWithMetadata(messages: ChatMessage[]): Promise<StreamReplyResult> {
  const startTime = Date.now();
  const stream = anthropic().messages.stream({
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages: trimHistory(messages).map((m) => ({ role: m.role, content: m.content })),
  });

  async function* chunks(): AsyncGenerator<string> {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  const metadata = (async (): Promise<StreamMetadata> => {
    const finalMessage = await stream.finalMessage();
    const elapsedTime = Date.now() - startTime;
    return {
      inputTokens: finalMessage.usage?.input_tokens ?? 0,
      outputTokens: finalMessage.usage?.output_tokens ?? 0,
      elapsedTimeMs: elapsedTime,
    };
  })();

  return {
    chunks: chunks(),
    metadata,
  };
}

/** Non-streaming reply, for callers that just want the whole answer. */
export async function reply(messages: ChatMessage[]): Promise<string> {
  const message = await anthropic().messages.create({
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages: trimHistory(messages).map((m) => ({ role: m.role, content: m.content })),
  });
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
