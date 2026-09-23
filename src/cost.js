/**
 * What one recording cost, in US dollars, for the admin page. Counts only.
 *
 * Everything a recording triggers (transcriptions, a second reading, the rewrite, the
 * summary, a dictated message) runs inside meter(): each successful provider call adds
 * its price to that recording's bill. Speech is priced by the minute of audio sent;
 * chat by the tokens the provider reports it used. Prices are list prices, so the total
 * is a close estimate, not an invoice. MODEL_PRICES (JSON) adds or overrides entries:
 *   {"my-stt": {"minute": 0.004}, "my-chat": {"in": 0.5, "out": 2}}   (chat: $ per 1M tokens)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const PRICES = {
  // speech to text, $ per minute of audio
  'gpt-4o-transcribe': { minute: 0.006 }, 'gpt-4o-mini-transcribe': { minute: 0.003 }, 'whisper-1': { minute: 0.006 },
  'whisper-large-v3': { minute: 0.111 / 60 }, 'whisper-large-v3-turbo': { minute: 0.04 / 60 },
  // chat, $ per million tokens
  'gpt-5.4-mini': { in: 0.75, out: 4.5 }, 'gpt-5-mini': { in: 0.25, out: 2 }, 'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'openai/gpt-oss-120b': { in: 0.15, out: 0.6 }, 'openai/gpt-oss-20b': { in: 0.075, out: 0.3 },
};
try { Object.assign(PRICES, JSON.parse(process.env.MODEL_PRICES || '{}')); } catch { console.warn('MODEL_PRICES is not valid JSON; ignored'); }
// A model we have no price for is billed like the dearest one of its kind, so the estimate errs high.
const FALLBACK = { minute: 0.006, in: 0.75, out: 4.5 };
const price = (model) => PRICES[model] || PRICES[String(model).split('/').pop()] || null;

const store = new AsyncLocalStorage();

/** Run fn with a bill for a recording of `seconds`; resolves to fn's result. Read the bill with bill(). */
export const meter = (seconds, fn) => store.run({ seconds, usd: 0, unpriced: false }, fn);
export const bill = () => store.getStore() || null;

/** One transcription of the current recording, by `model`. */
export function chargeSpeech(model) {
  const b = store.getStore(); if (!b) return;
  const p = price(model); if (!p?.minute) b.unpriced = true;
  b.usd += (b.seconds / 60) * (p?.minute ?? FALLBACK.minute);
}

/** One chat call, with the provider's reported token usage. */
export function chargeChat(model, usage) {
  const b = store.getStore(); if (!b || !usage) return;
  const p = price(model); if (!p?.in) b.unpriced = true;
  b.usd += ((Number(usage.prompt_tokens) || 0) * (p?.in ?? FALLBACK.in) + (Number(usage.completion_tokens) || 0) * (p?.out ?? FALLBACK.out)) / 1e6;
}

/** $ per minute of audio for a plan's model, speech only: for estimating minutes counted before the meter existed. */
export const speechPerMinute = (model) => price(model)?.minute ?? FALLBACK.minute;
