/**
 * The message the reader gets instead of listening to the recording.
 *
 * People ramble into a voice note, and word-level recognition of hard Hebrew
 * always leaves mistakes. The reader wants the CONTENT, as short and clear as it
 * can be: so a chat model edits the transcript into the message the speaker
 * would have typed — free to cut, reorder and reword, never free with the facts.
 * Every request, question, decision, name, number and time survives; nothing is
 * added. Recognition errors are fixed from context and from the other readings.
 *
 * Two styles. 'editor' is the above and goes to the pro plan; it needs a strong
 * model. 'faithful' keeps every point in the speaker's order (only recognition
 * errors and disfluencies go) — a small model does it well; the free plan gets it.
 *
 * Fail-open: if the model is unavailable, times out, or the result fails the
 * guards below, the raw transcript is delivered instead (logged).
 *
 * Env:
 *   REWRITE=0               deliver raw transcripts (default: on)
 *   REWRITE_MIN_WORDS       shorter transcripts are delivered as-is (default 4)
 *   REWRITE_TIMEOUT_MS      default 20000 (the faithful rewrite)
 *   REWRITE_EDITOR_TIMEOUT_MS default 60000: a strong model takes 13–25 s on a long note
 *   REWRITE_MODEL           the faithful rewrite's model (default: SUMMARY_MODEL)
 *   REWRITE_EDITOR_MODEL    the editor's model (default: the same)
 * Uses the SUMMARY_* provider/model (same as the one-line summary).
 */
import { llmText, llmEnabled } from './llm.js';
import { HEADLINE_RULES, acceptHeadline, summarizeEnabled, SUMMARY_MIN_WORDS } from './summarize.js';

export const rewriteEnabled = process.env.REWRITE !== '0' && llmEnabled;
// REWRITE_MODEL lets the rewrite use a different model than the summary (same provider).
export const rewriteLabel = process.env.REWRITE_MODEL || process.env.SUMMARY_MODEL || 'gpt-4o-mini';
// The free-hand editor is a harder job than a faithful copy: measured on real notes,
// the small model lost or changed something real in ~15% of runs, the large one in
// ~6%. REWRITE_EDITOR_MODEL names the model for it (same provider); unset = the same.
export const editorLabel = process.env.REWRITE_EDITOR_MODEL || rewriteLabel;
export const REWRITE_STYLES = ['editor', 'faithful'];
const MIN_WORDS = Math.max(1, Number(process.env.REWRITE_MIN_WORDS ?? 4) || 4);
const TIMEOUT_MS = Number(process.env.REWRITE_TIMEOUT_MS ?? 20000) || 20000;
const EDITOR_TIMEOUT_MS = Number(process.env.REWRITE_EDITOR_TIMEOUT_MS ?? 60000) || 60000;

