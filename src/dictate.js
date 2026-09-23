/**
 * Dictated messages. A voice note recorded straight into the control group
 * that says "send Eden that I'm on my way to pick her up" ("תשלח לעדן שאני
 * בדרך לאסוף אותה") becomes a text to Eden, sent as the owner — after the owner
 * confirms. A single clear saved contact is proposed ("Send to Eden Levi?"),
 * several are listed to pick from; a match alone never sends anything.
 *
 * Two pure parts live here and are tested without a network: reading the
 * model's answer into a validated {to, text}, and matching a spoken name
 * against the account's contacts. The model call goes through llm.js and
 * fails closed: any error, timeout or odd reply means "not a dictation".
 *
 * Env: DICTATE=0 turns it off (default: on whenever an LLM key is configured).
 *      DICTATE_TIMEOUT_MS  default 15000
 */
import { llmText, llmEnabled } from './llm.js';

export const dictateEnabled = process.env.DICTATE !== '0' && llmEnabled;
const TIMEOUT_MS = Number(process.env.DICTATE_TIMEOUT_MS ?? 15000) || 15000;
const MAX_TEXT = 2000;
const MAX_NAME = 60;

// Cheap gate before any model call: a dictation names the act of sending.
// Generous on purpose (stems, not words): its job is to skip the obvious
// non-commands, the model decides the rest.
const CUE = /(שלח|תגיד|הגיד|כתוב|תעביר|העביר|מסור|הודע|send|tell|text|write|message|let\s+\S+\s+know)/iu;
export const looksLikeDictation = (text) => CUE.test(String(text || ''));

const SYSTEM = `You read the text of a voice note that the owner of a WhatsApp account recorded into their own private control chat. Decide whether it is an instruction to send a message to one person, and if so extract that message.

Instructions look like: "send Eden that I'm on my way to pick her up", "תשלח לעדן שאני בדרך לאסוף אותה", "tell David the meeting moved to 3", "תכתוב לאמא שאני מאחר בעשר דקות", "text Dana: happy birthday".

Answer with JSON only, nothing else:
{"send": true, "to": "<recipient's name as spoken>", "spellings": ["<the same name in the other scripts it is commonly written in>"], "text": "<the message, addressed to the recipient>"}
or
{"send": false}

Rules:
- "send" is true ONLY when the note clearly instructs to send / tell / write / text a message to a NAMED person. A note that merely mentions someone, a note to self, a reminder, a question, a story, or anything unclear → {"send": false}.
- "to": the person's name exactly as spoken, one name, without the "to" / "ל" prefix — ONLY what was said: never add a surname, an emoji or anything else. Fix an obvious speech-recognition slip in the name ("לאדן" → עדן). A recipient that is not a person's name ("everyone", "the group", "the team") → {"send": false}.
- "spellings": contacts are saved in any script, so give the same name as it is usually written in the other ones: "עדן" → ["Eden"], "David" → ["דוד", "דויד"], "אמא" → ["Mom", "Ima"]. Up to 4, names only.
- "text": what the recipient should receive, written the way the owner would type it to them: the same language as the note, the owner in first person, the recipient in second person ("שאני בדרך לאסוף אותה" → "אני בדרך לאסוף אותך", "that I'll call him later" → "I'll call you later"), the framing ("send X that", "tell X", "תגיד ל...ש") removed. Keep every detail, number and time. Add nothing: no greeting, no sign-off, no emoji, unless spoken. Fix obvious speech-recognition slips, nothing more.`;

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
const SCRIPTS = [/\p{Script=Hebrew}/u, /\p{Script=Arabic}/u, /\p{Script=Cyrillic}/u, /\p{Script=Latin}/u];
const scriptShare = (s, re) => {
  const letters = [...String(s || '')].filter((c) => /\p{L}/u.test(c));
  return letters.length ? letters.filter((c) => re.test(c)).length / letters.length : 0;
};
const unquote = (s) => String(s || '').trim().replace(/^["'“”«]+|["'“”»]+$/g, '').replace(/\*/g, '').trim();

/**
 * Read the model's reply. Guards: the message must be text the owner could
 * have said (not longer than the note, same script), the recipient a short
 * name. Pure, exported for tests.
 * @returns {{ to: string, spellings: string[], text: string } | null}
 */
export function parseDictationReply(transcript, raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || obj.send !== true) return null;
  const to = unquote(obj.to).replace(/^to\s+/i, ''); // a Hebrew ל stays: לאה is a name (the matcher retries without it)
  const text = unquote(obj.text);
  const spellings = (Array.isArray(obj.spellings) ? obj.spellings : []).map((v) => unquote(v))
    .filter((v) => v && v.length <= MAX_NAME && words(v).length <= 4 && v !== to).slice(0, 4);
  if (!to || to.length > MAX_NAME || /\n/.test(to) || words(to).length > 4) return null;
  if (!text || text.length > MAX_TEXT) return null;
  const inW = words(transcript).length, outW = words(text).length;
  if (outW > inW * 1.5 + 5) return null;                       // invented, not extracted
  for (const re of SCRIPTS) if (scriptShare(transcript, re) >= 0.6 && scriptShare(text, re) < 0.5) return null;
  return { to, spellings, text };
}

/**
 * @param {string} text the voice note's text
 * @param {{ trace?: Function }} [opts] trace: opted-in accounts only (see Tenant.trace) — gets the prompt and the raw reply
 * @returns {Promise<{ to: string, spellings: string[], text: string } | null>} null = not a dictation (or the model is unavailable)
 */
export async function extractDictation(text, { trace = null } = {}) {
  if (!dictateEnabled || !looksLikeDictation(text)) return null;
  // The contact list never goes to the model: it names the person, we find them.
  const user = `Voice note:\n${text}`;
  // Generous budget: on reasoning models the hidden thinking counts against it.
  const raw = await llmText(SYSTEM, user, { maxTokens: 600, temperature: 0, timeoutMs: TIMEOUT_MS });
  trace?.('dictation.model', { input: user, reply: raw });
  if (raw == null) { console.warn('   ⚠️  dictation check unavailable (error/timeout) — treating the note as a plain recording'); return null; }
  return parseDictationReply(text, raw);
}

// ---------- contact matching (pure) ----------
export const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[\u0591-\u05C7]/g, '')          // niqqud and cantillation
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')        // punctuation, emoji, quotes
  .replace(/\s+/g, ' ').trim();

