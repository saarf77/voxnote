/**
 * Tiny chat-completion helper for the small "utility" LLM calls (time parsing,
 * command parsing). Uses the same provider/model as the summaries (SUMMARY_*),
 * with the same provider-aware key fallback, and always fails closed: any
 * error, timeout, or budget-truncated reply returns null.
 */
const BASE_URL = process.env.SUMMARY_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.SUMMARY_MODEL || 'gpt-4o-mini';

const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
// SUMMARY_API_KEY overrides only for the MAIN provider; the fallback must never
// inherit it (an OpenAI key sent to Groq is just a 401).
function keyFor(baseUrl, { allowOverride = true } = {}) {
  if (allowOverride && process.env.SUMMARY_API_KEY) return process.env.SUMMARY_API_KEY;
  const want = host(baseUrl);
  if (host(process.env.TRANSCRIBE_BASE_URL || 'https://api.groq.com/openai/v1') === want) return process.env.TRANSCRIBE_API_KEY || '';
  if (host(process.env.SHADOW_TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1') === want) return process.env.SHADOW_TRANSCRIBE_API_KEY || '';
  return process.env.SHADOW_TRANSCRIBE_API_KEY || process.env.TRANSCRIBE_API_KEY || '';
}
const API_KEY = keyFor(BASE_URL);

// Fallback provider for when the main one is down (quota exhausted, outage).
// Explicit via LLM_FALLBACK_BASE_URL / LLM_FALLBACK_MODEL; otherwise, if the
// main provider is OpenAI and a Groq key is around, Groq's gpt-oss-120b.
const GROQ = 'https://api.groq.com/openai/v1';
const FB_BASE_URL = process.env.LLM_FALLBACK_BASE_URL
  || (host(BASE_URL) !== host(GROQ) && keyFor(GROQ, { allowOverride: false }) ? GROQ : '');
const FB_MODEL = process.env.LLM_FALLBACK_MODEL || (FB_BASE_URL === GROQ ? 'openai/gpt-oss-120b' : '');
const FB_API_KEY = process.env.LLM_FALLBACK_API_KEY || (FB_BASE_URL ? keyFor(FB_BASE_URL, { allowOverride: false }) : '');
export const llmFallbackLabel = FB_BASE_URL && FB_API_KEY ? `${FB_MODEL} @ ${host(FB_BASE_URL)}` : '';

export const llmEnabled = Boolean(API_KEY);

/**
 * @param {{ fallback?: boolean }} [opts] fallback: false = no second provider (the
 *   caller has a better plan B of its own)
 * @returns the reply text, or null on any failure / truncation.
 */
export async function llmText(system, user, { fallback = true, ...opts } = {}) {
  const out = await callProvider(BASE_URL, API_KEY, system, user, opts);
  if (out !== null || !FB_API_KEY || !fallback) return out;
  console.warn(`   ↪️  falling back to ${llmFallbackLabel}`);
  return callProvider(FB_BASE_URL, FB_API_KEY, system, user, { ...opts, model: FB_MODEL });
}

async function callProvider(baseUrl, apiKey, system, user, { maxTokens = 600, temperature = 0, timeoutMs = 8000, model = MODEL } = {}) {
  if (!apiKey) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // OpenAI's gpt-5 / o-series chat models take max_completion_tokens, reject a
      // custom temperature, and want a small reasoning budget for a rewrite job.
      body: JSON.stringify(/^(gpt-5|o[1-9])/.test(model) ? {
        model, max_completion_tokens: maxTokens, reasoning_effort: 'low',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      } : {
        model, temperature, max_tokens: maxTokens,
        ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        ...(model.includes('qwen') ? { reasoning_effort: 'none' } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      // Log the provider's error code only — never its echo of the prompt.
      const body = await res.text().catch(() => '');
      let code = ''; try { code = JSON.parse(body)?.error?.code || JSON.parse(body)?.error?.type || ''; } catch { /* not json */ }
      console.warn(`   ⚠️  llm ${model} → HTTP ${res.status}${code ? ` (${code})` : ''}`); return null;
    }
    const choice = (await res.json()).choices?.[0];
    if (!choice || choice.finish_reason === 'length') { console.warn(`   ⚠️  llm ${model} → ${!choice ? 'no choice' : 'truncated (finish_reason=length)'}`); return null; } // never trust a cut-off reply
    return choice.message?.content?.trim() || null;
  } catch (e) {
    console.warn(`   ⚠️  llm ${model} → ${e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
