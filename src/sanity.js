/**
 * Sanity gate for transcripts. Speech-to-text models hallucinate on silence and
 * noise — Whisper's "תודה. תודה רבה. תודה." / "Thank you for watching", gpt-4o's
 * paragraph about vaccines in German — and once posted under a voice note that
 * text is embarrassing and impossible to unsee. Nothing leaves the agent without
 * passing this check. Pure function, no I/O.
 *
 *   checkTranscript(text, { seconds, language }) → { ok: true } | { ok: false, reason }
 */

const SCRIPT_FOR_LANGUAGE = {
  he: /\p{Script=Hebrew}/u, yi: /\p{Script=Hebrew}/u,
  ar: /\p{Script=Arabic}/u, fa: /\p{Script=Arabic}/u, ur: /\p{Script=Arabic}/u,
  ru: /\p{Script=Cyrillic}/u, uk: /\p{Script=Cyrillic}/u, bg: /\p{Script=Cyrillic}/u,
  el: /\p{Script=Greek}/u, ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  zh: /\p{Script=Han}/u, ko: /\p{Script=Hangul}/u, th: /\p{Script=Thai}/u,
  en: /\p{Script=Latin}/u, de: /\p{Script=Latin}/u, fr: /\p{Script=Latin}/u, es: /\p{Script=Latin}/u,
  it: /\p{Script=Latin}/u, pt: /\p{Script=Latin}/u, nl: /\p{Script=Latin}/u, pl: /\p{Script=Latin}/u,
};

// Phrases the models produce out of thin air (training-data artefacts: subtitle
// credits, video sign-offs, that one vaccine paragraph). Lower-cased substrings.
const KNOWN_HALLUCINATIONS = [
  'wirkung der impfung', 'untertitel', 'subtitles by', 'subtitled by', 'amara.org',
  'thank you for watching', 'thanks for watching', 'like and subscribe', 'see you in the next video',
  'תודה שצפיתם', 'כתוביות', 'תרגום וכתוביות', 'תודה על הצפייה',
  'sous-titres', 'sottotitoli', 'subtítulos', 'legendas', 'copyright ©',
];

const MIN_SCRIPT_SHARE = 0.4;   // letters that must be in the forced language's script
const MAX_WORDS_PER_SECOND = 6; // nobody speaks faster; more words than this = invented
const MAX_DISTINCT_SHARE = 0.4; // "תודה תודה רבה תודה תודה" → 2/5 distinct → filler

function words(text) {
  return text.split(/[\s.,!?;:"'()\-–—…]+/u).filter((w) => /\p{L}|\p{N}/u.test(w));
}

export function checkTranscript(text, { seconds = 0, language = '' } = {}) {
  const t = (text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  const lower = t.toLowerCase();

  for (const phrase of KNOWN_HALLUCINATIONS) {
    if (lower.includes(phrase)) return { ok: false, reason: `known hallucination phrase "${phrase}"` };
  }

  const lang = (language || '').toLowerCase().slice(0, 2);
  const script = SCRIPT_FOR_LANGUAGE[lang];
  if (script) {
    const letters = [...t].filter((c) => /\p{L}/u.test(c));
    if (letters.length) {
      const share = letters.filter((c) => script.test(c)).length / letters.length;
      if (share < MIN_SCRIPT_SHARE) return { ok: false, reason: `wrong script for "${lang}" (${Math.round(share * 100)}% match)` };
    }
  }

  const ws = words(t);
  if (ws.length >= 4) {
    const distinct = new Set(ws.map((w) => w.toLowerCase())).size;
    if (distinct / ws.length <= MAX_DISTINCT_SHARE) return { ok: false, reason: `repeated filler (${distinct} distinct of ${ws.length} words)` };
  }

  if (seconds > 0) {
    if (ws.length > MAX_WORDS_PER_SECOND * seconds + 3) return { ok: false, reason: `${ws.length} words in ${seconds}s — more than anyone can say` };
    if (seconds >= 4 && ws.length <= 1) return { ok: false, reason: `${seconds}s of audio but only ${ws.length} word` };
  }

  return { ok: true };
}