/**
 * Rank the account's contacts against a spoken name (and its spellings in
 * other scripts). The result is a SUGGESTION for the owner to confirm, never a
 * licence to send.
 *
 *   contacts: Map<jid, name>     activity: Map<jid, n> — how many messages the
 *   owner has sent that chat since we started counting (metadata, no content)
 *
 * How well the NAME fits comes first, always: 3 = the whole name ("Eden" →
 * "Eden 🌻"), 2 = the first name(s) ("Eden" → "Eden Levi"), 1 = another word
 * of it ("Eden" → "Amit Eden"). A weaker fit never outranks a better one,
 * whatever else is known about the contact. Inside a tier, the chat the owner
 * writes to most comes first. `proposed` is set only when the best tier holds
 * one person, or one the owner clearly writes to more than the rest.
 * The same person under two ids (phone + lid) counts once.
 * @returns {{ proposed: {jid,name}|null, candidates: Array<{jid,name,score}> }}
 */
export function matchContacts(spoken, contacts, { activity = new Map(), max = 6 } = {}) {
  const none = { proposed: null, candidates: [] };
  const queries = new Set();
  for (const v of Array.isArray(spoken) ? spoken : [spoken]) {
    const q = norm(v); if (!q) continue;
    queries.add(q);
    if (q.length > 2 && q.startsWith('ל')) queries.add(`\u0000${q.slice(1)}`); // a leftover Hebrew "to": tried, but ranked below
  }
  if (!queries.size || !contacts?.size) return none;
  const hits = [];
  for (const [jid, name] of contacts) {
    const n = norm(name); if (!n) continue;
    const t = n.split(' ');
    let score = 0;
    for (const raw of queries) {
      const weak = raw.startsWith('\u0000'); const q = weak ? raw.slice(1) : raw; const qt = q.split(' ');
      let sc = 0;
      if (n === q) sc = 3;
      else if (qt.length <= t.length && qt.every((w, i) => t[i] === w)) sc = 2;
      else if (qt.length === 1 && t.includes(q)) sc = 1;
      if (weak && sc) sc -= 0.5;
      score = Math.max(score, sc);
    }
    if (score > 0) hits.push({ jid, name: String(name).trim(), key: n, score, n: Number(activity.get(jid)) || 0 });
  }
  if (!hits.length) return none;
  // One entry per distinct name: its best score, the activity of all its ids, a phone-number id preferred.
  const byName = new Map();
  for (const h of hits) {
    const cur = byName.get(h.key);
    if (!cur) { byName.set(h.key, { ...h }); continue; }
    cur.n += h.n; cur.score = Math.max(cur.score, h.score);
    if (!cur.jid.endsWith('@s.whatsapp.net') && h.jid.endsWith('@s.whatsapp.net')) cur.jid = h.jid;
  }
  const ranked = [...byName.values()].sort((a, b) => b.score - a.score || b.n - a.n || a.name.length - b.name.length);
  const best = ranked.filter((h) => h.score === ranked[0].score);
  const clear = best.length === 1 || (best[0].n >= 3 && best[0].n >= 2 * best[1].n);
  const strip = ({ jid, name, score }) => ({ jid, name, score });
  return { proposed: clear ? strip(best[0]) : null, candidates: ranked.slice(0, max).map(strip) };
}
