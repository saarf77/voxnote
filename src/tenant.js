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
import { rewriteMessage } from './rewrite.js';
import { summarizeTranscript } from './summarize.js';
import { createGlossary } from './glossary.js';
import * as research from './research.js';
import * as claims from './claims.js';
import { normalizePhone } from './pairing.js';
import { LOGO_MARK_SVG } from './logo.js';
import { extractDictation, matchContacts, looksLikeDictation } from './dictate.js';

// Bounded work: at most this many recordings in flight per account, and across
// the whole process, so one flooded account can't starve the others or the box.
const PER_ACCOUNT_CONCURRENCY = Number(process.env.PER_ACCOUNT_CONCURRENCY ?? 2) || 2;
const GLOBAL_CONCURRENCY = Number(process.env.GLOBAL_CONCURRENCY ?? 8) || 8;
const MAX_QUEUE = Number(process.env.MAX_QUEUE_PER_ACCOUNT ?? 20) || 20; // waiting jobs per account beyond the running ones
const globalSlots = createSemaphore(GLOBAL_CONCURRENCY);

export const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Ramble';
const OWNER_LABEL = 'me';
// Every command is ONE English word — on, off, delete, yes, no, undo, leave, help, names —
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
const saveJson = (file, value) => { try { writeFileSync(file, JSON.stringify(value)); } catch (e) { console.warn('save failed:', file, e.message); } };
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
    });
    this.dir = dir; mkdirSync(dir, { recursive: true });
    this.tag = `[${this.id.slice(0, 6)}]`;
    this.mediaDir = join(dir, 'media');
    this.f = (name) => join(dir, name);

    // Settings and small state, all JSON files in the account's directory.
    this.target = loadJson(this.f('target.json'), null);           // control group { jid, name }
    this.muted = new Set(loadJson(this.f('muted.json'), []));       // private chats switched off
    this.enabled = new Set(loadJson(this.f('enabled.json'), []));   // groups switched on
    this.archived = new Set(loadJson(this.f('archived.json'), []));
    this.fwdMap = new Map(loadJson(this.f('fwdmap.json'), []));     // our control-group post id → source chat
    this.mediaSrc = new Map(loadJson(this.f('mediasrc.json'), [])); // media sha256 → source chat
    this.contactNames = new Map(loadJson(this.f('contacts.json'), []));
    this.savedNames = new Set(loadJson(this.f('saved.json'), []));   // contacts whose name came from the phone's address book (partial: only those synced since linking)
    this.groupNames = new Map();
    this.activity = new Map(loadJson(this.f('activity.json'), [])); // private chat → how many messages the owner sent it (a count, no content): ranks contacts for a dictated message
    this.dictated = new Map();   // our confirmation post id → the message we sent for the owner (memory only, for "undo")
    this.ownPosts = new Set();   // ids of messages we posted (memory only): their echo must never be read as the owner's answer
    this.pendingSend = null;     // a dictated message waiting for the owner to pick the recipient
    this.pendingLeave = null;    // "leave" was written in the control group; waiting for the yes
    this.seen = new Set(loadJson(this.f('seen.json'), []));         // message ids already handled
    this.glossary = createGlossary(this.f('glossary.json'));
    this.usage = loadJson(this.f('usage.json'), { day: '', seconds: 0, notified: false });
    this.usageHistory = loadJson(this.f('usage-history.json'), []); // [{ day, minutes }], the last 30 days that had any audio
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
    if (!this.linkedAt) { this.linkedAt = Date.now(); this.persistRecord(); this.onFirstLink?.(this); }
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
החיבור לוואטסאפ שלך הושלם. הקבוצה הזו היא לוח הבקרה, ואין בה אף אחד מלבדך.

• כל הודעה קולית שנשלחת ממך, בכל צ'אט, מקבלת טקסט ממש מתחתיה.
• גם הודעות קוליות שמגיעות אליך בצ'אטים פרטיים.
• קבוצות כבויות. כדי להפעיל קבוצה: להעביר ממנה הודעה קולית לכאן ולענות *on*.
• כדי להפסיק להשתמש: לכתוב כאן *leave*.
• לרשימת הפקודות: לכתוב כאן *help*.

הקלטות נמחקות ברגע שהן הופכות לטקסט.

