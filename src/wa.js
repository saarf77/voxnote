import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const logger = pino({ level: process.env.WA_LOG || 'silent' });

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
export function createLink(cb) {
  const authDir = join(cb.dir, 'baileys_auth');
  const resyncMarker = join(cb.dir, 'appstate-resync.json');
  const tag = cb.tag || '';
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let stopped = false;
  let sock = null;

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
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    if (stopped) return; // stop() may have run while we awaited — don't open a socket for a dead account

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      markOnlineOnConnect: false, // stay invisible: the phone keeps its notifications
      syncFullHistory: false,     // live messages only
      browser: Browsers.ubuntu('Chrome'), // a stock WhatsApp Web session, nothing unusual
    });
    const s = sock;

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) cb.onQr?.(qr);
      if (connection === 'open') {
        reconnectAttempts = 0;
        cb.onReady?.(s);
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
          try { rmSync(authDir, { recursive: true, force: true }); } catch (e) { console.warn(`${tag} could not clear auth dir:`, e.message); }
          cb.onLoggedOut?.();
        }
        if (reconnectTimer) return;
        const delay = Math.min(30000, 2000 * 2 ** reconnectAttempts);
        reconnectAttempts++;
        console.warn(`${tag} ↻ connection closed (${code}); reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
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
    s.ev.on('messaging-history.set', ({ chats, contacts }) => {
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
    if (!s) return Promise.resolve({ loggedOut: false });
    // Report honestly whether WhatsApp acknowledged the logout; the caller warns if not.
    const out = logout ? s.logout().then(() => ({ loggedOut: true }), () => ({ loggedOut: false })) : Promise.resolve({ loggedOut: false });
    return out.finally(() => { try { s.end?.(); } catch { /* ignore */ } });
  }

  return { start, stop, get sock() { return sock; } };
}
