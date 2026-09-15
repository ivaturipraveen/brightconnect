/** Tests for chat client SSE parsing and metadata handling */

// Mock the fetch API for testing SSE parsing
type SSEPayload = {
  text?: string;
  metadata?: { inputTokens?: number; outputTokens?: number; elapsedTimeMs?: number };
  error?: string;
  done?: boolean;
};

function encodeSSEEvent(payload: SSEPayload): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createMockResponse(events: SSEPayload[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        const encoded = encodeSSEEvent(event);
        controller.enqueue(new TextEncoder().encode(encoded));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function simulateStreamChat(
  events: SSEPayload[],
  onChunk: (text: string) => void,
): Promise<{
  inputTokens?: number;
  outputTokens?: number;
  elapsedTimeMs?: number;
}> {
  const res = createMockResponse(events);

  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let metadata: { inputTokens?: number; outputTokens?: number; elapsedTimeMs?: number } = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a partial frame stays buffered.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6)) as SSEPayload;
      if (payload.error) throw new Error(payload.error);
      if (payload.text) onChunk(payload.text);
      if (payload.metadata) metadata = payload.metadata;
      if (payload.done) return metadata;
    }
  }

  return metadata;
}

// Run tests
(async () => {
  console.log('Testing SSE metadata parsing...');

  // Test 1: Complete metadata
  {
    let output = '';
    const metadata = await simulateStreamChat(
      [
        { text: 'Hello ' },
        { text: 'world' },
        { metadata: { inputTokens: 10, outputTokens: 50, elapsedTimeMs: 1234 } },
        { done: true },
      ],
      (text) => {
        output += text;
      },
    );

    if (output !== 'Hello world') throw new Error(`Expected "Hello world", got "${output}"`);
    if (metadata.inputTokens !== 10)
      throw new Error(`Expected 10 input tokens, got ${metadata.inputTokens}`);
    if (metadata.outputTokens !== 50)
      throw new Error(`Expected 50 output tokens, got ${metadata.outputTokens}`);
    if (metadata.elapsedTimeMs !== 1234) throw new Error(`Expected 1234ms, got ${metadata.elapsedTimeMs}`);
    console.log('✓ Test 1: Complete metadata parsed correctly');
  }

  // Test 2: Partial metadata (only input tokens)
  {
    let output = '';
    const metadata = await simulateStreamChat(
      [
        { text: 'Response' },
        { metadata: { inputTokens: 5 } },
        { done: true },
      ],
      (text) => {
        output += text;
      },
    );

    if (metadata.inputTokens !== 5) throw new Error(`Expected 5 input tokens, got ${metadata.inputTokens}`);
    if (metadata.outputTokens !== undefined)
      throw new Error(`Expected undefined output tokens, got ${metadata.outputTokens}`);
    if (metadata.elapsedTimeMs !== undefined)
      throw new Error(`Expected undefined elapsedTimeMs, got ${metadata.elapsedTimeMs}`);
    console.log('✓ Test 2: Partial metadata handled correctly');
  }

  // Test 3: Empty metadata
  {
    let output = '';
    const metadata = await simulateStreamChat(
      [{ text: 'Just text' }, { metadata: {} }, { done: true }],
      (text) => {
        output += text;
      },
    );

    if (Object.keys(metadata).length !== 0)
      throw new Error(`Expected empty metadata object, got ${JSON.stringify(metadata)}`);
    console.log('✓ Test 3: Empty metadata handled correctly');
  }

  // Test 4: Metadata with zero values
  {
    let output = '';
    const metadata = await simulateStreamChat(
      [
        { text: 'Reply' },
        { metadata: { inputTokens: 0, outputTokens: 0, elapsedTimeMs: 0 } },
        { done: true },
      ],
      (text) => {
        output += text;
      },
    );

    if (metadata.inputTokens !== 0) throw new Error(`Expected 0 input tokens, got ${metadata.inputTokens}`);
    if (metadata.outputTokens !== 0)
      throw new Error(`Expected 0 output tokens, got ${metadata.outputTokens}`);
    // Note: elapsedTimeMs should not be 0 in practice but test parsing
    if (metadata.elapsedTimeMs !== 0) throw new Error(`Expected 0ms, got ${metadata.elapsedTimeMs}`);
    console.log('✓ Test 4: Zero metadata values handled correctly');
  }

  // Test 5: Multiple text chunks with metadata at end
  {
    let output = '';
    const metadata = await simulateStreamChat(
      [
        { text: 'This ' },
        { text: 'is ' },
        { text: 'a ' },
        { text: 'test' },
        { metadata: { inputTokens: 20, outputTokens: 100, elapsedTimeMs: 5000 } },
        { done: true },
      ],
      (text) => {
        output += text;
      },
    );

    if (output !== 'This is a test') throw new Error(`Text accumulation failed: ${output}`);
    if (metadata.inputTokens !== 20) throw new Error(`Metadata lost: ${JSON.stringify(metadata)}`);
    console.log('✓ Test 5: Multiple chunks with metadata at end parsed correctly');
  }

  // Test 6: Error handling
  {
    try {
      await simulateStreamChat([{ error: 'API failure' }, { done: true }], () => {});
      throw new Error('Expected error to be thrown');
    } catch (e) {
      if ((e as Error).message !== 'API failure') {
        throw new Error(`Expected "API failure" error, got "${(e as Error).message}"`);
      }
      console.log('✓ Test 6: Error handling works correctly');
    }
  }

  console.log('\n✅ All SSE metadata parsing tests passed!');
})().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
