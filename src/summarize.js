/**
 * Optional one-line summary for LONG transcripts, shown in bold above the text.
 *
 * Unlike the (retired) transcript "fixer", this never edits the speaker's words:
 * it writes one new sentence, and if anything goes wrong the transcript is
 * delivered without a summary. Fail-open to "no summary", never to a bad one.
 *
 * Env:
 *   SUMMARIZE=1              enable (off by default)
 *   SUMMARY_MIN_WORDS        transcripts shorter than this get no summary (default 60 ≈ 30s of speech)
 *   SUMMARY_MODEL            default gpt-4o-mini
 *   SUMMARY_BASE_URL         default https://api.openai.com/v1
 *   SUMMARY_API_KEY          defaults to SHADOW_TRANSCRIBE_API_KEY (the OpenAI key if you set one)
 *   SUMMARY_TIMEOUT_MS       default 8000
 */
import { llmText, llmEnabled } from './llm.js';

const MODEL = process.env.SUMMARY_MODEL || 'gpt-4o-mini';
// Provider, key resolution and request shape are shared with every other model
// call (see llm.js). Reasoning models are slower: allow more time than before.
const TIMEOUT_MS = Number(process.env.SUMMARY_TIMEOUT_MS ?? 20000);
export const SUMMARY_MIN_WORDS = Math.max(1, Number(process.env.SUMMARY_MIN_WORDS ?? 60) || 60);

export const summarizeEnabled = process.env.SUMMARIZE === '1' && llmEnabled;
export const summaryLabel = MODEL;

export const wordCount = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * What makes a headline worth reading.
 */
export const HEADLINE_RULES = `- It must stand on its own: someone who reads only the headline knows what the message is about and what is wanted from them. Give the context a bare question needs ("the lease: can they still keep the deposit if the damage was there before we moved in?", not "can they still keep it?").
- Length follows the message, and too short is the usual failure: a headline that does not get the point across is worthless. One simple point → one sentence, up to about 15 words. A long message with a few points, or several separate topics or requests → two or three short sentences, 25 to 45 words. Give the POINT of each — what was decided, asked or found — not a label for it ("מקרר: הטכנאי מגיע מחר בין 8 ל-12 ומישהו צריך להיות בבית", not "מקרר"). Never pick one topic out of several — least of all just the last thing said.
- A request or a question to the reader is always in the headline. So is how the speaker is doing when that is the point of the message ("I'm worn out, no progress this week").
- Lead with the concrete substance: numbers, times, outcomes, the actual question. Prefer "דוד נרדם ב-20 דקות בלי שהרמתי אותו" over "אני מתאר את ההרדמה".
- FORBIDDEN openings and words: "אני מתאר", "אני מדווח", "אני מעדכן", "אני מספר", "I describe", "I report", "update on", "כולל", "including", "various", "שונים". Never list the topics covered; say what happened.
- The language of the message, all the way through: an English message gets an English headline, a Hebrew one a Hebrew headline. Only terms the speaker used in another language stay as they said them.
- If a speaker name is given, name the speaker when it reads naturally ("דביר שואל מתי נוח לך"); if the speaker is ME, write in first person ("אני מציע…") or simply state the fact.
- One line. No quotes, no preamble, no emoji, no trailing period needed.`;

const SYSTEM = `You write the headline of a WhatsApp voice message, from its (imperfect) speech-to-text transcript. It is shown in bold above the text and may be all the reader reads.

The headline states the CONTENT — the key fact, outcome, decision or request — the way the speaker would text it. It never describes the act of speaking.

Rules:
${HEADLINE_RULES}
- The transcript may mishear words; write the meaning that is clearly intended, and never turn a misheard word into a person's name. If a list of known names is given, use those spellings — but never mention a name the text itself does not mention.
- Do not add anything that is not in the text. Do not answer the message.
Return only the headline, on one line.`;

// Guardrails: it must look like a headline, or we don't use it.
const MAX_CHARS = 420;
const MAX_WORDS = 60;

/**
 * Pure, exported for tests and for the rewrite (which writes the headline itself).
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function acceptHeadline(raw) {
  const out = (raw || '').trim().replace(/^["'“”«]+|["'“”»]+$/g, '').replace(/\*/g, '').trim(); // no quotes, no stray bold markers
  if (!out) return { ok: false, reason: 'empty' };
  if (out.includes('\n') || out.length > MAX_CHARS || wordCount(out) > MAX_WORDS) return { ok: false, reason: 'not a short single line' };
  // Report-speak ("I describe the routine, including…") is exactly what the
  // reader does not want; better no line than that line.
  if (/^(אני|I)\s+(מתאר|מדווח|מעדכן|מספר|מסביר|describe|report|update|talk|tell|explain)/u.test(out) || /\b(כולל|including)\b/u.test(out)) return { ok: false, reason: 'describes the message instead of stating it' };
  return { ok: true, text: out };
}

/**
 * @param {string} text
 * @param {{ speaker?: string|null, isMe?: boolean }} [opts] who spoke — used so the
 *   summary says "דביר שואל…" instead of "the speaker asks…"
 * @returns a one-line summary, or null (deliver without one).
 */
export async function summarizeTranscript(text, { speaker = null, isMe = false, names = '' } = {}) {
  if (!summarizeEnabled || wordCount(text) < SUMMARY_MIN_WORDS) return null;
  const who = isMe ? 'ME' : (speaker || null);
  const userContent = `${who ? `Speaker: ${who}\n` : ''}${names ? `Known names/terms: ${names}\n` : ''}\nTranscript:\n${text}`;

  try {
    // Through the shared helper: provider-specific request shapes (gpt-oss /
    // gpt-5 / qwen), error logging, and "never trust a cut-off reply" live there.
    // Generous budget on purpose: on reasoning models the hidden thinking counts
    // against it; the guardrails below still enforce "one short line".
    const raw = await llmText(SYSTEM, userContent, { maxTokens: 600, temperature: 0.2, timeoutMs: TIMEOUT_MS });
    if (raw == null) { console.warn('   ⚠️  summary unavailable — delivering without one'); return null; }
    const r = acceptHeadline(raw);
    if (!r.ok) { console.warn(`   ⚠️  summary rejected (${r.reason}) — delivering without one`); return null; }
    const out = r.text;
    console.log(`   📌 summary ok (${out.length} chars)`);
    return out;
  } catch (e) {
    console.warn(`   ⚠️  summary failed (${e.message}) — delivering without one`);
    return null;
  }
}
