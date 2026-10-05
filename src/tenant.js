/**
 * One linked WhatsApp account: its connection, its settings, its transcription
 * pipeline and its control group. Everything here is per account; nothing is
 * shared between tenants except the model providers.
 *
 * What a tenant does (and nothing else):
 *   - the owner's own voice notes → text posted under each, in every chat
 *   - voice notes / videos people send in private chats → text under them
 *   - groups: off until switched on (forward a note into the control group,
 *     reply "on"); then text under each recording, inside the group
 *   - the control group: created automatically on first link; on/off replies,
 *     "delete" to remove any post of ours, "names: …" to teach names
 *   - dictated messages: a voice note recorded in the control group saying
 *     "send Eden that I'm on my way" is matched to a contact and proposed; it is
 *     texted to Eden, as the owner, only after the owner replies yes
 */
import QRCode from 'qrcode';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { createLink } from './wa.js';
import { saveMedia, deleteMediaFile, sweepMediaDir, MAX_MEDIA_SECONDS } from './media.js';
import { createSemaphore } from './semaphore.js';
import { transcribeRun, measureSeconds, transcribeEnabled, planEnabled, planLabel, PLANS } from './transcribe.js';
import * as budget from './budget.js';
import { checkTranscript } from './sanity.js';
import { rewriteTranscript } from './rewrite.js';
import { summarizeTranscript } from './summarize.js';
import { createGlossary } from './glossary.js';
import * as research from './research.js';
import * as claims from './claims.js';
import { noteError } from './health.js';
import { normalizePhone } from './pairing.js';
import { LOGO_MARK_SVG } from './logo.js';
import { extractDictation, matchContacts, looksLikeDictation, norm as normName } from './dictate.js';
import { meter, bill } from './cost.js';

// Bounded work: at most this many recordings in flight per account, and across
// the whole process, so one flooded account can't starve the others or the box.
const PER_ACCOUNT_CONCURRENCY = Number(process.env.PER_ACCOUNT_CONCURRENCY ?? 2) || 2;
const GLOBAL_CONCURRENCY = Number(process.env.GLOBAL_CONCURRENCY ?? 8) || 8;
const MAX_QUEUE = Number(process.env.MAX_QUEUE_PER_ACCOUNT ?? 20) || 20; // waiting jobs per account beyond the running ones
const globalSlots = createSemaphore(GLOBAL_CONCURRENCY);

export const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Ramble';
const OWNER_LABEL = 'me';
// The languages an owner can pin, by code: set with "language <name>" in the control group ('' = auto-detect).
export const LANGUAGES = [['', 'auto', 'Auto-detect', 'זיהוי אוטומטי'], ['he', 'hebrew', 'Hebrew', 'עברית'], ['en', 'english', 'English', 'אנגלית'], ['ar', 'arabic', 'Arabic', 'ערבית'], ['ru', 'russian', 'Russian', 'רוסית'], ['es', 'spanish', 'Spanish', 'ספרדית'], ['fr', 'french', 'French', 'צרפתית'], ['de', 'german', 'German', 'גרמנית'], ['pt', 'portuguese', 'Portuguese', 'פורטוגזית'], ['it', 'italian', 'Italian', 'איטלקית']];
/** "hebrew", "Hebrew", "he", "auto" → its row; anything else → null. */
export const findLanguage = (word) => { const w = String(word || '').trim().toLowerCase(); return LANGUAGES.find(([code, name]) => w === name || (code && w === code)) || null; };
// Every command is ONE English word — include, exclude, delete, yes, no, undo, leave, help, names —
// so there is never a question of which one to write. No synonyms, no translations.
const TARGET_KEYWORD = '#transcribe'; // manual fallback for arming the control group
const PENDING_LEAVE_TTL_MS = 10 * 60e3;
// A spoken answer is speech, not a typed command: "Yes." / "כן" / "שתיים" — punctuation off,
// a Hebrew yes/no and number words brought to the one word a typed answer would be.
const SPOKEN_WORDS = new Map([['כן', 'yes'], ['לא', 'no'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'], ['six', '6'], ['אחד', '1'], ['אחת', '1'], ['שתיים', '2'], ['שניים', '2'], ['שתים', '2'], ['שלוש', '3'], ['ארבע', '4'], ['חמש', '5'], ['שש', '6']]);
export const spokenAnswer = (text) => { const w = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim(); return SPOKEN_WORDS.get(w) || w; };
// Both sides of a chat may be accounts here. The sender's account posts the text; the
// recipient's gives it this head start, then waits for the outcome before stepping in.
const YIELD_MS = Number(process.env.CLAIM_YIELD_MS ?? 1500);
const CLAIM_WAIT_MS = Number(process.env.CLAIM_WAIT_MS ?? 180e3);
const PENDING_SEND_TTL_MS = 10 * 60e3; // how long "reply with the number" stays open
const PENDING_SWITCH_TTL_MS = 10 * 60e3; // how long an include/exclude question stays open
export const TRANSCRIBE_VIDEO = process.env.TRANSCRIBE_VIDEO !== '0';
const TRANSCRIBE_MIN_SECONDS = Number(process.env.TRANSCRIBE_MIN_SECONDS ?? 1) || 0;
// A single recording longer than this is not transcribed: one forwarded lecture
// would otherwise eat a whole day's quota (and the matching bill) at once.
export const MAX_TRANSCRIBE_SECONDS = Number(process.env.MAX_TRANSCRIBE_SECONDS ?? 600) || 0;
export const DAILY_MINUTES_CAP = Number(process.env.DAILY_MINUTES_CAP ?? 30) || 0;
// Invite a friend, get more minutes a day. No codes to type: the friend opens
// your link, scans, and the moment their WhatsApp is linked you are credited.
export const INVITE_BONUS_MINUTES = Number(process.env.INVITE_BONUS_MINUTES ?? 10) || 0;
export const INVITE_BONUS_MAX = Number(process.env.INVITE_BONUS_MAX ?? 60) || 0; // per account, per UTC day; 0 = unlimited
// Which provider an account transcribes with (see transcribe.js).
export const DEFAULT_PLAN = PLANS.includes(process.env.DEFAULT_PLAN) ? process.env.DEFAULT_PLAN : 'pro';
// A cheap second reading of the same audio for EVERY account, handed to the
// rewrite so a misheard word can be corrected against another recogniser rather
// than guessed. Unset = single reading (cheapest). Costs one extra call per
// recording; a `whisper*` model is served by the free provider.
const SECOND_READING_MODEL = process.env.SECOND_READING_MODEL || '';
// The same recording forwarded twice (typically into the control group) is not
// paid for twice: its text is remembered in memory only, briefly.
const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MINUTES ?? 60) * 60e3;
const DEDUPE_CAP = 200;
const SELF_PREFIX = process.env.SELF_TRX_PREFIX ?? '🎙️ ';
const CAP_MAP = 5000;

const loadJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const saveJson = (file, value) => { try { writeFileSync(file, JSON.stringify(value)); } catch (e) { noteError(e); console.warn('save failed:', file, e.message); } };
const firstLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);

// View-once media is meant to be seen once and vanish; turning it into text
// would defeat that, so it is never unwrapped, downloaded or transcribed.
// Disappearing (ephemeral) messages are handled, and the reply inherits the
// chat's disappearing timer so the text lives no longer than the recording.
const VIEW_ONCE_KEYS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
// Dominant script of a text: 'he' | 'ar' | 'cy' | 'latin' | null (no letters).
export function dominantScript(text) {
  const letters = [...String(text || '')].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return null;
  const share = (re) => letters.filter((c) => re.test(c)).length / letters.length;
  const scored = [['he', share(/\p{Script=Hebrew}/u)], ['ar', share(/\p{Script=Arabic}/u)], ['cy', share(/\p{Script=Cyrillic}/u)], ['latin', share(/\p{Script=Latin}/u)]];
  return scored.sort((a, b) => b[1] - a[1])[0][0];
}
export const sameScript = (a, b) => dominantScript(a) === dominantScript(b);

function unwrap(message) {
  if (!message) return message;
  if (VIEW_ONCE_KEYS.some((k) => message[k])) return { viewOnce: true };
  const inner = message.ephemeralMessage?.message || message.documentWithCaptionMessage?.message || message;
  if (inner !== message && VIEW_ONCE_KEYS.some((k) => inner?.[k])) return { viewOnce: true };
  return inner;
}
const clampSeconds = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_MEDIA_SECONDS) : 0; };

export class Tenant {
  /** @param {{id:string,label?:string,language?:string,createdAt:number,manageKey:string}} rec */
  constructor(rec, dir) {
    Object.assign(this, {
      id: rec.id, label: rec.label || '', language: rec.language || '', createdAt: rec.createdAt,
      manageKey: rec.manageKey, linkedAt: rec.linkedAt || 0,
      locale: rec.locale === 'he' || rec.locale === 'en' ? rec.locale : '', // the language we talk to the owner in; from their browser at sign-up
      inviteCode: rec.inviteCode || '',        // public: the /i/<code> link this account hands out
      referredBy: rec.referredBy || '',        // the invite code this account arrived through
      invited: Number(rec.invited) || 0,       // friends who linked through it
      bonusMinutes: Number(rec.bonusMinutes) || 0,
      plan: PLANS.includes(rec.plan) ? rec.plan : DEFAULT_PLAN,
      abModel: rec.abModel || '', // set by admin to compare another model on real notes
      // Opt-in, off for everyone unless the owner asked for it: keep a copy of
      // each recording with what the models made of it, to improve the product.
      keepAudio: rec.keepAudio === true,
      // Minutes a day for this account alone, set from the admin page; 0 = the server's default (plus invite bonuses).
      capMinutes: Number.isInteger(rec.capMinutes) && rec.capMinutes > 0 ? rec.capMinutes : 0,
      firstNoteAt: Number(rec.firstNoteAt) || 0, // the owner's first voice note in the group: the end of onboarding
      // Groups nobody switched: 'off' (nothing at all; new accounts) or 'mine' (the owner's own notes get their text).
      // Accounts from before the setting existed keep what they had: their own notes everywhere.
      groups: rec.groups === 'off' || rec.groups === 'private' ? rec.groups : 'mine',
      paused: rec.paused === true, // the owner wrote "pause": nothing is transcribed until "resume"
      // Who this account is, for the admin page: the linked number and the owner's WhatsApp name.
      phone: /^\d{6,15}$/.test(rec.phone || '') ? rec.phone : '', waName: String(rec.waName || '').slice(0, 80),
    });
    this.dir = dir; mkdirSync(dir, { recursive: true });
    this.tag = `[${this.id.slice(0, 6)}]`;
    this.mediaDir = join(dir, 'media');
    this.f = (name) => join(dir, name);

    // Settings and small state, all JSON files in the account's directory.
    this.target = loadJson(this.f('target.json'), null);           // control group { jid, name }
    this.muted = new Set(loadJson(this.f('muted.json'), []));       // private chats switched off
    this.enabled = new Set(loadJson(this.f('enabled.json'), []));   // groups switched on
    this.quiet = new Set(loadJson(this.f('quiet.json'), []));       // chats in private mode: other people's recordings are transcribed into the control group only
    this.archived = new Set(loadJson(this.f('archived.json'), []));
    this.fwdMap = new Map(loadJson(this.f('fwdmap.json'), []));     // our control-group post id → source chat
    this.mediaSrc = new Map(loadJson(this.f('mediasrc.json'), [])); // media sha256 → source chat
    this.contactNames = new Map(loadJson(this.f('contacts.json'), []));
    this.savedNames = new Set(loadJson(this.f('saved.json'), []));   // contacts whose name came from the phone's address book (partial: only those synced since linking)
    this.groupNames = new Map();
    this.altIds = new Map(loadJson(this.f('altids.json'), [])); // phone id ⇄ lid of the same private chat
    this.activity = new Map(loadJson(this.f('activity.json'), [])); // private chat → how many messages the owner sent it (a count, no content): ranks contacts for a dictated message
    this.dictated = new Map();   // our confirmation post id → the message we sent for the owner (memory only, for "undo")
    this.ownPosts = new Set();   // ids of messages we posted (memory only): their echo must never be read as the owner's answer
    this.pendingSend = null;     // a dictated message waiting for the owner to pick the recipient
    this.pendingLeave = null;    // "leave" was written in the control group; waiting for the yes
    this.pendingSwitch = null;   // include/exclude of a chat: waiting for the pick and the yes
    // The owner's last commands and what came of each, for the admin page: the command word, the outcome
    // and whether our reply went out. Never a name or any text. The reply sent next is credited to the newest.
    this.commands = loadJson(this.f('commands.json'), []);
    this.cmdNow = null;
    this.seen = new Set(loadJson(this.f('seen.json'), []));         // message ids already handled
    this.glossary = createGlossary(this.f('glossary.json'));
    this.usage = loadJson(this.f('usage.json'), { day: '', seconds: 0, notified: false });
    this.usageHistory = loadJson(this.f('usage-history.json'), []); // [{ day, minutes }], the last 30 days that had any audio
    // Recordings turned into text, ever (counts, seconds and dollars only): the owner's own and everyone else's. Counted from `since`.
    this.totals = loadJson(this.f('totals.json'), null) || { own: 0, others: 0, since: Date.now() };
    this.recent = new Map(); // media sha -> { content, summary, at } — memory only, never on disk

    this.link = null; this.sock = null; this.ownId = null; this.ownLid = null;
    this.mode = 'starting'; this.qr = null; this.ready = false;
    this.pairPhone = ''; this.pairingCode = null; // link with a code instead of a scan: the number, and the code in force
    this.pairRefreshedAt = 0; // WhatsApp answered a scan by changing the code: the phone has to scan again
    this.lastMessageAt = 0; this.lastError = null; this.needsManualGroup = false;
    this.stats = { transcribed: 0, dropped: 0, failed: 0 };
    this.sendChain = Promise.resolve();
    this.slots = createSemaphore(PER_ACCOUNT_CONCURRENCY);
    this.stopped = false;
    this.abort = new AbortController(); // shared cancel signal for this account's downloads
    this.inFlight = new Set();          // running jobs, awaited by stop()
    const swept = sweepMediaDir(this.mediaDir); // nothing from before a crash/restart may linger
    if (swept) console.log(`${this.tag} 🧹 removed ${swept} leftover media file(s)`);
  }