const SYSTEM_EDITOR = `You receive an automatic speech-to-text transcript of a WhatsApp voice message — sometimes several transcripts of the SAME audio from different recognisers. People ramble when they record: they think out loud, circle back, repeat themselves, bury the point in the middle. Recognition is imperfect too: words are misheard (similar-sounding words substituted) and sentences run together.

Write the message the reader would want to get instead of listening: the shortest, clearest text that still carries everything the speaker wanted to get across. In the speaker's own voice (first person), as if they had thought it through and then typed it — and in the speaker's grammatical gender as the transcript shows it ("הולכת", "שמחה" → a woman: "אני שולחת", never "אני שולח"). Write in the language the transcript is written in: an English transcript gets an English message, a Hebrew one a Hebrew message — the examples below are Hebrew only because most recordings are. You are an editor with a free hand over wording, order and length — not over the facts.

What must survive:
1. Everything the reader needs in order to understand, answer or act: every request, question, decision, commitment, opinion and its reason, condition ("only if…", "unless…"), and every name, number, date, time, place, amount, link and term. A negation stays a negation. How the speaker feels about it (annoyed, excited, unsure, joking) is content too when it changes how the message should be read.
2. Add nothing. No facts, advice, answers, greetings or conclusions the speaker did not say. Do not make a hesitant speaker sound sure, or a sure one hesitant.

What you are free to do:
3. Cut what carries nothing: thinking out loud, repetition, the same point made twice, false starts, filler ("אה", "כאילו", "you know"), narration about the recording itself, and self-corrections — keep only the corrected version ("at 6.5, no, 6.35" → 6:35).
4. Reorder. Lead with the point: the request, the question or the bottom line first, then what the reader needs in order to deal with it. Put together things that belong together even if they were said minutes apart.
5. Say it in fewer and better words than the speaker did. Keep their register — casual stays casual, slang stays slang (סבבה, יאללה, שנ"צ = afternoon nap, "שנץ" is that word), nothing becomes formal or corporate.
6. Be as short as the content allows and no shorter. A short message that is already clear only needs cleaning; a three-minute ramble may come down to a few lines. Never drop a real point to save space. When the details ARE the message — a log of times, a report to a professional, instructions, a list of what happened — they all stay, and you only tidy them.
6a. Before you finish, go over the transcript once more: every question the speaker asked, every request, and every number or time must be in your message. Whatever you left out must be something the reader loses nothing without.
7. Structure when it helps reading: a blank line between topics. When there are several separate requests, questions or items — or the speaker enumerates ("אחד… שתיים…", "first… second…") — write them as a numbered list, each on its own line starting with "1. ", "2. ". Any intro stays above the list. A message with one point is just a sentence or two, no list.
8. A note that is an instruction to pass something on ("תשלח ל<name> ש…", "תגיד ל… ש…", "send <name> that…") stays that instruction: keep the opening words and the recipient's name exactly, and tidy only the message being passed on.

Reading the audio correctly (this part is not a matter of style):
9. Reconstruct meaning. Replace a misheard word with the word the speaker clearly meant: a word that sounds alike and fits the sentence. Never pass on a fragment that makes no sense when the intended meaning is clear.
9a. When more than one transcript is given, they are readings of the SAME audio. Wherever they differ, choose the reading that is a real phrase and fits the sentence, and prefer a reading that one of them actually contains over wording you invent yourself (e.g. "אין להם ממש תשקיע" vs "אלא אם ממש תשקיע" → אלא אם ממש תשקיע ותחפש; "לחור"/"לנחור" → לנחור; "ניק"/"העניקה" → הניקה). A word that only one recogniser heard is usually real, not noise — if one reading goes on after the others stop, that ending was said.
9b. Never change a claim while repairing it: same direction, same subject, same actor. Do not flip a meaning to make a sentence fluent ("אלא אם תשקיע" — unless you make an effort — must not become "אין במה להשקיע" — there is nothing to invest in), and never add a subject, an actor or an object the readings do not contain. If a fragment that matters stays unclear after weighing the readings, keep the speaker's words for it rather than inventing a sentence that sounds right. An unreadable stretch is never a gap to fill: no "we already decided", "I'll update you" or any other sentence the readings do not contain.
10. Spoken times are clock times: "8.20" → 8:20, "12.5" / "שתים עשרה וחצי" → 12:30, "ארבע ועשרים" → 4:20, "10.45" → 10:45. A number after "ב-" together with a time-of-day word (בלילה, בבוקר, בצהריים) is a clock time even if the recogniser wrote "דקות" after it ("קם ב-12.5 דקות בערך בלילה" → "קם בערך ב-12:30 בלילה"). Real durations stay durations ("לקח 20 דקות").
11. Foreign words or phrases spelled phonetically (English inside Hebrew): "ביי פאר"/"ביפר"/"בי פאר" = "by far", "ג'ימל" = Gmail, "מרקטינג" stays. Write them the way people type them; never turn such a phrase into a name or an acronym.
12. If a list of known names/terms is given, spell names as in that list when the transcript has a near-miss of one. Do not force a name where the speaker did not say one, and do not introduce a name the transcript does not mention.

The headline — only when the user message says "Headline: yes, about N words". It is shown in bold above the message and may be all the reader reads. N is the length of the HEADLINE only (never of the message) and it grows with the recording, so use it — do not stop at one short sentence when N is 30.
${HEADLINE_RULES}
- The message stays complete on its own; it does not lean on the headline.

Output: the message. Then, only with "Headline: yes", an empty line and a last line "HEADLINE: " followed by the headline — written last, from the finished message. No other headings, no bullet symbols other than that numbering, no bold, no quotes, no preamble.`;