👉 קדימה: לשלוח עכשיו הודעה קולית למישהו, בצ'אט פרטי.`;
    return `Welcome to *${PRODUCT_NAME}* ✅
It's linked to your WhatsApp. This group is your control panel, and only you are in it.

• Every voice note you send, in any chat, gets its text right under it.
• So do the voice notes people send you in private chats.
• Groups are off. To turn one on, forward a voice note from it to here and reply *on*.
• To stop using ${PRODUCT_NAME}, write *leave* here.
• For the list of commands, write *help* here.

Recordings are deleted the moment they become text.

👉 Go on: send someone a voice note now, in a private chat.`;
  }

  helpText() {
    if (this.ownerLocale() === 'he') return `*הפקודות של ${PRODUCT_NAME}*
כל פקודה היא מילה אחת באנגלית.

• הפעלה וכיבוי של צ'אט, *on* / *off*: להעביר לכאן הודעה קולית מהצ'אט, ולענות לטקסט שלה *on* או *off*. קבוצות מתחילות כבויות, צ'אטים פרטיים דולקים.
• מחיקת טקסט, *delete*: לענות כך לכל טקסט ש-${PRODUCT_NAME} פרסם, בכל צ'אט, והוא נמחק אצל כולם.
• התנתקות, *leave*: לכתוב כאן כדי לנתק את ${PRODUCT_NAME} ולמחוק את החשבון. נשאלת קודם שאלה, ועונים לה *yes* או *no*.
• הרשימה הזו: *help*.`;
    return `*${PRODUCT_NAME} commands*
Each one is a single word.

• *on* / *off*: forward a voice note from any chat to here, then reply *on* or *off* to its text to switch that chat. Groups start off, private chats start on.
• *delete*: reply with it to any text ${PRODUCT_NAME} posted, in any chat, and it's removed for everyone.
• *leave*: write it here to unlink ${PRODUCT_NAME} and erase your account. It asks first; answer *yes* or *no*.
• *help*: this list.`;
  }

  // ---------- state persistence ----------
  persistRecord() { saveJson(this.f('tenant.json'), { id: this.id, label: this.label, language: this.language, createdAt: this.createdAt, manageKey: this.manageKey, linkedAt: this.linkedAt, locale: this.locale, plan: this.plan, abModel: this.abModel, keepAudio: this.keepAudio, inviteCode: this.inviteCode, referredBy: this.referredBy, invited: this.invited, bonusMinutes: this.bonusMinutes }); }

  /** Today's ceiling for this account: the server default plus whatever invites earned. */
  dailyCapMinutes() { return DAILY_MINUTES_CAP > 0 ? DAILY_MINUTES_CAP + this.bonusMinutes : 0; }

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
    let changed = false;
    for (const c of chats) {
      const id = c?.id; if (!id) continue;
      const arch = c.archived ?? c.archive;
      if (arch === true && !this.archived.has(id)) { this.archived.add(id); changed = true; }
      else if (arch === false && this.archived.has(id)) { this.archived.delete(id); changed = true; }
    }
    if (changed) this.saveSet('archived.json', this.archived);
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
    return { id: m.key.id, chatId, isGroup, fromMe, senderName, type, body, hasMedia, isVoice, mimetype, mediaSha, mediaNode, seconds, expiration, forwarded, quoted };
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
      if (!n.fromMe && n.senderName && !this.savedNames.has(n.chatId)) this.contactNames.set(n.chatId, n.senderName);
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
    else if (n.fromMe && n.isVoice) want = true;                                      // owner's notes: everywhere
    else if (n.isGroup) want = this.enabled.has(n.chatId) && !this.archived.has(n.chatId);
    else want = !this.muted.has(n.chatId) && !this.archived.has(n.chatId);
    if (!want) return;

    // One recording, one text: the control group is ours alone, everywhere else another
    // account on this server may be looking at the very same message.
    if (inControl) { await this.handleRecording(m, n, chatName, isVideo, inControl); return; }
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
      return this.transcribeAndDeliver(m, n, chatName, media, isVideo, inControl);
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
      // One call writes the message and, for a long recording, its bold headline.
      // The separate summary is only the fallback when that call gave no headline.
      // The free-hand editor is the pro plan's; the free plan gets the faithful rewrite.
      const edited = await rewriteMessage(run.text, { ...who, names: this.namesHint(), alts, style: plan === 'pro' ? 'editor' : 'faithful' });
      const rewritten = edited?.text || null;
      const content = rewritten || run.text;
      const summary = edited?.summary || await summarizeTranscript(content, who);
      Object.assign(keep, { rewritten: rewritten || null, summary: summary || null });
      const body = summary ? `*${summary}*\n${content}` : content;
      this.trace('transcribed', { id: n.id, seconds: n.seconds, inControl: !!inControl, fromMe: n.fromMe, forwarded: n.forwarded, isGroup: n.isGroup, model: run.model, raw: run.text, alts, rewritten: rewritten || null, summary: summary || null });
      this.stats.transcribed++;
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
    const body = n.fromMe ? `${SELF_PREFIX}${text}` : `${isVideo ? '🎬' : '🎙️'} *${n.senderName || chatName || 'unknown'}*: ${text}`;
    // In a disappearing chat the text disappears on the same timer as the recording.
    const opts = { quoted: original, ...(n.expiration ? { ephemeralExpiration: n.expiration } : {}) };
    return this.sendPaced(n.chatId, { text: body }, opts)
      .then(() => { console.log(`${this.tag} 📝 posted ${n.fromMe ? 'own' : 'their'} transcript (${n.isGroup ? 'group' : 'private'})`); return true; })
      .catch((e) => { console.warn(`${this.tag} post failed: ${firstLine(e)}`); return false; });
  }

  /** A recording forwarded into the control group: its text + whether its source chat is on or off. */
  deliverProbe(n, body, isVideo, original) {
    if (this.stopped) return;
    const src = n.mediaSha ? this.mediaSrc.get(n.mediaSha) : null;
    let tail;
    if (!src) tail = "_(Couldn't tell which chat this came from — only recordings I saw arrive can be traced.)_";
    else {
      const on = src.chatId.endsWith('@g.us') ? this.enabled.has(src.chatId) : !this.muted.has(src.chatId);
      tail = on ? `🟢 *«${src.name}»* is ON. Reply *off* to stop transcribing it.` : `🔇 *«${src.name}»* is OFF. Reply *on* to transcribe it.`;
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
    const cue = looksLikeDictation(content);
    this.trace('control.note', { id: n.id, traceable, forwarded: n.forwarded, isVoice: n.isVoice, cue });
    if (!traceable && !n.forwarded && n.isVoice && cue) {
      const d = await this.dictationFor(content);
      this.trace('dictation.extracted', { id: n.id, result: d });
      if (d && !this.stopped) { await this.dictate(d, original); return; }
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
    const sent = await this.sendPaced(this.target.jid, { text: ask }, quoted).catch(() => null);
    this.pendingLeave = null; // the newest question owns the next "yes"
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
      await this.sendPaced(this.target.jid, { text: `⚠️ Couldn't send to *${contact.name}*. Nothing was sent.` }).catch(() => {});
      return;
    }
    console.log(`${this.tag} ✉️ sent a dictated message (${text.length} chars)`);
    this.trace('dictation.sent', { jid: contact.jid, name: contact.name, text, messageId: sent?.key?.id || null });
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
        await this.sendPaced(n.chatId, { text: '↩️ Deleted it for everyone.' }, { quoted: m }).catch(() => {});
      } catch (e) {
        console.warn(`${this.tag} undo failed: ${firstLine(e)}`);
        await this.sendPaced(n.chatId, { text: "⚠️ Couldn't delete it — remove it in the chat yourself." }, { quoted: m }).catch(() => {});
      }
      return true;
    }
    const p = this.pendingSend;
    if (!p || Date.now() - p.at > PENDING_SEND_TTL_MS || (n.quoted && n.quoted.stanzaId !== p.postId)) return false;
    if (lower === 'no') {
      this.pendingSend = null;
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
      this.pendingSend = null;
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
      await this.sendPaced(n.chatId, { text: he ? '👌 נשארים. שום דבר לא השתנה.' : '👌 Staying. Nothing changed.' }, { quoted: m }).catch(() => {});
      return true;
    }
    if (lower !== 'yes') return false;
    this.pendingLeave = null;
    console.log(`${this.tag} 👋 owner asked to leave from the control group`);
    await this.sendPaced(n.chatId, { text: he
      ? `👋 בוצע. *${PRODUCT_NAME}* מתנתק מהוואטסאפ שלך וכל מה שנשמר עליך כאן נמחק. אם הוא עדיין מופיע תחת *מכשירים מקושרים*, אפשר להסיר אותו שם. את הקבוצה הזו אפשר למחוק.`
      : `👋 Done. *${PRODUCT_NAME}* is unlinking from your WhatsApp and everything about you here is erased. If it still shows under *Linked devices*, remove it there. You can delete this group.` }).catch(() => {});
    await this.onLeave?.(this);
    return true;
  }

  setChatEnabled({ chatId, name }, enable) {
    const isGroup = chatId.endsWith('@g.us');
    if (isGroup) { enable ? this.enabled.add(chatId) : this.enabled.delete(chatId); this.saveSet('enabled.json', this.enabled); }
    else { enable ? this.muted.delete(chatId) : this.muted.add(chatId); this.saveSet('muted.json', this.muted); }
    console.log(`${this.tag} ${enable ? '🟢 ON' : '🔇 OFF'}: a ${isGroup ? 'group' : 'private chat'}`);
    const text = enable
      ? `🟢 *${name}* — transcription ON. Text will appear inside the chat, under each recording. Reply *off* to this message to stop.`
      : `🔇 *${name}* — transcription OFF. Reply *on* to this message to resume.`;
    this.sendPaced(this.target.jid, { text })
      .then((sent) => { if (sent?.key?.id) this.recordFwd(sent.key.id, { chatId, name }); })
      .catch(() => {});
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
      await this.sendPaced(n.chatId, { text: this.helpText() }, { quoted: m }).catch(() => {});
      return true;
    }
    // leave, then yes: unlink and erase, from inside WhatsApp.
    if (inControl && n.fromMe && !n.hasMedia && await this.handleLeave(m, n, lower)) return true;
    // A dictated message waiting for a recipient, or one to take back.
    if (inControl && n.fromMe && !n.hasMedia && await this.handleDictationReply(m, n, lower)) return true;
    // on / off, as a reply to one of our control-group posts.
    if (inControl && n.fromMe && n.quoted && (lower === 'on' || lower === 'off')) {
      const src = this.resolveQuotedSource(n.quoted.stanzaId, n.quoted);
      if (!src) await this.sendPaced(n.chatId, { text: "Couldn't tell which chat that's about. Reply to a forwarded recording's text or to an ON/OFF confirmation." }).catch(() => {});
      else this.setChatEnabled(src, lower === 'on');
      return true;
    }
    // delete, as a reply to any post of ours: revoke it for everyone, then the command.
    if (n.fromMe && n.quoted && lower === 'delete') {
      const key = { remoteJid: n.chatId, fromMe: true, id: n.quoted.stanzaId, ...(n.isGroup && this.ownId ? { participant: this.ownId } : {}) };
      try { await this.sock.sendMessage(n.chatId, { delete: key }); } catch (e) { console.warn(`${this.tag} delete failed: ${firstLine(e)}`); }
      try { await this.sock.sendMessage(n.chatId, { delete: m.key }); } catch { /* best effort */ }
      return true;
    }
    // names: … in Notes to self.
    if (n.fromMe && this.isSelfChat(n.chatId) && /^names\b/i.test(txt)) {
      const rest = txt.replace(/^names\s*:?\s*/i, '').trim();
      const g = this.glossary; let reply;
      if (!rest) reply = g.list().length ? `📇 Known names (${g.list().length}): ${g.list().join(', ')}` : '📇 No names yet. Write: *names: David, Eden*';
      else if (rest.startsWith('-')) reply = `📇 Removed ${g.remove(rest.slice(1).split(/[,،]/))}. Now: ${g.list().join(', ') || '(none)'}`;
      else reply = `📇 Added ${g.add(rest.split(/[,،]/))}. Known names (${g.list().length}): ${g.list().join(', ')}`;
      await this.sendPaced(n.chatId, { text: reply }, { quoted: m }).catch(() => {});
      return true;
    }
    return false;
  }

  // ---------- sending (paced, one queue per account) ----------
  sendPaced(jid, content, opts = {}) {
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
    this.sendChain = p.catch(() => {});
    return p;
  }

  // ---------- status (no message content, ever) ----------
  status({ full = false, history = false } = {}) {
    const base = {
      id: this.id, label: this.label, language: this.language || 'auto', createdAt: this.createdAt, linkedAt: this.linkedAt || null,
      plan: this.plan, model: planLabel(this.plan), abModel: this.abModel || null, keepAudio: this.keepAudio,
      mode: this.mode, ready: this.ready, controlGroup: this.target?.name || null, needsManualGroup: this.needsManualGroup,
      enabledGroups: this.enabled.size, mutedChats: this.muted.size, minutesToday: Math.round(this.usageSecondsToday() / 60),
      lastMessageAt: this.lastMessageAt || null, stats: this.stats, lastError: this.lastError,
      inviteCode: this.inviteCode, invited: this.invited, dailyMinutes: this.dailyCapMinutes(), bonusMinutes: this.bonusMinutes,
    };
    if (history) base.usageHistory = this.usageHistory;
    return full ? { ...base, qr: this.qr, pairingCode: this.pairingCode, pairByCode: !!this.pairPhone, rescan: this.pairRefreshedAt > 0 && Date.now() - this.pairRefreshedAt < 180e3, product: PRODUCT_NAME } : base;
  }
}