  // ---------- lifecycle ----------
  async start() {
    this.link = createLink({
      dir: this.dir, tag: this.tag,
      onQr: async (qr) => {
        this.ready = false; this.mode = 'qr'; this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        if (this.pairPhone && !this.pairingCode) await this.issuePairingCode(); // a new socket: the old code died with the last one
      },
      onPairRefresh: () => { this.pairRefreshedAt = Date.now(); },
      onReady: (sock) => this.onReady(sock),
      onClose: () => { this.ready = false; this.qr = null; this.pairingCode = null; this.pairRefreshedAt = 0; if (this.mode === 'connected') this.mode = 'reconnecting'; },
      onLoggedOut: () => { this.mode = 'logged_out'; this.ready = false; },
      onMessage: (m, sock) => this.onMessage(m, sock),
      onChats: (chats) => this.onChats(chats),
      onContacts: (contacts) => this.onContacts(contacts),
    });
    await this.link.start();
  }

  async stop({ logout = false } = {}) {
    this.stopped = true; this.mode = 'stopped'; this.ready = false;
    this.abort.abort();                 // downloads in progress are destroyed now
    // In-flight jobs stop at their next checkpoint; wait for them (bounded) so
    // that when we report "erased", nothing is still running.
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, 15000))]);
    const r = await this.link?.stop({ logout });
    if (logout && r && !r.loggedOut) console.warn(`${this.tag} ⚠️ WhatsApp did not confirm the logout — remove the device in WhatsApp → Linked devices to be sure`);
    return r;
  }

  async onReady(sock) {
    this.sock = sock;
    this.ownId = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
    this.ownLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
    this.ready = true; this.qr = null; this.mode = 'connected';
    const phone = this.ownId?.split('@')[0] || '', waName = String(sock.user?.name || sock.user?.verifiedName || this.waName).slice(0, 80);
    const known = (phone && phone !== this.phone) || waName !== this.waName; this.phone = phone || this.phone; this.waName = waName;
    if (!this.linkedAt) { this.linkedAt = Date.now(); this.persistRecord(); this.onFirstLink?.(this); }
    else if (known) this.persistRecord();
    this.pairPhone = ''; this.pairingCode = null;
    console.log(`${this.tag} ✅ connected as ${this.ownId?.replace(/^(\d{5})\d+/, '$1…')}${this.target ? ' · control group set' : ' · no control group yet'}`);
    if (!this.target) await this.createControlGroup();
    else if (!this.target.icon) await this.setGroupIcon(); // groups made before the icon existed
  }

  /** Link with a code: remember the number, and ask for a code now if a socket is waiting for a scan. */
  async requestPairingCode(phone) {
    const digits = normalizePhone(phone);
    if (!digits) return false;
    this.pairPhone = digits; this.pairingCode = null;
    if (this.mode === 'qr' && this.link?.sock) await this.issuePairingCode();
    return true;
  }
  usePairingQr() { this.pairPhone = ''; this.pairingCode = null; }
  async issuePairingCode() {
    try { this.pairingCode = await this.link.requestPairingCode(this.pairPhone); console.log(`${this.tag} 🔢 pairing code issued`); }
    catch (e) { console.warn(`${this.tag} pairing code failed: ${firstLine(e)}`); }
  }

  /** The control group wears the logo. Best effort, once. */
  async setGroupIcon() {
    if (!this.target || !this.sock) return;
    try {
      await Promise.race([this.sock.updateProfilePicture(this.target.jid, Buffer.from(LOGO_MARK_SVG)), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 30000))]);
      this.target.icon = Date.now(); saveJson(this.f('target.json'), this.target);
      console.log(`${this.tag} 🖼️ control group icon set`);
    } catch (e) { console.warn(`${this.tag} could not set the group icon: ${firstLine(e)}`); }
  }

  /** First link: create the control group with just the owner in it and post the welcome. */
  async createControlGroup() {
    try {
      const g = await this.sock.groupCreate(PRODUCT_NAME, []);
      if (!g?.id) throw new Error('no group id returned');
      this.target = { jid: g.id, name: PRODUCT_NAME, setAt: Date.now() };
      saveJson(this.f('target.json'), this.target);
      this.needsManualGroup = false;
      console.log(`${this.tag} 🎯 control group created`);
      await this.setGroupIcon();
      await this.sendPaced(g.id, { text: this.welcomeText() });
    } catch (e) {
      this.needsManualGroup = true;
      console.warn(`${this.tag} could not create the control group (${firstLine(e)}) — user must create one and post #transcribe`);
    }
  }

  // In Hebrew texts every line starts with a Hebrew letter: WhatsApp takes a line's direction
  // from its first letter, and one that opens with "Ramble" or "on" comes out left-to-right.
  /** The language we talk to the owner in: their browser's at sign-up, else a Hebrew transcription setting or an Israeli number. */
  ownerLocale() {
    if (this.locale) return this.locale;
    return this.language === 'he' || (!this.language && this.ownId?.startsWith('972')) ? 'he' : 'en';
  }

  welcomeText() {
    if (this.ownerLocale() === 'he') return `ברוכים הבאים ל-*${PRODUCT_NAME}* ✅
החיבור לוואטסאפ הושלם. הקבוצה הזו היא לוח הבקרה, ואין בה אף אחד מלבדכם.

• כל הודעה קולית בצ'אטים פרטיים מתומללת, והטקסט מופיע ממש מתחת להקלטה.
• כדי להפעיל תמלול בקבוצה, כתבו כאן *include* ואת שם הקבוצה, למשל: *include משפחת כהן*. אפשר גם לכתוב *private* ואת שם הקבוצה, כדי לקבל את התמלול רק כאן.
• רוצים לתמלל רק את ההודעות הקוליות שלכם, בכל הקבוצות? כתבו כאן *groups mine*.
• להפסקת השימוש ב-${PRODUCT_NAME}, כתבו כאן *leave*.
• לרשימת הפקודות המלאה, כתבו כאן *help*.

הקלטות נמחקות ברגע שהן הופכות לטקסט.

👉 נסו עכשיו: הקליטו הודעה קולית כאן, בקבוצה הזו.`;
    return `Welcome to *${PRODUCT_NAME}* ✅
It's linked to your WhatsApp. This group is your control panel, and only you are in it.

• Every voice note in a private chat, yours and theirs, gets its text right under it.
• Nothing is transcribed in groups. To turn one on, write *include* and the group's name here, or *private* and the name to get the text only here. *groups mine* transcribes just your own voice notes, in every group.
• To stop using ${PRODUCT_NAME}, write *leave* here.
• For the list of commands, write *help* here.

Recordings are deleted the moment they become text.

👉 Try it now: record a voice note right here, in this group.`;
  }

  helpText() {
    if (this.ownerLocale() === 'he') return `*הפקודות של ${PRODUCT_NAME}*
כל פקודה היא מילה אחת באנגלית.

• הפעלה וכיבוי של צ'אט, *include* / *exclude*: לכתוב כאן *exclude* ואת שם איש הקשר או הקבוצה, או מספר טלפון (למשל *exclude אמא*), ו-*include* כדי להחזיר. תמיד נשאלת קודם שאלה, ועונים *yes*. צ'אט מוחרג לא מתומלל בכלל, גם לא ההקלטות שלך. קבוצות מתחילות כבויות, צ'אטים פרטיים דולקים.
• קבוצות, *groups*: מה קורה בקבוצות שלא הוגדרו אחרת. *groups off*: כלום. *groups mine*: רק ההודעות הקוליות שלך, עם טקסט בקבוצה. *groups private*: ההודעות הקוליות של כולם, עם הטקסט רק כאן.
• תמלול בפרטיות, *private*: לכתוב כאן *private* ואת השם, והטקסט של כל הקלטה שם, גם שלך, יגיע רק לכאן, בלי שום דבר בצ'אט ההוא.
• מחיקת טקסט, *delete*: לענות כך לכל טקסט ש-${PRODUCT_NAME} פרסם, בכל צ'אט, והוא נמחק אצל כולם.
• שפת התמלול, *language*: לכתוב כאן *language* כדי לראות אותה, ו-*language hebrew* (או שפה אחרת, או *auto*) כדי לקבוע. בדרך כלל אין צורך: השפה מזוהה לבד.
• עצירה והמשך, *pause* / *resume*: לכתוב כאן כדי לעצור את כל התמלולים, ולהמשיך מתי שרוצים.
• התנתקות, *leave*: לכתוב כאן כדי לנתק את ${PRODUCT_NAME} ולמחוק את החשבון. נשאלת קודם שאלה, ועונים לה *yes* או *no*.
• הרשימה הזו: *help*.`;
    return `*${PRODUCT_NAME} commands*
Each one is a single word.

• *include* / *exclude*: write it here with a contact's or a group's name, or a phone number (*exclude Mom*), to switch that chat, or reply it to a forwarded recording's text. It always asks first; answer *yes*. An excluded chat is not transcribed at all, your own voice notes included. Groups start off, private chats start on.
• *groups*: what happens in groups you haven't switched. *groups off*: nothing. *groups mine*: your own voice notes, with the text in the group. *groups private*: everyone's voice notes, with the text only here.
• *private*: write it here with a name, and the text of every recording in that chat, yours included, comes only here; nothing is posted there.
• *delete*: reply with it to any text ${PRODUCT_NAME} posted, in any chat, and it's removed for everyone.
• *language*: write it here to see the transcription language, and *language hebrew* (or another, or *auto*) to fix it. Rarely needed: it's detected on its own.
• *pause* / *resume*: write it here to stop all transcription for a while, and to start again.
• *leave*: write it here to unlink ${PRODUCT_NAME} and erase your account. It asks first; answer *yes* or *no*.
• *help*: this list.`;
  }

  pauseReply(how) {
    const he = this.ownerLocale() === 'he';
    const t = {
      paused: ['⏸️ Paused. Nothing is transcribed until you write *resume* here.', '⏸️ מושהה. שום הקלטה לא מתומללת עד שכותבים כאן *resume*.'],
      resumed: ['▶️ Back on. Voice notes get their text again.', '▶️ חוזרים לפעול. הודעות קוליות מקבלות שוב טקסט.'],
      'already-paused': ['⏸️ Already paused. Write *resume* to start again.', '⏸️ כבר מושהה. כדי להמשיך, לכתוב כאן *resume*.'],
      'already-running': ["▶️ It's running. Write *pause* to stop it for a while.", '▶️ הכול פועל. כדי לעצור לזמן מה, לכתוב כאן *pause*.'],
      'paused-note': ['⏸️ Paused, so this was not transcribed. Write *resume* to start again.', '⏸️ מושהה, ולכן ההקלטה הזו לא תומללה. כדי להמשיך, לכתוב כאן *resume*.'],
    }[how];
    return t[he ? 1 : 0];
  }

  /** Answer "groups" (show the setting) or "groups off" / "groups mine" (after setting it). */
  groupsReply(how) {
    const he = this.ownerLocale() === 'he', g = this.groups;
    const say = {
      mine: he ? "👥 בכל קבוצה (חוץ מאלה שהוחרגו) ההודעות הקוליות שלך מקבלות טקסט מתחתיהן. של אחרים מתומללות רק בקבוצות שהופעלו עם *include*."
        : "👥 In every group (except excluded ones), your own voice notes get their text under them. Other people's are transcribed only in groups you *include*.",
      private: he ? "👥 בכל קבוצה שלא הוגדרה אחרת, כל הודעה קולית, שלך ושל כולם, מתומללת אל הקבוצה הזו בלבד. שום דבר לא נכתב בקבוצות עצמן."
        : "👥 In every group you haven't switched, every voice note, yours and everyone's, is transcribed into this group only. Nothing is posted in the groups.",
      off: he ? "👥 שום דבר לא מתומלל בקבוצות, לא שלך ולא של אחרים, אלא אם קבוצה הופעלה עם *include* (טקסט בקבוצה) או *private* (טקסט כאן)."
        : "👥 Nothing is transcribed in groups, yours or anyone's, unless you *include* one (text in the group) or make it *private* (text here).",
    };
    if (how === 'set') return `${he ? '👥 בוצע: ' : '👥 Done: '}${say[g].replace(/^👥 /, '')}`;
    const options = {
      off: he ? 'שום דבר בקבוצות: *groups off*' : '*groups off*: nothing in groups',
      mine: he ? 'רק ההודעות הקוליות שלך, עם טקסט בקבוצה: *groups mine*' : '*groups mine*: just your own voice notes, with the text in the group',
      private: he ? 'כל ההודעות הקוליות, עם הטקסט רק כאן: *groups private*' : "*groups private*: everyone's voice notes, with the text only here",
    };
    const others = Object.keys(options).filter((k) => k !== g).map((k) => `• ${options[k]}`).join('\n');
    return `${say[g]}\n${he ? 'אפשר גם:' : 'Or:'}\n${others}`;
  }

  /** Answer "language" (show it) or "language <name>" (set it). */
  languageReply(word) {
    const he = this.ownerLocale() === 'he';
    const label = (row) => (he ? row[3] : row[2]);
    const names = LANGUAGES.map((r) => r[1]).join(', ');
    if (!word) {
      const cur = LANGUAGES.find((r) => r[0] === (this.language || '')) || LANGUAGES[0];
      return he
        ? `🌐 שפת התמלול: *${label(cur)}*.\nכדי לקבוע שפה, לכתוב כאן *language* ואחריה אחת מאלה: ${names}.`
        : `🌐 Transcription language: *${label(cur)}*.\nTo fix it, write *language* and one of: ${names}.`;
    }
    const row = findLanguage(word);
    if (!row) return he ? `🤷 לא מכיר את השפה הזו. אפשר לבחור מאלה: ${names}.` : `🤷 I don't know that one. Pick from: ${names}.`;
    this.setLanguage(row[0]);
    if (!row[0]) return he ? '🌐 חזרנו לזיהוי אוטומטי: השפה של כל הקלטה מזוהה לבד.' : "🌐 Back to auto-detect: each recording's language is worked out on its own.";
    return he
      ? `🌐 שפת התמלול נקבעה: *${label(row)}*. כל הקלטה תתומלל בשפה הזו. *language auto* מחזיר לזיהוי אוטומטי.`
      : `🌐 Transcription language set to *${label(row)}*. Every recording is transcribed as ${label(row)} now. *language auto* goes back to detecting it.`;
  }

  // ---------- state persistence ----------
  persistRecord() { saveJson(this.f('tenant.json'), { id: this.id, label: this.label, language: this.language, createdAt: this.createdAt, manageKey: this.manageKey, linkedAt: this.linkedAt, locale: this.locale, plan: this.plan, abModel: this.abModel, keepAudio: this.keepAudio, inviteCode: this.inviteCode, referredBy: this.referredBy, invited: this.invited, bonusMinutes: this.bonusMinutes, paused: this.paused, groups: this.groups, capMinutes: this.capMinutes || undefined, firstNoteAt: this.firstNoteAt, phone: this.phone, waName: this.waName }); }

  /** Today's ceiling for this account: the server default plus whatever invites earned. */
  dailyCapMinutes() { return this.capMinutes > 0 ? this.capMinutes : DAILY_MINUTES_CAP > 0 ? DAILY_MINUTES_CAP + this.bonusMinutes : 0; }
  /** The admin's limit for this account; 0 goes back to the server's default. */
  setCapMinutes(n) { this.capMinutes = Number.isInteger(n) && n > 0 ? Math.min(n, 1440) : 0; if (this.usage.notified && !this.overCap()) { this.usage.notified = false; saveJson(this.f('usage.json'), this.usage); } this.persistRecord(); console.log(`${this.tag} ⏱️ daily limit → ${this.capMinutes || 'default'}`); return this.capMinutes; }

  /** A friend who used this account's invite link just linked their WhatsApp. */
  creditInvite() {
    this.invited += 1;
    if (INVITE_BONUS_MINUTES > 0 && this.bonusMinutes < INVITE_BONUS_MAX) {
      this.bonusMinutes = Math.min(INVITE_BONUS_MAX, this.bonusMinutes + INVITE_BONUS_MINUTES);
    }
    this.persistRecord();
    console.log(`${this.tag} 🎁 invite accepted (${this.invited} so far, +${this.bonusMinutes} min/day)`);
    if (this.target?.jid) {
      this.sendPaced(this.target.jid, { text: `🎉 Someone you invited just joined ${PRODUCT_NAME}. Your daily limit is now *${this.dailyCapMinutes()} minutes*.` }).catch(() => {});
    }
  }
  setKeepAudio(on) { this.keepAudio = !!on; this.persistRecord(); console.log(`${this.tag} 🎧 keep recordings for product work → ${this.keepAudio ? 'ON' : 'OFF'}`); return this.keepAudio; }
  setPlan(plan) { if (!PLANS.includes(plan)) return false; this.plan = plan; this.persistRecord(); console.log(`${this.tag} 💳 plan → ${plan} (${planLabel(plan)})`); return true; }
  setAbModel(model) { this.abModel = String(model || '').slice(0, 60); this.persistRecord(); console.log(`${this.tag} 🧪 A/B model → ${this.abModel || 'off'}`); return true; }

  // ---------- dedupe (memory only) ----------
  cachedFor(sha) {
    if (!sha) return null;
    const hit = this.recent.get(sha);
    if (!hit) return null;
    if (Date.now() - hit.at > DEDUPE_TTL_MS) { this.recent.delete(sha); return null; }
    return hit;
  }
  cacheText(sha, content, summary) {
    if (!sha) return;
    this.recent.set(sha, { content, summary, at: Date.now() });
    while (this.recent.size > DEDUPE_CAP) this.recent.delete(this.recent.keys().next().value);
  }
  setLanguage(code) { this.language = code; this.persistRecord(); console.log(`${this.tag} 🌐 language set to ${code || 'auto'}`); }
  saveSet(name, set) { saveJson(this.f(name), [...set]); }
  saveMap(name, map, cap = CAP_MAP) { while (map.size > cap) map.delete(map.keys().next().value); saveJson(this.f(name), [...map]); }
  recordFwd(sentId, src) { if (sentId && src?.chatId) { this.fwdMap.set(sentId, { chatId: src.chatId, name: src.name }); this.saveMap('fwdmap.json', this.fwdMap); } }
  recordMediaSource(sha, src) { if (sha && src?.chatId) { this.mediaSrc.set(sha, { chatId: src.chatId, name: src.name, ts: Date.now() }); this.saveMap('mediasrc.json', this.mediaSrc, 3000); } }
  markSeen(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > CAP_MAP) this.seen.delete(this.seen.values().next().value);
    if (!this._seenTimer) this._seenTimer = setTimeout(() => { this._seenTimer = null; this.saveSet('seen.json', this.seen); }, 5000);
    return true;
  }
  isSelfChat(jid) { return (this.ownId && jid === this.ownId) || (this.ownLid && jid === this.ownLid); }

  onChats(chats) {
    if (!Array.isArray(chats)) return;
    let changed = false, named = false;
    for (const c of chats) {
      const id = c?.id; if (!id) continue;
      const arch = c.archived ?? c.archive;
      if (arch === true && !this.archived.has(id)) { this.archived.add(id); changed = true; }
      else if (arch === false && this.archived.has(id)) { this.archived.delete(id); changed = true; }
      // The name the chat list shows — for a business or anyone not saved, often the only one there is.
      const name = String(c.name || c.displayName || '').trim().slice(0, 80);
      if (name && id.endsWith('@g.us')) { if (!this.groupNames.get(id)) this.groupNames.set(id, name); }
      else if (name && !this.isSelfChat(id)) named = this.learnName(id, name) || named;
      if (c.pnJid && c.lidJid) this.learnAltIds(jidNormalizedUser(c.pnJid), jidNormalizedUser(c.lidJid));
    }
    if (changed) this.saveSet('archived.json', this.archived);
    if (named) this.saveMap('contacts.json', this.contactNames, 5000);
  }
  /** A display name for a chat the owner has not saved: never over a saved name. Returns true if it changed. */
  learnName(jid, name) {
    if (!jid || !name || this.savedNames.has(jid) || this.contactNames.get(jid) === name) return false;
    this.contactNames.set(jid, name); return true;
  }
  /** The phone id and the lid of one private chat, when WhatsApp hands them over together. */
  learnAltIds(pn, lid) {
    if (!pn || !lid || this.altIds.get(pn) === lid) return;
    this.altIds.set(pn, lid); this.altIds.set(lid, pn);
    this.saveMap('altids.json', this.altIds, 6000);
  }
  onContacts(contacts) {
    if (!Array.isArray(contacts)) return;
    let changed = false, savedChanged = false;
    for (const c of contacts) {
      const jid = c?.id; if (!jid || jid.endsWith('@g.us')) continue;
      const saved = c.name || c.verifiedName; const display = c.notify;
      if (saved) { this.contactNames.set(jid, saved); if (!this.savedNames.has(jid)) { this.savedNames.add(jid); savedChanged = true; } changed = true; }
      else if (display && !this.savedNames.has(jid) && !this.contactNames.has(jid)) { this.contactNames.set(jid, display); changed = true; }
    }
    if (changed) this.saveMap('contacts.json', this.contactNames, 5000);
    if (savedChanged) this.saveSet('saved.json', this.savedNames);
  }
  noteActivity(jid) {
    const count = (this.activity.get(jid) || 0) + 1;
    this.activity.delete(jid); this.activity.set(jid, count); // re-inserted last, so the cap drops the stalest chat
    if (!this._actTimer) { this._actTimer = setTimeout(() => { this._actTimer = null; this.saveMap('activity.json', this.activity, 2000); }, 5000); this._actTimer.unref?.(); }
  }
  /** Known names for a prompt: the glossary, then saved contacts, then display names — best spellings first. */
  namesHint() {
    const saved = [], other = [];
    for (const [jid, name] of this.contactNames) (this.savedNames.has(jid) ? saved : other).push(name);
    return this.glossary.hint([...saved, ...other]);
  }
  async resolveGroupName(jid) {
    if (this.groupNames.has(jid)) return this.groupNames.get(jid);
    this.groupNames.set(jid, null);
    try { const meta = await this.sock.groupMetadata(jid); this.groupNames.set(jid, meta?.subject || null); } catch { /* not a member */ }
    return this.groupNames.get(jid);
  }

  // ---------- usage cap ----------
  todayKey() { return new Date().toISOString().slice(0, 10); }
  usageSecondsToday() {
    if (this.usage.day !== this.todayKey()) {
      // The day rolled over: yesterday's total goes into the history (minutes only, for the admin view).
      if (this.usage.day && this.usage.seconds > 0) {
        this.usageHistory = [...this.usageHistory.filter((h) => h.day !== this.usage.day), { day: this.usage.day, minutes: Math.round(this.usage.seconds / 60) }].slice(-30);
        saveJson(this.f('usage-history.json'), this.usageHistory);
      }
      this.usage = { day: this.todayKey(), seconds: 0, notified: false };
    }
    return this.usage.seconds;
  }
  addUsage(seconds) { this.usageSecondsToday(); this.usage.seconds = Math.max(0, this.usage.seconds + seconds); saveJson(this.f('usage.json'), this.usage); }
  /** Atomically reserve `seconds` against today's cap: false if it would not fit. */
  reserveUsage(seconds) {
    const used = this.usageSecondsToday();
    const cap = this.dailyCapMinutes();
    if (cap > 0 && used + seconds > cap * 60) return false;
    this.addUsage(seconds); return true;
  }
  overCap() { const cap = this.dailyCapMinutes(); return cap > 0 && this.usageSecondsToday() >= cap * 60; }

  // ---------- messages ----------
  normalize(m) {
    const content = unwrap(m.message);
    if (!content || content.viewOnce) return null;
    let type, body = '', hasMedia = false, isVoice = false, mimetype = null, mediaSha = null, mediaNode = null;
    const shaOf = (node) => (node?.fileSha256 ? Buffer.from(node.fileSha256).toString('base64') : null);
    const seconds = clampSeconds(content.audioMessage?.seconds ?? content.videoMessage?.seconds ?? 0);
    if (content.conversation) { type = 'chat'; body = content.conversation; }
    else if (content.extendedTextMessage) { type = 'chat'; body = content.extendedTextMessage.text || ''; }
    // A message with more than one media object is ambiguous (which one would be
    // validated, which one downloaded?) — refuse it outright.
    else if ([content.videoMessage, content.audioMessage, content.imageMessage, content.documentMessage, content.stickerMessage].filter(Boolean).length > 1) return null;
    else if (content.videoMessage) { type = 'video'; hasMedia = true; mediaNode = content.videoMessage; mimetype = mediaNode.mimetype; mediaSha = shaOf(mediaNode); }
    else if (content.audioMessage) { type = content.audioMessage.ptt ? 'ptt' : 'audio'; hasMedia = true; isVoice = true; mediaNode = content.audioMessage; mimetype = mediaNode.mimetype; mediaSha = shaOf(mediaNode); }
    else return null; // images, documents, stickers, reactions, system messages: not our business
    // Disappearing chat? Our reply must disappear on the same timer.
    const ctx = (mediaNode || content.extendedTextMessage)?.contextInfo;
    const expiration = Number(ctx?.expiration || 0) || 0;
    const forwarded = !!(ctx?.isForwarded || Number(ctx?.forwardingScore) > 0);
    const chatId = m.key.remoteJid;
    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) return null;
    const isGroup = chatId.endsWith('@g.us');
    const fromMe = !!m.key.fromMe;
    const senderName = fromMe ? OWNER_LABEL : (m.pushName || null);
    const ext = content.extendedTextMessage;
    const quoted = ext?.contextInfo?.stanzaId ? ext.contextInfo : null;
    // The same private chat may arrive under a phone id or a lid; WhatsApp sends the other one along.
    const chatAlt = m.key.remoteJidAlt ? jidNormalizedUser(m.key.remoteJidAlt) : null;
    return { id: m.key.id, chatId, chatAlt, isGroup, fromMe, senderName, type, body, hasMedia, isVoice, mimetype, mediaSha, mediaNode, seconds, expiration, forwarded, quoted };
  }

  async onMessage(m, sock) {
    this.sock = sock;
    const n = this.normalize(m);
    if (!n) return;
    this.lastMessageAt = Date.now();

    let chatName;
    if (n.isGroup) chatName = await this.resolveGroupName(n.chatId);
    else if (this.isSelfChat(n.chatId)) chatName = 'Notes to self';
    else {
      // The owner's saved name wins over the name people give themselves, under either of their ids.
      const savedAlt = n.chatAlt && this.savedNames.has(n.chatAlt) ? this.contactNames.get(n.chatAlt) : null;
      if (savedAlt && this.contactNames.get(n.chatId) !== savedAlt) this.contactNames.set(n.chatId, savedAlt);
      else if (!savedAlt && !n.fromMe && n.senderName && !this.savedNames.has(n.chatId)) this.contactNames.set(n.chatId, n.senderName);
      if (!n.fromMe && m.verifiedBizName && this.learnName(n.chatId, String(m.verifiedBizName).trim().slice(0, 80))) this.saveMap('contacts.json', this.contactNames, 5000);
      if (n.chatAlt) this.learnAltIds(...(n.chatId.endsWith('@lid') ? [n.chatAlt, n.chatId] : [n.chatId, n.chatAlt]));
      chatName = this.contactNames.get(n.chatId) || n.chatId.split('@')[0];
    }

    // Who the owner actually writes to is the best hint for which "Eden" they mean.
    if (n.fromMe && !n.isGroup && !this.isSelfChat(n.chatId)) this.noteActivity(n.chatId);

    if (await this.handleCommand(m, n, chatName)) return;
    if (!n.hasMedia) return;                       // text is never stored or processed
    if (!this.markSeen(n.id)) return;              // duplicate delivery

    const isVideo = n.type === 'video';
    const isMediaWeCare = n.isVoice || (isVideo && TRANSCRIBE_VIDEO);
    if (!isMediaWeCare) return;
    const inControl = this.target?.jid && n.chatId === this.target.jid;

    // Fingerprint every recording so a later forward into the control group can be traced back.
    if (!inControl && n.mediaSha) this.recordMediaSource(n.mediaSha, { chatId: n.chatId, name: chatName });

    let want;
    if (inControl) want = true;                                                       // probe: always
    else if (this.isExcluded(n)) want = false;                                        // excluded by the owner: nothing, their own notes included
    else if (n.fromMe && n.isVoice) want = !n.isGroup || this.groups === 'mine' || this.enabled.has(n.chatId) || this.isPrivateHere(n); // owner's notes: private chats, and groups by the setting
    else if (n.isGroup) want = (this.enabled.has(n.chatId) || this.isPrivateHere(n)) && !this.archived.has(n.chatId);
    else want = !this.archived.has(n.chatId);
    if (!want) return;
    // Paused by the owner: nothing is transcribed, nowhere. A recording in the group gets a reminder.
    if (this.paused) {
      if (inControl && n.fromMe) this.sendPaced(n.chatId, { text: this.pauseReply('paused-note') }, { quoted: m }).catch(() => {});
      return;
    }

    // One recording, one text: the control group is ours alone, everywhere else another
    // account on this server may be looking at the very same message.
    if (inControl) { await this.handleRecording(m, n, chatName, isVideo, inControl); return; }
    // Private mode: every recording in the chat, the owner's own included, has its text come to the control
    // group only. That is not a post in the chat, so it takes no part in deciding who posts there.
    if (this.isPrivateHere(n)) {
      // A copy in the control group would outlive a disappearing recording: none is made.
      if (n.expiration) { console.log(`${this.tag} ⏭️ private transcript skipped (disappearing chat)`); return; }
      await this.handleRecording(m, n, chatName, isVideo, inControl);
      return;
    }
    const key = `${n.id}|${n.mediaSha || ''}`;
    if (!await this.claimRecording(key, n)) return;
    let posted = false;
    try { posted = await this.handleRecording(m, n, chatName, isVideo, inControl); }
    finally { claims.settle(key, this.id, !!posted); }
  }

  /** True when this recording is ours to transcribe; false when another account's text is already under it. */
  async claimRecording(key, n) {
    if (n.fromMe) return claims.take(key, this.id) || (await claims.outcome(key, CLAIM_WAIT_MS)) !== 'posted' && claims.take(key, this.id, { force: true });
    // Someone else's recording: if its sender has an account here, that account goes first.
    if (!claims.holder(key)) await new Promise((r) => setTimeout(r, YIELD_MS));
    for (let i = 0; i < 3 && !this.stopped; i++) {
      if (claims.take(key, this.id)) return true;
      const how = await claims.outcome(key, CLAIM_WAIT_MS);
      if (how === 'posted') { console.log(`${this.tag} 🤝 another account posted this recording's text — nothing to add`); return false; }
      if (how === 'timeout') return claims.take(key, this.id, { force: true });
    }
    return false;
  }

  /** Transcribe one recording and post its text. Resolves true once a text is under it. */
  async handleRecording(m, n, chatName, isVideo, inControl) {
    if (this.stopped) return;
    if (n.seconds > 0 && n.seconds < TRANSCRIBE_MIN_SECONDS) { console.log(`${this.tag} ⏭️ skipped a ${n.seconds}s recording`); return; }
    if (MAX_TRANSCRIBE_SECONDS > 0 && n.seconds > MAX_TRANSCRIBE_SECONDS) {
      console.log(`${this.tag} ⏭️ skipped a ${n.seconds}s recording (over the ${MAX_TRANSCRIBE_SECONDS}s limit)`);
      if (this.target) this.sendPaced(this.target.jid, { text: `⏭️ A ${Math.round(n.seconds / 60)}-minute recording was skipped. The limit per recording is ${Math.round(MAX_TRANSCRIBE_SECONDS / 60)} minutes.` }).catch(() => {});
      return;
    }
    if (!transcribeEnabled) return;

    // The same recording again — almost always one forwarded into the control
    // group. Reuse the text: no provider call, no quota, nothing to pay.
    const cached = this.cachedFor(n.mediaSha);
    if (cached) {
      const body = cached.summary ? `*${cached.summary}*\n${cached.content}` : cached.content;
      console.log(`${this.tag} ♻️ same recording again — reused its text`);
      if (inControl) { this.deliverProbe(n, body, isVideo, m); return; }
      return this.deliver(n, chatName, body, isVideo, m);
    }

    // Reserve the quota BEFORE any work, atomically and twice: against this
    // account's daily cap and against the whole server's daily budget.
    const sec = n.seconds || 30;
    if (!budget.reserve(sec)) {
      console.warn(`${this.tag} ⏸️ server daily audio budget reached — skipped`);
      this.notifyOncePerDay('globalCap', `⏸️ ${PRODUCT_NAME} reached its daily limit for today. Transcription resumes tomorrow.`);
      return;
    }
    if (!this.reserveUsage(sec)) {
      budget.refund(sec); // the work never happened; give the server's budget back
      if (!this.usage.notified && this.target) {
        this.usage.notified = true; saveJson(this.f('usage.json'), this.usage);
        this.sendPaced(this.target.jid, { text: `⏸️ That's a lot of talking. You hit today's limit (${this.dailyCapMinutes()} minutes of audio) — back tomorrow.${INVITE_BONUS_MINUTES > 0 && this.bonusMinutes < INVITE_BONUS_MAX ? `\nWant more? Every friend who joins through your invite link adds ${INVITE_BONUS_MINUTES} minutes a day.` : ''}` }).catch(() => {});
      }
      console.log(`${this.tag} ⏸️ over daily cap, skipped`);
      return;
    }
    if (this.slots.waiting >= MAX_QUEUE) { console.log(`${this.tag} ⏸️ queue full, skipped`); return; }

    // One slot per account and one process-wide; the slot is held until the work
    // has actually finished or been cancelled. Every job is tracked so stop() can
    // cancel it and wait for it.
    const job = this.slots.run(() => globalSlots.run(async () => {
      if (this.stopped) return;
      const media = await saveMedia(n.mediaNode, isVideo ? 'video' : 'audio', n.id, this.mediaDir, { signal: this.abort.signal });
      if (!media) return;
      if (this.stopped) { deleteMediaFile(media); return; } // checkpoint: nothing leaves the box after stop()
      if (!await this.holdToRealLength(n, media, sec, isVideo)) { deleteMediaFile(media); return; }
      return this.metered(n, () => this.transcribeAndDeliver(m, n, chatName, media, isVideo, inControl));
    }));
    this.inFlight.add(job);
    try { return await job; } finally { this.inFlight.delete(job); }
  }

  /**
   * The length in the message is the sender's word, and a crafted client can call an hour of
   * audio one second. Before anything is uploaded the file itself is measured, and the
   * per-recording limit and both budgets are held against that. False = not to be transcribed.
   */
  async holdToRealLength(n, media, reserved, isVideo = false, measure = measureSeconds) {
    const limit = MAX_TRANSCRIBE_SECONDS || MAX_MEDIA_SECONDS;
    let real = await measure(media.absPath, { limitSeconds: limit });
    const giveBack = () => { budget.refund(reserved); this.addUsage(-reserved); };
    if (real == null) {
      // ffmpeg could not tell. A video it cannot read is not sent anywhere; for audio the file's
      // size still bounds the length (a voice note is 16 kbit/s or more, 2000 bytes a second).
      if (isVideo) { giveBack(); console.warn(`${this.tag} ⏭️ skipped a video whose length could not be measured`); return false; }
      let bytes = 0; try { bytes = statSync(media.absPath).size; } catch { /* gone */ }
      real = Math.max(n.seconds, bytes / 2000);
    }
    real = Math.ceil(real);
    if (MAX_TRANSCRIBE_SECONDS > 0 && real > MAX_TRANSCRIBE_SECONDS) {
      giveBack();
      console.log(`${this.tag} ⏭️ skipped a recording that is really over the ${MAX_TRANSCRIBE_SECONDS}s limit (it declared ${n.seconds}s)`);
      return false;
    }
    const extra = real - reserved;
    if (extra <= 5) return true; // what was reserved covers it
    if (!budget.reserve(extra)) { giveBack(); console.warn(`${this.tag} ⏸️ server daily audio budget reached — skipped`); return false; }
    if (!this.reserveUsage(extra)) { budget.refund(extra); giveBack(); console.log(`${this.tag} ⏸️ over daily cap, skipped`); return false; }
    n.seconds = real; // the sanity check and the logs work with the true length
    return true;
  }

  /** Everything one recording sets off is billed to it, and the bill added to this account's total (dollars, no content). */
  metered(n, fn) {
    return meter(n.seconds, async () => {
      try { return await fn(); } finally {
        const b = bill();
        if (b?.usd > 0) { this.totals.usd = (this.totals.usd || 0) + b.usd; if (b.unpriced) this.totals.unpriced = true; saveJson(this.f('totals.json'), this.totals); }
      }
    });
  }

  async transcribeAndDeliver(m, n, chatName, media, isVideo, inControl) {
    if (this.stopped) { deleteMediaFile(media); return; } // checkpoint before anything is uploaded
    const plan = planEnabled(this.plan) ? this.plan : (planEnabled('pro') ? 'pro' : 'free');
    // Filled in as we go; only used when this account opted in to keeping audio.
    const keep = { seconds: n.seconds, isVideo, fromMe: n.fromMe, plan, language: this.language || 'auto' };
    try {
      const run = await transcribeRun({
        absPath: media.absPath, isVideo, plan, language: this.language,
        validate: (text, ctx) => checkTranscript(text, { seconds: n.seconds, language: ctx.language }),
        // An account under test compares its own list; everyone else gets the
        // single cheap second reading, if one is configured.
        compareModels: this.abModel || SECOND_READING_MODEL || null,
        signal: this.abort.signal,
      });
      if (this.stopped || !run.text) return;
      Object.assign(keep, { model: run.model, text: run.text, usedFallback: run.usedFallback, check: run.check, compare: run.compare });
      if (run.usedFallback) console.warn(`${this.tag} ⚠️ ${planLabel(plan)} failed — the fallback provider answered`);
      if (!run.check.ok) {
        this.stats.dropped++;
        console.warn(`${this.tag} 🚫 dropped likely hallucination (${run.check.reason}) on a ${n.seconds}s ${isVideo ? 'video' : 'voice note'}`);
        if (inControl) this.sendPaced(n.chatId, { text: "🤷 Couldn't make out any speech in that recording." }, { quoted: m }).catch(() => {});
        return;
      }
      const who = { speaker: n.senderName, isMe: n.fromMe };
      // Other readings of the same audio (a comparison run, or the fallback
      // provider) are the best signal for a misheard word — hand them to the
      // rewrite. Only same-script readings: a transliterated one would mislead it.
      const alts = (run.compare || []).map((c) => c.text).filter((t) => t && sameScript(run.text, t));
      const rewritten = await rewriteTranscript(run.text, { ...who, names: this.namesHint(), alts });
      const content = rewritten || run.text;
      const summary = await summarizeTranscript(content, who);
      Object.assign(keep, { rewritten: rewritten || null, summary: summary || null });
      const body = summary ? `*${summary}*\n${content}` : content;
      this.trace('transcribed', { id: n.id, seconds: n.seconds, inControl: !!inControl, fromMe: n.fromMe, forwarded: n.forwarded, isGroup: n.isGroup, model: run.model, raw: run.text, alts, rewritten: rewritten || null, summary: summary || null });
      this.stats.transcribed++;
      const whose = n.fromMe && !n.forwarded ? 'own' : 'others';
      this.totals[whose]++; this.totals[`${whose}Seconds`] = (this.totals[`${whose}Seconds`] || 0) + n.seconds;
      saveJson(this.f('totals.json'), this.totals);
      this.cacheText(n.mediaSha, content, summary);
      console.log(`${this.tag} ${isVideo ? '🎬' : '🎙️'} ${n.seconds}s → ${content.length} chars${summary ? ' + summary' : ''} [${plan}]`);
      let posted = false;
      if (inControl) await this.handleControlNote(n, content, body, isVideo, m);
      else posted = await this.deliver(n, chatName, body, isVideo, m);
      // A/B: the comparison goes to the owner's own control group, never to a log.
      // Only an account explicitly under test sees the comparison message; the
      // second reading of a normal account is used silently by the rewrite.
      if (this.abModel && run.compare?.length && this.target) {
        const readings = [`*${run.model}* (delivered):\n${run.text}`, ...run.compare.map((c) => `*${c.model}:*\n${c.text}`)];
        this.sendPaced(this.target.jid, { text: `🧪 *Same recording, ${readings.length} models*\n\n${readings.join('\n\n')}` }).catch(() => {});
      }
      return posted;
    } catch (e) {
      this.stats.failed++; this.lastError = { at: Date.now(), message: firstLine(e) };
      console.warn(`${this.tag} ⚠️ transcription failed: ${firstLine(e)}`);
      keep.error = firstLine(e);
    } finally {
      // Opted in: the recording is kept with what the models made of it, so a
      // model change can be judged on real audio. Otherwise it is deleted now.
      const item = this.keepAudio ? research.archive({ accountId: this.id, mediaPath: media.absPath, meta: keep }) : null;
      if (item) console.log(`${this.tag} 🎧 kept the recording for product work`);
      else deleteMediaFile(media);
    }
  }

  /**
   * Full trace of what happened to a recording — transcript, the model's
   * reading of it, who it matched, what was sent. ONLY for an account whose
   * owner opted in to keeping data for product work; silent for everyone else.
   */
  trace(event, data = {}) {
    if (!this.keepAudio) return;
    console.log(`${this.tag} 🔬 ${event} ${JSON.stringify(data)}`);
  }

  /** One notice per calendar day per kind, into the control group. */
  notifyOncePerDay(kind, text) {
    const day = this.todayKey();
    this.notices = this.notices || {};
    if (this.notices[kind] === day || !this.target) return;
    this.notices[kind] = day;
    this.sendPaced(this.target.jid, { text }).catch(() => {});
  }

  // ---------- delivery ----------
  /** Resolves true once the text is in the chat (another account may be waiting to hear). */
  deliver(n, chatName, text, isVideo, original) {
    if (this.stopped) return false;
    if (this.isPrivateHere(n)) return this.deliverPrivate(n, chatName, text, isVideo);
    const body = n.fromMe ? `${SELF_PREFIX}${text}` : `${isVideo ? '🎬' : '🎙️'} *${n.senderName || chatName || 'unknown'}*: ${text}`;
    // In a disappearing chat the text disappears on the same timer as the recording.
    const opts = { quoted: original, ...(n.expiration ? { ephemeralExpiration: n.expiration } : {}) };
    return this.sendPaced(n.chatId, { text: body }, opts)
      .then(() => { console.log(`${this.tag} 📝 posted ${n.fromMe ? 'own' : 'their'} transcript (${n.isGroup ? 'group' : 'private'})`); return true; })
      .catch((e) => { console.warn(`${this.tag} post failed: ${firstLine(e)}`); return false; });
  }

  /**
   * Private mode: the text goes to the control group as a message of its own, nothing to the chat.
   * Replying include / exclude / private to it switches that chat, and delete removes it.
   */
  deliverPrivate(n, chatName, text, isVideo) {
    if (!this.target) return false;
    const he = this.ownerLocale() === 'he', icon = isVideo ? '🎬' : '🎙️';
    const sender = n.senderName || chatName || 'unknown';
    // Theirs: who, and in which group. The owner's own: where it went.
    const head = n.fromMe
      ? (he ? `${icon} ההקלטה שלך ${n.isGroup ? 'ב' : 'ל'}*${chatName}*` : `${icon} *You* ${n.isGroup ? 'in' : 'to'} *${chatName}*`)
      : `${icon} *${sender}*${n.isGroup && chatName ? ` ${he ? 'ב' : 'in '}*${chatName}*` : ''}`;
    return this.sendPaced(this.target.jid, { text: `${head}\n${text}` })
      .then((sent) => {
        if (sent?.key?.id) this.recordFwd(sent.key.id, { chatId: n.chatId, name: chatName || sender });
        console.log(`${this.tag} 📝 private transcript (${n.isGroup ? 'group' : 'private'})`);
        return false; // not a post in the chat: nobody else's text there depends on it
      })
      .catch((e) => { console.warn(`${this.tag} private post failed: ${firstLine(e)}`); return false; });
  }

  /** A recording forwarded into the control group: its text + whether its source chat is on or off. */
  deliverProbe(n, body, isVideo, original) {
    if (this.stopped) return;
    const src = n.mediaSha ? this.mediaSrc.get(n.mediaSha) : null;
    let tail;
    if (!src) tail = "_(Couldn't tell which chat this came from — only recordings I saw arrive can be traced.)_";
    else {
      const mode = this.chatMode(src.chatId), nm = src.name;
      tail = this.ownerLocale() === 'he'
        ? { included: `🟢 מתומלל: *«${nm}»*, והטקסט מופיע בצ'אט. לענות *private* כדי לקבל אותו רק כאן, או *exclude* כדי להפסיק.`,
          private: `🔒 מתומלל בפרטיות: *«${nm}»*. הטקסט מגיע לכאן, ושום דבר לא נכתב שם. לענות *include* כדי שיופיע בצ'אט, או *exclude* כדי להפסיק.`,
          mine: `🟡 רק ההודעות הקוליות שלך מתומללות ב*«${nm}»*. לענות *include* כדי לתמלל את כולם, *private* כדי לקבל הכול רק כאן, או *exclude* כדי להפסיק.`,
          off: `🔇 לא מתומלל: *«${nm}»*. לענות *include* כדי לקבל טקסט בצ'אט, או *private* כדי לקבל אותו רק כאן.` }[mode]
        : { included: `🟢 *«${nm}»* is transcribed, with the text in the chat. Reply *private* to get it only here, or *exclude* to stop.`,
          private: `🔒 *«${nm}»* is transcribed privately: the text comes here and nothing is posted there. Reply *include* to post it in the chat, or *exclude* to stop.`,
          mine: `🟡 *«${nm}»*: only your own voice notes are transcribed. Reply *include* for everyone's, *private* to get everything only here, or *exclude* to stop.`,
          off: `🔇 *«${nm}»* is not transcribed. Reply *include* to get the text in the chat, or *private* to get it only here.` }[mode];
    }
    this.sendPaced(this.target.jid, { text: `${isVideo ? '🎬' : '🎙️'} ${src ? `from *${src.name}*` : 'forwarded recording'}\n${body}\n\n${tail}` }, { quoted: original })
      .then((sent) => { if (src && sent?.key?.id) this.recordFwd(sent.key.id, src); })
      .catch((e) => console.warn(`${this.tag} probe post failed: ${firstLine(e)}`));
  }

  // ---------- dictated messages ----------
  /**
   * A recording in the control group. A forwarded one (or one we saw arrive
   * elsewhere) is a probe of its chat. A voice note recorded right here may be
   * a dictated message: "send Eden that I'm on my way". If it is not one, or
   * the model cannot tell, it is treated as a probe like before.
   */
  async handleControlNote(n, content, body, isVideo, original) {
    // Only the owner's own voice can dictate or answer: should anyone else ever be in this group,
    // their recordings are transcribed like any forwarded one and nothing more.
    if (!n.fromMe) { this.deliverProbe(n, body, isVideo, original); return; }
    const traceable = !!(n.mediaSha && this.mediaSrc.has(n.mediaSha));
    // A question of ours is open and the owner answered it out loud ("yes", "כן", "שתיים").
    if (!traceable && !n.forwarded && n.isVoice && this.pendingSend && await this.handleDictationReply(original, n, spokenAnswer(content))) return;
    if (!traceable && !n.forwarded && n.isVoice && this.pendingSwitch && await this.handleSwitchReply(original, n, spokenAnswer(content))) return;
    const cue = looksLikeDictation(content);
    this.trace('control.note', { id: n.id, traceable, forwarded: n.forwarded, isVoice: n.isVoice, cue });
    if (!traceable && !n.forwarded && n.isVoice && cue) {
      const d = await this.dictationFor(content);
      this.trace('dictation.extracted', { id: n.id, result: d });
      if (d && !this.stopped) { await this.dictate(d, original); return; }
    }
    // Recorded right here, not forwarded: it is the owner's own note, and gets its text like one.
    // The first one is the last step of onboarding: say that this is it, and what to do next.
    if (!traceable && !n.forwarded && n.isVoice) {
      const posted = await this.deliver(n, 'me', content, isVideo, original);
      if (posted && !this.firstNoteAt && !this.stopped) {
        this.firstNoteAt = Date.now(); this.persistRecord();
        if (Date.now() - (this.linkedAt || 0) < 7 * 86400e3) {
          await this.sendPaced(n.chatId, { text: this.ownerLocale() === 'he'
            ? "👏 ככה זה עובד: כל הודעה קולית שנשלחת ממך מקבלת טקסט ממש מתחתיה, בכל צ'אט.\nעכשיו לשלוח אחת למישהו, בצ'אט פרטי."
            : "👏 That's how it works: every voice note you send gets its text right under it, in any chat.\nNow send one to someone, in a private chat." }).catch(() => {});
        }
      }
      return;
    }
    this.deliverProbe(n, body, isVideo, original);
  }
  dictationFor(text) { return extractDictation(text, { trace: (e, d) => this.trace(e, d) }); }

  /**
   * Resolve the recipient and ASK. Nothing is ever sent on the strength of a
   * match alone: even one certain saved contact is only proposed, with the end
   * of their number, and goes out when the owner replies yes. Several possible
   * contacts are listed and picked by number.
   */
  async dictate({ to, spellings = [], text }, original) {
    const { proposed: certain, candidates } = matchContacts([to, ...spellings], this.contactNames, { activity: this.activity });
    this.trace('dictation.match', { to, spellings, text, proposed: certain, candidates, contacts: this.contactNames.size });
    const quoted = original ? { quoted: original } : {};
    if (!candidates.length) {
      console.log(`${this.tag} ✉️ dictation: no contact matched — nothing sent`);
      this.noteCommand('dictate', 'no contact matched');
      await this.sendPaced(this.target.jid, { text: `🤷 Couldn't find *${to}* in your contacts, so nothing was sent. If the spelling is off, *names: ${to}* in Notes to self teaches me.` }, quoted).catch(() => {});
      return;
    }
    // The proposed one first, so that "yes" and "1" mean the same person.
    const list = certain ? [certain, ...candidates.filter((c) => c.jid !== certain.jid)] : candidates;
    const tail = (jid) => (jid.endsWith('@s.whatsapp.net') ? ` (…${jid.split('@')[0].slice(-4)})` : '');
    const label = (c) => `${c.name}${tail(c.jid)}`;
    console.log(`${this.tag} ✉️ dictation: ${list.length} possible contact(s) — asking before sending`);
    const others = list.length > 1 ? `\n\nSomeone else? Reply with the number:\n${list.map((c, i) => `${i + 1}. ${label(c)}`).join('\n')}` : '';
    const ask = certain
      ? `✉️ Send to *${label(certain)}*?\n«${text}»\n\nReply *yes* to send, *no* to drop it — typed or spoken.${others}`
      : `🤔 Not sure who *${to}* is:\n${list.map((c, i) => `${i + 1}. ${label(c)}`).join('\n')}\n\nReply with the number to send them:\n«${text}»\n\nReply *no* to drop it.`;
    this.noteCommand('dictate', certain ? 'asked to confirm' : `asked to pick (${list.length})`);
    const sent = await this.sendPaced(this.target.jid, { text: ask }, quoted).catch(() => null);
    this.pendingLeave = null; this.pendingSwitch = null; // the newest question owns the next "yes"
    this.pendingSend = { postId: sent?.key?.id || null, candidates: list, proposed: !!certain, text, at: Date.now() };
  }

  /** Send the message as the owner, then confirm in the control group with an undo handle. */
  async sendDictated(contact, text, original) {
    if (this.stopped) return;
    let sent;
    try { sent = await this.sendPaced(contact.jid, { text }); }
    catch (e) {
      console.warn(`${this.tag} ✉️ dictated message failed: ${firstLine(e)}`);
      this.trace('dictation.send_failed', { jid: contact.jid, name: contact.name, text, error: firstLine(e) });
      this.noteCommand('dictate', 'sending failed');
      await this.sendPaced(this.target.jid, { text: `⚠️ Couldn't send to *${contact.name}*. Nothing was sent.` }).catch(() => {});
      return;
    }
    console.log(`${this.tag} ✉️ sent a dictated message (${text.length} chars)`);
    this.trace('dictation.sent', { jid: contact.jid, name: contact.name, text, messageId: sent?.key?.id || null });
    this.noteCommand('dictate', 'sent');
    const conf = await this.sendPaced(this.target.jid, { text: `✉️ Sent to *${contact.name}*:\n«${text}»\n\nReply *undo* to delete it for everyone.` }, original ? { quoted: original } : {}).catch(() => null);
    if (conf?.key?.id && sent?.key?.id) {
      this.dictated.set(conf.key.id, { chatId: contact.jid, id: sent.key.id });
      while (this.dictated.size > 200) this.dictated.delete(this.dictated.keys().next().value);
    }
  }

  /** Control-group text that answers a dictation: a number picks the recipient, undo/cancel drops or revokes. */
  async handleDictationReply(m, n, lower) {
    if (this.ownPosts.has(n.id)) return false; // our own post echoing back is never an answer
    const undo = n.quoted ? this.dictated.get(n.quoted.stanzaId) : null;
    if (undo || this.pendingSend) this.trace('dictation.reply', { said: lower.slice(0, 40), quoted: n.quoted?.stanzaId || null, undo: !!undo, pending: this.pendingSend ? { postId: this.pendingSend.postId, candidates: this.pendingSend.candidates, ageMs: Date.now() - this.pendingSend.at } : null });
    if (undo && lower === 'undo') {
      this.dictated.delete(n.quoted.stanzaId);
      try {
        await this.sock.sendMessage(undo.chatId, { delete: { remoteJid: undo.chatId, fromMe: true, id: undo.id } });
        this.noteCommand('undo', 'done');
        await this.sendPaced(n.chatId, { text: '↩️ Deleted it for everyone.' }, { quoted: m }).catch(() => {});
      } catch (e) {
        console.warn(`${this.tag} undo failed: ${firstLine(e)}`);
        this.noteCommand('undo', 'failed');
        await this.sendPaced(n.chatId, { text: "⚠️ Couldn't delete it — remove it in the chat yourself." }, { quoted: m }).catch(() => {});
      }
      return true;
    }
    const p = this.pendingSend;
    if (!p || Date.now() - p.at > PENDING_SEND_TTL_MS || (n.quoted && n.quoted.stanzaId !== p.postId)) return false;
    if (lower === 'no') {
      this.pendingSend = null;
      this.noteCommand('dictate', 'cancelled');
      await this.sendPaced(n.chatId, { text: '👌 Dropped. Nothing was sent.' }, { quoted: m }).catch(() => {});
      return true;
    }
    const pick = /^\d{1,2}$/.test(lower) ? p.candidates[Number(lower) - 1] : (p.proposed && lower === 'yes' ? p.candidates[0] : null);
    if (!pick) return false;
    this.pendingSend = null;
    await this.sendDictated(pick, p.text, m);
    return true;
  }

  /** "leave" in the control group asks; a typed yes unlinks the device and erases the account. */
  async handleLeave(m, n, lower) {
    if (this.ownPosts.has(n.id)) return false;
    const he = this.ownerLocale() === 'he';
    if (lower === 'leave') {
      this.pendingSend = null; this.pendingSwitch = null;
      this.noteCommand('leave', 'asked to confirm');
      const sent = await this.sendPaced(n.chatId, { text: he
        ? `⚠️ לנתק את *${PRODUCT_NAME}* מהוואטסאפ שלך ולמחוק את כל מה ששמור עליך כאן?\n\nלענות *yes* כדי להתנתק, *no* כדי להמשיך כרגיל.`
        : `⚠️ Unlink *${PRODUCT_NAME}* from your WhatsApp and erase everything about you here?\n\nReply *yes* to leave, *no* to carry on.` }, { quoted: m }).catch(() => null);
      this.pendingLeave = { postId: sent?.key?.id || null, at: Date.now() };
      return true;
    }
    const p = this.pendingLeave;
    if (!p || Date.now() - p.at > PENDING_LEAVE_TTL_MS || (n.quoted && n.quoted.stanzaId !== p.postId)) return false;
    if (lower === 'no') {
      this.pendingLeave = null;
      this.noteCommand('leave', 'cancelled');
      await this.sendPaced(n.chatId, { text: he ? '👌 נשארים. שום דבר לא השתנה.' : '👌 Staying. Nothing changed.' }, { quoted: m }).catch(() => {});
      return true;
    }
    if (lower !== 'yes') return false;
    this.pendingLeave = null;
    console.log(`${this.tag} 👋 owner asked to leave from the control group`);
    this.noteCommand('leave', 'done');
    await this.sendPaced(n.chatId, { text: he
      ? `👋 בוצע. *${PRODUCT_NAME}* מתנתק מהוואטסאפ שלך וכל מה שנשמר עליך כאן נמחק. אם הוא עדיין מופיע תחת *מכשירים מקושרים*, אפשר להסיר אותו שם. את הקבוצה הזו אפשר למחוק.`
      : `👋 Done. *${PRODUCT_NAME}* is unlinking from your WhatsApp and everything about you here is erased. If it still shows under *Linked devices*, remove it there. You can delete this group.` }).catch(() => {});
    await this.onLeave?.(this);
    return true;
  }

  // ---------- include / exclude a chat ----------
  /** True when this recording's chat was excluded by the owner, under either of its ids. */
  isExcluded(n) { return this.muted.has(n.chatId) || (!!n.chatAlt && this.muted.has(n.chatAlt)); }
  /** True when this recording's chat is in private mode, under either of its ids. */
  isQuiet(n) { return this.quiet.has(n.chatId) || (!!n.chatAlt && this.quiet.has(n.chatAlt)); }
  /** Private delivery for this recording: its chat is in private mode, or it is a group nobody switched and the setting is "groups private". */
  isPrivateHere(n) { return this.isQuiet(n) || (n.isGroup && this.groups === 'private' && !this.enabled.has(n.chatId) && !this.isExcluded(n)); }
  /** What happens to other people's recordings in this chat: 'included' (text in the chat), 'private' (text here), or 'off'. */
  chatMode(chatId) { return this.muted.has(chatId) ? 'off' : this.quiet.has(chatId) ? 'private' : this.chatIncluded(chatId) ? 'included' : chatId.endsWith('@g.us') && this.groups !== 'off' ? this.groups : 'off'; }
  /** Whether other people's recordings in this chat are transcribed. */
  chatIncluded(chatId) { return chatId.endsWith('@g.us') ? this.enabled.has(chatId) && !this.muted.has(chatId) : !this.muted.has(chatId); }

  /** Every id WhatsApp may use for this private chat: the phone id and the lid, when the mapping is known. */
  async chatIdsFor(jid) {
    const ids = new Set([jid]);
    if (jid.endsWith('@g.us')) return [...ids];
    if (this.altIds.get(jid)) ids.add(this.altIds.get(jid));
    const map = this.sock?.signalRepository?.lidMapping;
    try {
      if (jid.endsWith('@lid')) { const pn = await map?.getPNForLID(jid); if (pn) ids.add(jidNormalizedUser(pn)); }
      else { const lid = await map?.getLIDForPN(jid); if (lid) ids.add(jidNormalizedUser(lid)); }
    } catch { /* mapping unavailable: the id we have still counts */ }
    return [...ids];
  }

  /** Contacts and groups the owner can name, as jid → name. Never the control group or Notes to self. */
  async switchDirectory() {
    if (this.sock?.groupFetchAllParticipating && (!this._groupsAt || Date.now() - this._groupsAt > 10 * 60e3)) {
      try {
        const all = await this.sock.groupFetchAllParticipating();
        for (const [jid, meta] of Object.entries(all || {})) if (meta?.subject) this.groupNames.set(jid, meta.subject);
        this._groupsAt = Date.now();
      } catch { /* offline: the groups seen so far */ }
    }
    const dir = new Map();
    for (const [jid, name] of this.contactNames) if (name && !this.isSelfChat(jid)) dir.set(jid, name);
    for (const [jid, name] of this.groupNames) if (name && jid !== this.target?.jid) dir.set(jid, name);
    return dir;
  }

  /**
   * The chats a typed name may mean, one option per chat. Different people who share a name stay
   * separate options, told apart by the end of their number; the phone id and the lid of the same
   * person are one option.
   */
  async switchOptions(name) {
    const dir = await this.switchDirectory();
    const { candidates } = matchContacts(name, dir, { activity: this.activity, max: 8 });
    // One option per person, across every name they matched under (their saved name and the one they
    // gave themselves can both match), labelled with the name the owner saved them under when known.
    const people = [];
    const savedName = (ids) => ids.map((id) => (this.savedNames.has(id) ? this.contactNames.get(id) : null)).find(Boolean) || null;
    for (const c of candidates) {
      // matchContacts folds everything with the same name into one; unfold it into the chats behind it.
      const same = [...dir].filter(([, v]) => normName(v) === normName(c.name)).map(([jid]) => jid);
      for (const jid of same) {
        const ids = await this.chatIdsFor(jid);
        const known = people.find((p) => p.ids.some((id) => ids.includes(id)));
        if (known) { for (const id of ids) if (!known.ids.includes(id)) known.ids.push(id); if (jid.endsWith('@s.whatsapp.net')) known.chatId = jid; }
        else people.push({ chatId: jid, ids, name: String(dir.get(jid)).trim(), isGroup: jid.endsWith('@g.us') });
      }
    }
    for (const p of people) if (!p.isGroup) p.name = String(savedName(p.ids) || p.name).trim();
    return people.slice(0, 9);
  }

  /**
   * "exclude 050-123-4567" / "+44 7700 900123": the private chat with that number — for a business
   * or anyone whose name was never seen. Known chats whose number ends the same way come first;
   * otherwise WhatsApp is asked whether the full number has an account.
   */
  async switchByNumber(raw) {
    let digits = raw.replace(/\D/g, '');
    const intl = /^\s*(\+|00)/.test(raw);
    if (intl) digits = digits.replace(/^00/, '');
    const tail = digits.replace(/^0+/, '').slice(-9);
    if (tail.length < 6) return [];
    const known = new Set([...this.contactNames.keys(), ...this.activity.keys(), ...this.altIds.keys(), ...[...this.mediaSrc.values()].map((v) => v.chatId)]);
    let hits = [...known].filter((j) => j.endsWith('@s.whatsapp.net') && j.split('@')[0].endsWith(tail));
    if (!hits.length && this.sock?.onWhatsApp) {
      // A local number takes the owner's own country code — only when the owner's number shows it plainly.
      const cc = (this.ownId || '').match(/^(972|44|1)/)?.[1];
      const full = intl ? digits : digits.startsWith('0') && cc ? cc + digits.replace(/^0+/, '') : null;
      if (full) try { const [r] = await this.sock.onWhatsApp(full); if (r?.exists && r.jid) hits = [jidNormalizedUser(r.jid)]; } catch { /* lookup unavailable */ }
    }
    const options = [];
    for (const jid of new Set(hits)) options.push({ chatId: jid, ids: await this.chatIdsFor(jid), name: this.contactNames.get(jid) || `+${jid.split('@')[0]}`, isGroup: false });
    return options.slice(0, 9);
  }

  switchLabel(o) {
    const he = this.ownerLocale() === 'he';
    if (o.isGroup) return `${o.name} (${he ? 'קבוצה' : 'group'})`;
    const phone = o.ids.find((id) => id.endsWith('@s.whatsapp.net'));
    return phone ? `${o.name} (…${phone.split('@')[0].slice(-4)})` : o.name;
  }

  /** "include Mom" / "exclude Mom", or either word as a reply to a forwarded recording: find the chat, then ask. */
  async askSwitch(m, n, action, name) {
    const he = this.ownerLocale() === 'he';
    let options;
    if (!name && n.quoted) {
      const src = this.resolveQuotedSource(n.quoted.stanzaId, n.quoted);
      options = src ? [{ chatId: src.chatId, ids: await this.chatIdsFor(src.chatId), name: src.name, isGroup: src.chatId.endsWith('@g.us') }] : [];
      if (!options.length) {
        this.noteCommand(action, 'could not tell which chat');
        await this.sendPaced(n.chatId, { text: he ? `🤷 לא ברור על איזה צ'אט מדובר. לכתוב *${action}* ואת השם.` : `🤷 Couldn't tell which chat that's about. Write *${action}* and the name.` }, { quoted: m }).catch(() => {});
        return;
      }
    } else if (!name) {
      this.noteCommand(action, 'shown what is switched');
      await this.sendPaced(n.chatId, { text: this.switchStatus(action) }, { quoted: m }).catch(() => {});
      return;
    } else options = /^[+\d][\d\s()-]{5,}$/.test(name) ? await this.switchByNumber(name) : await this.switchOptions(name);
    this.trace('switch.match', { action, name, options: options.map((o) => ({ chatId: o.chatId, ids: o.ids, name: o.name })) });
    if (!options.length) {
      this.noteCommand(action, /^[+\d]/.test(name) ? 'no chat with that number' : 'no chat with that name');
      await this.sendPaced(n.chatId, { text: he
        ? `🤷 לא מצאתי איש קשר או קבוצה בשם *${name}*. שום דבר לא השתנה.\nאפשר לכתוב את המספר במקום השם (*${action} 050-1234567*), או להעביר לכאן הודעה קולית מהצ'אט ולענות לה *${action}*.`
        : `🤷 No contact or group called *${name}*. Nothing changed.\nWrite the number instead of the name (*${action} +1 555 123 4567*), or forward a voice note from that chat to here and reply *${action}* to it.` }, { quoted: m }).catch(() => {});
      return;
    }
    this.pendingSend = null; this.pendingLeave = null; // the newest question owns the next "yes"
    if (options.length === 1) { await this.confirmSwitch(m, n.chatId, action, options, options[0]); return; }
    const list = options.map((o, i) => `${i + 1}. ${this.switchLabel(o)}`).join('\n');
    this.noteCommand(action, `asked to pick (${options.length})`);
    const sent = await this.sendPaced(n.chatId, { text: he
      ? `🤔 למי הכוונה?\n${list}\n\nלענות במספר, או *no* כדי לבטל.`
      : `🤔 Which one?\n${list}\n\nReply with the number, or *no* to cancel.` }, { quoted: m }).catch(() => null);
    this.pendingSwitch = { postId: sent?.key?.id || null, action, options, chosen: null, at: Date.now() };
  }

  /** The last step, always: name the one chat that would change, and wait for a yes. */
  async confirmSwitch(m, chatId, action, options, chosen) {
    const he = this.ownerLocale() === 'he';
    const label = this.switchLabel(chosen);
    const text = action === 'private'
      ? (he ? `🔒 לתמלל את *${label}* בפרטיות?\nכל הקלטה בצ'אט ההוא תתומלל, גם שלך, והטקסט יגיע רק לקבוצה הזו. שום דבר לא ייכתב בצ'אט ההוא.\n\nלענות *yes* כדי לעבור, *no* כדי לבטל.`
        : `🔒 Transcribe *${label}* privately?\nEvery recording there will be transcribed, yours included, and the text will come only to this group. Nothing is posted in that chat.\n\nReply *yes* to switch, *no* to cancel.`)
      : action === 'exclude'
      ? (he ? `🔇 להחריג את *${label}*?\nשום הקלטה בצ'אט הזה לא תתומלל, גם לא ההקלטות שלך.\n\nלענות *yes* כדי להחריג, *no* כדי לבטל.`
        : `🔇 Exclude *${label}*?\nNo recording in this chat will be transcribed, your own voice notes included.\n\nReply *yes* to exclude, *no* to cancel.`)
      : (he ? `🟢 לתמלל את *${label}*?\nהקלטות בצ'אט הזה יקבלו טקסט מתחתיהן.\n\nלענות *yes* כדי לתמלל, *no* כדי לבטל.`
        : `🟢 Transcribe *${label}*?\nRecordings in this chat will get their text under them.\n\nReply *yes* to include it, *no* to cancel.`);
    this.noteCommand(action, `asked to confirm (${chosen.isGroup ? 'a group' : 'a private chat'})`);
    const sent = await this.sendPaced(chatId, { text }, m ? { quoted: m } : {}).catch(() => null);
    this.pendingSwitch = { postId: sent?.key?.id || null, action, options, chosen, at: Date.now() };
  }

  /** An answer to an include/exclude question: a number picks, yes applies, no cancels. */
  async handleSwitchReply(m, n, lower) {
    if (this.ownPosts.has(n.id)) return false;
    const p = this.pendingSwitch;
    if (!p || Date.now() - p.at > PENDING_SWITCH_TTL_MS || (n.quoted && n.quoted.stanzaId !== p.postId)) return false;
    const he = this.ownerLocale() === 'he';
    if (lower === 'no') {
      this.pendingSwitch = null;
      this.noteCommand(p.action, 'cancelled');
      await this.sendPaced(n.chatId, { text: he ? '👌 בוטל. שום דבר לא השתנה.' : '👌 Cancelled. Nothing changed.' }, { quoted: m }).catch(() => {});
      return true;
    }
    if (!p.chosen) {
      const pick = /^\d{1,2}$/.test(lower) ? p.options[Number(lower) - 1] : null;
      if (!pick) return false;
      await this.confirmSwitch(m, n.chatId, p.action, p.options, pick);
      return true;
    }
    if (lower !== 'yes') return false;
    this.pendingSwitch = null;
    await this.applySwitch(p.chosen, p.action);
    return true;
  }

  /** Switch the chat, under every id it may arrive with, and say so in the control group. */
  async applySwitch({ chatId, ids, name, isGroup }, action) {
    // One mode per chat: the three sets never hold the same chat.
    const all = new Set([...(ids || []), ...(await this.chatIdsFor(chatId))]);
    const include = action === 'include', quiet = action === 'private';
    if (isGroup) { include ? this.enabled.add(chatId) : this.enabled.delete(chatId); this.saveSet('enabled.json', this.enabled); }
    for (const id of all) { action === 'exclude' ? this.muted.add(id) : this.muted.delete(id); quiet ? this.quiet.add(id) : this.quiet.delete(id); }
    this.saveSet('muted.json', this.muted); this.saveSet('quiet.json', this.quiet);
    console.log(`${this.tag} ${include ? '🟢 included' : quiet ? '🔒 private' : '🔇 excluded'}: a ${isGroup ? 'group' : 'private chat'}`);
    this.noteCommand(action, `done (${isGroup ? 'a group' : 'a private chat'})`);
    const he = this.ownerLocale() === 'he';
    const text = quiet
      ? (he ? `🔒 בוצע: *${name}* מתומלל בפרטיות. הטקסט של כל הקלטה שם יגיע לכאן. כדי שיופיע בצ'אט: *include ${name}*. כדי להפסיק: *exclude ${name}*.`
        : `🔒 Done: *${name}* is transcribed privately. The text of every recording there comes here. To post it in the chat instead: *include ${name}*. To stop: *exclude ${name}*.`)
      : include
      ? (he ? `🟢 בוצע: *${name}* מתומלל. הטקסט יופיע בצ'אט, מתחת לכל הקלטה. כדי להפסיק: *exclude ${name}*.` : `🟢 Done: *${name}* is transcribed. The text appears in the chat, under each recording. To stop: *exclude ${name}*.`)
      : (he ? `🔇 בוצע: *${name}* מוחרג. שום הקלטה בו לא מתומללת. כדי להחזיר: *include ${name}*.` : `🔇 Done: *${name}* is excluded. Nothing in it is transcribed. To bring it back: *include ${name}*.`);
    const sent = await this.sendPaced(this.target.jid, { text }).catch(() => null);
    if (sent?.key?.id) this.recordFwd(sent.key.id, { chatId, name });
  }

  /** "exclude" or "include" alone: what is switched now, and how to switch a chat. */
  switchStatus(action) {
    const he = this.ownerLocale() === 'he';
    const nameOf = (jid) => this.contactNames.get(jid) || this.groupNames.get(jid) || null;
    const names = (ids) => [...new Set([...ids].map(nameOf).filter(Boolean))];
    const excluded = names(this.muted), included = names([...this.enabled].filter((j) => !this.muted.has(j)));
    const privately = names(this.quiet);
    const list = action === 'exclude' ? excluded : action === 'private' ? privately : included;
    const head = action === 'private'
      ? (he ? (list.length ? `🔒 מתומללים בפרטיות: ${list.join(', ')}` : "🔒 אין צ'אטים שמתומללים בפרטיות.") : (list.length ? `🔒 Transcribed privately: ${list.join(', ')}` : '🔒 No chat is transcribed privately.'))
      : action === 'exclude'
      ? (he ? (list.length ? `🔇 מוחרגים: ${list.join(', ')}` : "🔇 אין צ'אטים מוחרגים.") : (list.length ? `🔇 Excluded: ${list.join(', ')}` : '🔇 No chat is excluded.'))
      : (he ? (list.length ? `🟢 קבוצות מתומללות: ${list.join(', ')}` : '🟢 אף קבוצה לא מתומללת.') : (list.length ? `🟢 Groups transcribed: ${list.join(', ')}` : '🟢 No group is transcribed.'));
    return `${head}\n${he ? `כדי לשנות: *${action}* ואת השם, למשל *${action} אמא*.` : `To switch one: *${action}* and the name, e.g. *${action} Mom*.`}`;
  }

  resolveQuotedSource(quotedId, contextInfo) {
    const mapped = this.fwdMap.get(quotedId);
    if (mapped) return mapped;
    const qm = contextInfo?.quotedMessage;
    const qtext = qm?.conversation || qm?.extendedTextMessage?.text || '';
    const mm = qtext.match(/(?:from \*|«)([^*»\n]+)/);
    if (!mm) return null;
    const name = mm[1].trim();
    const hits = [...this.groupNames.entries(), ...this.contactNames.entries()].filter(([, v]) => v === name);
    return hits.length === 1 ? { chatId: hits[0][0], name } : null;
  }

  // ---------- commands ----------
  async handleCommand(m, n, chatName) {
    const txt = (n.body || '').trim();
    if (!txt) return false;
    const lower = txt.toLowerCase();
    const inControl = this.target?.jid && n.chatId === this.target.jid;

    // Manual fallback for arming the control group (only needed if auto-creation failed).
    if (n.isGroup && n.fromMe && lower === TARGET_KEYWORD) {
      // The control group must be the owner's alone: it's where private replies
      // and on/off controls live, and its name is shown on the link page.
      let meta = null;
      try { meta = await this.sock.groupMetadata(n.chatId); } catch { /* unavailable */ }
      const others = (meta?.participants || []).filter((p) => !this.isSelfChat(jidNormalizedUser(p.id)) && p.id !== this.ownId && p.id !== this.ownLid);
      if (!meta || others.length > 0) {
        await this.sendPaced(n.chatId, { text: `This group has other members, so it can't be the ${PRODUCT_NAME} control group. Create a group with only you in it and post the command there.` }).catch(() => {});
        return true;
      }
      this.target = { jid: n.chatId, name: String(chatName || PRODUCT_NAME).slice(0, 80), setAt: Date.now() };
      saveJson(this.f('target.json'), this.target); this.needsManualGroup = false;
      await this.sendPaced(n.chatId, { text: this.welcomeText() }).catch(() => {});
      await this.setGroupIcon();
      return true;
    }
    if (inControl && n.fromMe && !n.hasMedia && lower === 'help' && !this.ownPosts.has(n.id)) {
      this.noteCommand('help', 'shown');
      await this.sendPaced(n.chatId, { text: this.helpText() }, { quoted: m }).catch(() => {});
      return true;
    }
    // language, or language <name>: the transcription language, set from WhatsApp.
    const lang = /^language(?:\s*:?\s*(\S+))?$/.exec(lower);
    if (inControl && n.fromMe && !n.hasMedia && lang && !this.ownPosts.has(n.id)) {
      const before = this.language, text = this.languageReply(lang[1]);
      this.noteCommand('language', !lang[1] ? 'shown' : this.language !== before ? `set to ${this.language || 'auto'}` : 'unchanged (same, or not a language)');
      await this.sendPaced(n.chatId, { text }, { quoted: m }).catch(() => {});
      return true;
    }
    // groups, or groups off / groups mine: what happens in groups nobody switched.
    const grp = /^groups(?:\s*:?\s*(\S+))?$/.exec(lower);
    if (inControl && n.fromMe && !n.hasMedia && grp && !this.ownPosts.has(n.id)) {
      const want = ['off', 'mine', 'private'].includes(grp[1]) ? grp[1] : null;
      const changed = want && want !== this.groups;
      if (changed) { this.groups = want; this.persistRecord(); console.log(`${this.tag} 👥 groups → ${want}`); }
      this.noteCommand('groups', changed ? `set to ${want}` : want ? `already ${want}` : grp[1] ? 'not an option' : 'shown');
      await this.sendPaced(n.chatId, { text: this.groupsReply(want ? 'set' : 'show') }, { quoted: m }).catch(() => {});
      return true;
    }
    // pause / resume: stop transcribing for a while, and start again.
    if (inControl && n.fromMe && !n.hasMedia && (lower === 'pause' || lower === 'resume') && !this.ownPosts.has(n.id)) {
      const want = lower === 'pause';
      const how = want === this.paused ? (want ? 'already-paused' : 'already-running') : (want ? 'paused' : 'resumed');
      if (want !== this.paused) { this.paused = want; this.persistRecord(); console.log(`${this.tag} ${want ? '⏸️ paused' : '▶️ resumed'} by the owner`); }
      this.noteCommand(lower, how.replace('-', ' '));
      await this.sendPaced(n.chatId, { text: this.pauseReply(how) }, { quoted: m }).catch(() => {});
      return true;
    }
    // leave, then yes: unlink and erase, from inside WhatsApp.
    if (inControl && n.fromMe && !n.hasMedia && await this.handleLeave(m, n, lower)) return true;
    // A dictated message waiting for a recipient, or one to take back.
    if (inControl && n.fromMe && !n.hasMedia && await this.handleDictationReply(m, n, lower)) return true;
    // include / exclude a chat: by name, or as a reply to a forwarded recording's text. Always asks first.
    if (inControl && n.fromMe && !n.hasMedia && !this.ownPosts.has(n.id) && await this.handleSwitchReply(m, n, lower)) return true;
    const sw = /^(include|exclude|private)(?:\s+([\s\S]+))?$/i.exec(txt);
    if (inControl && n.fromMe && !n.hasMedia && sw && !this.ownPosts.has(n.id)) {
      await this.askSwitch(m, n, sw[1].toLowerCase(), (sw[2] || '').trim());
      return true;
    }
    // delete, as a reply to any post of ours: revoke it for everyone, then the command.
    if (n.fromMe && n.quoted && lower === 'delete') {
      const key = { remoteJid: n.chatId, fromMe: true, id: n.quoted.stanzaId, ...(n.isGroup && this.ownId ? { participant: this.ownId } : {}) };
      try { await this.sock.sendMessage(n.chatId, { delete: key }); this.noteCommand('delete', 'done'); } catch (e) { this.noteCommand('delete', 'failed'); console.warn(`${this.tag} delete failed: ${firstLine(e)}`); }
      try { await this.sock.sendMessage(n.chatId, { delete: m.key }); } catch { /* best effort */ }
      return true;
    }
    // names: … in Notes to self.
    if (n.fromMe && this.isSelfChat(n.chatId) && /^names\b/i.test(txt)) {
      const rest = txt.replace(/^names\s*:?\s*/i, '').trim();
      const g = this.glossary; let reply;
      this.noteCommand('names', !rest ? 'shown' : rest.startsWith('-') ? 'removed' : 'added');
      if (!rest) reply = g.list().length ? `📇 Known names (${g.list().length}): ${g.list().join(', ')}` : '📇 No names yet. Write: *names: David, Eden*';
      else if (rest.startsWith('-')) reply = `📇 Removed ${g.remove(rest.slice(1).split(/[,،]/))}. Now: ${g.list().join(', ') || '(none)'}`;
      else reply = `📇 Added ${g.add(rest.split(/[,،]/))}. Known names (${g.list().length}): ${g.list().join(', ')}`;
      await this.sendPaced(n.chatId, { text: reply }, { quoted: m }).catch(() => {});
      return true;
    }
    // Typed in the Ramble group and nothing took it: an answer nothing was waiting for, or not a command.
    if (inControl && n.fromMe && !n.hasMedia && !this.ownPosts.has(n.id)) {
      this.noteCommand(/^(yes|no|undo|\d{1,2})$/.test(lower) ? 'reply' : 'text', /^(yes|no|undo|\d{1,2})$/.test(lower) ? 'nothing was waiting for it (expired or already answered)' : 'not a command');
      this.cmdNow = null; // nothing is sent back for these
    }
    return false;
  }

  noteCommand(cmd, outcome) {
    const e = { at: Date.now(), cmd, outcome, replied: null };
    this.commands = [...this.commands, e].slice(-30); this.cmdNow = e;
    saveJson(this.f('commands.json'), this.commands);
  }

  // ---------- sending (paced, one queue per account) ----------
  sendPaced(jid, content, opts = {}) {
    const cmd = this.cmdNow; this.cmdNow = null; // the reply to the command just noted, if any
    const replied = (ok) => { if (cmd) { cmd.replied = ok; saveJson(this.f('commands.json'), this.commands); } };
    const run = async () => {
      if (this.stopped) throw new Error('account stopped');
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
      if (this.stopped) throw new Error('account stopped'); // checked again after the wait
      if (!this.sock) throw new Error('not connected');
      const sent = await this.sock.sendMessage(jid, content, opts);
      if (sent?.key?.id) { this.ownPosts.add(sent.key.id); if (this.ownPosts.size > 500) this.ownPosts.delete(this.ownPosts.values().next().value); }
      return sent;
    };
    const p = this.sendChain.then(run, run);
    p.then(() => replied(true), () => replied(false));
    this.sendChain = p.catch(() => {});
    return p;
  }

  // ---------- status (no message content, ever) ----------
  status({ full = false, history = false } = {}) {
    const base = {
      id: this.id, label: this.label, language: this.language || 'auto', createdAt: this.createdAt, linkedAt: this.linkedAt || null,
      plan: this.plan, model: planLabel(this.plan), abModel: this.abModel || null, keepAudio: this.keepAudio, paused: this.paused,
      mode: this.mode, ready: this.ready, controlGroup: this.target?.name || null, needsManualGroup: this.needsManualGroup,
      enabledGroups: this.enabled.size, mutedChats: this.muted.size, privateChats: this.quiet.size, groups: this.groups, capMinutes: this.capMinutes || null, minutesToday: Math.round(this.usageSecondsToday() / 60),
      lastMessageAt: this.lastMessageAt || null, stats: this.stats, lastError: this.lastError,
      inviteCode: this.inviteCode, invited: this.invited, dailyMinutes: this.dailyCapMinutes(), bonusMinutes: this.bonusMinutes,
    };
    // The admin page also sees who the account is: its number, WhatsApp name and who invited it.
    if (history) Object.assign(base, { usageHistory: this.usageHistory, totals: this.totals, commands: this.commands.slice(-12).reverse(), phone: this.phone || null, waName: this.waName || null, referredBy: this.referredBy || null });
    return full ? { ...base, qr: this.qr, pairingCode: this.pairingCode, pairByCode: !!this.pairPhone, rescan: this.pairRefreshedAt > 0 && Date.now() - this.pairRefreshedAt < 180e3, waMe: this.ownId ? `https://wa.me/${this.ownId.split('@')[0]}` : null, product: PRODUCT_NAME } : base;
  }
}