// The faithful rewrite: every point kept, in the speaker's order. Far less room to
// lose something, so a small model does it well — this is what the free plan gets.
const SYSTEM_FAITHFUL = `You receive an automatic speech-to-text transcript of a WhatsApp voice message — sometimes several transcripts of the SAME audio from different recognisers. Recognition is imperfect: words are misheard (similar-sounding words substituted), sentences run together, and spoken false starts, repetitions and self-corrections are transcribed literally.

Rewrite it as the clear, well-written message the speaker meant, in the SAME language as the transcript, in the speaker's own voice (first person), as if they had typed it carefully.

Rules:
1. Keep EVERY point, detail, name, number, time, place, question and request. Nothing omitted — small or irrelevant remarks stay too. Add nothing: no commentary, no answers, no summary, no facts that are not in the transcript.
2. Reconstruct meaning. Replace a misheard word with the word the speaker clearly meant: a word that sounds alike and fits the sentence. Never leave a fragment that makes no sense when the intended meaning is clear.
2a. When more than one transcript is given, they are readings of the SAME audio. Wherever they differ, choose the reading that is a real phrase and fits the sentence, and prefer a reading that one of them actually contains over wording you invent yourself (e.g. "אין להם ממש תשקיע" vs "אלא אם ממש תשקיע" → אלא אם ממש תשקיע ותחפש; "לחור"/"לנחור" → לנחור; "ניק"/"העניקה" → הניקה). A word that only one recogniser heard is usually real, not noise — a longer reading that makes sense beats a shorter one that does not.
2b. Repair, never re-author. A repair must be the smallest change that makes the words say what they plainly say: keep the same claim, the same direction and the same subject. Do not flip a meaning to make a sentence fluent ("אלא אם תשקיע" — unless you make an effort — must not become "אין במה להשקיע" — there is nothing to invest in), and never add a subject, an actor or an object the readings do not contain. If a fragment stays unclear after weighing the readings, keep the speaker's words as they are rather than inventing a sentence that sounds right.
3. Drop disfluencies: false starts, stutters, repeated words, "אה", "כאילו" used as filler, and self-corrections — keep only the corrected version (if the speaker says "at 6.5, no, 6.35", write 6:35).
4. Spoken times are clock times: "8.20" → 8:20, "12.5" / "שתים עשרה וחצי" → 12:30, "ארבע ועשרים" → 4:20, "10.45" → 10:45. A number after "ב-" together with a time-of-day word (בלילה, בבוקר, בצהריים) is a clock time even if the recogniser wrote "דקות" after it ("קם ב-12.5 דקות בערך בלילה" → "קם בערך ב-12:30 בלילה"). Real durations stay durations ("לקח 20 דקות").
5. Foreign words or phrases spelled phonetically (English inside Hebrew): "ביי פאר"/"ביפר"/"בי פאר" = "by far", "ג'ימל" = Gmail, "מרקטינג" stays. Write them the way people type them; never turn such a phrase into a name or an acronym.
6. Colloquial words stay colloquial (סבבה, יאללה, שנ"צ = afternoon nap, "שנץ" is that word). Keep the speaker's tone and register. Keep the order of ideas.
7. If a list of known names/terms is given, spell names as in that list when the transcript has a near-miss of one. Do not force a name where the speaker did not say one, and do not introduce a name the transcript does not mention.
8. When the speaker enumerates items — "אחד… שתיים… שלוש", "דבר ראשון… דבר שני", "first… second…", "א'… ב'…", or a spoken "שלושה דברים:" followed by items — write them as a numbered list: each item on its own line, starting with "1. ", "2. ", "3. ". Any intro sentence stays above the list, any closing remark below it. Only number what the speaker actually enumerated.
9. Output only the rewritten text. Line breaks between topics are fine. No headings, no bullet symbols other than that numbering, no bold, no quotes.`;

const words = (s) => (s || '').trim().split(/\s+/).filter(Boolean);
const scriptShare = (s, re) => {
  const letters = [...s].filter((c) => /\p{L}/u.test(c));
  return letters.length ? letters.filter((c) => re.test(c)).length / letters.length : 0;
};
const SCRIPTS = [/\p{Script=Hebrew}/u, /\p{Script=Arabic}/u, /\p{Script=Cyrillic}/u, /\p{Script=Latin}/u];

/**
 * Guards. The editor's message may be much shorter than the ramble it came from,
 * but not a stub (a few words out of a long note lost something) and never longer
 * than the speech (that is invention). The faithful rewrite must stay roughly the
 * transcript's size: much shorter is a summary. Both stay in the transcript's script.
 * Pure, exported for tests.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function acceptRewrite(input, output, { style = 'editor' } = {}) {
  let out = (output || '').trim().replace(/^["'“”«]+|["'“”»]+$/g, '').replace(/\*\*?/g, '').trim();
  if (!out) return { ok: false, reason: 'empty' };
  const inW = words(input).length, outW = words(out).length;
  const floor = style === 'faithful' ? Math.max(3, inW * 0.45) : Math.max(2, inW * 0.15);
  if (outW < Math.min(inW, floor)) return { ok: false, reason: `too short (${outW} vs ${inW} words) — content was lost` };
  if (outW > (style === 'faithful' ? inW * 1.6 + 10 : inW * 1.2 + 8)) return { ok: false, reason: `too long (${outW} vs ${inW} words) — looks invented` };
  for (const re of SCRIPTS) {
    const inShare = scriptShare(input, re);
    if (inShare >= 0.6 && scriptShare(out, re) < 0.5) return { ok: false, reason: 'language/script changed' };
  }
  if (/^(sure|here|הנה|בטח)/i.test(out)) return { ok: false, reason: 'chatty preamble' };
  return { ok: true, text: out };
}

/** How long a headline to ask for: about an eighth of the speech, 12 to 45 words. */
export const headlineWords = (text) => Math.min(45, Math.max(12, Math.round(words(text).length / 8)));

