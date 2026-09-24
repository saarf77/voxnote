/**
 * A correction pass over the transcript — what gets delivered instead of the raw
 * speech-to-text output.
 *
 * The text stays the speaker's: every word, in their order, greetings, thanks and
 * slang included. Only what the recogniser got wrong is fixed — a misheard word,
 * a missing comma, a time written as a decimal — so the reader gets exactly what
 * was said, just readable. Nothing is shortened, reordered or summarised; the
 * bold line on top of a long recording is the separate summary (summarize.js).
 *
 * Fail-open: if the model is unavailable, times out, or the result fails the
 * guards below, the raw transcript is delivered instead (logged).
 *
 * Env:
 *   REWRITE=0               deliver raw transcripts (default: on)
 *   REWRITE_MIN_WORDS       shorter transcripts are delivered as-is (default 4)
 *   REWRITE_TIMEOUT_MS      default 20000
 *   REWRITE_MODEL           default: SUMMARY_MODEL
 * Uses the SUMMARY_* provider (same as the one-line summary).
 */
import { llmText, llmEnabled } from './llm.js';

export const rewriteEnabled = process.env.REWRITE !== '0' && llmEnabled;
// REWRITE_MODEL lets the rewrite use a different model than the summary (same provider).
export const rewriteLabel = process.env.REWRITE_MODEL || process.env.SUMMARY_MODEL || 'gpt-4o-mini';
const MIN_WORDS = Math.max(1, Number(process.env.REWRITE_MIN_WORDS ?? 4) || 4);
const TIMEOUT_MS = Number(process.env.REWRITE_TIMEOUT_MS ?? 20000) || 20000;

const SYSTEM = `You receive an automatic speech-to-text transcript of a WhatsApp voice message — sometimes several transcripts of the SAME audio from different recognisers. Recognition is imperfect: words are misheard (similar-sounding words substituted), words are split or glued together, punctuation is missing or wrong.

Your job is a correction pass, not a rewrite. Return the same message, word for word, in the same order, with only the recognition mistakes fixed — so it reads exactly as the speaker said it. Same language as the transcript.

Keep:
1. Every word the speaker said, in their order: greetings and openings ("היי", "מה אחי", "hey"), thanks and sign-offs ("תודה", "יאללה ביי"), side remarks, repetitions made for emphasis, questions they answer themselves, the way they build up to a point. Nothing is shortened, merged, reordered or summarised, and no sentence is dropped because it seems unimportant.
2. Their voice: slang, spoken words and phrasing stay as spoken ("כאילו", "אחי", "וואלה", "סבבה", "יאללה", שנ"צ = afternoon nap, "שנץ" is that word). Do not make it more formal, more correct or more fluent than it was said. The speaker's grammatical gender stays as the transcript shows it. Slang is a real word even when it looks like a mishearing of a more common one: "אש" (great), "פצצה", "תותח", "סחתיין", "חבל על הזמן", "על הפנים", "חלאס" — keep them; never "correct" one into a similar-looking everyday word ("אש, סגרנו" stays; it is not "יש, סגרנו" or "אה, סגרנו").
3. Add nothing: no commentary, no answers, no summary, no words the speaker did not say.

Fix:
4. Misheard words. Replace a word the recogniser got wrong with the word the speaker clearly said: one that sounds alike and fits the sentence. Never leave a fragment that makes no sense when the intended words are clear.
4a. When more than one transcript is given, they are readings of the SAME audio. Wherever they differ, choose the reading that is a real phrase and fits the sentence, and prefer a reading that one of them actually contains over wording you invent yourself (e.g. "אין להם ממש תשקיע" vs "אלא אם ממש תשקיע" → אלא אם ממש תשקיע ותחפש; "לחור"/"לנחור" → לנחור; "ניק"/"העניקה" → הניקה). A word or an ending that only one recogniser heard is usually real, not noise.
4b. Repair, never re-author. A repair is the smallest change that makes the words say what they plainly say: same claim, same direction, same subject. Do not flip a meaning to make a sentence fluent ("אלא אם תשקיע" — unless you make an effort — must not become "אין במה להשקיע" — there is nothing to invest in), and never add a subject, an actor or an object the readings do not contain. If a fragment stays unclear, keep the transcript's words for it rather than inventing a sentence that sounds right.
5. Punctuation and layout, so a long message is easy to read: commas, full stops, question marks, and an empty line between parts — wherever the speaker moves to another topic, another step of the story or another request. A long message should not be one block: split it into short paragraphs of a few sentences at those natural turns. A short message (one or two sentences) stays one paragraph.
5a. When the speaker enumerates — "אחד… שתיים… שלוש", "דבר ראשון… דבר שני", "first… second…", or a spoken "שלושה דברים:" followed by items — put each item on its own line starting with "1. ", "2. ", "3. ", with the words kept as spoken. Only number what the speaker actually enumerated.
Layout never changes the words: every word stays, in the same order.
6. Only pure hesitation sounds go ("אה", "אממ", "uh", "um") and a word stuttered twice by accident ("אני אני" → אני). Everything that is a word stays.
7. Spoken times are clock times: "8.20" → 8:20, "12.5" / "שתים עשרה וחצי" → 12:30, "ארבע ועשרים" → 4:20, "10.45" → 10:45. A number after "ב-" together with a time-of-day word (בלילה, בבוקר, בצהריים) is a clock time even if the recogniser wrote "דקות" after it ("קם ב-12.5 דקות בערך בלילה" → "קם ב-12:30 בערך בלילה"). Real durations stay durations ("לקח 20 דקות").
8. Foreign words or phrases spelled phonetically (English inside Hebrew): "ביי פאר"/"ביפר"/"בי פאר" = "by far", "ג'ימל" = Gmail, "מרקטינג" stays. Write them the way people type them; never turn such a phrase into a name or an acronym.
9. If a list of known names/terms is given, spell names as in that list when the transcript has a near-miss of one. Do not force a name where the speaker did not say one, and do not introduce a name the transcript does not mention.

Output only the corrected text. No headings, no bullets, no numbering the speaker did not enumerate, no bold, no quotes, no preamble.`;

