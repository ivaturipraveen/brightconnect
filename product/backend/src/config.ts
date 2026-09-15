/** Configuration for the chat API. */

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: Number(env('CHAT_PORT', '8080')),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /**
   * Haiku by default: this is conversational question-answering, where latency
   * matters more than depth and the volume is high. Set CHAT_MODEL to
   * claude-sonnet-5 or claude-opus-5 for harder questions.
   */
  model: env('CHAT_MODEL', 'claude-haiku-4-5'),
  maxTokens: Number(env('CHAT_MAX_TOKENS', '4096')),
  /** Conversation turns kept before the oldest are dropped. */
  historyLimit: Number(env('CHAT_HISTORY_LIMIT', '20')),
} as const;

export const hasApiKey = () => {
  const k = config.anthropicApiKey.trim();
  return k.length > 0 && !k.endsWith('...');
};
