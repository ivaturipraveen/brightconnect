/**
 * The chat API, relative to wherever this app is mounted.
 *
 * In production the app is served at /app/ and only /app/api/ reaches the chat
 * backend - a bare /api/chat/stream falls through to the dashboard's API on a
 * different port and comes back 404. Deriving it from the app's own base keeps
 * dev and production on the same path.
 */
const API = `${import.meta.env.BASE_URL}api`;

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Send the conversation and stream the reply back.
 *
 * `onChunk` is called for each fragment as it arrives, so the caller can render
 * the answer as it is written rather than after it finishes.
 */
export async function streamChat(
  messages: Message[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      /* not JSON; use the raw body */
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
      const payload = JSON.parse(line.slice(6)) as
        { text?: string; done?: boolean; error?: string };
      if (payload.error) throw new Error(payload.error);
      if (payload.text) onChunk(payload.text);
      if (payload.done) return;
    }
  }
}

export async function checkHealth(): Promise<{ ready: boolean; model: string }> {
  const res = await fetch(`${API}/health`);
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return res.json() as Promise<{ ready: boolean; model: string }>;
}