const words = (s) => (s || '').trim().split(/\s+/).filter(Boolean);
const scriptShare = (s, re) => {
  const letters = [...s].filter((c) => /\p{L}/u.test(c));
  return letters.length ? letters.filter((c) => re.test(c)).length / letters.length : 0;
};
const SCRIPTS = [/\p{Script=Hebrew}/u, /\p{Script=Arabic}/u, /\p{Script=Cyrillic}/u, /\p{Script=Latin}/u];

/**
 * Guards: a correction pass stays close to the transcript's size — much shorter
 * means something was dropped, much longer means something was invented — and
 * in its script. Pure, exported for tests.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function acceptRewrite(input, output) {
  const out = (output || '').trim().replace(/^["'“”«]+|["'“”»]+$/g, '').replace(/\*\*?/g, '').trim();
  if (!out) return { ok: false, reason: 'empty' };
  const inW = words(input).length, outW = words(out).length;
  if (outW < Math.min(inW, Math.max(3, inW * 0.7))) return { ok: false, reason: `too short (${outW} vs ${inW} words) — something was dropped` };
  if (outW > inW * 1.3 + 8) return { ok: false, reason: `too long (${outW} vs ${inW} words) — looks invented` };
  for (const re of SCRIPTS) {
    const inShare = scriptShare(input, re);
    if (inShare >= 0.6 && scriptShare(out, re) < 0.5) return { ok: false, reason: 'language/script changed' };
  }
  if (/^(sure|here|הנה|בטח)/i.test(out)) return { ok: false, reason: 'chatty preamble' };
  return { ok: true, text: out };
}

/**
 * Build the user message. Other readings of the same audio are the single best
 * signal for fixing a misheard word, so they are labelled and handed over.
 * Pure, exported for tests.
 */
export function buildRewriteInput(text, { speaker = null, isMe = false, names = '', alts = [] } = {}) {
  const who = isMe ? 'the account owner (me)' : (speaker || 'unknown');
  const seen = new Set([text.trim()]);
  const others = (Array.isArray(alts) ? alts : [alts])
    .map((a) => (typeof a === 'string' ? a : a?.text) || '')
    .map((a) => a.trim())
    .filter((a) => a && !seen.has(a) && seen.add(a));
  const head = `Speaker: ${who}${names ? `\nKnown names/terms that may appear: ${names}` : ''}`;
  if (!others.length) return `${head}\n\nTranscript:\n${text}`;
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const blocks = [text, ...others].map((t, i) => `Transcript ${letters[i]}${i === 0 ? ' (the one being corrected)' : ''}:\n${t}`);
  return `${head}\n\n${blocks.join('\n\n')}`;
}

/**
 * @param {string} text raw transcript
 * @param {{ speaker?: string|null, isMe?: boolean, names?: string, alt?: string|null,
 *           alts?: Array<string|{text:string}> }} [opts]
 *   names: comma-separated known names/terms (see glossary.js)
 *   alt / alts: other readings of the same audio
 * @returns the corrected text, or null (deliver the raw transcript).
 */
export async function rewriteTranscript(text, { speaker = null, isMe = false, names = '', alt = null, alts = [] } = {}) {
  if (!rewriteEnabled || words(text).length < MIN_WORDS) return null;
  const readings = [...(Array.isArray(alts) ? alts : [alts]), alt].filter(Boolean);
  const user = buildRewriteInput(text, { speaker, isMe, names, alts: readings });
  // Generous budget: on reasoning models the hidden thinking counts against it,
  // and llmText returns null on a truncated reply rather than a cut-off text.
  const raw = await llmText(SYSTEM, user, { maxTokens: 3000, temperature: 0.2, timeoutMs: TIMEOUT_MS, model: rewriteLabel });
  if (raw == null) { console.warn('   ⚠️  rewrite unavailable (error/timeout/truncated) — delivering the raw transcript'); return null; }
  const r = acceptRewrite(text, raw);
  if (!r.ok) { console.warn(`   ⚠️  rewrite rejected (${r.reason}) — delivering the raw transcript`); return null; }
  console.log(`   ✍️  rewrite ok (${r.text.length} chars)`);
  return r.text;
}
