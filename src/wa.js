import './logguard.js'; // the Signal library logs session keys to the console directly
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import { attach as attachPairing } from './pairing.js';
import { useAuthStore } from './authstore.js';
import { bump } from './health.js';
import { connectSlot, jitter } from './connectgate.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Every request that makes the phone show "Finished syncing with WhatsApp on …":
// app-state syncs, asking the phone to resend a message we couldn't decrypt,
// history sync. Baileys only logs these at info/debug, so pick them out of its
// log and print one line each (the message text only, never the objects with jids).
const PHONE_SYNC = /resync|synced |app state sync|history sync|placeholder resend|PDO|AwaitingInitialSync|Syncing state/i;
function waLogger(tag) {
  if (process.env.WA_LOG) return pino({ level: process.env.WA_LOG });
  return pino({
    level: 'debug',
    hooks: {
      logMethod(args) {
        const msg = args.find((a) => typeof a === 'string');
        if (msg && PHONE_SYNC.test(msg)) console.log(`${tag} 📲 ${msg.replace(/ for message \S+/, '').replace(/ \([^)]*\)/, '')}`);
      },
    },
  });
}

// Asking the phone for an app-state resync makes it show "WhatsApp synced with a
// linked device" and clears its notifications — so at most once per N days.
const RESYNC_DAYS = Number(process.env.APP_STATE_RESYNC_DAYS ?? 7);

/**
 * One WhatsApp link (one account) via Baileys — protocol-level, no browser.
 * Never marks itself online, never sends read receipts. Reconnects with backoff;
 * on a logged-out session it wipes the credentials and starts a fresh pairing.
 *
 *   const link = createLink({ dir, tag, onQr, onReady, onMessage, onClose, onChats, onContacts, onLoggedOut });
 *   await link.start();   link.stop();
 */
// Which WhatsApp Web version to announce: asked for once an hour, not once per connection.
let versionAt = 0, versionPromise = null;
function latestVersion() {
  if (!versionPromise || Date.now() - versionAt > 3600e3) { versionAt = Date.now(); versionPromise = fetchLatestBaileysVersion().catch((e) => { versionPromise = null; throw e; }); }
  return versionPromise;
}

export function createLink(cb) {
  const resyncMarker = join(cb.dir, 'appstate-resync.json');
  const tag = cb.tag || '';
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let stopped = false;
  let sock = null;
  let store = null; // this account's session keys; one open at a time
  const logger = waLogger(tag);

  function resyncDue() {
    if (RESYNC_DAYS <= 0) return false;
    try { const { at } = JSON.parse(readFileSync(resyncMarker, 'utf8')); return Date.now() - at > RESYNC_DAYS * 86400e3; }
    catch { return true; }
  }
  function markResynced() {
    try { writeFileSync(resyncMarker, JSON.stringify({ at: Date.now() })); } catch { /* best effort */ }
  }

  async function start() {
    if (stopped) return;
    store ??= await useAuthStore(cb.dir, { tag });
    const auth = store;
    const { state, saveCreds } = await auth.auth();
    const { version } = await latestVersion();
    // A slot first: connections are opened a few at a time (see connectgate.js).
    const release = await connectSlot();
    if (stopped) { release(); auth.close(); store = null; return; } // stop() may have run while we awaited — don't open a socket for a dead account

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      markOnlineOnConnect: false, // stay invisible: the phone keeps its notifications
      syncFullHistory: false,     // live messages only
      browser: Browsers.ubuntu('Chrome'), // a stock WhatsApp Web session, nothing unusual
      qrTimeout: 45000, // each QR (and so a pairing code) lives 45s; a socket offers six before it starts over
    });
    const s = sock;
    bump('sockets');
    attachPairing(s, { tag, onQr: (qr) => cb.onQr?.(qr), onRefresh: () => cb.onPairRefresh?.() });

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open' || connection === 'close' || u.qr) release(); // the attempt has its answer
      if (connection === 'open') {
        reconnectAttempts = 0;
        cb.onReady?.(s);
        auth.settle().catch((e) => console.warn(`${tag} could not remove the old session folder:`, e.message));
        console.log(`${tag} 📲 connection open (sync counter ${state.creds.accountSyncCounter ?? 0})`);
        if (resyncDue()) {
          s.resyncAppState?.(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true)
            .then(() => { markResynced(); console.log(`${tag} 🔄 app-state resynced; next in ${RESYNC_DAYS} days`); })
            .catch((e) => console.warn(`${tag} app-state resync failed:`, e?.message || e));
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        cb.onClose?.(loggedOut, code);
        if (stopped) return;
        if (loggedOut) {
          // Revoked on the phone (or a pairing that never completed): wipe and re-pair.
          console.warn(`${tag} ❌ session logged out — clearing credentials, fresh pairing next`);
          try { await auth.clear(); } catch (e) { console.warn(`${tag} could not clear the session:`, e.message); }
          cb.onLoggedOut?.();
        }
        if (reconnectTimer) return;
        // An unpaired socket closes on its own when its QRs run out: not a failure, so no backoff.
        const poolRanOut = code === DisconnectReason.timedOut && !state.creds.registered;
        const delay = jitter(poolRanOut ? 2000 : Math.min(30000, 2000 * 2 ** reconnectAttempts));
        if (!poolRanOut) reconnectAttempts++;
        console.warn(`${tag} ↻ connection closed (${code}${poolRanOut ? ', QR pool used up' : ''}); reconnecting in ${Math.round(delay / 1000)}s${poolRanOut ? '' : ` (attempt ${reconnectAttempts})`}`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          start().catch((e) => console.error(`${tag} reconnect failed:`, e.message));
        }, delay);
      }
    });

    s.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        try { await cb.onMessage?.(m, s); }
        catch (e) { console.warn(`${tag} message handler error:`, e.message); }
      }
    });
    s.ev.on('messaging-history.set', ({ chats, contacts, messages, syncType, progress }) => {
      bump('historySets'); bump('historyMessages', messages?.length || 0); bump('historyChats', chats?.length || 0);
      console.log(`${tag} 📲 history sync received (type ${syncType}, ${chats?.length || 0} chats, ${contacts?.length || 0} contacts${progress != null ? `, ${progress}%` : ''})`);
      if (chats?.length) cb.onChats?.(chats);
      if (contacts?.length) cb.onContacts?.(contacts);
    });
    s.ev.on('chats.upsert', (chats) => cb.onChats?.(chats));
    s.ev.on('chats.update', (updates) => cb.onChats?.(updates));
    s.ev.on('contacts.upsert', (contacts) => cb.onContacts?.(contacts));
    s.ev.on('contacts.update', (contacts) => cb.onContacts?.(contacts));
    return s;
  }

  /** Stop reconnecting and close the socket (used when a user unlinks). */
  function stop({ logout = false } = {}) {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const s = sock; sock = null;
    if (!s) { store?.close(); store = null; return Promise.resolve({ loggedOut: false }); }
    // Report honestly whether WhatsApp acknowledged the logout; the caller warns if not.
    const out = logout ? s.logout().then(() => ({ loggedOut: true }), () => ({ loggedOut: false })) : Promise.resolve({ loggedOut: false });
    return out.finally(() => { try { s.end?.(); } catch { /* ignore */ } store?.close(); store = null; });
  }

  /** A pairing code for this phone number, valid for the current socket (the QR keeps working too). */
  const requestPairingCode = (phone) => { if (!sock) throw new Error('not connected'); return sock.requestPairingCode(phone); };

  return { start, stop, requestPairingCode, get sock() { return sock; } };
}
