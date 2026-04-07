import { logLLM } from './logger.js';

const BASE_URL = 'https://llm.bankr.bot/v1/chat/completions';

const MODELS = {
  cheap: 'minimax-m2.7',
  medium: 'claude-sonnet-4.6',
  expensive: 'claude-opus-4.6',
};

function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

export async function chat(model, systemPrompt, userMessage, opts = {}) {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) throw new Error('BANKR_API_KEY not set');

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });

  const body = {
    model,
    messages,
    max_tokens: opts.maxTokens || 4096,
    temperature: opts.temperature ?? 0.3,
  };

  const start = Date.now();
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      console.log(`  Retry ${attempt}/${MAX_RETRIES} for ${model} after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000),
      });

      if (!res.ok) {
        const text = await res.text();
        if (RETRYABLE_CODES.has(res.status) && attempt < MAX_RETRIES) {
          lastError = new Error(`LLM API error ${res.status}: ${text.slice(0, 200)}`);
          continue;
        }
        throw new Error(`LLM API error ${res.status}: ${text}`);
      }

      const data = await res.json();
      const latencyMs = Date.now() - start;

      let content = data.choices?.[0]?.message?.content || '';
      content = stripThinkTags(content);
      const usage = data.usage || {};

      logLLM({
        model,
        role: opts.role || 'unknown',
        promptChars: (systemPrompt || '').length + userMessage.length,
        responseChars: content.length,
        tokens: {
          prompt: usage.prompt_tokens,
          completion: usage.completion_tokens,
          total: usage.total_tokens,
        },
        latencyMs,
      });

      return content;
    } catch (err) {
      if (err.name === 'TimeoutError' && attempt < MAX_RETRIES) {
        lastError = err;
        continue;
      }
      if (err.message?.includes('LLM API error') && attempt < MAX_RETRIES) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('LLM call failed after retries');
}

export function cheap(systemPrompt, userMessage, opts = {}) {
  return chat(MODELS.cheap, systemPrompt, userMessage, { ...opts, role: opts.role || 'cheap' });
}

export function medium(systemPrompt, userMessage, opts = {}) {
  return chat(MODELS.medium, systemPrompt, userMessage, { ...opts, role: opts.role || 'medium' });
}

export function expensive(systemPrompt, userMessage, opts = {}) {
  return chat(MODELS.expensive, systemPrompt, userMessage, { ...opts, role: opts.role || 'expensive' });
}

export { MODELS };
