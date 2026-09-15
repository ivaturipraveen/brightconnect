/** Tests for API message parsing and validation */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Replicate the parseMessages function from index.ts for testing */
function parseMessages(body: unknown) {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: { role: string; content: string }[] = [];
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string' || !content.trim()) return null;
    out.push({ role, content });
  }
  return out;
}

test('parseMessages accepts valid user message', () => {
  const result = parseMessages({
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.deepEqual(result, [{ role: 'user', content: 'Hello' }]);
});

test('parseMessages accepts valid assistant message', () => {
  const result = parseMessages({
    messages: [{ role: 'assistant', content: 'Hi there' }],
  });
  assert.deepEqual(result, [{ role: 'assistant', content: 'Hi there' }]);
});

test('parseMessages accepts multiple messages', () => {
  const result = parseMessages({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ],
  });
  assert.equal(result?.length, 2);
});

test('parseMessages rejects null body', () => {
  assert.strictEqual(parseMessages(null), null);
});

test('parseMessages rejects non-object body', () => {
  assert.strictEqual(parseMessages('not an object'), null);
});

test('parseMessages rejects missing messages field', () => {
  assert.strictEqual(parseMessages({}), null);
});

test('parseMessages rejects non-array messages', () => {
  assert.strictEqual(parseMessages({ messages: 'not an array' }), null);
});

test('parseMessages rejects empty messages array', () => {
  assert.strictEqual(parseMessages({ messages: [] }), null);
});

test('parseMessages rejects invalid role', () => {
  assert.strictEqual(
    parseMessages({
      messages: [{ role: 'bot', content: 'Hello' }],
    }),
    null,
  );
});

test('parseMessages rejects empty content', () => {
  assert.strictEqual(
    parseMessages({
      messages: [{ role: 'user', content: '' }],
    }),
    null,
  );
});

test('parseMessages rejects whitespace-only content', () => {
  assert.strictEqual(
    parseMessages({
      messages: [{ role: 'user', content: '   ' }],
    }),
    null,
  );
});

test('parseMessages rejects non-string content', () => {
  assert.strictEqual(
    parseMessages({
      messages: [{ role: 'user', content: 123 }],
    }),
    null,
  );
});

test('parseMessages rejects null message object', () => {
  assert.strictEqual(
    parseMessages({
      messages: [null],
    }),
    null,
  );
});

test('parseMessages preserves content with special characters', () => {
  const content = 'What is 2+2? "quotes" and \n newlines';
  const result = parseMessages({
    messages: [{ role: 'user', content }],
  });
  assert.deepEqual(result, [{ role: 'user', content }]);
});