/**
 * Build the user message. Other readings of the same audio are the single best
 * signal for fixing a misheard word, so they are labelled and handed over.
 * Pure, exported for tests.
 */
export function buildRewriteInput(text, { speaker = null, isMe = false, names = '', alts = [], headline = null } = {}) {
  const who = isMe ? 'the account owner (me)' : (speaker || 'unknown');
  const seen = new Set([text.trim()]);
  const others = (Array.isArray(alts) ? alts : [alts])
    .map((a) => (typeof a === 'string' ? a : a?.text) || '')
    .map((a) => a.trim())
    .filter((a) => a && !seen.has(a) && seen.add(a));
  const head = `Speaker: ${who}${names ? `\nKnown names/terms that may appear: ${names}` : ''}${headline == null ? '' : `\nHeadline: ${headline ? `yes, about ${headlineWords(text)} words` : 'no'}`}`;
  if (!others.length) return `${head}\n\nTranscript:\n${text}`;
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const blocks = [text, ...others].map((t, i) => `Transcript ${letters[i]}${i === 0 ? ' (the one being rewritten)' : ''}:\n${t}`);
  return `${head}\n\n${blocks.join('\n\n')}`;
}

/**
 * Split a reply into the message and the headline on its last line. A reply
 * without the marker is all message. Pure, exported for tests.
 */
export function splitHeadline(raw) {
  const m = /^([\s\S]*?)\n+[ \t]*HEADLINE:[ \t]*(.*?)\s*$/.exec(raw || '');
  return m && m[1].trim() ? { headline: m[2], body: m[1] } : { headline: null, body: (raw || '').replace(/^[ \t]*HEADLINE:.*$/gm, '') };
}

/**
 * @param {string} text raw transcript
 * @param {{ speaker?: string|null, isMe?: boolean, names?: string, alt?: string|null,
 *           alts?: Array<string|{text:string}> }} [opts]
 *   names: comma-separated known names/terms (see glossary.js)
 *   alt / alts: other readings of the same audio
 *   style: 'editor' (free hand, writes the headline too) or 'faithful' (every point
 *   kept in the speaker's order; the headline comes from summarize.js)
 * @returns {Promise<{ text: string, summary: string|null } | null>} the message and,
 *   from the editor on a long recording, its bold headline — written in the same
 *   call, so they agree and cost one request. null = deliver the raw transcript.
 */
export async function rewriteMessage(text, { speaker = null, isMe = false, names = '', alt = null, alts = [], style = 'editor' } = {}) {
  if (!rewriteEnabled || words(text).length < MIN_WORDS) return null;
  const readings = [...(Array.isArray(alts) ? alts : [alts]), alt].filter(Boolean);
  if (style === 'faithful') return runRewrite(text, { speaker, isMe, names, readings, editor: false });
  const edited = await runRewrite(text, { speaker, isMe, names, readings, editor: true });
  if (edited) return edited;
  // The editor timed out or failed its guards: the faithful rewrite on the small
  // model is a far better plan B than the raw transcript or another provider.
  console.warn('   ↪️  editor gave nothing usable — falling back to the faithful rewrite');
  return runRewrite(text, { speaker, isMe, names, readings, editor: false });
}

async function runRewrite(text, { speaker, isMe, names, readings, editor }) {
  const headline = editor && summarizeEnabled && words(text).length >= SUMMARY_MIN_WORDS;
  const user = buildRewriteInput(text, { speaker, isMe, names, alts: readings, headline: editor ? headline : null });
  const label = editor ? 'editor' : 'faithful';
  // Generous budget: on reasoning models the hidden thinking counts against it,
  // and llmText returns null on a truncated reply rather than a cut-off text.
  // The editor has its own plan B (the faithful rewrite), so no second provider.
  const raw = await llmText(editor ? SYSTEM_EDITOR : SYSTEM_FAITHFUL, user, { maxTokens: 3000, temperature: 0.2, timeoutMs: editor ? EDITOR_TIMEOUT_MS : TIMEOUT_MS, model: editor ? editorLabel : rewriteLabel, fallback: !editor });
  if (raw == null) { console.warn(`   ⚠️  rewrite [${label}] unavailable (error/timeout/truncated)`); return null; }
  const parts = splitHeadline(raw);
  const r = acceptRewrite(text, parts.body, { style: label });
  if (!r.ok) { console.warn(`   ⚠️  rewrite [${label}] rejected (${r.reason})`); return null; }
  const h = headline && parts.headline ? acceptHeadline(parts.headline) : null;
  if (headline && !h?.ok) console.warn(`   ⚠️  headline ${h ? `rejected (${h.reason})` : 'missing'}`);
  console.log(`   ✍️  rewrite ok [${label}] (${r.text.length} chars${h?.ok ? ` + headline ${h.text.length}` : ''})`);
  return { text: r.text, summary: h?.ok ? h.text : null };
}
