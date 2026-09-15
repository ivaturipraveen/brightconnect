/** Tests for conversation handling that do not need the API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimHistory, type ChatMessage, type StreamMetadata } from './chat.ts';

const msg = (i: number): ChatMessage => ({ role: 'user', content: `message ${i}` });

test('trimHistory leaves a short conversation alone', () => {
  const messages = [msg(1), msg(2), msg(3)];
  assert.deepEqual(trimHistory(messages), messages);
});

test('trimHistory keeps the most recent turns, not the oldest', () => {
  const messages = Array.from({ length: 50 }, (_, i) => msg(i));
  const trimmed = trimHistory(messages);
  assert.ok(trimmed.length <= 50);
  // The last message must survive - it is the one being answered.
  assert.equal(trimmed.at(-1)?.content, messages.at(-1)?.content);
});

test('trimHistory handles an empty conversation', () => {
  assert.deepEqual(trimHistory([]), []);
});

test('StreamMetadata has all required fields', () => {
  const metadata: StreamMetadata = {
    inputTokens: 42,
    outputTokens: 100,
    elapsedTimeMs: 1500,
  };

  assert.equal(metadata.inputTokens, 42);
  assert.equal(metadata.outputTokens, 100);
  assert.equal(metadata.elapsedTimeMs, 1500);
  assert.ok(metadata.inputTokens >= 0, 'input tokens must be non-negative');
  assert.ok(metadata.outputTokens >= 0, 'output tokens must be non-negative');
  assert.ok(metadata.elapsedTimeMs > 0, 'elapsed time must be positive');
});
